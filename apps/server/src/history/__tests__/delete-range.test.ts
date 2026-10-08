/**
 * `deleteRange`:按时间窗删行 —— devtools 截流「清掉截流期间历史行」用的。
 *
 * 守的契约:
 *   - 窗内的行整条消失(本体行 + 它的补丁行一起),窗外的一行不少
 *   - 行上引用的图**不由这里删**(图在图库里,可能还被别的行引用):行没了,图库的清扫过了宽限期按引用收走
 *   - 删掉的行如果还「开着」(同 pushId 再来会追加),也得从内存表摘掉 —— 否则下一段追加
 *     会写一条补丁行,补的是一行已经不存在的本体
 *   - 回删了几行
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { IMAGE_GRACE_MS, type ImageStore } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryStore, type NewHistoryEntry } from "../store.js";

let dataDir: string;
let store: HistoryStore;
let imageStore: ImageStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-del-"));
	const images = makeHistoryImages(dataDir);
	imageStore = images.imageStore;
	store = createHistoryStore({
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		images: images.historyImages,
	});
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const SUB = randomUUID();
const T1 = randomUUID();
const OK = ok({ latencyMs: 5 });

function text(t: string): NotificationPayload {
	return { kind: "text", text: t };
}

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

async function at(iso: string, over: Partial<NewHistoryEntry> = {}): Promise<HistoryEntry> {
	vi.setSystemTime(new Date(iso));
	return store.record(input(over));
}

async function dayLines(dateIso: string): Promise<string[]> {
	const raw = await readFile(join(dataDir, "history", `${dateIso.slice(0, 10)}.jsonl`), "utf8");
	return raw.split("\n").filter((l) => l.trim() !== "");
}

describe("deleteRange", () => {
	it("窗内的行消失,窗外的一行不少;回删了几行", async () => {
		const before = await at("2026-09-06T07:59:00.000Z");
		const inside1 = await at("2026-09-06T08:01:00.000Z");
		const inside2 = await at("2026-09-06T08:05:00.000Z");
		const after = await at("2026-09-06T08:11:00.000Z");

		const deleted = await store.deleteRange({
			fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
			toMs: Date.parse("2026-09-06T08:10:00.000Z"),
		});

		expect(deleted).toBe(2);
		const ids = (await store.query({ limit: 100 })).map((e) => e.id);
		expect(ids).toEqual([after.id, before.id]);
		expect(ids).not.toContain(inside1.id);
		expect(ids).not.toContain(inside2.id);
	});

	it("补丁行跟着本体一起走,盘上不留孤儿补丁", async () => {
		const pushId = randomUUID();
		const row = await at("2026-09-06T08:01:00.000Z", { pushId });
		await at("2026-09-06T08:02:00.000Z", {
			pushId,
			messages: [{ payload: text("@全体"), role: "extra", result: OK }],
		});
		expect(await dayLines(row.createdAt)).toHaveLength(2);

		await store.deleteRange({
			fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
			toMs: Date.parse("2026-09-06T08:10:00.000Z"),
		});

		expect(await dayLines(row.createdAt)).toEqual([]);
	});

	const imageRow = (n: number): NewHistoryEntry["messages"] => [
		{
			payload: { kind: "image", image: { buffer: distinctPng(n), mime: "image/png" } },
			role: "main",
			result: OK,
		},
	];
	const WINDOW = {
		fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
		toMs: Date.parse("2026-09-06T08:10:00.000Z"),
	};
	/** 宽限期过了:清扫按「一天多以后」的时钟算。图的修改时间是文件系统的真时钟,不是这里假的那个。 */
	const afterGrace = () => new Date(vi.getRealSystemTime() + IMAGE_GRACE_MS + 60 * 60 * 1000);

	it("行上引用的图不由 deleteRange 删,图库的清扫在行没了、宽限期过了以后才收走", async () => {
		const row = await at("2026-09-06T08:01:00.000Z", { messages: imageRow(1) });
		const ref = row.messages[0]?.payload.image ?? "";
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);

		await store.deleteRange(WINDOW);

		expect((await store.query({ limit: 10 })).map((e) => e.id)).not.toContain(row.id);
		// 行没了,图还在 —— 删行的这一步不碰图。
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);
		const swept = await imageStore.sweep({ now: afterGrace() });
		expect(swept.removed).toEqual([ref]);
		expect(await readdir(join(dataDir, "images"))).toEqual([]);
	});

	it("同一张图还被窗外的另一行引用着:行删了、清扫也不收", async () => {
		const gone = await at("2026-09-06T08:01:00.000Z", { messages: imageRow(2) });
		const kept = await at("2026-09-06T09:00:00.000Z", { messages: imageRow(2) });
		const ref = gone.messages[0]?.payload.image ?? "";
		expect(kept.messages[0]?.payload.image).toBe(ref);

		await store.deleteRange(WINDOW);

		const swept = await imageStore.sweep({ now: afterGrace() });
		expect(swept).toMatchObject({ removed: [], referenced: 1 });
		expect(await readdir(join(dataDir, "images"))).toEqual([ref]);
	});

	it("删掉的开着的行从内存表摘掉:同 pushId 再来是新建一行,不是补丁", async () => {
		const pushId = randomUUID();
		const first = await at("2026-09-06T08:01:00.000Z", { pushId });
		await store.deleteRange({
			fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
			toMs: Date.parse("2026-09-06T08:10:00.000Z"),
		});

		const again = await at("2026-09-06T08:12:00.000Z", {
			pushId,
			messages: [{ payload: text("@全体"), role: "extra", result: OK }],
		});

		expect(again.id).not.toBe(first.id);
		expect(again.messages).toHaveLength(1);
		expect((await store.query({ limit: 10 })).map((e) => e.id)).toEqual([again.id]);
	});

	it("跨天的窗每个日文件都清", async () => {
		const d1 = await at("2026-09-05T23:59:00.000Z");
		const d2 = await at("2026-09-06T00:01:00.000Z");
		const keep = await at("2026-09-06T01:00:00.000Z");

		const deleted = await store.deleteRange({
			fromMs: Date.parse("2026-09-05T23:00:00.000Z"),
			toMs: Date.parse("2026-09-06T00:30:00.000Z"),
		});

		expect(deleted).toBe(2);
		const ids = (await store.query({ limit: 10 })).map((e) => e.id);
		expect(ids).toEqual([keep.id]);
		expect(ids).not.toContain(d1.id);
		expect(ids).not.toContain(d2.id);
	});

	it("日文件读不动 → 整趟失败,绝不当成空文件把它改写掉", async () => {
		// 破坏性改写是「先读整份、再把留下的写回去」。读要是能半路失败又被咽掉,写回去的
		// 就是残缺的那半份 —— 剩下的行永久消失,而且回的 deleted 还小得像没事发生。
		// 所以这条路上的读必须全有或全无:读不动就抛,文件一个字节都不许动。
		const row = await at("2026-09-06T08:01:00.000Z");
		const path = join(dataDir, "history", `${row.createdAt.slice(0, 10)}.jsonl`);
		if (process.getuid?.() === 0) return; // root 无视权限位,这条测不了
		await chmod(path, 0o000);
		try {
			await expect(
				store.deleteRange({
					fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
					toMs: Date.parse("2026-09-06T08:10:00.000Z"),
				}),
			).rejects.toThrow();
		} finally {
			await chmod(path, 0o600);
		}
		expect(await dayLines(row.createdAt)).toHaveLength(1);
	});

	it("窗里没有行 → 0,文件原样", async () => {
		const row = await at("2026-09-06T08:01:00.000Z");
		const deleted = await store.deleteRange({
			fromMs: Date.parse("2026-09-06T09:00:00.000Z"),
			toMs: Date.parse("2026-09-06T10:00:00.000Z"),
		});
		expect(deleted).toBe(0);
		expect(await dayLines(row.createdAt)).toHaveLength(1);
	});
});
