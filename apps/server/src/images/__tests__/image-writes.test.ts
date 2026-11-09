/**
 * 图库延迟写入入口 `deferImageWrites`：过滤后、出卡前才提交。
 *
 * 图用**真的图库**存(临时目录),引用是真的内容哈希,字节能从图库读回来。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { png } from "../../__tests__/support/report-images.js";
import { i18n } from "../../i18n/index.js";
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
	i18n.set({ locale: "zh-CN", voice: "maid" });
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

describe("deferred image write feedback", () => {
	it.each([
		[
			"en",
			{
				invalid:
					"Unsupported image. Only png / jpg / gif / webp up to 8 MiB per image are accepted.",
				disk: "Could not save the post image to the library: Original disk 原文",
				expected: "Post image reference mismatch: expected ",
				actual: ", library returned ",
			},
		],
		[
			"ja",
			{
				invalid: "対応していない画像です。1枚8 MiB以下のpng / jpg / gif / webpのみ受け付けます。",
				disk: "投稿画像を画像ライブラリに保存できません：Original disk 原文",
				expected: "投稿画像の参照が一致しません：期待値 ",
				actual: "、画像ライブラリの戻り値 ",
			},
		],
		[
			"zh-TW",
			{
				invalid: "不支援此圖片，只接受每張不超過 8 MiB 的 png / jpg / gif / webp。",
				disk: "無法將作品圖片存入圖片庫：Original disk 原文",
				expected: "作品圖片引用不符：預期 ",
				actual: "，圖片庫回傳 ",
			},
		],
	] as const)(
		"%s localizes deferred-write failures without losing diagnostics or reference identity",
		async (locale, text) => {
			const bytes = png(10, 10, 1);
			const expected = await refOf(bytes);
			i18n.set({ locale, voice: "plain" });
			const put = vi.fn(async () => fail("unavailable", "Original disk 原文"));
			const broken = deferImageWrites({ put });
			expect(await broken.sink.put(new Uint8Array())).toEqual({
				ok: false,
				code: "invalid",
				message: text.invalid,
			});
			expect(put).not.toHaveBeenCalled();
			expect(await broken.sink.put(bytes)).toEqual({ ok: true, ref: expected });
			await expect(broken.commit()).rejects.toThrow(text.disk);
			await expect(broken.commit()).rejects.toThrow(text.disk);
			expect(put).toHaveBeenCalledTimes(1);
			const actual = `${"f".repeat(64)}.png`;
			const drifted = deferImageWrites({ put: async () => ({ ok: true, ref: actual }) });
			await drifted.sink.put(bytes);
			await expect(drifted.commit()).rejects.toThrow(
				`${text.expected}${expected}${text.actual}${actual}`,
			);
		},
	);
});

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
