/**
 * 图库延迟写入入口 `deferImageWrites`：过滤后、出卡前才提交。
 *
 * 图用**真的图库**存(临时目录),引用是真的内容哈希,字节能从图库读回来。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { png } from "../../__tests__/support/report-images.js";
import {
	createImageStore,
	IMAGE_MAX_BYTES,
	type ImageStore,
	type ImageWriter,
} from "../image-store.js";
import { deferImageWrites } from "../image-writes.js";

let dir: string;
let store: ImageStore;
let writer: ImageWriter;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-image-writes-"));
	store = createImageStore({ dir: join(dir, "images") });
	writer = store.register({ name: "作品配图", listRefs: async () => [] });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const refOf = async (bytes: Uint8Array) => {
	const stored = await writer.put(bytes);
	if (!stored.ok) throw new Error(`夹具图存不进图库:${stored.message}`);
	return stored.ref;
};

/**
 * 图的写盘推迟到出卡那一刻(㉑e)。过滤吃翻好的 `Post`,所以翻译要排在过滤之前 —— 而被屏蔽的、关了出图的、版式藏起卡片的
 * 作品根本不出卡,不该为它们往图库写盘。引用是内容哈希(`imageRefOf`,和真存图起的名字一致),翻译时不用写就知道。
 */
describe("deferImageWrites — 翻译时只算引用,出卡前才真正写进图库", () => {
	it("put 回的引用与真存进图库得到的逐字相同(取名规矩只此一份),但 commit 之前图库里什么都没有", async () => {
		const bytes = png(10, 10, 4);
		const deferred = deferImageWrites(writer);
		const result = await deferred.sink.put(bytes);
		if (!result.ok) throw new Error(result.message);
		expect(await store.read(result.ref)).toBeUndefined();

		await deferred.commit();
		const read = await store.read(result.ref);
		expect(read && Buffer.from(read.bytes).equals(Buffer.from(bytes))).toBe(true);
		// 真存一遍(内容寻址,同一份字节同一个名字)—— 推迟的那个引用就是它。
		expect(await refOf(bytes)).toBe(result.ref);
	});

	it("图库不收的图(格式不认 / 超 8 MiB)和真存一样回 invalid,commit 也不去写它", async () => {
		const put = vi.spyOn(writer, "put");
		const deferred = deferImageWrites(writer);
		for (const bad of [new Uint8Array([1, 2, 3]), png(10, 10, 9, IMAGE_MAX_BYTES + 1)]) {
			const result = await deferred.sink.put(bad);
			expect(result).toMatchObject({ ok: false, code: "invalid" });
		}
		await deferred.commit();
		expect(put).not.toHaveBeenCalled();
	});

	it("没 commit 就不写:put 之后真图库的口一次都没被调", async () => {
		const put = vi.spyOn(writer, "put");
		const deferred = deferImageWrites(writer);
		await deferred.sink.put(png(10, 10, 1));
		await deferred.sink.put(png(10, 10, 2));
		expect(put).not.toHaveBeenCalled();
	});

	it("commit 把推迟的图各写一次(同一份字节只写一次),重复 commit 不再写", async () => {
		const put = vi.spyOn(writer, "put");
		const deferred = deferImageWrites(writer);
		const a = png(10, 10, 1);
		await deferred.sink.put(a);
		await deferred.sink.put(a);
		await deferred.sink.put(png(10, 10, 2));
		await deferred.commit();
		await deferred.commit();
		expect(put).toHaveBeenCalledTimes(2);
	});

	it("磁盘写失败:commit 抛错(这一次出卡失败,装配降级成纯文字),不是悄悄少一张", async () => {
		const failing: Pick<ImageWriter, "put"> = {
			put: async () => {
				throw new Error("磁盘满了");
			},
		};
		const deferred = deferImageWrites(failing);
		await deferred.sink.put(png(10, 10, 1));
		await expect(deferred.commit()).rejects.toThrow("磁盘满了");
	});

	it("图库说存不进(与本地判断对不上):commit 抛错,不吞", async () => {
		const refusing: Pick<ImageWriter, "put"> = {
			put: async () => ({ ok: false, code: "invalid", message: "不收" }),
		};
		const deferred = deferImageWrites(refusing);
		await deferred.sink.put(png(10, 10, 1));
		await expect(deferred.commit()).rejects.toThrow("不收");
	});

	it("图库给的引用与算出来的不一样(取名规矩漂了):commit 抛错,免得 Post 里挂着一个指向别处的引用", async () => {
		const drifted: Pick<ImageWriter, "put"> = {
			put: async () => ({ ok: true, ref: `${"f".repeat(64)}.png` }),
		};
		const deferred = deferImageWrites(drifted);
		await deferred.sink.put(png(10, 10, 1));
		await expect(deferred.commit()).rejects.toThrow("对不上");
	});
});

describe("deferImageWrites — 真图库写盘失败(环境的事)", () => {
	it("图库的目录建不出来:commit 抛、原因带着(这一次出卡失败,装配降级成纯文字)", async () => {
		// 图库的目录是个普通文件:往里写必挂(ENOTDIR)。
		const blocked = join(dir, "挡路");
		await writeFile(blocked, "x");
		const broken = createImageStore({ dir: blocked }).register({
			name: "作品配图",
			listRefs: async () => [],
		});
		const deferred = deferImageWrites(broken);
		await deferred.sink.put(png(10, 10, 1));

		await expect(deferred.commit()).rejects.toThrow(/ENOTDIR/);
	});
});
