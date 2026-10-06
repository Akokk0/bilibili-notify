/**
 * 单元测试 — `HistoryStore.clear()`(㉙d「存储占用」清推送历史的文字;真实 tmpdir FS)。
 *
 * 守护契约:
 *   - 全部日文件**真删**(不是写成空文件,那是 `deleteRange` 给「删一段」用的),连同重推原件 `repush/`
 *     (行没了,原件没有任何入口能读到);水位线 `retention.json` 原样
 *   - 经写道:先交出去还没落盘的 `record` 清完不会被写回来
 *   - 内存里「同一次推送还能追加」的行一并忘掉:清空之后同一个 pushId + 目标再来是新建一行,不是往没了的行后面追加
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createHistoryStore, type HistoryStore, type NewHistoryEntry } from "../store.js";

// 落盘函数前的闸默认敞开;只有「排在在飞的写后面」那条用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

let dataRoot: string;
let store: HistoryStore;
beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-history-clear-"));
	const { historyImages } = makeHistoryImages(dataRoot);
	store = createHistoryStore({
		dataRoot,
		bus: createNodeMessageBus(),
		logger: silentLogger,
		images: historyImages,
	});
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(dataRoot, { recursive: true, force: true });
});

const dir = () => join(dataRoot, "history");
const entry = (over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
	pushId: randomUUID(),
	feature: "post",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	subscriptionId: randomUUID(),
	targetId: randomUUID(),
	messages: [
		{ payload: { kind: "text", text: "hi" }, role: "main", result: { ok: true, latencyMs: 1 } },
	],
	...over,
});

describe("clear", () => {
	it("日文件全删(不是写成空文件),重推原件一起删,水位线原样", async () => {
		await store.record(entry());
		await writeFile(join(dir(), "2026-01-01.jsonl"), "{}\n");
		await writeFile(join(dir(), "retention.json"), `{"clearedThrough":"2026-01-01"}`);
		await mkdir(join(dir(), "repush", "2026-01-01"), { recursive: true });
		await writeFile(join(dir(), "repush", "2026-01-01", "r.json"), "{}");

		await store.clear();

		expect(await readdir(dir())).toEqual(["retention.json"]);
		expect(await store.query({})).toEqual([]);
	});

	it("先交出去、停在写盘前的 record 排在清空前面,清空等着它,清完不会被写回来", async () => {
		await store.record(entry()); // 让目录与日文件存在
		storageWriteGate.hold();
		const inFlight = store.record(entry());
		await storageWriteGate.arrived();
		let cleared = false;
		const clearing = store.clear().then(() => {
			cleared = true;
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(cleared).toBe(false);
		storageWriteGate.release();
		await Promise.all([inFlight, clearing]);
		expect((await readdir(dir())).filter((n) => n.endsWith(".jsonl"))).toEqual([]);
	});

	it("忘掉还能追加的行:清空后同一次推送同一目标再来,是新的一行", async () => {
		const first = entry();
		await store.record(first);
		await store.clear();
		const again = await store.record({ ...first });
		expect(again.messages).toHaveLength(1);
		expect(await store.query({})).toHaveLength(1);
	});

	it("没有日文件、目录都没建也成功", async () => {
		await expect(store.clear()).resolves.toBeUndefined();
	});
});
