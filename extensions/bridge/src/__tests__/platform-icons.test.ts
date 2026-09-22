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

	/**
	 * 🔴 平台名是对端报的开放字符串,这张表拿普通对象按下标查的话:`constructor` 会读到
	 * `[Function: Object]`、`__proto__` 读到 `Object.prototype` —— 进了视图的 icon 格,宿主
	 * 校验不过就把**整份视图**换成一条错误提示。查表前先转小写,所以要试的是转完还落在原型链上的
	 * 那几个(`toString` 转完是 `tostring`,碰不上)。
	 */
	it.each(["constructor", "__proto__", "Constructor", "__PROTO__"])(
		"%s —— 原型链上的名字不算带着的平台",
		(platform) => {
			expect(platformIcon(platform)).toBeUndefined();
		},
	);
});
