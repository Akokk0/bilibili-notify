/**
 * 「怎么用三态能力」只写一份 —— 服务端的派发器 / 审批守卫 / devtools 与面板的订阅抽屉 /
 * 审批开关 / 链接解析设置都读这三个函数。表驱动钉住的就是主人定的那张表:
 *
 * | 用在哪             | 支持 | 不支持 | 还不知道 |
 * | 单发 @全体         | 发   | 不发   | 发       |
 * | 锐评审批能不能开   | 能   | 不能   | 不能     |
 * | 链接解析列不列这个群 | 列   | 不列   | 列       |
 */

import { describe, expect, it } from "vite-plus/test";
import { canReceiveReply, listsForLinkParsing, shouldSendAtAll } from "../constants";

type Support = { state: "supported" | "unsupported" | "unknown" } | undefined;

const SUPPORTED: Support = { state: "supported" };
const UNSUPPORTED: Support = { state: "unsupported" };
const UNKNOWN: Support = { state: "unknown" };

describe("shouldSendAtAll —— 不是「不支持」就发", () => {
	it.each([
		["支持 → 发", SUPPORTED, true],
		["不支持 → 不发", UNSUPPORTED, false],
		["还不知道 → 发", UNKNOWN, true],
		["undefined(按还不知道) → 发", undefined, true],
	] as const)("%s", (_what, support, expected) => {
		expect(shouldSendAtAll(support)).toBe(expected);
	});
});

describe("canReceiveReply —— 只有「支持」才算", () => {
	it.each([
		["支持 → 能", SUPPORTED, true],
		["不支持 → 不能", UNSUPPORTED, false],
		["还不知道 → 不能", UNKNOWN, false],
		["undefined(按还不知道) → 不能", undefined, false],
	] as const)("%s", (_what, support, expected) => {
		expect(canReceiveReply(support)).toBe(expected);
	});
});

describe("listsForLinkParsing —— 不是「不支持」就列", () => {
	it.each([
		["支持 → 列", SUPPORTED, true],
		["不支持 → 不列", UNSUPPORTED, false],
		["还不知道 → 列", UNKNOWN, true],
		["undefined(按还不知道) → 列", undefined, true],
	] as const)("%s", (_what, support, expected) => {
		expect(listsForLinkParsing(support)).toBe(expected);
	});
});
