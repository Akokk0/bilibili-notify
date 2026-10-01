/**
 * 0.x 的推送历史老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)经迁移器进新代
 * (`migration/history.ts`,⑥c)。这些老行在搬家时一次改成现在的形状(`kind` / `messages[]` / `status` /
 * `targetId`),schema 与历史仓开机只认最新的形状、读时不再映射。
 *
 * 前两组用例原先钉在读时映射上(`packages/internal` 的 `schema/__tests__/history.test.ts`「老格式行」、
 * `history/__tests__/record.test.ts` 的「老格式读时映射」),读时映射删掉时抄到这里,**期望值一个没改**:只是摆数据
 * 的位置从「代目录里直接写一份老行」换成「第 0 代(`history/<日>.jsonl`)→ 迁移器 → 在新代上开真的历史仓读回来」。
 *
 * 末两条是迁移器自己的钉:新代里不留老形状(直接读新代的文件,不经历史仓);迁两遍和迁一遍一样。
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createHistoryStore, type HistoryStore } from "../../history/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { migrateHistoryFiles } from "../history.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-history-");

/** 在新代上开一次真的历史仓。 */
function openStore(): HistoryStore {
	return createHistoryStore({
		dataRoot: sandbox.target,
		bus: createNodeMessageBus(),
		logger: silentLogger,
	});
}

/** 迁一代,再在新代上开历史仓。 */
async function migrateAndOpen(): Promise<HistoryStore> {
	await sandbox.migrate();
	return openStore();
}

const SUB = randomUUID();
const T2 = randomUUID();

/** 往第 0 代摆一天的历史(`history/<日>.jsonl`,一行一条,末尾带换行)。 */
async function writeDay(date: string, lines: string[]): Promise<void> {
	await sandbox.placeZeroText(`history/${date}.jsonl`, `${lines.join("\n")}\n`);
}

describe("HistoryEntrySchema — 行的身份", () => {
	const BASE = {
		id: "11111111-1111-4111-8111-111111111111",
		ts: "2026-09-24T00:00:00.000Z",
		subscriptionId: "33333333-3333-4333-8333-333333333333",
		targetId: "44444444-4444-4444-8444-444444444444",
	} as const;

	it("老格式行(source / result / payload)照样读得进来,映射成 B 站行", async () => {
		await writeDay("2026-09-24", [
			JSON.stringify({
				id: BASE.id,
				ts: BASE.ts,
				source: "live-summary",
				uid: "u7",
				subscriptionId: BASE.subscriptionId,
				targetIds: [BASE.targetId],
				payload: { kind: "text", text: "词云" },
				result: { ok: true, per: [{ ok: true, latencyMs: 4 }] },
				unameSnapshot: "老UP",
			}),
		]);
		const [parsed] = await (await migrateAndOpen()).query({});
		expect(parsed).toMatchObject({
			pushId: BASE.id,
			kind: "live-end",
			uid: "u7",
			targetId: BASE.targetId,
			status: "delivered",
			unameSnapshot: "老UP",
		});
		expect(parsed?.extensionId).toBeUndefined();
		expect(parsed?.externalId).toBeUndefined();
	});
});

describe("老格式行(source / result / payload)→ 现在的行", () => {
	function legacy(over: Record<string, unknown>) {
		return JSON.stringify({
			id: randomUUID(),
			ts: "2026-05-10T01:00:00.000Z",
			source: "dynamic",
			uid: "u9",
			subscriptionId: SUB,
			targetIds: [T2],
			result: { ok: true, per: [{ targetId: T2, ok: true, latencyMs: 3 }] },
			payload: { kind: "text", text: "老的" },
			unameSnapshot: "老UP",
			...over,
		});
	}

	it("老行:source → kind、ok → status、首个目标 → targetId、payload → 单条 main 消息;pushId 借行 id", async () => {
		await writeDay("2026-05-10", [legacy({})]);
		const [e] = await (await migrateAndOpen()).query({});
		expect(e).toMatchObject({
			kind: "dynamic",
			status: "delivered",
			targetId: T2,
			uid: "u9",
			unameSnapshot: "老UP",
		});
		expect(e?.pushId).toBe(e?.id);
		expect(e?.messages).toEqual([
			{ payload: { kind: "text", text: "老的" }, role: "main", result: { ok: true, latencyMs: 3 } },
		]);
	});

	it.each<[string, string, boolean, string]>([
		["live", "live", true, "delivered"],
		["live-summary", "live-end", true, "delivered"],
		["sc", "sc", false, "failed"],
		["guard", "guard", true, "delivered"],
		["special-danmaku", "special-danmaku", true, "delivered"],
		["special-enter", "special-enter", true, "delivered"],
	])("老 source %s → kind %s", async (source, kind, ok, status) => {
		await writeDay("2026-05-10", [
			legacy({
				source,
				result: { ok, per: [{ targetId: T2, ok, latencyMs: 1, err: ok ? undefined : "x" }] },
			}),
		]);
		const [e] = await (await migrateAndOpen()).query({});
		expect(e?.kind).toBe(kind);
		expect(e?.status).toBe(status);
	});
});

