import { DIRECT_CONNECTORS, defaultConnectorFor, isWebhookPlatform } from "../constants.js";
import type { DirectConnector } from "./targets.js";

/**
 * 配置形状迁移 —— 落盘的 connections / targets 从旧形状抬到当前形状。
 *
 * 纯函数,吃 raw JSON 吐 raw JSON,不碰磁盘也不 parse。**启动路径与备份恢复路径都调它**:
 * 一份三个月前导出的备份和一份三个月前的磁盘状态是同一个形状问题,不该有两套答案。
 *
 * 判据是**数据形状**,不是版本号。版本文件会掉电写一半、会被用户手删、在备份里干脆不存在;
 * 而「这条连接有没有 `connector`」是自明的。版本号只做一件事:**挡降级** —— 旧载荷读到
 * 更新的盘时明确报错,而不是把不认识的字段当垃圾丢掉再写回去(应用内更新可以回退旧载荷,
 * 这条路是真会走到的)。
 *
 * 所以迁移必须**幂等**:同一份数据被走两遍要得到同一个结果,且第二遍不报 `changed`。
 */

/**
 * 当前配置形状版本。
 *
 * - `1` —— 连接以 `platform` 为判别子,「怎么连」藏在 OneBot config 的 `transport` 里;
 *   目标只有 `platform`,「这是个会话还是个单向终点」靠 `platform === "webhook"` 推。
 * - `2` —— 连接长出 `kind` + `connector`(「怎么连」独立成一根轴),目标长出 `kind`
 *   (`session` / `endpoint`,形态独立成一根轴);`platform: "webhook"` 这个假平台降格,
 *   原先压在 `config.provider` 里的真平台(飞书 / 钉钉 / 企微 / 未指明)升上来。
 */
export const CONFIG_SCHEMA_VERSION = 2;

/** 迁移的输入 / 输出:raw JSON,还没过 schema。 */
export interface RawConfigSections {
	connections?: readonly unknown[];
	targets?: readonly unknown[];
}

/** 哪些分区被改写过 —— 调用方据此决定回写哪个文件,别把没动的那份也重写一遍。 */
export interface MigratedSectionFlags {
	connections: boolean;
	targets: boolean;
}

export interface MigratedConfigSections {
	connections: unknown[];
	targets: unknown[];
	changed: MigratedSectionFlags;
	/** 迁移前探到的形状版本。 */
	from: number;
}

const CONNECTOR_SET = new Set<string>(DIRECT_CONNECTORS);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 一条连接已经是新形状？两件事都要成立:`connector` 在,且 `platform` 不再是 `"webhook"`
 * —— 后者是被降格掉的那个假平台,还留着就说明上一半迁移没跑完。
 */
function isMigratedConnection(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.connector === "string" && entry.platform !== "webhook";
}

/** 一个目标已经是新形状？同理:`kind` 在,且 `platform` 不再是 `"webhook"`。 */
function isMigratedTarget(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.kind === "string" && entry.platform !== "webhook";
}

/**
 * 探测一份配置的形状版本。
 *
 * 两个分区**一起判**:连接迁了、目标没迁,整份就还是老的 —— 上一次写到一半掉电正是
 * 这个样子,必须再走一遍(迁移幂等,重走无害)。
 * 都空算**当前版本** —— 全新安装没有待迁移的东西,不该被拖去走一遍迁移再回写。
 */
export function detectConfigVersion(input: RawConfigSections): number {
	const connections = input.connections ?? [];
	const targets = input.targets ?? [];
	const migrated = connections.every(isMigratedConnection) && targets.every(isMigratedTarget);
	return migrated ? CONFIG_SCHEMA_VERSION : 1;
}

/**
 * v1 → v2(连接):两件独立的事,各自幂等。
 *
 * ① `platform: "webhook"` 降格 —— webhook 从来不是平台而是连法,真平台原先被压在
 *    `config.provider` 里,现在提上来(缺了就是 `generic`),`provider` 从 config 摘掉。
 * ② 「怎么连」提上来成 `kind` + `connector`。
 *
 * 顺序要紧:先降格再取连接器,`connectorOf` 才看得到 feishu 这类新平台名。
 */
