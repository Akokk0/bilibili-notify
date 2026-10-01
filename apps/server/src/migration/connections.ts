/**
 * 连接与推送目标这一族:0.x 各个版本留在盘上的形状 → 0.x 最新的形状(ADR-0022 决策 4)。⑥c 从配置仓和
 * internal 的 schema 里收进迁移模块 —— 旧格式的知识只住在这里,配置仓开机只认最新的形状。
 *
 * 三件事,都是 raw → raw:
 * - 最老的单文件 `targets.json`(连接参数和会话捆在一条目标里)拆成连接 + 目标({@link migrateLegacyTargets});
 * - 连接 / 目标 v1 → v2({@link migrateConfigSections}),判据是数据形状,幂等;
 * - 已撤下平台的存量条目丢掉({@link isRetiredConnectionRecord}、{@link isRetiredTargetRecord})。
 *
 * 连接从新代里的 `connections.json` 读,没有就读第 0 代的 `state/adapters.json`(它的旧名,只作输入、不进
 * 新代)。
 */

import { join } from "node:path";
import {
	type Connection,
	ConnectionPlatformSchema,
	ConnectionSchema,
	deterministicUuid,
	type PushTarget,
	PushTargetSchema,
} from "@bilibili-notify/internal";
import {
	DIRECT_CONNECTORS,
	type DirectConnector,
	defaultConnectorFor,
	isWebhookPlatform,
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/constants";
import { readJsonFile, rewriteJsonFile } from "./files.js";

/**
 * v1 → v2 是纯函数,吃 raw JSON 吐 raw JSON,不碰磁盘也不 parse。判据是**数据形状**,不是版本号:版本文件
 * 会掉电写一半、会被用户手删、在备份里干脆不存在;而「这条连接有没有 `connector`」是自明的。所以它必须
 * **幂等**:同一份数据被走两遍要得到同一个结果,且第二遍不报 `changed`。
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
 *
 * 拓展连接(`kind: "extension"`)不在这套判据里:它从来没有 `connector`(怎么连是桥的事),
 * 它的 `platform` 是从桥报的 bot 上抄来的、可能恰好叫 `onebot` —— 按「没有 connector」去判
 * 就会把它当成史前直连,凭空戴上 `kind: "direct"`,改完当场过不了 schema。
 */
function isMigratedConnection(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	if (isExtensionConnection(entry)) return true;
	return typeof entry.connector === "string" && entry.platform !== "webhook";
}

function isExtensionConnection(entry: Record<string, unknown>): boolean {
	return entry.kind === "extension";
}

/**
 * 一个目标已经是新形状？五件事都要成立:`kind` 在、`platform` 不再是被降格掉的
 * `"webhook"`、每平台一套的 `session` 已经收成了一格 `address`、指向连接的那一格
 * 已经改叫 `connectionId`、`managedBy` 说的是「连接托管」而不是「adapter 托管」。
 */
function isMigratedTarget(entry: unknown): boolean {
	return (
		isRecord(entry) &&
		typeof entry.kind === "string" &&
		entry.platform !== "webhook" &&
		entry.session === undefined &&
		entry.adapterId === undefined &&
		entry.managedBy !== "adapter"
	);
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
	// 拓展连接自成一种形状,这两步都不归它 —— 见 isMigratedConnection。
	if (isExtensionConnection(entry)) return { next: entry, changed: false };

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
 * v1 → v2(目标):五件事,各自幂等。
 *
 * ① 指向连接的那一格从 `adapterId` 改叫 `connectionId` —— 排在最前面,后面几步(尤其是
 *    ③里那次按连接查平台)只认新名字,不必两个名字各写一遍。
 * ② `managedBy` 的值从 `"adapter"` 改叫 `"connection"` —— 托管这张目标的是那条**连接**,
 *    不是实现它的那个 adapter。注意托管目标的 **id 种子不跟着改**:那串 uuid 已经落在盘上,
 *    被订阅的路由表引用着,换了种子等于把主人配好的路由指到一个不存在的目标上。
 * ③ `platform: "webhook"` 降格 —— 但目标自己不知道是飞书还是钉钉,**跟着它那条连接走**。
 *    连接找不到(备份只导了 targets 这一段、或者引用悬空)就落 `generic`;托管目标是
 *    连接的派生物,加载时 `syncManagedWebhookTargets` 会照着连接重算,落错也自愈。
 * ④ 「这是个会话还是个单向终点」从 `platform` 提上来成 `kind`。老盘上这个判断处处写成
 *    `platform === "webhook"`,降格后那些比较会**静默恒假**,所以判据必须搬轴。
 * ⑤ 每平台一套的 `session` 收成一格 `address`(+ 官机频道的 `parentAddress`)。
 *    取哪一格由 `scope` 决定 —— 这正是收成一格要消灭的那个矩阵。
 */
function targetToV2(
	entry: unknown,
	platformByConnection: ReadonlyMap<string, string>,
): { next: unknown; changed: boolean } {
	if (!isRecord(entry)) return { next: entry, changed: false };

	let next = entry;
	let changed = false;

	if (next.adapterId !== undefined) {
		const { adapterId, ...rest } = next;
		// 两个名字都在(半迁移过的盘)以新的那个为准 —— 老的那格只可能更旧。
		next = { ...rest, connectionId: rest.connectionId ?? adapterId };
		changed = true;
	}

	if (next.managedBy === "adapter") {
		next = { ...next, managedBy: "connection" };
		changed = true;
	}

	if (next.platform === "webhook") {
		const owner =
			typeof next.connectionId === "string"
				? platformByConnection.get(next.connectionId)
				: undefined;
		next = { ...next, platform: owner ?? "generic" };
		changed = true;
	}

	if (typeof next.kind !== "string") {
		const kind = targetKindOf(next);
		// 已撤下平台(web-dashboard / koishi-bot / astrbot)的存量目标**整条原样放行**:
		// 加载器认不出它、会丢弃它,在这里替它改一半只会让 .bak 之外那份更难看懂。
		if (!kind) return { next: entry, changed: false };
		next = { ...next, kind };
		changed = true;
	}

	if (next.session !== undefined) {
		const { session, ...rest } = next;
		next = next.kind === "session" ? { ...rest, ...addressOf(next, session) } : rest;
		changed = true;
	}

	return { next, changed };
}

/** 老 session 里那一格地址 —— 由 `scope` 决定读哪个字段。 */
function addressOf(
	entry: Record<string, unknown>,
	session: unknown,
): { address: string; parentAddress?: string } {
	const s = isRecord(session) ? session : {};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	if (entry.platform === "onebot") {
		return { address: str(entry.scope === "private" ? s.userId : s.groupId) };
	}
	if (entry.scope === "channel") {
		const parentAddress = str(s.guildId);
		return { address: str(s.channelId), ...(parentAddress ? { parentAddress } : {}) };
	}
	return { address: str(entry.scope === "private" ? s.userOpenid : s.groupOpenid) };
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

// ── 最老的单文件 targets.json ──────────────────────────────────────────────────

/** 0.x 早期的一条推送目标:连接参数与会话捆在 `config` 里。 */
interface LegacyPushTarget {
	id: string;
	name: string;
	platform: string;
	scope: "group" | "private" | "channel";
	enabled: boolean;
	config?: Record<string, unknown>;
}

/**
 * 最老的单文件形状:没有任何一条指向连接(`connectionId`,或 v1 的 `adapterId`)。空文件也算,拆出来两份
 * 都是空的。混着新形状的不算 —— 那是 `connections.json` 丢了,配置仓开机时会报出来,不凭空造连接。
 */
function isLegacyTargetFile(rows: readonly unknown[]): boolean {
	return rows.every(
		(row) => isRecord(row) && row.connectionId === undefined && row.adapterId === undefined,
	);
}

/**
 * 最老的单文件 `targets.json` 拆成(连接, 目标)。同一平台、同一组连接参数的目标共用一条连接,迁 N 个群
 * 不会冒出 N 条一模一样的 NapCat 连接。
 *
 * 连接的 id 按「第一个用到它的那条老目标」算,确定的:从第 0 代重迁(回退后重迁、开发期抬修订号)拆出来的
 * 还是同一批 id,摘要守卫也看得见产出变没变。不拿连接参数算 —— 里面有 token 与 secret。
 */
export function migrateLegacyTargets(raw: readonly unknown[]): {
	connections: Connection[];
	targets: PushTarget[];
} {
	const connections: Connection[] = [];
	const targets: PushTarget[] = [];
	// 连接参数 → 连接 id,重复的连接并成一条。
	const connectionIdByKey = new Map<string, string>();
	const connectionIdOf = (key: string, legacy: LegacyPushTarget) => {
		const known = connectionIdByKey.get(key);
		if (known) return { id: known, created: false };
		const id = deterministicUuid(`connection:legacy-target:${legacy.id}`);
		connectionIdByKey.set(key, id);
		return { id, created: true };
	};

	for (const item of raw) {
		const legacy = item as LegacyPushTarget;
		if (legacy.platform === "onebot") {
			const cfg = (legacy.config ?? {}) as {
				baseUrl?: string;
				accessToken?: string;
				groupId?: string;
				userId?: string;
				protocolVersion?: "v11";
			};
			const baseUrl = cfg.baseUrl ?? "";
			const accessToken = cfg.accessToken ?? "";
			const connection = connectionIdOf(`onebot|${baseUrl}|${accessToken}`, legacy);
			if (connection.created) {
				connections.push({
					id: connection.id,
					name: deriveConnectionName(legacy.name, baseUrl),
					enabled: true,
					kind: "direct",
					connector: "http",
					platform: "onebot",
					config: {
						transport: "http",
						baseUrl,
						accessToken: accessToken || undefined,
						protocolVersion: cfg.protocolVersion ?? "v11",
						headers: {},
						timeoutMs: 15_000,
						imageMinTimeoutMs: ONEBOT_IMAGE_MIN_TIMEOUT_MS,
						forwardMinTimeoutMs: ONEBOT_FORWARD_MIN_TIMEOUT_MS,
						retryTimes: 0,
						retryIntervalMs: 1_000,
					},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				connectionId: connection.id,
				kind: "session",
				platform: "onebot",
				scope: legacy.scope,
				enabled: legacy.enabled,
				address: (legacy.scope === "private" ? cfg.userId : cfg.groupId) ?? "",
			});
		} else if (legacy.platform === "webhook") {
			const cfg = (legacy.config ?? {}) as {
				url?: string;
				secret?: string;
				headers?: Record<string, string>;
			};
			const url = cfg.url ?? "";
			const connection = connectionIdOf(`webhook|${url}|${cfg.secret ?? ""}`, legacy);
			if (connection.created) {
				connections.push({
					id: connection.id,
					name: deriveConnectionName(legacy.name, url),
					enabled: true,
					kind: "direct",
					connector: "webhook",
					// 这条遗留路径来自「webhook 是一个平台」那一代,当时连 provider 都还没有
					// (它是后来才加进 config 的)—— 所以一律落 generic。
					platform: "generic",
					config: {
						url,
						secret: cfg.secret || undefined,
						headers: cfg.headers ?? {},
					},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				connectionId: connection.id,
				kind: "endpoint",
				platform: "generic",
				scope: legacy.scope,
				enabled: legacy.enabled,
			});
		}
		// 认不得的老平台(含撤下的 web-dashboard)静默丢掉:主人看得到目标没了,在支持的平台下重建即可。
	}

	return { connections, targets };
}

function deriveConnectionName(targetName: string, addr: string): string {
	if (addr) {
		try {
			const u = new URL(addr);
			return `${targetName} · ${u.host}`;
		} catch {
			/* fall through */
		}
	}
	return targetName || "默认连接";
}

// ── 已撤下平台的存量 ──────────────────────────────────────────────────────────

/**
 * 随宿主一起撤下的那些平台 —— 盘上还留着它们的存量条目。
 *
 * 当年的 schema 是收它们的(面板不给建,但直调 API / 旧备份都能留下),今天没有任何 adapter 认领,迁移时
 * 一律丢掉:留到开机再 parse 就是启动期 throw,而那时没有面板可以进去改。
 *
 * **写成显式名单,不用「词表里没有」反推** —— 目标的平台是开放词表(桥驮来什么算什么),反推在那一侧等于
 * 「认不得的平台上的损坏一律吃掉」。
 */
const RETIRED_PLATFORMS: ReadonlySet<string> = new Set(["web-dashboard", "koishi-bot", "astrbot"]);

/**
 * 这条**连接**是不是「已撤下平台留下的存量」—— 该丢掉的那种。
 *
 * 判据是:**我们认得的平台必须能 parse;认不得的平台又 parse 不过,才是存量。** 所以它**只在 parse 失败
 * 之后**才问({@link keepConnection}),永远不跑在 parse 之前。
 *
 * ⚠️ **别把它挪到 parse 之前。** 拿原始 JSON 用闭集问「这个平台认得吗」,等于「词表里没有 = 不存在」:
 * 桥接入根本没有 `platform` 那一格,拓展带来的连接平台也不在闭集里 —— 两者都会被静默丢光。
 *
 * ⚠️ **目标那一侧不用这条**(见 {@link isRetiredTargetRecord}):连接的平台是闭集、目标的是开放词表,
 * 同一条判据套过去就变成「桥驮来的平台上的真损坏一律静默吃掉」。
 *
 * - `koishi-bot` 的老条目:词表外 + 老形状 parse 不过 → 丢弃
 * - 没有 `platform` 的拓展连接(桥接入还是连接那一版的形状,未发版):丢弃
 * - 桥借来的 telegram bot 那条连接:parse 得过 → 走不到这里
 * - onebot 的坏条目:词表内 → 留着,配置仓开机时照旧报错,不许静默吃掉真正的损坏
 */
function isRetiredConnectionRecord(raw: unknown): boolean {
	const record = raw as { kind?: unknown; platform?: unknown } | undefined;
	// 拓展连接曾经**没有** `platform`(那时它是「一条桥接入」,ADR-0012 决策 27);连接改成「一个 bot」
	// 之后这一格必填(决策 45)。老形状没发过版,不写迁移 —— 当作已撤下的形状丢掉,主人在拓展页重建即可。
	if (record?.kind === "extension") return record.platform === undefined;
	return !ConnectionPlatformSchema.safeParse(record?.platform).success;
}

/**
 * 这条**目标**是不是已撤下平台留下的存量。
 *
 * 🔴 判据只有一条:**平台名在那份显式的撤下名单里**(同样只在 parse 失败之后才问)。目标的平台是开放词表,
 * 拿连接那份闭集去反推的话,一条桥借来的 telegram bot 底下的目标只要有任何真实损坏就会被静默丢掉;而同样
 * 的损坏落在 onebot 目标上却是照旧报错。
 */
function isRetiredTargetRecord(raw: unknown): boolean {
	const record = raw as { platform?: unknown } | undefined;
	return typeof record?.platform === "string" && RETIRED_PLATFORMS.has(record.platform);
}

function keepConnection(raw: unknown): boolean {
	return ConnectionSchema.safeParse(raw).success || !isRetiredConnectionRecord(raw);
}

function keepTarget(raw: unknown): boolean {
	return PushTargetSchema.safeParse(raw).success || !isRetiredTargetRecord(raw);
}

// ── 新代里的两份文件 ──────────────────────────────────────────────────────────

export interface ConnectionFilesInput {
	/** 新代的 `config/`:`connections.json`、`targets.json` 已经从第 0 代搬了过来(硬链接)。 */
	configDir: string;
	/** 第 0 代的 `state/adapters.json`:`connections.json` 的旧名,只作输入。 */
	adaptersPath: string;
}

/**
 * 新代里连接与目标两份文件迁成最新的形状,回改写过的文件(绝对路径)。
 *
 * 只重写变了的,而且写的是**新文件**(原子换名):搬过来的那两份是指向第 0 代的硬链接,原地写会改到第 0 代。
 * 认不得的内容(不是 JSON、不是数组)原样留着,由配置仓开机时报出来 —— 那里的报错指得到是哪个文件、哪一行。
 */
export async function migrateConnectionFiles(input: ConnectionFilesInput): Promise<string[]> {
	const connectionsPath = join(input.configDir, "connections.json");
	const targetsPath = join(input.configDir, "targets.json");
	const rewritten: string[] = [];
	const write = async (path: string, value: unknown, modeFrom: string) => {
		await rewriteJsonFile(path, value, modeFrom);
		rewritten.push(path);
	};

	const targetsFile = await readJsonFile(targetsPath);
	const targets =
		targetsFile.kind === "ok" && Array.isArray(targetsFile.value) ? targetsFile.value : undefined;
	let connectionsFile = await readJsonFile(connectionsPath);
	const fromAdapters = connectionsFile.kind === "missing";
	if (fromAdapters) connectionsFile = await readJsonFile(input.adaptersPath);

	if (connectionsFile.kind === "missing") {
		if (targets && isLegacyTargetFile(targets)) {
			const split = migrateLegacyTargets(targets);
			// 两份都从那一个老文件里拆出来,连接参数(含 token)原先就住在它里面。
			await write(connectionsPath, split.connections, targetsPath);
			await write(targetsPath, split.targets, targetsPath);
		}
		return rewritten;
	}
	if (connectionsFile.kind === "unreadable" || !Array.isArray(connectionsFile.value)) {
		// 旧名那份坏了:新代里没有 connections.json,配置仓会说「connections.json 不见了」,而真正坏的是
		// 它 —— 所以在这里就把话说准。
		if (fromAdapters) throw new Error("第 0 代的 state/adapters.json 不是 JSON 数组,连接没法迁");
		return rewritten;
	}

	const migrated = migrateConfigSections({
		connections: connectionsFile.value,
		targets: targets ?? [],
	});
	const connections = migrated.connections.filter(keepConnection);
	if (
		fromAdapters ||
		migrated.changed.connections ||
		connections.length !== migrated.connections.length
	) {
		await write(connectionsPath, connections, fromAdapters ? input.adaptersPath : connectionsPath);
	}
	if (targets) {
		const kept = migrated.targets.filter(keepTarget);
		if (migrated.changed.targets || kept.length !== migrated.targets.length) {
			await write(targetsPath, kept, targetsPath);
		}
	}
	return rewritten;
}
