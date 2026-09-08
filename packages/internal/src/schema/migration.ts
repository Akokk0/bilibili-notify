import { DIRECT_CONNECTORS, defaultConnectorFor } from "../constants.js";
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
 *   (`session` / `endpoint`,形态独立成一根轴)。
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

/** 一条连接已经是新形状？只认 `connector` —— `kind` 在连接上只有一档,单看它区分不出来。 */
function hasConnector(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.connector === "string";
}

/** 一个目标已经是新形状？`kind` 在目标上有两档,自明。 */
function hasKind(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.kind === "string";
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
	const migrated = connections.every(hasConnector) && targets.every(hasKind);
	return migrated ? CONFIG_SCHEMA_VERSION : 1;
}

/** v1 → v2(连接):把「怎么连」从 config 里提上来,成为连接自己的一根轴。 */
function connectionToV2(entry: unknown): { next: unknown; changed: boolean } {
	if (!isRecord(entry) || hasConnector(entry)) return { next: entry, changed: false };

	const connector = connectorOf(entry);
	// 不认识的平台(web-dashboard / koishi-bot 这类已撤下的存量条目)原样放行:
	// 加载器本来就会静默丢弃它们,在这里凭空造一个 connector 只会让丢弃前多一次改写。
	if (!connector) return { next: entry, changed: false };

	return { next: { ...entry, kind: "direct", connector }, changed: true };
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
 * v1 → v2(目标):把「这是个会话还是个单向终点」从 `platform` 里提上来。
 *
 * 老盘上这个判断处处写成 `platform === "webhook"`。webhook 降格成连接器之后
 * `platform` 会变成 feishu / dingtalk / …,那些比较会**静默恒假**,所以判据先搬轴。
 */
function targetToV2(entry: unknown): { next: unknown; changed: boolean } {
	if (!isRecord(entry) || hasKind(entry)) return { next: entry, changed: false };

	const kind = targetKindOf(entry);
	// 已撤下平台的存量目标同样原样放行 —— 加载器会丢弃它们。
	if (!kind) return { next: entry, changed: false };

	return { next: { ...entry, kind }, changed: true };
}

function targetKindOf(entry: Record<string, unknown>): "session" | "endpoint" | undefined {
	switch (entry.platform) {
		case "webhook":
			return "endpoint";
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
	const targets = migrateSection([...(input.targets ?? [])], targetToV2);

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
