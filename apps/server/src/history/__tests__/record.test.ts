/**
 * 推送历史的新模型:**一行 = 一次推送 × 一个目标**,行里是消息列表与逐条结果。
 *
 * 守的契约:
 *   - 首次 `record` 建行、emit `history-recorded`;同 pushId + 同目标再来就往这一行追加消息、
 *     重算状态、emit `history-updated`(不再 recorded)
 *   - jsonl 仍 append-only:追加写的是**补丁行**,读回来按行 id 合并
 *   - 四态:全到 = delivered;本体到了附加没到 = partial;本体没到 = failed;`target: null` = no-targets
 *   - 无目标行消息照存、图照落盘,只是没有结果
 *   - 老格式(source / result / payload)读时映射成新形状,不重写盘
 *   - 按日聚合:total 数行、不计无目标;failures = failed + partial;counts 按 8 类
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryRecordInput, type HistoryStore } from "../store.js";

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let store: HistoryStore;
let recorded: HistoryEntry[];
let updated: HistoryEntry[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-"));
	bus = createNodeMessageBus();
	recorded = [];
	updated = [];
	bus.on("history-recorded", (e) => recorded.push(e));
	bus.on("history-updated", (e) => updated.push(e));
	store = createHistoryStore({
		dataDir,
		bus,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const SUB = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();
const OK = { ok: true, latencyMs: 5 };
const FAIL = { ok: false, latencyMs: 7, err: "boom" };

function text(t: string): NotificationPayload {
	return { kind: "text", text: t };
}

function input(over: Partial<HistoryRecordInput> = {}): HistoryRecordInput {
	return {
		pushId: randomUUID(),
		kind: "dynamic",
		uid: "u1",
		subscriptionId: SUB,
		target: T1,
		messages: [{ payload: text("卡片"), role: "main", result: OK }],
		unameSnapshot: "某UP",
		...over,
	};
}

async function dayLines(entry: HistoryEntry): Promise<string[]> {
	const raw = await readFile(join(dataDir, "history", `${entry.ts.slice(0, 10)}.jsonl`), "utf8");
	return raw.trim().split("\n");
}

describe("record — 建行与追加", () => {
	it("首次 record 建行:status delivered、消息带 role 与结果、emit history-recorded", async () => {
		const pushId = randomUUID();
		const entry = await store.record(input({ pushId }));
		expect(entry).toMatchObject({
			pushId,
			kind: "dynamic",
			uid: "u1",
			subscriptionId: SUB,
			targetId: T1,
			status: "delivered",
			unameSnapshot: "某UP",
		});
		expect(entry.messages).toEqual([
			{ payload: { kind: "text", text: "卡片" }, role: "main", result: OK },
		]);
		expect(recorded.map((e) => e.id)).toEqual([entry.id]);
		expect(updated).toHaveLength(0);
	});

	it("同 pushId 同目标再 record → 追加消息、重算状态、emit history-updated;盘上是补丁行,读回是合并后的一行", async () => {
		const pushId = randomUUID();
		const first = await store.record(input({ pushId }));
		const merged = await store.record(
			input({
				pushId,
				messages: [{ payload: text("词云"), role: "extra", result: FAIL }],
			}),
		);
		expect(merged.id).toBe(first.id);
		expect(merged.status).toBe("partial");
		expect(merged.messages.map((m) => [m.payload.text, m.role, m.result?.ok])).toEqual([
			["卡片", "main", true],
			["词云", "extra", false],
		]);
		expect(recorded).toHaveLength(1);
		expect(updated.map((e) => e.id)).toEqual([first.id]);
		expect(updated[0]?.messages).toHaveLength(2);

		const lines = await dayLines(first);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string)).toMatchObject({ patch: first.id, status: "partial" });

		const [read] = await store.query({ limit: 10 });
		expect(read).toEqual(merged);
	});

	it("同 pushId 不同目标 → 各自一行,互不影响", async () => {
		const pushId = randomUUID();
		const a = await store.record(input({ pushId, target: T1 }));
		const b = await store.record(
			input({ pushId, target: T2, messages: [{ payload: text("x"), role: "main", result: FAIL }] }),
		);
		expect(a.id).not.toBe(b.id);
		expect(a.status).toBe("delivered");
		expect(b.status).toBe("failed");
		expect((await store.query({})).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
	});
});

describe("record — 四态", () => {
	it.each<[string, HistoryRecordInput["messages"], HistoryEntry["status"]]>([
		[
			"全到 → delivered",
			[
				{ payload: text("a"), role: "main", result: OK },
				{ payload: text("b"), role: "extra", result: OK },
			],
			"delivered",
		],
		[
			"本体到了、附加没到 → partial",
			[
				{ payload: text("a"), role: "main", result: OK },
				{ payload: text("b"), role: "extra", result: FAIL },
			],
			"partial",
		],
		[
			"本体没到 → failed(附加就算到了也不算)",
			[
				{ payload: text("a"), role: "main", result: FAIL },
				{ payload: text("b"), role: "extra", result: OK },
			],
			"failed",
		],
		[
			"本体分两条、第二条失败 → partial(第一条到了)",
			[
				{ payload: text("a"), role: "main", result: OK },
				{ payload: text("b"), role: "main", result: FAIL },
			],
			"partial",
		],
		[
			"只有附加项、还失败了(@全体 先到) → failed,等本体来了再算",
			[{ payload: text("@全体"), role: "extra", result: FAIL }],
			"failed",
		],
		[
			"有目标却一条结果都没有 → failed(没发出去就不是「全到了」)",
			[{ payload: text("a"), role: "main" }],
			"failed",
		],
	])("%s", async (_name, messages, status) => {
		const entry = await store.record(input({ messages }));
		expect(entry.status).toBe(status);
	});

	it("target: null → no-targets;消息照存、没有结果;后续追加照常", async () => {
		const pushId = randomUUID();
		const entry = await store.record(
			input({ pushId, target: null, messages: [{ payload: text("卡片"), role: "main" }] }),
		);
		expect(entry.status).toBe("no-targets");
		expect(entry.targetId).toBeNull();
		expect(entry.messages).toEqual([{ payload: { kind: "text", text: "卡片" }, role: "main" }]);
		const merged = await store.record(
			input({ pushId, target: null, messages: [{ payload: text("总结"), role: "extra" }] }),
		);
		expect(merged.id).toBe(entry.id);
		expect(merged.status).toBe("no-targets");
		expect(merged.messages).toHaveLength(2);
	});
});

describe("record — 图片落盘", () => {
	const png = (s: string): NotificationPayload => ({
		kind: "image",
		image: { buffer: Buffer.from(s), mime: "image/png" },
	});

	it("多条消息各自落盘,补丁那条也落,文件名不撞", async () => {
		const pushId = randomUUID();
		const first = await store.record(
			input({
				pushId,
				messages: [
					{ payload: png("A"), role: "main", result: OK },
					{ payload: png("B"), role: "main", result: OK },
				],
			}),
		);
		const merged = await store.record(
			input({ pushId, messages: [{ payload: png("C"), role: "extra", result: OK }] }),
		);
		const refs = merged.messages.map((m) => m.payload.imageRef);
		expect(new Set(refs).size).toBe(3);
		expect(refs.every((r) => r?.startsWith(first.id))).toBe(true);
		const files = (await readdir(store.imageDir())).sort();
		expect(files).toEqual([...refs].sort());
		expect((await readFile(join(store.imageDir(), refs[2] as string))).toString()).toBe("C");
	});

	it("无目标行的图也落盘", async () => {
		const entry = await store.record(
			input({ target: null, messages: [{ payload: png("W"), role: "main" }] }),
		);
		expect(entry.messages[0]?.payload.imageRef).toBeDefined();
		expect(await readdir(store.imageDir())).toHaveLength(1);
	});

	it("无 caption 的纯图:下播的附加项写「[弹幕词云]」,其余写「[卡片图]」", async () => {
		const wc = await store.record(
			input({ kind: "live-end", messages: [{ payload: png("W"), role: "extra", result: OK }] }),
		);
		expect(wc.messages[0]?.payload.text).toBe("[弹幕词云]");
		const card = await store.record(
			input({ kind: "live-end", messages: [{ payload: png("C"), role: "main", result: OK }] }),
		);
		expect(card.messages[0]?.payload.text).toBe("[卡片图]");
	});
});

describe("老格式读时映射", () => {
	async function writeDay(date: string, lines: string[]) {
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", `${date}.jsonl`), `${lines.join("\n")}\n`, "utf8");
	}
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
		const [e] = await store.query({});
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
		const [e] = await store.query({});
		expect(e?.kind).toBe(kind);
		expect(e?.status).toBe(status);
	});
});

describe("query — kind 过滤与补丁行", () => {
	it("kind 过滤走新键", async () => {
		const a = await store.record(input({ kind: "live-end" }));
		await store.record(input({ kind: "sc" }));
		expect((await store.query({ kind: "live-end" })).map((e) => e.id)).toEqual([a.id]);
	});

	it("补丁行不占 limit:取尾巴按行(row)数", async () => {
		// 三行,每行两个补丁 —— 尾窗按原始行数取会只剩最后一行半。
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const pushId = randomUUID();
			const e = await store.record(input({ pushId }));
			await store.record(
				input({ pushId, messages: [{ payload: text("a"), role: "extra", result: OK }] }),
			);
			await store.record(
				input({ pushId, messages: [{ payload: text("b"), role: "extra", result: OK }] }),
			);
			ids.push(e.id);
		}
		const got = await store.query({ limit: 2 });
		expect(got.map((e) => e.id)).toEqual([ids[2], ids[1]]);
		expect(got.every((e) => e.messages.length === 3)).toBe(true);
	});
});

describe("aggregateDaily — 新口径", () => {
	const TZ = 0;
	it("total 数行、不计无目标;failures = failed + partial;counts 按类", async () => {
		const now = new Date();
		const pushId = randomUUID();
		await store.record(input({ pushId, target: T1 })); // delivered
		await store.record(input({ pushId, target: T2 })); // delivered(同一次推送,另一个目标也算一行)
		await store.record(
			input({ kind: "live-end", messages: [{ payload: text("x"), role: "main", result: FAIL }] }),
		); // failed
		const p = await store.record(input({ kind: "sc" }));
		await store.record(
			input({
				pushId: p.pushId,
				kind: "sc",
				messages: [{ payload: text("y"), role: "extra", result: FAIL }],
			}),
		); // → partial
		await store.record(
			input({ kind: "guard", target: null, messages: [{ payload: text("z"), role: "main" }] }),
		); // no-targets

		const [today] = (await store.aggregateDaily({ days: 1, tzOffsetMin: TZ, now })) ?? [];
		expect(today).toMatchObject({ total: 4, failures: 2 });
		expect(today?.counts).toMatchObject({ dynamic: 2, "live-end": 1, sc: 1, guard: 0 });
		expect(Object.keys(today?.counts ?? {}).sort()).toEqual(
			[
				"dynamic",
				"live",
				"live-ongoing",
				"live-end",
				"guard",
				"sc",
				"special-danmaku",
				"special-enter",
			].sort(),
		);
	});
});
