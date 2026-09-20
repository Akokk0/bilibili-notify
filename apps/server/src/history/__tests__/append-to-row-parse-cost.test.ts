/**
 * **补一行 N 条,不许把当天那份 jsonl 解析 N 遍。**
 *
 * `appendToRow` 每被调一次就 `readJsonl(dayFile(ts))` —— 整份日文件读进来、**逐行**跑
 * 一遍 `HistoryEntrySchema` / `HistoryPatchSchema`。日文件是「一次推送 × 一个目标」一行,
 * 高推送量实例一天几千行;而人工重推「重推全部」是一条消息一次 `appendToRow`,一个
 * 6 条的行就是 6 遍全份解析(`start()` 的 `findRow` 还占一遍)。更糟的是这几遍都排在
 * 写队列 `tail` 上 —— 期间所有正常推送的落行都在后面等着。
 *
 * 同一个文件的作者早就为 `query()` 写过 `readTailEntries` 来躲开「每次请求都把当天每一
 * 行都读一遍」;重推这条路又把它整个请了回来。现有注释只算了**一遍**的账(「重推是
 * 低频的人工动作(一次点击)」),漏掉的是它乘以 N。
 *
 * 所以这里数的是**真的读了几次文件**(桩掉 `createReadStream`,`readRawLines` 只走它),
 * 钉两件事:次数不随 N 涨,以及 🔴 **省下来的那几遍不能省成脏读** —— 手上那一行只在
 * 「这份日文件自那以后一个字节都没被动过」时才算数,别人往同一天写过就必须重读。
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryRecordInput, type HistoryStore } from "../store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

let dataDir: string;
let store: HistoryStore;

const SUB = randomUUID();
const T1 = randomUUID();
const FAIL = { ok: false, latencyMs: 7, err: "boom" };
const OK = { ok: true, latencyMs: 5 };

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

/** 整份日文件被读了几次 —— `readJsonl` / `readTailEntries` 都只经这一扇门。 */
const reads = (): number => vi.mocked(createReadStream).mock.calls.length;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-append-cost-"));
	store = createHistoryStore({ dataDir, bus: createNodeMessageBus(), logger: logger() });
	vi.mocked(createReadStream).mockClear();
});
afterEach(() => vi.restoreAllMocks());

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

function input(): HistoryRecordInput {
	return {
		pushId: randomUUID(),
		kind: "dynamic",
		uid: "u1",
		subscriptionId: SUB,
		target: T1,
		messages: [{ payload: text("卡片"), role: "main", result: FAIL }],
	};
}

const retry = (n: number) =>
	[{ payload: text(`补 ${n}`), role: "main" as const, result: OK, retryOf: n }] as const;

function dayPath(ts: string): string {
	return join(dataDir, "history", `${ts.slice(0, 10)}.jsonl`);
}

describe("appendToRow — 解析成本", () => {
	it("补 6 条与补 1 条读同样多次文件(不随 N 线性增长)", async () => {
		const solo = await store.record(input());
		const many = await store.record(input());

		const before1 = reads();
		await store.appendToRow(solo.id, solo.ts, retry(0));
		const cost1 = reads() - before1;

		const before6 = reads();
		for (let i = 0; i < 6; i++) await store.appendToRow(many.id, many.ts, retry(i));
		const cost6 = reads() - before6;

		expect(cost1).toBe(1);
		expect(cost6).toBe(cost1);
	});

	it("补完 6 条,行里就是 1 + 6 条,状态照样算得对", async () => {
		const entry = await store.record(input());
		for (let i = 0; i < 6; i++) await store.appendToRow(entry.id, entry.ts, retry(i));
		const merged = await store.findRow(entry.id, entry.ts);
		expect(merged?.messages).toHaveLength(7);
		// 身份号 0 最后一次成了 → 整行翻绿(1-5 号是重投,原行里本来没有那几号)。
		expect(merged?.status).toBe("delivered");
	});

	it("🔴 盘上那一行被别人动过 → 手上那份作废,重读一遍再补", async () => {
		const entry = await store.record(input());
		await store.appendToRow(entry.id, entry.ts, retry(0));

		// 外面直接往同一天的文件追一条补丁行(另一个写者 / 夹具都会这么干)。
		// 键序固定 `patch` 打头 —— 读侧靠行首认它。
		const intruder = {
			patch: entry.id,
			status: "partial",
			messages: [{ payload: { kind: "text", text: "别人写的" }, role: "extra", result: FAIL }],
		};
		await writeFile(dayPath(entry.ts), `${JSON.stringify(intruder)}\n`, {
			flag: "a",
			encoding: "utf8",
		});

		const before = reads();
		const merged = await store.appendToRow(entry.id, entry.ts, retry(1));
		// 重读了(缓存没敢用),而且并进来的是**盘上那一份**:1 本体 + 1 补 + 1 别人 + 1 补。
		expect(reads() - before).toBe(1);
		expect(merged?.messages).toHaveLength(4);
		expect(merged?.messages.map((m) => m.payload.text)).toContain("别人写的");
		// 盘上也不能被盖掉 —— 覆盖式的 base 会让「别人写的」那条从读回来的行里消失。
		const back = await store.findRow(entry.id, entry.ts);
		expect(back?.messages).toHaveLength(4);
	});

	it("同一天又落了一行 → 也作废(文件变了就不认)", async () => {
		const entry = await store.record(input());
		await store.appendToRow(entry.id, entry.ts, retry(0));
		await store.record(input());
		const before = reads();
		await store.appendToRow(entry.id, entry.ts, retry(1));
		expect(reads() - before).toBe(1);
	});

	it("日文件整份没了(保留期端了它)→ 照旧回 null,不凭手上那份凭空补一行出来", async () => {
		const entry = await store.record(input());
		await store.appendToRow(entry.id, entry.ts, retry(0));
		await writeFile(dayPath(entry.ts), "", "utf8");
		expect(await store.appendToRow(entry.id, entry.ts, retry(1))).toBeNull();
		expect(await readFile(dayPath(entry.ts), "utf8")).toBe("");
	});
});
