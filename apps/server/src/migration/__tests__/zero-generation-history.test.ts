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
 * 已经是现在形状的行与认不得的行一个字节不动;迁两遍和迁一遍一样。
 *
 * ⑳d:跟图有关的格(`imageRef` → `image`、`uavatarSnapshot` 丢掉、原件里的 `{ ref, mime, own? }` → 引用)读盘、进图库,
 * 细节在 `zero-generation-history-images.test.ts`;这里只钉它们没有破坏行级的形状改写。
 *
 * ⑱b:行里的格原地改名(`ts` → `createdAt`、`uid` / `extensionId` + `externalId` → `identity`、`unameSnapshot` →
 * `nameSnapshot`、消息的 `retryOf` → `repushOf`),补丁行的 `patch` → `rowId`(头一回改写补丁行)。和 `kind` → `feature`
 * 在 `migrateHistoryLine` 里同一趟读写,键都留在原来的位置。
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createHistoryStore, type HistoryStore } from "../../history/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { migrateHistoryDayFiles, migrateRepushSnapshotFiles } from "../history.js";
import { createHistoryImages } from "../history-images.js";
import { useZeroSandbox } from "./support.js";
import { makeZeroGlobals } from "./zero-fixtures.js";

const sandbox = useZeroSandbox("bn-zero-history-");

/** 在新代上开一次真的历史仓。 */
function openStore(): HistoryStore {
	return createHistoryStore({
		dataRoot: sandbox.target,
		bus: createNodeMessageBus(),
		logger: silentLogger,
		images: makeHistoryImages(sandbox.target).historyImages,
	});
}

/**
 * 对已经迁好的新代再跑一遍日文件与原件的改写(第 0 代的历史目录不存在,水位线给最早的一天:什么图都读不到、什么都不该变)。
 * 回改写过的文件;幂等就是回 `[]`。
 */
