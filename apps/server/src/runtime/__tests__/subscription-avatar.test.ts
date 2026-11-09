/**
 * 新建订阅解析门候选带的头像 data URL(ADR-0019 决策 49):128 KiB 封顶、只收 png / jpeg / webp,
 * 声明的类型得对得上字节。来源后报的头像已经过图库存好图,不再经过这里。
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { i18n } from "../../i18n/index.js";
import { decodeSubscriptionAvatar } from "../subscription-avatar.js";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

describe("decodeSubscriptionAvatar(候选里的 data URL)", () => {
	it.each([
		[
			"en",
			(type: string) => `The avatar declares image/${type}, but its content is not in that format.`,
		],
		[
			"ja",
			(type: string) =>
				`アバターはimage/${type}として宣言されていますが、内容がその形式ではありません。`,
		],
		["zh-TW", (type: string) => `頭像宣告為 image/${type}，但內容不是該格式。`],
	] as const)("%s：拒绝类型与字节不符，合法头像仍保留原字节", (locale, message) => {
		i18n.set({ locale, voice: "plain" });
		for (const type of ["png", "webp"] as const) {
			expect(decodeSubscriptionAvatar(avatarDataUrl(type, JPEG_BYTES))).toEqual({
				ok: false,
				code: "invalid",
				message: message(type),
			});
		}
		const url = avatarDataUrl("png", PNG_BYTES);
		expect(decodeSubscriptionAvatar(url)).toEqual({ ok: true, bytes: PNG_BYTES });
	});

	it.each([
		["png", PNG_BYTES],
		["jpeg", JPEG_BYTES],
		["webp", WEBP_BYTES],
	] as const)("%s:声明的类型与字节对得上 → 解成字节", (type, bytes) => {
		const decoded = decodeSubscriptionAvatar(avatarDataUrl(type, bytes));
		expect(decoded.ok && decoded.bytes.equals(bytes)).toBe(true);
	});

	it.each([
		["声明 png、字节是 jpeg", avatarDataUrl("png", JPEG_BYTES)],
		["声明 webp、字节是 png", avatarDataUrl("webp", PNG_BYTES)],
		["声明 jpeg、字节是 webp", avatarDataUrl("jpeg", WEBP_BYTES)],
		["svg", avatarDataUrl("svg+xml", Buffer.from("<svg/>"))],
		["不是 data URL", "https://example.com/a.png"],
	])("%s → 拒收,并点名原因", (_label, dataUrl) => {
		const decoded = decodeSubscriptionAvatar(dataUrl);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) expect(decoded.message.length).toBeGreaterThan(0);
	});
});
