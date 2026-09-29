/**
 * 资产存储的原名清单是模块级的写道(同一个进程里同一目录可以有好几个 store 实例),关停时只 flush、
 * 不关门 —— 见 `flushAssetLabelWrites`。这里钉那两句:等得到在途的清单写,flush 之后照样收写。
 *
 * 单独一个文件:`asset-store.test.ts` 全走真目录、不 mock 原语,而要让清单写停在半路只能垫存储层的闸。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { type AssetStore, createAssetStore, flushAssetLabelWrites } from "../asset-store.js";

// 落盘函数前的闸默认敞开;只有 hold 之后才拦(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;
let dir: string;
let store: AssetStore;

beforeEach(async () => {
	storageWriteGate.reset();
	root = await mkdtemp(join(tmpdir(), "bn-asset-flush-"));
	dir = join(root, "assets");
	store = createAssetStore({
		dir,
		formats: { png: "image/png" },
		maxBytes: 1024,
		naming: { kind: "random" },
		labelsFile: "index.json",
	});
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(root, { recursive: true, force: true });
});

describe("flushAssetLabelWrites:关停时只等、不关门", () => {
	it("等到在途的清单写落盘才落定", async () => {
		// 资产字节先落进去(不拦),再拦住随后那笔清单写。
		storageWriteGate.hold();
		const putting = store.put({ bytes: PNG, ext: "png", label: "甲.png" });
		await storageWriteGate.arrived();
		// 字节那一笔停在闸门口:放它过去,下一笔(清单)再拦住。
		storageWriteGate.release();
		storageWriteGate.hold();
		await storageWriteGate.arrived();

		let flushed = false;
		const flushing = flushAssetLabelWrites().then(() => {
			flushed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(flushed).toBe(false);

		storageWriteGate.release();
		await flushing;
		const result = await putting;
		if (!result.ok) throw new Error(result.message);
		const labels = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as Record<
			string,
			string
		>;
		expect(labels[result.id]).toBe("甲.png");
	});

	it("flush 过之后队列照样收写:模块级的队被同一进程里下一个起的服务接着用", async () => {
		await flushAssetLabelWrites();
		const result = await store.put({ bytes: PNG, ext: "png", label: "乙.png" });
		if (!result.ok) throw new Error(result.message);
		expect(await store.labels()).toEqual({ [result.id]: "乙.png" });
	});
});