describe("迁移器自己的钉", () => {
	const ROW_ID = "55555555-5555-4555-8555-555555555555";
	const DAY = "2026-05-10";

	/** 一行已经是现在形状的行(0.x 后期写的)、它的补丁行、一行坏行:迁移器一个字节不动。 */
	const NEW_ROW = JSON.stringify({
		id: ROW_ID,
		pushId: randomUUID(),
		ts: "2026-05-10T02:00:00.000Z",
		kind: "dynamic",
		uid: "u1",
		subscriptionId: SUB,
		targetId: T2,
		status: "delivered",
		messages: [
			{ payload: { kind: "text", text: "卡片" }, role: "main", result: { ok: true, latencyMs: 5 } },
		],
		unameSnapshot: "某UP",
	});
	const PATCH_LINE = JSON.stringify({
		patch: ROW_ID,
		status: "partial",
		messages: [
			{
				payload: { kind: "text", text: "词云" },
				role: "extra",
				result: { ok: false, latencyMs: 7, err: "boom" },
			},
		],
	});
	const BAD_LINE = '{"id":"断在这里';

	const OLD_SOURCES = [
		"dynamic",
		"live",
		"sc",
		"guard",
		"special-danmaku",
		"special-enter",
		"live-summary",
	];

	function legacyRow(source: string): string {
		return JSON.stringify({
			id: randomUUID(),
			ts: "2026-05-10T01:00:00.000Z",
			source,
			uid: "u9",
			subscriptionId: SUB,
			targetIds: [T2],
			result: { ok: true, per: [{ targetId: T2, ok: true, latencyMs: 3 }] },
			payload: { kind: "text", text: `老的 ${source}` },
			unameSnapshot: "老UP",
		});
	}

	async function placeMixedDay(): Promise<string[]> {
		const lines = [...OLD_SOURCES.map(legacyRow), NEW_ROW, PATCH_LINE, BAD_LINE];
		await writeDay(DAY, lines);
		return lines;
	}

	const dayPath = () => join(sandbox.target, "history", `${DAY}.jsonl`);

	it("新代里不留老形状:每一行没有 source / payload / result / targetIds、都有 kind;新行、补丁行、坏行原样", async () => {
		const placed = await placeMixedDay();
		await sandbox.migrate();

		const lines = (await readFile(dayPath(), "utf8")).split("\n");
		expect(lines.at(-1)).toBe("");
		const kept = lines.slice(0, -1);
		expect(kept).toHaveLength(placed.length);

		const oldRows = kept.slice(0, OLD_SOURCES.length);
		for (const line of oldRows) {
			const row = JSON.parse(line) as Record<string, unknown>;
			expect(row).not.toHaveProperty("source");
			expect(row).not.toHaveProperty("payload");
			expect(row).not.toHaveProperty("result");
			expect(row).not.toHaveProperty("targetIds");
			expect(row).toHaveProperty("kind");
			expect(row).toHaveProperty("messages");
		}
		// 七种老 source 各自落成对应的现在的种类(`live-summary` 归到下播)。
		expect(oldRows.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
			"dynamic",
			"live",
			"sc",
			"guard",
			"special-danmaku",
			"special-enter",
			"live-end",
		]);
		// 不是老行的一个字节不动。
		expect(kept.slice(OLD_SOURCES.length)).toEqual([NEW_ROW, PATCH_LINE, BAD_LINE]);
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],文件字节不变", async () => {
		await placeMixedDay();
		const report = await sandbox.migrate();
		expect(report.rewritten).toContain(`history/${DAY}.jsonl`);

		const snapshot = async () =>
			Promise.all(
				(await readdir(join(sandbox.target, "history")))
					.sort()
					.map(async (name) => [
						name,
						await readFile(join(sandbox.target, "history", name), "utf8"),
					]),
			);
		const before = await snapshot();
		expect(before).toHaveLength(1);

		expect(await migrateHistoryFiles(sandbox.target)).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});
});
