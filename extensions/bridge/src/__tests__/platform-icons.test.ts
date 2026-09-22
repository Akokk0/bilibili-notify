/**
 * 桥带着的平台小表(ADR-0019 决策 31)—— 插件没报图标时,面板上 bot 那一行靠它画方块。
 */

import { describe, expect, it } from "vite-plus/test";
import { platformIcon } from "../platform-icons.js";

/** BN 收图片的那道门(与桥协议 §5.2 同一条):图片的 base64 data URL,整段不超过 32 KB。 */
const HOST_IMAGE = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

describe("platformIcon", () => {
	it.each([
		"onebot",
		"aiocqhttp",
		"qq_official",
		"telegram",
		"discord",
		"lark",
		"dingtalk",
		"wecom",
	])("%s —— 有,而且过得了 BN 那道图片门", (platform) => {
		const icon = platformIcon(platform);
		expect(icon).toMatch(HOST_IMAGE);
		expect((icon ?? "").length).toBeLessThanOrEqual(32 * 1024);
	});

	it("同一个平台在 koishi / AstrBot 两边叫法不同,指的是同一枚;大小写不论", () => {
		expect(platformIcon("aiocqhttp")).toBe(platformIcon("onebot"));
		expect(platformIcon("Telegram")).toBe(platformIcon("telegram"));
		expect(platformIcon("feishu")).toBe(platformIcon("lark"));
	});

	it("没带着的平台 —— undefined(面板退回两个字)", () => {
		expect(platformIcon("kook")).toBeUndefined();
	});
});
