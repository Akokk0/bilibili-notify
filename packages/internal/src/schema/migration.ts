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
 * - `1` —— 连接以 `platform` 为判别子,「怎么连」藏在 OneBot config 的 `transport` 里。
 * - `2` —— 连接长出 `kind` + `connector` 两个字段,「怎么连」成为独立的一根轴。
 */
export const CONFIG_SCHEMA_VERSION = 2;

/** 迁移的输入 / 输出:raw JSON,还没过 schema。 */
export interface RawConfigSections {
	connections?: readonly unknown[];
	targets?: readonly unknown[];
}

export interface MigratedConfigSections {
	connections: unknown[];
	targets: unknown[];
	/** 有任何一条被改写过。调用方据此决定要不要回写磁盘。 */
	changed: boolean;
	/** 迁移前探到的形状版本。 */
	from: number;
}

const CONNECTOR_SET = new Set<string>(DIRECT_CONNECTORS);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 一条连接已经是新形状？只认 `connector` —— `kind` 只有一档,单看它区分不出来。 */
function hasConnector(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.connector === "string";
}

/**
 * 探测一批连接的形状版本。
 *
 * 空表算**当前版本** —— 全新安装没有待迁移的东西，不该被拖去走一遍迁移再回写。
 * 混着的算**老版本**：上一次迁移写到一半掉电就是这个样子，必须再走一遍（迁移幂等，重走无害）。
 */
export function detectConfigVersion(connections: readonly unknown[]): number {
	if (connections.length === 0) return CONFIG_SCHEMA_VERSION;
	return connections.every(hasConnector) ? CONFIG_SCHEMA_VERSION : 1;
}

/** v1 → v2:把「怎么连」从 config 里提上来,成为连接自己的一根轴。 */
function toV2(entry: unknown): { next: unknown; changed: boolean } {
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

/** 把 raw 配置抬到 {@link CONFIG_SCHEMA_VERSION}。幂等。 */
export function migrateConfigSections(input: RawConfigSections): MigratedConfigSections {
	const connections = [...(input.connections ?? [])];
	const targets = [...(input.targets ?? [])];
	const from = detectConfigVersion(connections);

	let changed = false;
	const nextConnections = connections.map((entry) => {
		const r = toV2(entry);
		if (r.changed) changed = true;
		return r.next;
	});

	return { connections: nextConnections, targets, changed, from };
}
