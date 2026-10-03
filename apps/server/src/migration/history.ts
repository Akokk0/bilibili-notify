/**
 * 推送历史 `history/<日>.jsonl`:0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)
 * → 现在的行(`feature` / `messages[]` / `status` / `targetId`)。一项一项收进来(⑥c);从前是 schema 读时映射、
 * 盘上不重写,历史仓开机只认最新的形状。补丁行、已经是现在形状的行、坏行一个字节不动。
 *
 * 行级的变换都在 {@link migrateHistoryLine} 一个函数里、**一趟读写**:老 `source` 先翻成 0.x 的推送种类,
 * 再把推送种类那一格 `kind`(0.x 的八种名字)换成 `feature`(特性键,⑬f)。⑱ 要往行里再加别的字段、⑳ 要换跟图有关的格,也都加在
 * 这个函数里,历史不会多迁一次。
 */

import { join } from "node:path";
import type { FeatureKey } from "@bilibili-notify/internal";
import { isPatchLine, listDayFiles } from "../history/store.js";
import { dataPath } from "../runtime/roots.js";
import { isPlainObject, parseJsonLine, rewriteJsonlFile } from "./files.js";
import type { ZeroPushKind } from "./zero-vocabulary.js";

/**
 * `live` 只当开播(老格式分不出周期复推),`live-summary`(词云 / 总结)归到下播。pushId 借行 id —— 老行本来
 * 就一行一次推送。
 */
const LEGACY_SOURCE_TO_KIND: Record<string, ZeroPushKind> = {
	dynamic: "dynamic",
	live: "live",
	sc: "sc",
	guard: "guard",
	"special-danmaku": "special-danmaku",
	"special-enter": "special-enter",
	"live-summary": "live-end",
};

/**
 * 0.x 的推送种类 → 特性键(⑬f)。一一对应:周期「正在直播」(`live-ongoing`)是 `liveStreaming`,开播(`live`)是
 * `liveStart`(0.x 的历史分不出补报与开播,迁过来都当开播)。`satisfies` 钉着 0.x 的种类一个不漏、值都是活的特性键。
 */
const ZERO_PUSH_KIND_TO_FEATURE = {
	dynamic: "post",
	live: "liveStart",
	"live-ongoing": "liveStreaming",
	"live-end": "liveEnd",
	guard: "membership",
	sc: "superchat",
	"special-danmaku": "specialDanmaku",
	"special-enter": "specialUserEnter",
} satisfies Record<ZeroPushKind, FeatureKey>;

/** 一行老历史 → 新形状(推送种类那一格还叫 `kind`);不是老行的原样回(同一个对象)。 */
export function migrateLegacyHistoryEntry(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const r = raw as Record<string, unknown>;
	if (!("source" in r) || "kind" in r) return raw;
	const result = r.result as { ok?: unknown; per?: unknown[] } | undefined;
	const per = result?.per?.[0] as { ok?: unknown; latencyMs?: unknown; err?: unknown } | undefined;
	const targetIds = Array.isArray(r.targetIds) ? r.targetIds : [];
	return {
		id: r.id,
		pushId: r.id,
		ts: r.ts,
		kind: LEGACY_SOURCE_TO_KIND[String(r.source)] ?? r.source,
		uid: r.uid,
		subscriptionId: r.subscriptionId,
		targetId: targetIds[0] ?? null,
		status: result?.ok === true ? "delivered" : "failed",
		messages: [
			{
				payload: r.payload,
				role: "main",
				result: per ? { ok: per.ok, latencyMs: per.latencyMs, err: per.err } : undefined,
			},
		],
		unameSnapshot: r.unameSnapshot,
		uavatarSnapshot: r.uavatarSnapshot,
	};
}

/**
 * 推送种类那一格 `kind`(0.x 的八种名字)→ `feature`(特性键),**键留在原来的位置**、别的格一个字不动。
 * 已经有 `feature` 的行、`kind` 不是那八种之一的行(历史仓照旧当坏行跳过)原样回(同一个对象)。
 */
function migrateKindToFeature(raw: unknown): unknown {
	if (!isPlainObject(raw) || "feature" in raw) return raw;
	const kind = raw.kind;
	if (typeof kind !== "string" || !Object.hasOwn(ZERO_PUSH_KIND_TO_FEATURE, kind)) return raw;
	const feature = ZERO_PUSH_KIND_TO_FEATURE[kind as ZeroPushKind];
	return Object.fromEntries(
		Object.entries(raw).map(([key, value]) =>
			key === "kind" ? ["feature", feature] : [key, value],
		),
	);
}

/**
 * 一行历史(jsonl 的一行原文)迁成最新形状:老 `source` → 0.x 的推送种类 → `feature`。
 * 补丁行照历史仓的认法跳过(它从来不过老行的映射);没变的行回原文(一个字节不动)。
 */
export function migrateHistoryLine(line: string): string {
	if (isPatchLine(line)) return line;
	const row = parseJsonLine(line);
	const next = migrateKindToFeature(migrateLegacyHistoryEntry(row));
	return next === row ? line : JSON.stringify(next);
}

/** 新代里每个日文件迁成最新的形状,回改写过的文件(绝对路径)。 */
export async function migrateHistoryFiles(dataRoot: string): Promise<string[]> {
	const root = dataPath(dataRoot, "history");
	const rewritten: string[] = [];
	for (const name of (await listDayFiles(dataRoot)).sort()) {
		const path = join(root, name);
		if (await rewriteJsonlFile(path, (lines) => lines.map(migrateHistoryLine))) {
			rewritten.push(path);
		}
	}
	return rewritten;
}
