/**
 * AI 聊天页自己的思考设置(`ai.chat`)—— 与服务商实例桶里的那两格**分家**。
 *
 * 实例桶里的 enableThinking / thinkingLevel 是**引擎**的(动态点评、直播总结、
 * 锐评);聊天页曾经直接改它,于是在对话里拨一下开关,整个女仆的点评行为跟着变。
 * 分家后聊天读写 `ai.chat`,两边互不牵动。
 *
 * 继承语义:`ai.chat` 的字段是 **optional 的「没写 = 跟随当前实例」**。全新配置
 * 什么都不写,聊天页显示的就是女仆引擎的当下值;一旦拨过开关 / 调过等级,那个
 * 字段写实,此后引擎那边怎么改都不再影响聊天(反之亦然)。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveChatThinking } from "../constants";
import { AISettingsSchema } from "./common";

const BASE = {
	enabled: true,
	persona: {
		name: "",
		addressUser: "",
		addressSelf: "",
		traits: "",
		catchphrase: "",
		baseRole: "",
		extraSystemPrompt: "",
	},
	dynamicPrompt: "",
	liveSummaryPrompt: "",
	presets: [],
};

function withProfile(chat?: Record<string, unknown>) {
	return AISettingsSchema.parse({
		...BASE,
		activeProfile: "deepseek",
		providers: {
			deepseek: { provider: "deepseek", enableThinking: true, thinkingLevel: "high" },
		},
		...(chat !== undefined ? { chat } : {}),
	});
}

describe("schema:ai.chat", () => {
	it("老配置没有 chat 段 → 补一个空对象,不是 undefined", () => {
		// 空对象 = 「全跟随」。undefined 会让每个读它的地方都多背一个分支。
		expect(AISettingsSchema.parse({ ...BASE }).chat).toEqual({});
	});

	it("写过的字段原样保留,没写的保持缺席", () => {
		const ai = withProfile({ enableThinking: false });
		expect(ai.chat.enableThinking).toBe(false);
		expect(ai.chat.thinkingLevel).toBeUndefined();
	});

	it("非法等级直接拒", () => {
		expect(AISettingsSchema.safeParse({ ...BASE, chat: { thinkingLevel: "ultra" } }).success).toBe(
			false,
		);
	});
});

describe("resolveChatThinking —— 聊天此刻用什么思考设置", () => {
	it("chat 段全空 → 跟随当前实例(初始默认值从 AI 女仆读取)", () => {
		expect(resolveChatThinking(withProfile())).toEqual({
			enableThinking: true,
			thinkingLevel: "high",
		});
	});

	it("chat 写过的字段压过实例,没写的仍跟随", () => {
		// 「后面就分开了」:拨过开关之后,引擎那边怎么改都不再影响聊天。
		const ai = withProfile({ enableThinking: false });
		expect(resolveChatThinking(ai)).toEqual({ enableThinking: false, thinkingLevel: "high" });
	});

	it("两个字段各分各的家 —— 只调过等级时,开关照旧跟随实例", () => {
		const ai = withProfile({ thinkingLevel: "low" });
		expect(resolveChatThinking(ai)).toEqual({ enableThinking: true, thinkingLevel: "low" });
	});

	it("指针悬空(一份实例都没有)→ 落到空档案的默认值,不炸", () => {
		const ai = AISettingsSchema.parse({ ...BASE, activeProfile: "", providers: {} });
		expect(resolveChatThinking(ai)).toEqual({ enableThinking: false, thinkingLevel: "medium" });
	});
});