function connectionToV2(entry: unknown): { next: unknown; changed: boolean } {
	if (!isRecord(entry)) return { next: entry, changed: false };

	let next = entry;
	let changed = false;

	if (next.platform === "webhook") {
		const { provider, ...config } = isRecord(next.config) ? next.config : {};
		next = {
			...next,
			platform: isWebhookPlatform(String(provider)) ? provider : "generic",
			config,
		};
		changed = true;
	}

	if (typeof next.connector !== "string") {
		const connector = connectorOf(next);
		// 不认识的平台(web-dashboard / koishi-bot 这类已撤下的存量条目)原样放行:
		// 加载器本来就会静默丢弃它们,在这里凭空造一个 connector 只会让丢弃前多一次改写。
		if (connector) {
			next = { ...next, kind: "direct", connector };
			changed = true;
		}
	}

	return { next, changed };
}

function connectorOf(entry: Record<string, unknown>): DirectConnector | undefined {
	if (entry.platform === "onebot") {
		const transport = isRecord(entry.config) ? entry.config.transport : undefined;
		if (typeof transport === "string" && CONNECTOR_SET.has(transport)) {
			return transport as DirectConnector;
		}
	}
	return defaultConnectorFor(String(entry.platform));
}

/**
 * v1 → v2(目标):同样两件事。
 *
 * ① `platform: "webhook"` 降格 —— 但目标自己不知道是飞书还是钉钉,**跟着它那条连接走**。
 *    连接找不到(备份只导了 targets 这一段、或者引用悬空)就落 `generic`;托管目标是
 *    连接的派生物,加载时 `syncManagedWebhookTargets` 会照着连接重算,落错也自愈。
 * ② 「这是个会话还是个单向终点」从 `platform` 提上来成 `kind`。老盘上这个判断处处写成
 *    `platform === "webhook"`,降格后那些比较会**静默恒假**,所以判据必须搬轴。
 */
function targetToV2(
	entry: unknown,
	platformByConnection: ReadonlyMap<string, string>,
): { next: unknown; changed: boolean } {
	if (!isRecord(entry)) return { next: entry, changed: false };

	let next = entry;
	let changed = false;

	if (next.platform === "webhook") {
		const owner =
			typeof next.adapterId === "string" ? platformByConnection.get(next.adapterId) : undefined;
		next = { ...next, platform: owner ?? "generic" };
		changed = true;
	}

	if (typeof next.kind !== "string") {
		const kind = targetKindOf(next);
		// 已撤下平台的存量目标同样原样放行 —— 加载器会丢弃它们。
		if (kind) {
			next = { ...next, kind };
			changed = true;
		}
	}

	return { next, changed };
}

function targetKindOf(entry: Record<string, unknown>): "session" | "endpoint" | undefined {
	const platform = String(entry.platform);
	if (isWebhookPlatform(platform)) return "endpoint";
	switch (platform) {
		case "onebot":
		case "qq-official":
			return "session";
		default:
			return undefined;
	}
}

/** 把 raw 配置抬到 {@link CONFIG_SCHEMA_VERSION}。幂等。 */
export function migrateConfigSections(input: RawConfigSections): MigratedConfigSections {
	const from = detectConfigVersion(input);
	const connections = migrateSection([...(input.connections ?? [])], connectionToV2);
	// 目标的平台跟着连接走,所以用**迁移后**的连接建表 —— 迁移前那张表里全是 "webhook"。
	const platformByConnection = new Map<string, string>();
	for (const entry of connections.entries) {
		if (isRecord(entry) && typeof entry.id === "string" && typeof entry.platform === "string") {
			platformByConnection.set(entry.id, entry.platform);
		}
	}
	const targets = migrateSection([...(input.targets ?? [])], (entry) =>
		targetToV2(entry, platformByConnection),
	);

	return {
		connections: connections.entries,
		targets: targets.entries,
		changed: { connections: connections.changed, targets: targets.changed },
		from,
	};
}

function migrateSection(
	entries: unknown[],
	step: (entry: unknown) => { next: unknown; changed: boolean },
): { entries: unknown[]; changed: boolean } {
	let changed = false;
	const next = entries.map((entry) => {
		const r = step(entry);
		if (r.changed) changed = true;
		return r.next;
	});
	return { entries: next, changed };
}
