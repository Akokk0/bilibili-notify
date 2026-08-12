/**
 * AI 聊天页的思考**等级**(`ai.chat.thinkingLevel`)—— 与实例桶里的两格分家。
 *
 * 桶里的 enableThinking / thinkingLevel 是**引擎**的(动态点评、直播总结、锐评);
 * 聊天页只在配置里存**等级**,且「没写 = 跟随当前实例,写过即分家」。
 *
 * 聊天的思考**开关**不在配置里:它是会话级的(输入框旁那颗胶囊,默认关、手动开、
 * 不落盘),按消息走请求体。曾经有过一格 `ai.chat.enableThinking`(未发版即删),
 * 老数据里残留时 zod 静默剥掉 —— 这里钉住「剥掉」而不是「拒收」:拒收会让一份
 * 本来能用的备份整个还原失败。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveChatThinkingLevel } from "../constants";
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
		const ai = AISettingsSchema.parse(BASE);
		expect(ai.chat).toEqual({});
	});

	it("残留的 enableThinking 被静默剥掉(未发版即删的字段),等级照常保留", () => {
		const ai = withProfile({ enableThinking: true, thinkingLevel: "low" });
		expect("enableThinking" in ai.chat).toBe(false);
		expect(ai.chat.thinkingLevel).toBe("low");
	});

	it("非法等级拒收 —— 别让一个坏档位悄悄变成默认档", () => {
		const r = AISettingsSchema.safeParse({ ...BASE, chat: { thinkingLevel: "ultra" } });
		expect(r.success).toBe(false);
	});
});

describe("resolveChatThinkingLevel — 继承与分家", () => {
	it("chat 没写等级 → 跟随当前实例(初始默认值从女仆读取)", () => {
		expect(resolveChatThinkingLevel(withProfile())).toBe("high");
	});

	it("chat 写过等级 → 压过实例,从此互不牵动", () => {
		expect(resolveChatThinkingLevel(withProfile({ thinkingLevel: "low" }))).toBe("low");
	});

	it("指针悬空(实例刚被删)→ 落回空档案的 medium,不炸", () => {
		const ai = AISettingsSchema.parse({ ...BASE, activeProfile: "ghost" });
		expect(resolveChatThinkingLevel(ai)).toBe("medium");
	});
});
