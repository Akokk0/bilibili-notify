import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import {
	digestOf,
	EXTENSION_ZIP_EPOCH,
	PAYLOAD_ZIP_EPOCH,
	reproducibleZip,
} from "./reproducible-zip.mjs";

/**
 * 这两条不是「测函数返回什么」,而是**把已经发出去的那些包的字节钉住**:两个 epoch 各自
 * 的值早就烧进了线上包的 sha256 里,换掉任何一个(或者把两个统一成一个),重跑那条老 tag
 * 打出来的字节就和当初发出去的不一样 —— 而流水线全绿。所以这里写死摘要:动了就红。
 */
describe("可复现的 zip", () => {
	const files = { "a.txt": strToU8("bilibili-notify") };

	it("拓展包那条链的 epoch 不许动", () => {
		expect(digestOf(reproducibleZip(files, EXTENSION_ZIP_EPOCH))).toEqual({
			sha256: "ae93903903957632822082d1fd311c548e45e17ea173874713738f6b0a7a8209",
			size: 122,
		});
	});

	it("升级载荷那条链的 epoch 不许动,而且与拓展包那份**不是**同一个", () => {
		expect(digestOf(reproducibleZip(files, PAYLOAD_ZIP_EPOCH))).toEqual({
			sha256: "f2da03d8e5c78a8f26ff9f0ee1e49f1d743f6c69d2b4e654147083ba85f040fa",
			size: 122,
		});
	});
});

describe("digestOf", () => {
	it("就是这份字节的 sha256 与长度 —— 清单 / 索引直接拿去用", () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		expect(digestOf(bytes)).toEqual({
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: 5,
		});
	});
});