async function rerunMigrators(): Promise<string[]> {
	const images = createHistoryImages({
		zeroDir: join(sandbox.zero, "history"),
		imagesDir: join(sandbox.target, "images"),
		clearedThrough: undefined,
	});
	return [
		...(await migrateHistoryDayFiles(sandbox.target, images)),
		...(await migrateRepushSnapshotFiles(sandbox.target, images)).rewritten,
	];
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
			createdAt: BASE.ts,
			feature: "liveEnd",
			identity: { sourceKey: "bilibili", externalId: "u7" },
			targetId: BASE.targetId,
			status: "delivered",
			nameSnapshot: "老UP",
		});
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
			identity: { sourceKey: "bilibili", externalId: "u9" },
			nameSnapshot: "老UP",
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
	/** ⑬f 之后、⑱b 之前写的行:已经是 `feature`,格还是旧名(含一条重投消息和头像快照)。 */
	const PRE_RENAME_ROW_OBJECT = {
		id: randomUUID(),
		pushId: randomUUID(),
		ts: "2026-05-10T03:00:00.000Z",
		feature: "liveStart",
		uid: "u2",
		subscriptionId: SUB,
		targetId: T2,
		status: "partial",
		messages: [
			{
				payload: { kind: "text", text: "开播" },
				role: "main",
				result: { ok: false, latencyMs: 9 },
			},
			{
				payload: { kind: "text", text: "开播" },
				role: "main",
				result: { ok: true, latencyMs: 4 },
				retryOf: 0,
			},
		],
		unameSnapshot: "另一位UP",
		uavatarSnapshot: "https://i0.hdslb.com/bfs/face/x.jpg",
	};
	/** 拓展行(只在 dev-next 上有):拓展 id + 外部 id,不带 `uid`、没有头像快照。 */
	const PRE_RENAME_EXTENSION_ROW_OBJECT = {
		id: randomUUID(),
		pushId: randomUUID(),
		ts: "2026-05-10T04:00:00.000Z",
		feature: "post",
		extensionId: "douyin",
		externalId: "sec-123",
		subscriptionId: SUB,
		targetId: T2,
		status: "delivered",
		messages: [{ payload: { kind: "text", text: "作品" }, role: "main" }],
		unameSnapshot: "某抖音号",
	};
	/** 已经是现在形状的行(推送种类叫 `feature`、身份是 `identity`)、它的补丁行、一行坏行:迁移器一个字节不动。 */
	const CURRENT_ROW = JSON.stringify({
		id: randomUUID(),
		pushId: randomUUID(),
		createdAt: "2026-05-10T05:00:00.000Z",
		feature: "liveStreaming",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: T2,
		status: "delivered",
		messages: [
			{ payload: { kind: "text", text: "卡片" }, role: "main", result: { ok: true, latencyMs: 5 } },
		],
		nameSnapshot: "某UP",
	});
	/** 老补丁行:`patch` 打头,带一条重投消息。 */
	const PATCH_LINE = JSON.stringify({
		patch: ROW_ID,
		status: "partial",
		messages: [
			{
				payload: { kind: "text", text: "词云" },
				role: "extra",
				result: { ok: false, latencyMs: 7, err: "boom" },
				retryOf: 1,
			},
		],
	});
	/** 现在形状的补丁行:`rowId` 打头。 */
	const CURRENT_PATCH_LINE = JSON.stringify({
		rowId: ROW_ID,
		status: "delivered",
		messages: [
			{
				payload: { kind: "text", text: "词云" },
				role: "extra",
				result: { ok: true, latencyMs: 3 },
				repushOf: 1,
			},
		],
	});
	const BAD_LINE = '{"id":"断在这里';
	/**
	 * 推不出「替谁发的」的行:拓展行少了外部 id(哪怕还带着一格 `uid`,拓展那两格有一格就只按拓展那一支认、
	 * 不退去按 `uid` 认);以及两种身份都没有。当坏行原样留着,别的格也不翻。
	 */
	const NO_IDENTITY_LINES = [
		JSON.stringify({
			...PRE_RENAME_EXTENSION_ROW_OBJECT,
			id: randomUUID(),
			externalId: undefined,
			uid: "u3",
		}),
		JSON.stringify({ ...PRE_RENAME_ROW_OBJECT, id: randomUUID(), uid: undefined }),
	];

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
		const lines = [
			...OLD_SOURCES.map(legacyRow),
			ZERO_ROW,
			JSON.stringify(PRE_RENAME_ROW_OBJECT),
			JSON.stringify(PRE_RENAME_EXTENSION_ROW_OBJECT),
			CURRENT_ROW,
			PATCH_LINE,
			CURRENT_PATCH_LINE,
			BAD_LINE,
			...NO_IDENTITY_LINES,
		];
		await writeDay(DAY, lines);
		return lines;
	}

	const dayPath = () => join(sandbox.target, "history", `${DAY}.jsonl`);

	it("新代里不留老形状:每一行没有 source / payload / result / targetIds / kind / ts / uid、都有 feature 与 identity;现在形状的行、补丁行、坏行原样", async () => {
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
			expect(row).not.toHaveProperty("ts");
			expect(row).not.toHaveProperty("uid");
			expect(row).toHaveProperty("feature");
			expect(row).toHaveProperty("identity");
			expect(row).toHaveProperty("createdAt");
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
		// 0.x 后期形状的行:`kind` 换成 `feature`、别的格也换成现在的名字,键都留在原来的位置。
		const migrated = kept[OLD_SOURCES.length] ?? "";
		expect(JSON.parse(migrated)).toEqual({
			id: ROW_ID,
			pushId: ZERO_ROW_OBJECT.pushId,
			createdAt: "2026-05-10T02:00:00.000Z",
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T2,
			status: "delivered",
			messages: ZERO_ROW_OBJECT.messages,
			nameSnapshot: "某UP",
		});
		expect(Object.keys(JSON.parse(migrated) as object)).toEqual([
			"id",
			"pushId",
			"createdAt",
			"feature",
			"identity",
			"subscriptionId",
			"targetId",
			"status",
			"messages",
			"nameSnapshot",
		]);
		// 现在形状的行、现在形状的补丁行、坏行、推不出身份的行一个字节不动;老补丁行被改写(下面有专门的钉)。
		const [, , currentRow, migratedPatch, ...untouched] = kept.slice(OLD_SOURCES.length + 1);
		expect(currentRow).toBe(CURRENT_ROW);
		expect(migratedPatch?.startsWith('{"rowId":')).toBe(true);
		expect(untouched).toEqual([CURRENT_PATCH_LINE, BAD_LINE, ...NO_IDENTITY_LINES]);
	});

	it("⑱b:⑬f 之后写的行(已经是 feature、格还是旧名)原地改名,键留在原位;消息里别的格不动,B 站远端头像网址丢掉(⑳d)", async () => {
		await writeDay(DAY, [JSON.stringify(PRE_RENAME_ROW_OBJECT)]);
		await sandbox.migrate();
		const [line] = (await readFile(dayPath(), "utf8")).split("\n");
		const row = JSON.parse(line ?? "") as Record<string, unknown>;
		expect(Object.keys(row)).toEqual([
			"id",
			"pushId",
			"createdAt",
			"feature",
			"identity",
			"subscriptionId",
			"targetId",
			"status",
			"messages",
			"nameSnapshot",
		]);
		expect(row).toMatchObject({
			createdAt: "2026-05-10T03:00:00.000Z",
			identity: { sourceKey: "bilibili", externalId: "u2" },
			nameSnapshot: "另一位UP",
		});
		expect(row).not.toHaveProperty("uavatarSnapshot");
		const messages = row.messages as Record<string, unknown>[];
		// 老失败没带原话:`unknown` + 一句固定的话(3a-15);消息里别的格、键的位置不动。
		expect(messages[0]).toEqual({
			payload: { kind: "text", text: "开播" },
			role: "main",
			result: { ok: false, code: "unknown", message: "没有送达，对端没说原因" },
		});
		expect(Object.keys(messages[0] ?? {})).toEqual(["payload", "role", "result"]);
		// 重投那一条:`retryOf` → `repushOf`,在消息里原来的位置。
		expect(messages[1]).toEqual({
			payload: { kind: "text", text: "开播" },
			role: "main",
			result: { ok: true, latencyMs: 4 },
			repushOf: 0,
		});
		expect(Object.keys(messages[1] ?? {})).toEqual(["payload", "role", "result", "repushOf"]);
	});

	it("⑱b:拓展行的 extensionId + externalId 并成一格 identity(来源键 = 拓展 id),落在 extensionId 的位置上,没有头像快照", async () => {
		await writeDay(DAY, [JSON.stringify(PRE_RENAME_EXTENSION_ROW_OBJECT)]);
		await sandbox.migrate();
		const [line] = (await readFile(dayPath(), "utf8")).split("\n");
		const row = JSON.parse(line ?? "") as Record<string, unknown>;
		expect(row).not.toHaveProperty("extensionId");
		expect(row).not.toHaveProperty("externalId");
		expect(row.identity).toEqual({ sourceKey: "douyin", externalId: "sec-123" });
		expect(Object.keys(row)).toEqual([
			"id",
			"pushId",
			"createdAt",
			"feature",
			"identity",
			"subscriptionId",
			"targetId",
			"status",
			"messages",
			"nameSnapshot",
		]);
	});

	it("⑱b:老补丁行的 `patch` → `rowId`、仍是第一个键(行首认得出),消息的 retryOf → repushOf;现在形状的补丁行原样", async () => {
		await writeDay(DAY, [PATCH_LINE, CURRENT_PATCH_LINE]);
		await sandbox.migrate();
		const [first, second] = (await readFile(dayPath(), "utf8")).split("\n");
		expect(first?.startsWith('{"rowId":')).toBe(true);
		expect(JSON.parse(first ?? "")).toEqual({
			rowId: ROW_ID,
			status: "partial",
			messages: [
				{
					payload: { kind: "text", text: "词云" },
					role: "extra",
					// 老失败 → `unknown` + 原话,不带耗时(3a-15)。
					result: { ok: false, code: "unknown", message: "boom" },
					repushOf: 1,
				},
			],
		});
		expect(Object.keys(JSON.parse(first ?? "") as object)).toEqual(["rowId", "status", "messages"]);
		expect(second).toBe(CURRENT_PATCH_LINE);
	});

	it("⑱b:推不出「替谁发的」的行(拓展行缺外部 id、两种身份都没有)是坏行,整行原样 —— 连 ts 与 retryOf 也不翻", async () => {
		await writeDay(DAY, NO_IDENTITY_LINES);
		const report = await sandbox.migrate();
		expect((await readFile(dayPath(), "utf8")).split("\n").slice(0, 2)).toEqual(NO_IDENTITY_LINES);
		expect(report.rewritten).not.toContain(`history/${DAY}.jsonl`);
	});

	it("⑱b:已经有 identity 的行以它为准、整行原样 —— 哪怕还带着一格没清掉的 uid / ts", async () => {
		const both = JSON.stringify({
			...JSON.parse(CURRENT_ROW),
			id: randomUUID(),
			uid: "stale",
			ts: "2000-01-01T00:00:00.000Z",
		});
		await writeDay(DAY, [both]);
		const report = await sandbox.migrate();
		expect((await readFile(dayPath(), "utf8")).split("\n")[0]).toBe(both);
		expect(report.rewritten).not.toContain(`history/${DAY}.jsonl`);
	});

	/**
	 * 3a-15:投递结果落盘改成结果形状(ADR-0026 决策 5)。老失败 `{ ok: false, latencyMs, err? }` →
	 * `{ ok: false, code: "unknown", message: 原话 }`,不按原话猜标准码;送达的那一格一个字节不动。
	 */
	describe("老失败 → unknown + 原话", () => {
		const oldFailure = (err?: string) => ({ ok: false, latencyMs: 7, ...(err ? { err } : {}) });
		const resultsOf = (line: string | undefined): unknown[] =>
			(JSON.parse(line ?? "") as { messages: { result?: unknown }[] }).messages.map(
				(m) => m.result,
			);
		const migratedLines = async () => (await readFile(dayPath(), "utf8")).split("\n").slice(0, -1);

		it("0.x 后期的行:失败带原话的抄原话、没带的填固定那句,耗时不留;同一行里送达的那一格字节不变", async () => {
			const row = {
				...ZERO_ROW_OBJECT,
				status: "partial",
				messages: [
					{
						payload: { kind: "text", text: "卡片" },
						role: "main",
						result: { ok: true, latencyMs: 5 },
					},
					{ payload: { kind: "text", text: "词云" }, role: "extra", result: oldFailure("boom") },
					{ payload: { kind: "text", text: "总结" }, role: "extra", result: oldFailure() },
					{ payload: { kind: "text", text: "没发的" }, role: "extra" },
				],
			};
			await writeDay(DAY, [JSON.stringify(row)]);
			await sandbox.migrate();
			const [line] = await migratedLines();
			expect(resultsOf(line).map((r) => JSON.stringify(r))).toEqual([
				'{"ok":true,"latencyMs":5}',
				'{"ok":false,"code":"unknown","message":"boom"}',
				'{"ok":false,"code":"unknown","message":"没有送达，对端没说原因"}',
				undefined,
			]);
			// 迁完的行历史仓读得进来(老失败的形状它不认)。
			const [entry] = await openStore().query({});
			expect(entry?.status).toBe("partial");
			expect(entry?.messages[1]?.result).toEqual({ ok: false, code: "unknown", message: "boom" });
		});

		it("不按原话猜码:原话里写着超时、401、限流,也都是 unknown", async () => {
			const row = {
				...ZERO_ROW_OBJECT,
				status: "failed",
				messages: [
					"ws action 响应超时 (15000ms)",
					"HTTP 401 Unauthorized",
					"被限流了 rate limit",
				].map((err) => ({
					payload: { kind: "text", text: "x" },
					role: "main",
					result: oldFailure(err),
				})),
			};
			await writeDay(DAY, [JSON.stringify(row)]);
			await sandbox.migrate();
			const [line] = await migratedLines();
			expect(resultsOf(line)).toEqual([
				{ ok: false, code: "unknown", message: "ws action 响应超时 (15000ms)" },
				{ ok: false, code: "unknown", message: "HTTP 401 Unauthorized" },
				{ ok: false, code: "unknown", message: "被限流了 rate limit" },
			]);
		});

		it("0.x 更老的行(`result.per[0]`):失败同样落成 unknown + 原话;送达的照旧", async () => {
			const legacy = (ok: boolean, err?: string) =>
				JSON.stringify({
					id: randomUUID(),
					ts: "2026-05-10T01:00:00.000Z",
					source: "dynamic",
					uid: "u9",
					subscriptionId: SUB,
					targetIds: [T2],
					result: { ok, per: [{ targetId: T2, ok, latencyMs: 3, ...(err ? { err } : {}) }] },
					payload: { kind: "text", text: "老的" },
				});
			await writeDay(DAY, [legacy(false, "kicked"), legacy(false), legacy(true)]);
			await sandbox.migrate();
			const lines = await migratedLines();
			expect(lines.map((line) => JSON.stringify(resultsOf(line)[0]))).toEqual([
				'{"ok":false,"code":"unknown","message":"kicked"}',
				'{"ok":false,"code":"unknown","message":"没有送达，对端没说原因"}',
				'{"ok":true,"latencyMs":3}',
			]);
			expect((await openStore().query({})).map((e) => e.status).sort()).toEqual([
				"delivered",
				"failed",
				"failed",
			]);
		});

		it("🔴 已经是现在形状的行(带 identity)与补丁行(rowId 打头)里的老失败也要改:不被「现形状原样回」跳过;键的位置不动", async () => {
			const row = JSON.stringify({
				...JSON.parse(CURRENT_ROW),
				status: "failed",
				messages: [
					{ payload: { kind: "text", text: "卡片" }, role: "main", result: oldFailure("boom") },
				],
			});
			const patch = JSON.stringify({
				rowId: ROW_ID,
				status: "partial",
				messages: [
					{
						payload: { kind: "text", text: "词云" },
						role: "extra",
						result: oldFailure(),
						repushOf: 1,
					},
				],
			});
			await writeDay(DAY, [row, patch]);
			const report = await sandbox.migrate();
			expect(report.rewritten).toContain(`history/${DAY}.jsonl`);
			const [migratedRow, migratedPatch] = await migratedLines();
			expect(resultsOf(migratedRow)).toEqual([{ ok: false, code: "unknown", message: "boom" }]);
			expect(Object.keys(JSON.parse(migratedRow ?? "") as object)).toEqual(
				Object.keys(JSON.parse(CURRENT_ROW) as object),
			);
			expect(migratedPatch?.startsWith('{"rowId":')).toBe(true);
			expect(JSON.parse(migratedPatch ?? "")).toEqual({
				rowId: ROW_ID,
				status: "partial",
				messages: [
					{
						payload: { kind: "text", text: "词云" },
						role: "extra",
						result: { ok: false, code: "unknown", message: "没有送达，对端没说原因" },
						repushOf: 1,
					},
				],
			});
		});

		it("幂等:已经是结果形状的失败(带 upstreamCode 的也算)一个字节不动,这一天的文件不算改写;再迁一遍回 []", async () => {
			const row = JSON.stringify({
				...JSON.parse(CURRENT_ROW),
				status: "failed",
				messages: [
					{
						payload: { kind: "text", text: "卡片" },
						role: "main",
						result: { ok: false, code: "rate_limited", message: "慢点", upstreamCode: 22009 },
					},
				],
			});
			const patch = JSON.stringify({
				rowId: ROW_ID,
				status: "failed",
				messages: [
					{
						payload: { kind: "text", text: "词云" },
						role: "extra",
						result: {
							ok: false,
							code: "unavailable",
							message: "HTTP 502",
							upstreamCode: "http:502",
						},
					},
				],
			});
			await writeDay(DAY, [row, patch]);
			const report = await sandbox.migrate();
			expect(report.rewritten).not.toContain(`history/${DAY}.jsonl`);
			expect(await migratedLines()).toEqual([row, patch]);
			expect(await rerunMigrators()).toEqual([]);
			expect(await migratedLines()).toEqual([row, patch]);
		});

		it("老失败迁过一遍之后再迁一遍:回 [],字节不变", async () => {
			await writeDay(DAY, [
				JSON.stringify({
					...ZERO_ROW_OBJECT,
					status: "failed",
					messages: [
						{ payload: { kind: "text", text: "卡片" }, role: "main", result: oldFailure("boom") },
					],
				}),
				PATCH_LINE,
			]);
			await sandbox.migrate();
			const once = await migratedLines();
			expect(once.join("\n")).not.toContain('"err"');
			expect(await rerunMigrators()).toEqual([]);
			expect(await migratedLines()).toEqual(once);
		});

		it("坏行(推不出「替谁发的」)里的老失败不碰:整行原样", async () => {
			await writeDay(DAY, NO_IDENTITY_LINES);
			await sandbox.migrate();
			expect(await migratedLines()).toEqual(NO_IDENTITY_LINES);
		});
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],文件字节不变", async () => {
		await placeMixedDay();
		const report = await sandbox.migrate();
		expect(report.rewritten).toContain(`history/${DAY}.jsonl`);

		// 只看日文件:`history/` 底下还有迁移新写的水位线 `retention.json`(⑲c),它不归这一步管。
		const snapshot = async () =>
			Promise.all(
				(await readdir(join(sandbox.target, "history")))
					.filter((name) => name.endsWith(".jsonl"))
					.sort()
					.map(async (name) => [
						name,
						await readFile(join(sandbox.target, "history", name), "utf8"),
					]),
			);
		const before = await snapshot();
		expect(before).toHaveLength(1);

		expect(await rerunMigrators()).toEqual([]);
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

	it("认不得的 kind(不是八种之一)与已经带 feature 的行:一个字节不动,留给历史仓照旧当坏行跳过 —— ⑱b 的改名也不碰它们", async () => {
		const stranger = JSON.stringify({ ...ZERO_ROW_OBJECT, id: randomUUID(), kind: "mystery" });
		const both = JSON.stringify({ ...ZERO_ROW_OBJECT, id: randomUUID(), feature: "liveEnd" });
		await writeDay(DAY, [stranger, both]);
		await sandbox.migrate();
		expect((await readFile(dayPath(), "utf8")).split("\n").slice(0, 2)).toEqual([stranger, both]);
	});
});

