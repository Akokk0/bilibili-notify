/**
 * 路由测试 — 锐评走的是哪种 AI 调用。
 *
 * 单独成文件是因为要 `vi.mock` 整个 `@bilibili-notify/ai`,别的 stats 用例不该
 * 被这个 mock 波及。
 *
 * 守的是一条容易在 review 里滑过去的语义差别:`CommentaryGenerator` 有两个入口,
 * `chat()` 按 sessionId **保存多轮历史**并自动挂上工具,`comment()` 是单次调用、
 * 不存历史、不带工具,但**两者都会前置人格 system prompt**。锐评是一次性任务,
 * 必须走后者 —— 走前者会有三个后果:
 *
 * 1. sessionId 固定 ⇒ 评完 A 再评 B,B 的上下文里坐着 A 的数据和上一次回复,
 *    而提示词明写着「只针对这一位」;
 * 2. 「重新生成」时模型看得见自己上次的答案,倾向照抄;
 * 3. 工具能力对锐评毫无用处,却多出一条「模型中途发起 tool call 而不是回 JSON」
 *    的失败路径。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";

const comment = vi.fn(async (_prompt: string, _scene?: unknown) => "{}");
const chat = vi.fn(async (_prompt: string, _sessionId: string) => ({
	result: "{}",
	pendingActions: [],
}));

vi.mock("@bilibili-notify/ai", () => ({
	// class 而不是箭头函数 —— 路由是 `new CommentaryGenerator(...)`,
	// 箭头函数不能当构造器。
	CommentaryGenerator: class {
		comment = comment;
		chat = chat;
	},
}));

const AI_SETTINGS = {
	enabled: true,
	apiKey: "k",
	baseUrl: "https://example.invalid/v1",
	model: "m",
	temperature: 0.7,
	persona: {
		name: "伦伦",
		addressUser: "主人",
		addressSelf: "我",
		traits: "毒舌",
		catchphrase: "~",
		baseRole: "女仆",
		extraSystemPrompt: "",
	},
	dynamicPrompt: "",
	liveSummaryPrompt: "",
};

function makeDeps(subs: Array<{ id: string; uid: string }>): RouteDeps {
	return {
		runtime: {
			fansStore: { listSamplesSince: async () => [] },
			statsStore: {
				listDynamics: async () => [],
				listLiveSessions: async () => [],
				recordingSince: async () => "1970-01-01T00:00:00.000Z",
			},
			engines: { api: {}, listLiveRooms: () => [] },
			fansPoller: null,
			subRuntimeStore: { get: () => ({ cachedProfile: { name: "老番茄" } }) },
			serviceCtx: {},
		},
		store: {
			getSubscriptions: () => subs,
			getGlobals: () => ({ defaults: { ai: AI_SETTINGS } }),
		},
	} as unknown as RouteDeps;
}

beforeEach(() => {
	comment.mockClear();
	chat.mockClear();
});

describe("锐评的 AI 调用方式", () => {
	it("单人锐评走一次性的 comment(),不碰会话历史", async () => {
		const deps = makeDeps([{ id: "s1", uid: "1" }]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(comment).toHaveBeenCalledTimes(1);
		expect(chat).not.toHaveBeenCalled();
	});

	it("榜单锐评同样走 comment()", async () => {
		const deps = makeDeps([
			{ id: "s1", uid: "1" },
			{ id: "s2", uid: "2" },
		]);
		await createStatsRoute(deps).request("/roast", { method: "POST" });
		expect(comment).toHaveBeenCalledTimes(1);
		expect(chat).not.toHaveBeenCalled();
	});

	it("提示词照常带着这位 UP 的数据过去", async () => {
		const deps = makeDeps([{ id: "s1", uid: "1" }]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(String(comment.mock.calls[0]?.[0])).toContain("老番茄");
	});

	it("不传 scene —— 动态/下播总结的场景补充提示词与锐评无关", async () => {
		const deps = makeDeps([{ id: "s1", uid: "1" }]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(comment.mock.calls[0]?.[1]).toBeUndefined();
	});
});
