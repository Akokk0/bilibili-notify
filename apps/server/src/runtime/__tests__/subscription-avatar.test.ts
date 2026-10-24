/**
 * 新建订阅解析门候选带的头像 data URL(ADR-0019 决策 49):128 KiB 封顶、只收 png / jpeg / webp,
 * 声明的类型得对得上字节。来源后报的头像已经过图库存好图,不再经过这里。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { decodeSubscriptionAvatar } from "../subscription-avatar.js";

describe("decodeSubscriptionAvatar(候选里的 data URL)", () => {
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
