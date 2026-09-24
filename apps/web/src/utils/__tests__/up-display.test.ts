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

/**
 * 颜色与搬家之前一字不差(ADR-0020 决策 15:拓展的配色种子搬进 internal,面板与出卡共用)。下面的
 * 色值是拿**搬之前**那份代码(git 里 up-display.ts 的 `extensionColorSeed` + internal 的
 * `colorFromUid`)现算出来写死的 —— 搬完之后订阅卡、历史行上同一个人的颜色一个都不许变。
 */
describe("颜色与搬家之前一字不差", () => {
	const BILI: Array<[string, string]> = [
		["1", "#ffaf7b"],
		["12345", "#fb7299"],
		["946974", "#01b355"],
		["387654321", "#ff9c89"],
	];
	const EXT: Array<[string, string, string]> = [
		["douyin", "12345", "#ffaf7b"],
		["douyin", "MS4wLjABAAAA-abc/def", "#fb7299"],
		["fake-source", "1", "#b3cd2f"],
		["kuaishou", "3xabc", "#ff93d1"],
	];

	it("B 站:订阅卡与历史行都是搬之前那个颜色", () => {
		for (const [uid, color] of BILI) {
			expect(subscriptionColor(makeEmptySubscription(uid)), uid).toBe(color);
			expect(historyRowColor({ subscriptionId: "s", uid }), uid).toBe(color);
		}
	});

	it("拓展:订阅卡与历史行都是搬之前那个颜色", () => {
		for (const [extensionId, externalId, color] of EXT) {
			const sub = makeEmptyExtensionSubscription(extensionId, externalId);
			expect(subscriptionColor(sub), externalId).toBe(color);
			expect(historyRowColor({ subscriptionId: "s", extensionId, externalId }), externalId).toBe(
				color,
			);
		}
	});

	it("两格都没有的历史行退订阅 id,也是搬之前那个颜色", () => {
		expect(historyRowColor({ subscriptionId: "s-only" })).toBe("#b3cd2f");
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
