/**
 * `deleteRange`:按时间窗删行 —— devtools 截流「清掉截流期间历史行」用的。
 *
 * 守的契约:
 *   - 窗内的行整条消失(本体行 + 它的补丁行一起),窗外的一行不少
 *   - 行上引用的图片文件一并删掉,别在 dev 数据目录里留孤儿
 *   - 删掉的行如果还「开着」(同 pushId 再来会追加),也得从内存表摘掉 —— 否则下一段追加
 *     会写一条补丁行,补的是一行已经不存在的本体
 *   - 回删了几行
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, NotificationPayload } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryRecordInput, type HistoryStore } from "../store.js";

let dataDir: string;
let store: HistoryStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-hist-del-"));
	store = createHistoryStore({
		dataDir,
		bus: createNodeMessageBus(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	});
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const SUB = randomUUID();
const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };

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
		...over,
	};
}

async function at(iso: string, over: Partial<HistoryRecordInput> = {}): Promise<HistoryEntry> {
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
		expect(await dayLines(row.ts)).toHaveLength(2);

		await store.deleteRange({
			fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
			toMs: Date.parse("2026-09-06T08:10:00.000Z"),
		});

		expect(await dayLines(row.ts)).toEqual([]);
	});

	it("行上引用的图片一并删掉", async () => {
		const row = await at("2026-09-06T08:01:00.000Z", {
			messages: [
				{
					payload: { kind: "image", image: { buffer: Buffer.from("png"), mime: "image/png" } },
					role: "main",
					result: OK,
				},
			],
		});
		const imgDir = store.imageDir();
		expect(await readdir(imgDir)).toHaveLength(1);

		await store.deleteRange({
			fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
			toMs: Date.parse("2026-09-06T08:10:00.000Z"),
		});

		expect(await readdir(imgDir)).toEqual([]);
		expect((await store.query({ limit: 10 })).map((e) => e.id)).not.toContain(row.id);
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
		const path = join(dataDir, "history", `${row.ts.slice(0, 10)}.jsonl`);
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
		expect(await dayLines(row.ts)).toHaveLength(1);
	});

	it("窗里没有行 → 0,文件原样", async () => {
		const row = await at("2026-09-06T08:01:00.000Z");
		const deleted = await store.deleteRange({
			fromMs: Date.parse("2026-09-06T09:00:00.000Z"),
			toMs: Date.parse("2026-09-06T10:00:00.000Z"),
		});
		expect(deleted).toBe(0);
		expect(await dayLines(row.ts)).toHaveLength(1);
	});
});
