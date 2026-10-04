/**
 * 拓展订阅头像进图库之前的两道关(ADR-0019 决策 49 / 62;存进图库本身归图库,见 `images/image-store.ts`):
 * - 新建订阅时解析门候选带的位图 data URL(128 KiB 封顶):声明的类型得对得上字节;
 * - 拓展报资料时交的字节(约 96 KiB 封顶):类型按文件头认。
 * 两条都只收 png / jpeg / webp —— 图库收 gif,头像不收。
 */

import { SUBSCRIPTION_AVATAR_MAX_BYTES } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { checkSubscriptionAvatarBytes, decodeSubscriptionAvatar } from "../subscription-avatar.js";

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

describe("checkSubscriptionAvatarBytes(拓展报资料交的字节)", () => {
	it.each([
		["png", PNG_BYTES],
		["jpeg", JPEG_BYTES],
		["webp", WEBP_BYTES],
	] as const)("%s:按文件头认 → 收", (_type, bytes) => {
		const checked = checkSubscriptionAvatarBytes(new Uint8Array(bytes));
		expect(checked.ok && checked.bytes.equals(bytes)).toBe(true);
	});

	it.each([
		["gif", Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")],
		["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
		["空的", Buffer.alloc(0)],
		["超过头像的上限", Buffer.concat([PNG_BYTES, Buffer.alloc(SUBSCRIPTION_AVATAR_MAX_BYTES)])],
	])("%s → 拒收", (_label, bytes) => {
		expect(checkSubscriptionAvatarBytes(new Uint8Array(bytes)).ok).toBe(false);
	});
});
