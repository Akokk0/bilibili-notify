/**
 * 推送历史 `history/<日>.jsonl`:0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)
 * → 现在的行(`kind` / `messages[]` / `status` / `targetId`)。一项一项收进来(⑥c);从前是 schema 读时映射、
 * 盘上不重写,历史仓开机只认最新的形状。补丁行、新行、坏行一个字节不动。
 */

import { join } from "node:path";
import type { PushKind } from "@bilibili-notify/internal";
import { isPatchLine, listDayFiles } from "../history/store.js";
import { dataPath } from "../runtime/roots.js";
import { parseJsonLine, rewriteJsonlFile } from "./files.js";

/**
 * `live` 只当开播(老格式分不出周期复推),`live-summary`(词云 / 总结)归到下播。pushId 借行 id —— 老行本来
 * 就一行一次推送。
 */
const LEGACY_SOURCE_TO_KIND: Record<string, PushKind> = {
	dynamic: "dynamic",
	live: "live",
	sc: "sc",
	guard: "guard",
	"special-danmaku": "special-danmaku",
	"special-enter": "special-enter",
	"live-summary": "live-end",
};

/** 一行老历史 → 新形状;不是老行的原样回(同一个对象)。 */
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

/** 补丁行照历史仓的认法跳过(它从来不过老行的映射)。 */
function migrateHistoryLine(line: string): string {
	if (isPatchLine(line)) return line;
	const row = parseJsonLine(line);
	const next = migrateLegacyHistoryEntry(row);
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
