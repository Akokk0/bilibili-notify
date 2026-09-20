/**
 * **按行 id 往一行里补消息**(ADR-0017 的「历史仓要开一条新路径」)。
 *
 * 现有的 `record` 靠内存里那张 `open` 表找行,键是 `pushId|targetId`、上限 2000 行、
 * 重启即空 —— 它服务的是「同一次推送的几段消息陆续落地」,那几段之间只隔几秒到几分钟。
 *
 * 人工重推**不在那个窗口里**:主人是隔了几小时、甚至重启过一次之后才点那颗按钮的。
 * 那时 `open` 表里早没有这一行了,`record` 会当成新行建第二行 —— 于是面板上出现两行
 * 同一次推送,而「失败过、后来补上了」这件事被拆成了两半。
 *
 * 所以这条路径**只认行 id**,盘上的补丁行本来就是按行 id 认亲的(`parseLines`)。
 *
 * 🔴 **补丁必须写进「原行那一天」的日文件**:`parseLines` 用的是一张**单文件局部**的
 * `byId` 表,跨了日文件就找不到亲,整条补丁被静默丢掉 —— 症状是「点了重推,消息真的
 * 发出去了,面板上却什么都没变」。本文件里「隔了几天再补」那一条就是钉这个的。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryRecordInput, type HistoryStore } from "../store.js";

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let store: HistoryStore;
let updated: HistoryEntry[];

const SUB = randomUUID();
const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };
const FAIL = { ok: false, latencyMs: 7, err: "boom" };

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-append-"));
	bus = createNodeMessageBus();
	updated = [];
	bus.on("history-updated", (e) => updated.push(e));
	store = createHistoryStore({ dataDir, bus, logger: logger() });
});
afterEach(() => vi.restoreAllMocks());

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

function input(over: Partial<HistoryRecordInput> = {}): HistoryRecordInput {
	return {
		pushId: randomUUID(),
		kind: "dynamic",
		uid: "u1",
		subscriptionId: SUB,
		target: T1,
		messages: [{ payload: text("卡片"), role: "main", result: FAIL }],
		...over,
	};
}

async function dayLines(ts: string): Promise<string[]> {
	const raw = await readFile(join(dataDir, "history", `${ts.slice(0, 10)}.jsonl`), "utf8");
	return raw.trim().split("\n");
}

describe("appendToRow", () => {
	it("补一条成功的 → 行里多一条带 retryOf 的消息,状态翻成 delivered", async () => {
		const entry = await store.record(input());
		expect(entry.status).toBe("failed");
		const merged = await store.appendToRow(entry.id, entry.ts, [
			{ payload: text("卡片"), role: "main", result: OK, retryOf: 0 },
		]);
		expect(merged?.id).toBe(entry.id);
		expect(merged?.messages).toHaveLength(2);
		expect(merged?.messages[1]?.retryOf).toBe(0);
		expect(merged?.status).toBe("delivered");
	});

	it("补了还是失败 → 再多一条,状态不变", async () => {
		const entry = await store.record(input());
		const merged = await store.appendToRow(entry.id, entry.ts, [
			{ payload: text("卡片"), role: "main", result: FAIL, retryOf: 0 },
		]);
		expect(merged?.status).toBe("failed");
		expect(merged?.messages).toHaveLength(2);
	});

	it("emit 的是 history-updated(不是 recorded —— 行还是那一行)", async () => {
		const entry = await store.record(input());
		updated.length = 0;
		await store.appendToRow(entry.id, entry.ts, [
			{ payload: text("卡片"), role: "main", result: OK, retryOf: 0 },
		]);
		expect(updated).toHaveLength(1);
		expect(updated[0]?.id).toBe(entry.id);
		expect(updated[0]?.status).toBe("delivered");
	});

	/**
	 * 🔴 这条是这条路径存在的**全部理由**。换一个 store 实例 = 服务端重启过一次:
	 * `open` 表空了,`record` 那条路会建出第二行来。
	 */
	it("内存里那张表早没了(重启过)也照样找得到这一行", async () => {
		const entry = await store.record(input());
		const afterRestart = createHistoryStore({ dataDir, bus, logger: logger() });
		const merged = await afterRestart.appendToRow(entry.id, entry.ts, [
			{ payload: text("卡片"), role: "main", result: OK, retryOf: 0 },
		]);
		expect(merged?.id).toBe(entry.id);
		expect(merged?.status).toBe("delivered");
		// 读回来仍然只有一行。
		const rows = await afterRestart.query({});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.messages).toHaveLength(2);
	});

	/**
	 * 🔴 补丁写进**原行那一天**。`parseLines` 的 `byId` 是单文件局部的 —— 写进今天的
	 * 文件,读的时候找不到亲,整条补丁静默消失:消息真发出去了,面板上却什么都没变。
	 */
	it("隔了几天再补:补丁落在原行那一天的文件里,不是今天", async () => {
		// 手工造一行三天前的。
		const old = "2026-09-17T10:00:00.000Z";
		const id = randomUUID();
		const row = {
			id,
			pushId: randomUUID(),
			ts: old,
			kind: "dynamic",
			uid: "u1",
			subscriptionId: SUB,
			targetId: T1,
			status: "failed",
			messages: [{ payload: { kind: "text", text: "卡片" }, role: "main", result: FAIL }],
		};
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", "2026-09-17.jsonl"), `${JSON.stringify(row)}\n`);

		const merged = await store.appendToRow(id, old, [
			{ payload: text("卡片"), role: "main", result: OK, retryOf: 0 },
		]);
		expect(merged?.status).toBe("delivered");

		// 三天前那个文件里多了一条补丁行,今天的文件压根没被建出来。
		const lines = await dayLines(old);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string)).toMatchObject({ patch: id, status: "delivered" });
		await expect(dayLines(new Date().toISOString())).rejects.toThrow();

		// 而且读回来真的并进了那一行 —— 补丁不是写了就算数,得找得到亲。
		const rows = await store.query({});
		expect(rows[0]?.messages).toHaveLength(2);
		expect(rows[0]?.status).toBe("delivered");
	});

	it("行 id 找不到 → null,什么都不写", async () => {
		const entry = await store.record(input());
		const merged = await store.appendToRow(randomUUID(), entry.ts, [
			{ payload: text("x"), role: "main", result: OK, retryOf: 0 },
		]);
		expect(merged).toBeNull();
		expect(await dayLines(entry.ts)).toHaveLength(1);
	});

	it("那一天压根没有文件 → null", async () => {
		const merged = await store.appendToRow(randomUUID(), "2020-01-01T00:00:00.000Z", [
			{ payload: text("x"), role: "main", result: OK, retryOf: 0 },
		]);
		expect(merged).toBeNull();
	});

	it("一条都不补 → null,不写空补丁行", async () => {
		const entry = await store.record(input());
		expect(await store.appendToRow(entry.id, entry.ts, [])).toBeNull();
		expect(await dayLines(entry.ts)).toHaveLength(1);
	});

	// 重推补的图跟着原行的序号往后排,不会盖掉原来那几张。
	it("补进来的图另起文件名,不覆盖原消息的图", async () => {
		const png = (s: string): NotificationPayload => ({
			kind: "image",
			image: { buffer: Buffer.from(s), mime: "image/png" },
		});
		const entry = await store.record(
			input({ messages: [{ payload: png("原图"), role: "main", result: FAIL }] }),
		);
		const first = entry.messages[0]?.payload.imageRef;
		const merged = await store.appendToRow(entry.id, entry.ts, [
			{ payload: png("补的图"), role: "main", result: OK, retryOf: 0 },
		]);
		const second = merged?.messages[1]?.payload.imageRef;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(await readFile(join(dataDir, "history", "img", first as string), "utf8")).toBe("原图");
		expect(await readFile(join(dataDir, "history", "img", second as string), "utf8")).toBe(
			"补的图",
		);
	});
});
