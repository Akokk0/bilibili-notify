/**
 * 历史行在面板上「是谁」(ADR-0019 决策 73):颜色与那行身份小字。
 *
 * - 颜色跟着人走:B 站行按 uid、拓展行按「拓展 id:外部 id」这一串 —— 与订阅卡同一个颜色,删了再加
 *   也不变;两格都没有才退订阅 id。
 * - 身份小字:B 站行「UID xxx」;拓展行「平台名 · 外部 id」,平台名由调用方按已装拓展的清单取。
 */

import { colorFromUid } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import { makeEmptyExtensionSubscription, makeEmptySubscription } from "../../types/domain";
import { historyRowColor, historyRowIdentity, subscriptionColor } from "../up-display";

const BILI_ROW = { subscriptionId: "s-gone", uid: "12345" };
const EXT_ROW = { subscriptionId: "s-gone", extensionId: "douyin", externalId: "12345" };

describe("historyRowColor", () => {
	it("B 站行与它那条订阅卡同一个颜色(按 uid)", () => {
		expect(historyRowColor(BILI_ROW)).toBe(subscriptionColor(makeEmptySubscription("12345")));
	});

	it("拓展行与同一个人的订阅卡同一个颜色 —— 订阅删了又加(id 变了)也一样", () => {
		const readded = makeEmptyExtensionSubscription("douyin", "12345");
		expect(historyRowColor(EXT_ROW)).toBe(subscriptionColor(readded));
	});

	it("拓展行不按外部 id 取色:外部 id 恰好等于某个 B 站 uid 时,取色的种子也不是那串 uid", () => {
		expect(historyRowColor(EXT_ROW)).toBe(colorFromUid("douyin:12345"));
	});

	it("两格都没有 → 退订阅 id", () => {
		expect(historyRowColor({ subscriptionId: "s-only" })).toBe(colorFromUid("s-only"));
	});
});

describe("historyRowIdentity", () => {
	const labelOf = (extensionId: string) => (extensionId === "douyin" ? "抖音" : extensionId);

	it("B 站行:「UID xxx」", () => {
		expect(historyRowIdentity(BILI_ROW, labelOf)).toBe("UID 12345");
	});

	it("拓展行:「平台名 · 外部 id」", () => {
		expect(historyRowIdentity(EXT_ROW, labelOf)).toBe("抖音 · 12345");
	});

	it("拓展行、没给平台名 → 写拓展 id", () => {
		expect(historyRowIdentity(EXT_ROW)).toBe("douyin · 12345");
	});
});
