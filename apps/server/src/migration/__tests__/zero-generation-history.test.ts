/**
 * 0.x 的推送历史老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)经迁移器进新代
 * (`migration/history.ts`,⑥c)。这些老行在搬家时一次改成现在的形状(`feature` / `messages[]` / `status` /
 * `targetId`),schema 与历史仓开机只认最新的形状、读时不再映射。
 *
 * ⑬f:推送种类那一格从 0.x 的 `kind`(八种推送种类名)改成 `feature`(特性键),和老 `source` 翻成种类**同一趟**读写。
 * 期望值一律写字面量 —— 对照表是迁移自己的,拿它推期望等于没测。
 *
 * 前两组用例原先钉在读时映射上(`packages/internal` 的 `schema/__tests__/history.test.ts`「老格式行」、
 * `history/__tests__/record.test.ts` 的「老格式读时映射」),读时映射删掉时抄到这里,**期望值一个没改**:只是摆数据
 * 的位置从「代目录里直接写一份老行」换成「第 0 代(`history/<日>.jsonl`)→ 迁移器 → 在新代上开真的历史仓读回来」。
 *
 * 末几条是迁移器自己的钉:新代里不留老形状(直接读新代的文件,不经历史仓);0.x 的八种推送种类各一行都落成对应的特性键;
 * 已经是 `feature` 的行与认不得的行一个字节不动;迁两遍和迁一遍一样。
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
			feature: "liveEnd",
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

	it("老行:source → feature、ok → status、首个目标 → targetId、payload → 单条 main 消息;pushId 借行 id", async () => {
		await writeDay("2026-05-10", [legacy({})]);
		const [e] = await (await migrateAndOpen()).query({});
		expect(e).toMatchObject({
			feature: "post",
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
		["live", "liveStart", true, "delivered"],
		["live-summary", "liveEnd", true, "delivered"],
		["sc", "superchat", false, "failed"],
		["guard", "membership", true, "delivered"],
		["special-danmaku", "specialDanmaku", true, "delivered"],
		["special-enter", "specialUserEnter", true, "delivered"],
	])("老 source %s → feature %s", async (source, feature, ok, status) => {
		await writeDay("2026-05-10", [
			legacy({
				source,
				result: { ok, per: [{ targetId: T2, ok, latencyMs: 1, err: ok ? undefined : "x" }] },
			}),
		]);
		const [e] = await (await migrateAndOpen()).query({});
		expect(e?.feature).toBe(feature);
		expect(e?.status).toBe(status);
	});
});

describe("迁移器自己的钉", () => {
	const ROW_ID = "55555555-5555-4555-8555-555555555555";
	const DAY = "2026-05-10";

	/** 0.x 后期写的行(一行一次推送、已经有 `messages[]`,推送种类那一格还叫 `kind`)。 */
	const ZERO_ROW_OBJECT = {
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
	};
	const ZERO_ROW = JSON.stringify(ZERO_ROW_OBJECT);
	/** 已经是现在形状的行(推送种类那一格叫 `feature`)、它的补丁行、一行坏行:迁移器一个字节不动。 */
	const CURRENT_ROW = JSON.stringify({
		...ZERO_ROW_OBJECT,
		id: randomUUID(),
		kind: undefined,
		feature: "liveStreaming",
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
		const lines = [...OLD_SOURCES.map(legacyRow), ZERO_ROW, CURRENT_ROW, PATCH_LINE, BAD_LINE];
		await writeDay(DAY, lines);
		return lines;
	}

	const dayPath = () => join(sandbox.target, "history", `${DAY}.jsonl`);

	it("新代里不留老形状:每一行没有 source / payload / result / targetIds / kind、都有 feature;现在形状的行、补丁行、坏行原样", async () => {
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
			expect(row).not.toHaveProperty("kind");
			expect(row).toHaveProperty("feature");
			expect(row).toHaveProperty("messages");
		}
		// 七种老 source 各自落成对应的特性键(`live-summary` 归到下播,`live` 只当开播)。
		expect(oldRows.map((line) => (JSON.parse(line) as { feature: string }).feature)).toEqual([
			"post",
			"liveStart",
			"superchat",
			"membership",
			"specialDanmaku",
			"specialUserEnter",
			"liveEnd",
		]);
		// 0.x 后期形状的行:`kind` 换成 `feature`,别的一个字也不动(键的位置也留着)。
		const migrated = JSON.parse(kept[OLD_SOURCES.length] ?? "") as Record<string, unknown>;
		expect(migrated).toEqual({ ...ZERO_ROW_OBJECT, kind: undefined, feature: "post" });
		expect(Object.keys(migrated)).toEqual(
			Object.keys(ZERO_ROW_OBJECT).map((key) => (key === "kind" ? "feature" : key)),
		);
		// 已经是现在形状的行、补丁行、坏行一个字节不动。
		expect(kept.slice(OLD_SOURCES.length + 1)).toEqual([CURRENT_ROW, PATCH_LINE, BAD_LINE]);
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

	/** 0.x 后期形状(`kind` 是八种推送种类名之一)的行,每种一行;期望的特性键写字面量。 */
	it.each<[kind: string, feature: string]>([
		["dynamic", "post"],
		["live", "liveStart"],
		["live-ongoing", "liveStreaming"],
		["live-end", "liveEnd"],
		["guard", "membership"],
		["sc", "superchat"],
		["special-danmaku", "specialDanmaku"],
		["special-enter", "specialUserEnter"],
	])("0.x 的推送种类 %s → feature %s,`kind` 不留", async (kind, feature) => {
		await writeDay(DAY, [JSON.stringify({ ...ZERO_ROW_OBJECT, kind })]);
		await sandbox.migrate();
		const [line] = (await readFile(dayPath(), "utf8")).split("\n");
		const row = JSON.parse(line ?? "") as Record<string, unknown>;
		expect(row.feature).toBe(feature);
		expect(row).not.toHaveProperty("kind");
	});

	it("八种推送种类一次覆盖到八把特性键,没有两种落到同一把", async () => {
		const kinds = [
			"dynamic",
			"live",
			"live-ongoing",
			"live-end",
			"guard",
			"sc",
			"special-danmaku",
			"special-enter",
		];
		await writeDay(
			DAY,
			kinds.map((kind) => JSON.stringify({ ...ZERO_ROW_OBJECT, id: randomUUID(), kind })),
		);
		await sandbox.migrate();
		const features = (await readFile(dayPath(), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { feature: string }).feature);
		expect([...features].sort()).toEqual(
			[
				"liveEnd",
				"liveStart",
				"liveStreaming",
				"membership",
				"post",
				"specialDanmaku",
				"specialUserEnter",
				"superchat",
			].sort(),
		);
	});

	it("认不得的 kind(不是八种之一)与已经带 feature 的行:一个字节不动,留给历史仓照旧当坏行跳过", async () => {
		const stranger = JSON.stringify({ ...ZERO_ROW_OBJECT, id: randomUUID(), kind: "mystery" });
		const both = JSON.stringify({ ...ZERO_ROW_OBJECT, id: randomUUID(), feature: "liveEnd" });
		await writeDay(DAY, [stranger, both]);
		await sandbox.migrate();
		expect((await readFile(dayPath(), "utf8")).split("\n").slice(0, 2)).toEqual([stranger, both]);
	});
});
