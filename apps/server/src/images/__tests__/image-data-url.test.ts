/**
 * 出图器的「图库引用 → 可画的地址」解析口(`imageRefDataUrl`,㉑d)。
 *
 * 要的性质:同一份字节转出来的 data URL 与拓展作品从前直接转字节的写法**逐字相同**(这是「作品卡从内存字节换成图库
 * 字节后可见内容不变」的依据);引用指着的图不在了、引用不合规矩、读盘出错都回 `undefined`(出图器画占位,不拖累整张卡)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { putImage } from "../../__tests__/support/chat-images.js";
import { imageRefDataUrl } from "../image-data-url.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../image-store.js";
import { imageDataUrl } from "../profile-avatar.js";

let dir: string;
let store: ImageStore;
let writer: ImageWriter;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-image-data-url-"));
	store = createImageStore({ dir: join(dir, "images") });
	writer = store.register({ name: "测试", listRefs: async () => [] });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("imageRefDataUrl", () => {
	it("引用 → data URL,类型取图库认出来的类型,字节原样编码;与直接转字节的写法逐字相同", async () => {
		const resolve = imageRefDataUrl(store);
		for (const [bytes, mime] of [
			[PNG_BYTES, "image/png"],
			[JPEG_BYTES, "image/jpeg"],
			[WEBP_BYTES, "image/webp"],
		] as const) {
			const ref = await putImage(writer, bytes);
			const url = await resolve(ref);
			expect(url).toBe(`data:${mime};base64,${bytes.toString("base64")}`);
			expect(url).toBe(imageDataUrl(bytes));
		}
	});

	it("图不在了(被清扫 / 从没存过)、引用不合规矩:回 undefined,不抛", async () => {
		const resolve = imageRefDataUrl(store);
		expect(await resolve(`${"0".repeat(64)}.png`)).toBeUndefined();
		expect(await resolve("../../etc/passwd")).toBeUndefined();
		expect(await resolve("")).toBeUndefined();
	});

	it("读盘出错:回 undefined(一张图坏了不拖累整张卡),不往外抛", async () => {
		const resolve = imageRefDataUrl({
			read: async () => {
				throw new Error("EIO");
			},
		});
		await expect(resolve(`${"0".repeat(64)}.png`)).resolves.toBeUndefined();
	});
});
