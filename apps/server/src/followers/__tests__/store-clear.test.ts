/**
 * 单元测试 — `FollowersStore.clear()`(㉙d「存储占用」清数据统计的粉丝那一半;真实 tmpdir FS)。
 *
 * 守护契约:盘上每个键的文件都删、没有文件也成功;经各键的写队,排在这个键在飞的追加之后,清完不会被写回来;
 * 清空之后新的样本照常追加。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { createFollowersStore, FOLLOWERS_DIR, type FollowersStore } from "../store.js";

// 落盘函数前的闸默认敞开;只有「排在在飞的追加后面」那条用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

let dataRoot: string;
let store: FollowersStore;
beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-followers-clear-"));
	store = createFollowersStore({ dataRoot, logger: silentLogger });
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(dataRoot, { recursive: true, force: true });
});

const dir = () => join(dataRoot, ...FOLLOWERS_DIR);
const sample = (followers: number) => ({ sampledAt: "2026-10-06T10:00:00.000Z", followers });

describe("clear", () => {
	it("每个键的文件都删", async () => {
		await store.append("a", sample(1));
		await store.append("b", sample(2));
		expect((await store.keys()).sort()).toEqual(["a", "b"]);
		await store.clear();
		expect(await readdir(dir())).toEqual([]);
		expect(await store.keys()).toEqual([]);
	});

	it("没有目录、没有文件也成功", async () => {
		await expect(store.clear()).resolves.toBeUndefined();
		await store.append("a", sample(1));
		await store.clear();
		await expect(store.clear()).resolves.toBeUndefined();
	});

	it("排在这个键在飞的追加后面:追加停在写盘前时清空等着它,清完文件不会被写回来", async () => {
		await store.append("a", sample(1)); // 先让文件存在,clear 才列得出这个键
		storageWriteGate.hold();
		const inFlight = store.append("a", sample(2));
		await storageWriteGate.arrived();
		let cleared = false;
		const clearing = store.clear().then(() => {
			cleared = true;
		});
		// 追加还停在闸门口时,清空没有越过它去删文件。
		await new Promise((r) => setTimeout(r, 30));
		expect(cleared).toBe(false);
		storageWriteGate.release();
		await Promise.all([inFlight, clearing]);
		expect(await readdir(dir())).toEqual([]);
	});

	it("清空之后新的样本照常追加", async () => {
		await store.append("a", sample(1));
		await store.clear();
		await store.append("a", sample(9));
		expect(await store.listSamplesSince("a", "")).toEqual([sample(9)]);
	});
});
