/**
 * **原件与历史行绑在一起**(ADR-0017 决策 1、4、5)—— 这一份钉的是**接线**,不是零件。
 *
 * `repush-store.test.ts` 证明了原件自己存得对、读得回;可那证明不了历史仓真的在调它。
 * 零件各自绿着、线压根没接上,是这个仓里反复栽过的坑 —— 所以每根线都要有一条「剪断
 * 必红」的守卫:
 *
 * 1. **落行就留一份原料**,追加也跟着长。原料只在 `record` 那一刻还是原样(再往后
 *    历史里就只剩有损摘要了),错过就永远补不回来。
 * 2. **无目标行不留** —— 那不是失败是没配目标,按钮本来就不给它(决策 6),留了也没人取。
 * 3. **行没了原件就得跟着没**:`deleteRange`(devtools 截流清理)删掉行之后,原件再留着
 *    就成了没人认领的孤儿,而且盘上多一份谁都读不到的推送内容。
 *
 * 保留期那根线(日文件到期 → 原件日目录到期)在 `retention.test.ts` 里,它和历史的
 * 日文件淘汰是同一件事、同一个数。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createRepushStore, type RepushStore } from "../repush-store.js";
import { createHistoryStore, type HistoryRecordInput, type HistoryStore } from "../store.js";

let dataDir: string;
let store: HistoryStore;
let repush: RepushStore;

const SUB = randomUUID();
const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };
const FAIL = { ok: false, latencyMs: 7, err: "boom" };

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-repush-wire-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	repush = createRepushStore({ dataDir, logger });
	store = createHistoryStore({ dataDir, bus: createNodeMessageBus(), logger, repush });
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
		messages: [{ payload: text("卡片"), role: "main", result: OK }],
		...over,
	};
}

/** 原件的日目录里有哪些文件。目录不存在就当空。 */
async function draftFiles(ts: string): Promise<string[]> {
	try {
		return (await readdir(join(dataDir, "history", "repush", ts.slice(0, 10)))).sort();
	} catch {
		return [];
	}
}

describe("record → 原件", () => {
	it("落行就留一份原料,条数与行对得上", async () => {
		const entry = await store.record(input());
		expect(await draftFiles(entry.ts)).toEqual([`${entry.id}.json`]);
		const draft = await repush.load(entry.id, entry.ts, entry.messages.length);
		expect(draft?.messages).toEqual([{ payload: { kind: "text", text: "卡片" }, role: "main" }]);
	});

	it("追加也跟着长,下标始终与行的 messages 一一对应", async () => {
		const pushId = randomUUID();
		await store.record(input({ pushId }));
		const merged = await store.record(
			input({ pushId, messages: [{ payload: text("词云"), role: "extra", result: FAIL }] }),
		);
		expect(merged.messages).toHaveLength(2);
		const draft = await repush.load(merged.id, merged.ts, 2);
		expect(draft?.messages.map((m) => (m.payload.kind === "text" ? m.payload.text : "?"))).toEqual([
			"卡片",
			"词云",
		]);
	});

	/**
	 * 🔴 历史那条 `reduce` 会把 at-all 段碾成字面文字「@全体」。这条钉的是:**经过
	 * 历史仓这一趟之后,原件里那个段还是段** —— 拿它重发才会真的 @ 全体,而不是把
	 * 四个字发出去。
	 */
	it("at-all 段经过历史仓仍是段,没被碾成字面文字", async () => {
		const payload: NotificationPayload = { kind: "composite", segments: [{ type: "at-all" }] };
		const entry = await store.record(
			input({ messages: [{ payload, role: "extra", result: FAIL }] }),
		);
		// 历史那一行里它已经只剩四个字了。
		expect(entry.messages[0]?.payload.text).toBe("@全体");
		// 原件里还是原来那个段。
		const draft = await repush.load(entry.id, entry.ts, 1);
		expect(draft?.messages[0]?.payload).toEqual(payload);
	});

	it("无目标行不留原件 —— 按钮本来就不给它", async () => {
		const entry = await store.record(
			input({ target: null, messages: [{ payload: text("卡片"), role: "main" }] }),
		);
		expect(entry.status).toBe("no-targets");
		expect(await draftFiles(entry.ts)).toEqual([]);
	});

	it("没给 repush 的历史仓照常工作,只是不留原件", async () => {
		const bare = createHistoryStore({
			dataDir,
			bus: createNodeMessageBus(),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});
		const entry = await bare.record(input());
		expect(entry.status).toBe("delivered");
		expect(await draftFiles(entry.ts)).toEqual([]);
	});
});

describe("deleteRange → 原件跟着没", () => {
	it("行被删掉,它的原件也不见了", async () => {
		const entry = await store.record(input());
		expect(await draftFiles(entry.ts)).toHaveLength(1);
		const ms = Date.parse(entry.ts);
		expect(await store.deleteRange({ fromMs: ms - 1000, toMs: ms + 1000 })).toBe(1);
		expect(await draftFiles(entry.ts)).toEqual([]);
	});

	it("窗外的行不受影响,原件照留", async () => {
		const entry = await store.record(input());
		const ms = Date.parse(entry.ts);
		expect(await store.deleteRange({ fromMs: ms + 60_000, toMs: ms + 120_000 })).toBe(0);
		expect(await draftFiles(entry.ts)).toHaveLength(1);
	});
});