describe("⑱c:重推原件 `v` → `version`", () => {
	const DAY_DIR = "history/repush/2026-05-10";
	const MESSAGES = [{ payload: { kind: "text", text: "卡片" }, role: "main" }];
	const rel = (name: string) => `${DAY_DIR}/${name}`;
	const read = (name: string) => readFile(join(sandbox.target, rel(name)), "utf8");

	it("0.x 的原件:`v` 换成 `version`、仍是第一个键,消息一个字不动;第 0 代那份不动", async () => {
		const name = `${randomUUID()}.json`;
		const zeroText = JSON.stringify({ v: 1, messages: MESSAGES });
		await sandbox.placeZeroText(rel(name), zeroText);
		await sandbox.migrate();
		const text = await read(name);
		expect(Object.keys(JSON.parse(text))[0]).toBe("version");
		expect(JSON.parse(text)).toEqual({ version: 1, messages: MESSAGES });
		expect(await readFile(join(sandbox.zero, rel(name)), "utf8")).toBe(zeroText);
	});

	it("已经是 `version` 的原件、读不懂的原件:一个字节不动;原件自己存的图不进新代(⑳d:当成迁移输入)", async () => {
		const done = `${randomUUID()}.json`;
		const broken = `${randomUUID()}.json`;
		const image = `${randomUUID()}-1.png`;
		const doneText = JSON.stringify({ version: 1, messages: MESSAGES });
		await sandbox.placeZeroText(rel(done), doneText);
		await sandbox.placeZeroText(rel(broken), "{不是 JSON");
		await sandbox.placeZeroBytes(rel(image), PNG_BYTES);
		await sandbox.migrate();
		expect(await read(done)).toBe(doneText);
		expect(await read(broken)).toBe("{不是 JSON");
		expect(existsSync(join(sandbox.target, rel(image)))).toBe(false);
		// 第 0 代那份还在。
		expect(existsSync(join(sandbox.zero, rel(image)))).toBe(true);
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],原件字节不变", async () => {
		const name = `${randomUUID()}.json`;
		await sandbox.placeZero(rel(name), { v: 1, messages: MESSAGES });
		await sandbox.migrate();
		const once = await read(name);
		expect(await rerunMigrators()).toEqual([]);
		expect(await read(name)).toBe(once);
	});
});

