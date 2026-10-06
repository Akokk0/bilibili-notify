/**
 * 单元测试 — `ConversationStore.clear()`(㉙d「存储占用」清女仆 AI;真实 tmpdir FS)。
 *
 * 守护契约:
 *   - 目录里全部文件都删:正常会话、零消息的空壳、读不成 JSON 的坏文件
 *   - 清完列表为空,之后还能新建、新聊(清空不是关门)
 *   - 正在跑的那一轮(`markBusy`)照 `remove` 的口径:它拿到回复后的 `appendMessages` 回 `null`,不凭空造一个
 *   - 目录不在也成功;排在在飞的写后面,清完不会被它写回来
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import {
	CONVERSATIONS_DIR,
	type ConversationStore,
	createConversationStore,
} from "../conversation-store.js";

// 落盘函数前的闸默认敞开;只有「排在在飞的写后面」那条用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

let dataRoot: string;
let store: ConversationStore;
beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-conv-clear-"));
	store = createConversationStore({ dataRoot, logger: silentLogger });
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(dataRoot, { recursive: true, force: true });
});

const dir = () => join(dataRoot, ...CONVERSATIONS_DIR);

describe("clear", () => {
	it("全部文件都删:正常会话、零消息空壳、坏文件", async () => {
		const real = await store.create();
		await store.appendMessages(real.id, [{ role: "user", content: "问" }]);
		await store.create(); // 零消息的空壳
		await writeFile(join(dir(), "broken.json"), "{not json");
		expect((await readdir(dir())).length).toBe(3);

		await store.clear();

		expect(await readdir(dir())).toEqual([]);
		expect(await store.list()).toEqual([]);
	});

	it("清空不是关门:之后照常新建、追加", async () => {
		await store.create();
		await store.clear();
		const next = await store.create();
		expect(await store.appendMessages(next.id, [{ role: "user", content: "再来" }])).not.toBeNull();
		expect((await store.list()).map((c) => c.id)).toEqual([next.id]);
	});

	it("在跑的那一轮:拿到回复后追加到已清空的会话回 null,盘上不留幽灵会话", async () => {
		const running = await store.create();
		const release = store.markBusy(running.id);
		await store.clear();
		expect(
			await store.appendMessages(running.id, [{ role: "assistant", content: "迟到的回复" }]),
		).toBeNull();
		release();
		expect(await readdir(dir())).toEqual([]);
	});

	it("目录还没建(一次都没聊过)也成功", async () => {
		await expect(store.clear()).resolves.toBeUndefined();
	});

	it("排在在飞的写后面:停在写盘前的追加,清空等着它,清完不会被写回来", async () => {
		const conv = await store.create();
		storageWriteGate.hold();
		const pending = store.appendMessages(conv.id, [{ role: "user", content: "问" }]);
		await storageWriteGate.arrived();
		let cleared = false;
		const clearing = store.clear().then(() => {
			cleared = true;
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(cleared).toBe(false);
		storageWriteGate.release();
		await Promise.all([pending, clearing]);
		expect(await readdir(dir())).toEqual([]);
	});

	it("目录里多出来的东西(子目录、杂文件)也清掉,目录本身留着", async () => {
		await mkdir(join(dir(), "stray"), { recursive: true });
		await writeFile(join(dir(), "stray", "x"), "1");
		await writeFile(join(dir(), "note.txt"), "2");
		await store.clear();
		expect(await readdir(dir())).toEqual([]);
	});
});
