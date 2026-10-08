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
import { fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import type { ImageWriter } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createRepushStore, type RepushStore } from "../repush-store.js";
import { createHistoryStore, type HistoryStore, type NewHistoryEntry } from "../store.js";

let dataDir: string;
let store: HistoryStore;
let repush: RepushStore;
let historyImages: ImageWriter;

const SUB = randomUUID();
const T1 = randomUUID();
const OK = ok({ latencyMs: 5 });
const FAIL = fail("unavailable", "boom");

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-repush-wire-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const images = makeHistoryImages(dataDir);
	historyImages = images.historyImages;
	repush = createRepushStore({
		dataRoot: dataDir,
		logger,
		images: images.repushImages,
		imageStore: images.imageStore,
	});
	store = createHistoryStore({
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		logger,
		images: historyImages,
		repush,
	});
});
afterEach(() => vi.restoreAllMocks());

const text = (t: string): NotificationPayload => ({ kind: "text", text: t });

function input(over: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
	return {
		pushId: randomUUID(),
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: SUB,
		targetId: T1,
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
		expect(await draftFiles(entry.createdAt)).toEqual([`${entry.id}.json`]);
		const draft = await repush.load(entry.id, entry.createdAt, entry.messages.length);
		expect(draft?.messages).toEqual([{ payload: { kind: "text", text: "卡片" }, role: "main" }]);
	});

	it("追加也跟着长,下标始终与行的 messages 一一对应", async () => {
		const pushId = randomUUID();
		await store.record(input({ pushId }));
		const merged = await store.record(
			input({ pushId, messages: [{ payload: text("词云"), role: "extra", result: FAIL }] }),
		);
		expect(merged.messages).toHaveLength(2);
		const draft = await repush.load(merged.id, merged.createdAt, 2);
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
		const payload: NotificationPayload = { kind: "composite", segments: [{ kind: "at-all" }] };
		const entry = await store.record(
			input({ messages: [{ payload, role: "extra", result: FAIL }] }),
		);
		// 历史那一行里它已经只剩四个字了。
		expect(entry.messages[0]?.payload.text).toBe("@全体");
		// 原件里还是原来那个段。
		const draft = await repush.load(entry.id, entry.createdAt, 1);
		expect(draft?.messages[0]?.payload).toEqual(payload);
	});

	/**
	 * 带图的行:历史行记第一张、原件里每一张都在图库里 —— 两边指着同一个引用(同字节同文件),
	 * 原件读回来的字节与当时发出去的一模一样。重推再 append 同一张图也不会多一个文件。
	 */
	it("带图的行:历史与原件引用同一张图,原件读得回原字节", async () => {
		const entry = await store.record(
			input({
				messages: [
					{
						payload: { kind: "image", image: { buffer: PNG_BYTES, mime: "image/png" } },
						role: "main",
						result: FAIL,
					},
				],
			}),
		);
		const ref = entry.messages[0]?.payload.image;
		expect(ref).toBeDefined();
		const draft = await repush.load(entry.id, entry.createdAt, 1);
		const p = draft?.messages[0]?.payload;
		if (p?.kind !== "image") throw new Error("kind");
		expect(new Uint8Array(p.image.buffer)).toEqual(new Uint8Array(PNG_BYTES));
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);

		// 人工重推补第二条(另一张图):原件长出第二个引用,第一张还是同一个文件。
		const merged = await store.appendToRow(entry.id, entry.createdAt, [
			{
				payload: { kind: "image", image: { buffer: distinctPng(7), mime: "image/png" } },
				role: "extra",
				repushOf: 0,
			},
		]);
		expect(merged?.messages).toHaveLength(2);
		expect(await readdir(join(dataDir, "images"))).toHaveLength(2);
	});

	// 被静音 / 免扰挡下的行有目标、一条都没发:原件必须留着,补发靠它。
	it("被挡的行照留原件:原样 payload 都在,追加的附加项也跟着长", async () => {
		const pushId = randomUUID();
		const entry = await store.record(
			input({
				pushId,
				messages: [
					{
						payload: { kind: "image", image: { buffer: distinctPng(11), mime: "image/png" } },
						role: "main",
						isSilenced: true,
					},
				],
			}),
		);
		expect(entry.status).toBe("silenced");
		await store.record(
			input({ pushId, messages: [{ payload: text("词云"), role: "extra", isSilenced: true }] }),
		);
		const loaded = await repush.load(entry.id, entry.createdAt, 2);
		expect(loaded?.messages.map((m) => [m.payload.kind, m.role])).toEqual([
			["image", "main"],
			["text", "extra"],
		]);
		const [card] = loaded?.messages ?? [];
		if (card?.payload.kind !== "image") throw new Error("原件里那张图不见了");
		expect(Buffer.from(card.payload.image.buffer).equals(distinctPng(11))).toBe(true);
	});

	it("无目标行不留原件 —— 按钮本来就不给它", async () => {
		const entry = await store.record(
			input({ targetId: null, messages: [{ payload: text("卡片"), role: "main" }] }),
		);
		expect(entry.status).toBe("no-targets");
		expect(await draftFiles(entry.createdAt)).toEqual([]);
	});

	it("没给 repush 的历史仓照常工作,只是不留原件", async () => {
		const bare = createHistoryStore({
			dataRoot: dataDir,
			bus: createNodeMessageBus(),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			images: historyImages,
		});
		const entry = await bare.record(input());
		expect(entry.status).toBe("delivered");
		expect(await draftFiles(entry.createdAt)).toEqual([]);
	});
});

describe("deleteRange → 原件跟着没", () => {
	it("行被删掉,它的原件也不见了", async () => {
		const entry = await store.record(input());
		expect(await draftFiles(entry.createdAt)).toHaveLength(1);
		const ms = Date.parse(entry.createdAt);
		expect(await store.deleteRange({ fromMs: ms - 1000, toMs: ms + 1000 })).toBe(1);
		expect(await draftFiles(entry.createdAt)).toEqual([]);
	});

	it("窗外的行不受影响,原件照留", async () => {
		const entry = await store.record(input());
		const ms = Date.parse(entry.createdAt);
		expect(await store.deleteRange({ fromMs: ms + 60_000, toMs: ms + 120_000 })).toBe(0);
		expect(await draftFiles(entry.createdAt)).toHaveLength(1);
	});
});