/**
 * **迁移里先替主人跑一次清扫**(ADR-0022 决策 9 下 10-04 的 🔗):和开机后的清扫是同一个函数,时钟注入。照换算后的
 * 天数,过了保留期的重推原件整天目录不带过来、水位线定好;文字照搬。⑳d 起清扫不碰图 —— `history/img/` 不整目录搬,
 * 保留期内的行引用的图逐张复制进图库,过了保留期的行拿掉图格、不读图文件,孤儿不搬(细节见
 * `zero-generation-history-images.test.ts`)。新代里删的是新代的那份,第 0 代那份不动。
 */
describe("⑲c:迁移里的历史清扫", () => {
	// 保留 30 天、此刻 06-15:截止日是 05-16,05-15 及以前到期。
	const NOW = new Date("2026-06-15T12:00:00.000Z");
	const MESSAGES = [{ payload: { kind: "text", text: "卡片" }, role: "main" }];

	/** 一行带一张图的历史(已是现在的形状),图名 `ref`(0.x 的 `history/img/` 里的名字)。 */
	const rowWithImage = (day: string, ref: string) =>
		JSON.stringify({
			id: randomUUID(),
			pushId: randomUUID(),
			createdAt: `${day}T08:00:00.000Z`,
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: SUB,
			targetId: T2,
			status: "delivered",
			messages: [
				{
					payload: { kind: "image", text: "x", imageRef: ref },
					role: "main",
					result: { ok: true, latencyMs: 1 },
				},
			],
		});

	/** 摆一天:一行、它的图(一张真 PNG,每天内容不同)、一份重推原件。 */
	async function placeDay(day: string, ref: string, variant: number): Promise<void> {
		await writeDay(day, [rowWithImage(day, ref)]);
		await sandbox.placeZeroBytes(
			`history/img/${ref}`,
			Buffer.concat([PNG_BYTES, Buffer.from([variant])]),
		);
		await sandbox.placeZero(`history/repush/${day}/${randomUUID()}.json`, {
			v: 1,
			messages: MESSAGES,
		});
	}

	const imagesInLibrary = async () =>
		(await readdir(join(sandbox.target, "images")).catch(() => [])).sort();
	const snapshotDays = async () =>
		(await readdir(join(sandbox.target, "history", "repush"))).sort();
	const mark = async () =>
		JSON.parse(await readFile(join(sandbox.target, "history", "retention.json"), "utf8"));
	const imageOfDay = async (day: string) => {
		const [line] = (await readFile(join(sandbox.target, "history", `${day}.jsonl`), "utf8")).split(
			"\n",
		);
		return (JSON.parse(line ?? "") as { messages: { payload: { image?: string } }[] }).messages[0]
			?.payload.image;
	};

	it("过了保留期的那几天:原件不带过来、行的图格拿掉、不读图,文字照搬;水位线定在到期日;第 0 代那份不动", async () => {
		await placeDay("2026-05-10", "expired.png", 1);
		await placeDay("2026-06-10", "kept.png", 2);
		const report = await sandbox.migrate({ now: NOW });

		expect(await snapshotDays()).toEqual(["2026-06-10"]);
		const days = (await readdir(join(sandbox.target, "history"))).filter((f) =>
			f.endsWith(".jsonl"),
		);
		expect(days.sort()).toEqual(["2026-05-10.jsonl", "2026-06-10.jsonl"]);
		expect(await mark()).toEqual({ clearedThrough: "2026-05-15" });
		// 过期那一行:文字在、图格没了;保留期内那一行:图复制进了图库、行里是引用。
		expect(await imageOfDay("2026-05-10")).toBeUndefined();
		const kept = await imageOfDay("2026-06-10");
		expect(kept).toMatch(/^[0-9a-f]{64}\.png$/);
		expect(await imagesInLibrary()).toEqual([kept]);
		// 历史图不进新代;第 0 代是备份,一个字节不动。
		expect(existsSync(join(sandbox.target, "history", "img"))).toBe(false);
		expect(
			new Uint8Array(await readFile(join(sandbox.zero, "history", "img", "expired.png"))),
		).toEqual(new Uint8Array(Buffer.concat([PNG_BYTES, Buffer.from([1])])));
		expect(await readdir(join(sandbox.zero, "history", "repush"))).toContain("2026-05-10");

		// 报告:没带过来的各记一句(按数量,不逐个文件列);搬过去的清单里没有它们。
		expect(report.skipped).toEqual(
			expect.arrayContaining([
				{ path: "history/img", reason: expect.stringMatching(/1 张.*保留期/) },
				{ path: "history/repush", reason: expect.stringMatching(/1 天.*保留期/) },
			]),
		);
		const carried = report.transfers.map((t) => t.to);
		expect(carried).toContain(`images/${kept}`);
		expect(carried.some((to) => to.startsWith("history/repush/2026-05-10/"))).toBe(false);
		expect(carried.some((to) => to.startsWith("history/repush/2026-06-10/"))).toBe(true);
		expect(carried.some((to) => to.startsWith("history/img/"))).toBe(false);
	});

	it("没有任何一行引用的孤儿图不搬,和时钟无关;报告里另记一句", async () => {
		await placeDay("2026-06-10", "kept.png", 2);
		await sandbox.placeZeroBytes(
			"history/img/orphan.png",
			Buffer.concat([PNG_BYTES, Buffer.from([9])]),
		);
		const report = await sandbox.migrate();

		expect(await imagesInLibrary()).toHaveLength(1);
		expect(report.skipped).toContainEqual({
			path: "history/img",
			reason: expect.stringMatching(/1 张.*没有.*引用/),
		});
		expect(report.transfers.map((t) => t.from)).not.toContain("history/img/orphan.png");
		expect(existsSync(join(sandbox.zero, "history", "img", "orphan.png"))).toBe(true);
	});

	it("按换算后的天数算:0.x 设了 5 天 → 七档里是 7 天,只留 7 天以内的", async () => {
		const zero = makeZeroGlobals();
		await sandbox.placeZero("state/globals.json", {
			...zero,
			app: { ...zero.app, historyRetentionDays: 5 },
		});
		// 保留 7 天、此刻 06-15:截止日是 06-08,06-07 及以前到期。
		await placeDay("2026-06-05", "expired.png", 1);
		await placeDay("2026-06-10", "kept.png", 2);
		await sandbox.migrate({ now: NOW });

		expect(await imageOfDay("2026-06-05")).toBeUndefined();
		expect(await imageOfDay("2026-06-10")).toBeDefined();
		expect(await imagesInLibrary()).toHaveLength(1);
		expect(await mark()).toEqual({ clearedThrough: "2026-06-07" });
	});

	it("没有到期的、也没有孤儿:被引用的图与原件全带过来,报告里只多历史图那一句「不整目录搬」", async () => {
		await placeDay("2026-06-10", "kept.png", 2);
		const report = await sandbox.migrate({ now: NOW });

		expect(await imagesInLibrary()).toHaveLength(1);
		expect(await snapshotDays()).toEqual(["2026-06-10"]);
		expect(report.skipped.filter((s) => s.path.startsWith("history"))).toEqual([
			{ path: "history/img", reason: expect.stringContaining("不整目录进新代") },
		]);
	});
});
