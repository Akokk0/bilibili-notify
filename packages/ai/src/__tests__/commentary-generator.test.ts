/**
 * 单元测试 — `CommentaryGenerator`(packages/ai 首份测试)。
 *
 * 覆盖:
 *   - callAPI 配置守卫(apiKey / baseURL 缺失即抛)
 *   - comment():engine 直接调用的单次点评 —— scene 提示词叠加、per-call override
 *     (model/temperature)、多模态图片仅在 enableVision 时下挂、thinking 不支持
 *     时的降级重试
 *   - chat():多轮会话历史携带 / enableConversation 关闭即丢弃 / 满载压缩 /
 *     tool-calling 循环 + MAX_ROUNDS 上限
 *   - session 生命周期:TTL 过期计数、stop() 清空、flushPendingSubActions 吞错
 *
 * 策略:`openai` 是 `await import("openai")` 动态导入 → `vi.mock` 注入 FakeOpenAI;
 * `./tools` 整体 mock 以隔离 tool 循环(不牵连真实 executeTool / api / 订阅);
 * `./persona-presets#buildSystemPrompt` 保持真实(纯函数,产物不做精确断言)。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentaryGenerator, type CommentaryGeneratorConfig } from "../commentary-generator";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const oai = vi.hoisted(() => {
	const create = vi.fn();
	const ctorArgs: unknown[] = [];
	class FakeOpenAI {
		chat = { completions: { create } };
		constructor(opts: unknown) {
			ctorArgs.push(opts);
		}
	}
	return { create, ctorArgs, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

const toolsMock = vi.hoisted(() => ({
	// 显式标注前两参(name/args),否则 vi.fn 推出空参元组,.mock.calls[0][0]
	// 会触发 TS2493(索引长度 0 的元组)。运行时仍记录 SUT 传入的全部 7 个实参。
	executeTool: vi.fn(
		async (_name: string, _args: Record<string, string>): Promise<string> => "tool-result",
	),
}));
vi.mock("../tools", () => ({
	TOOL_DEFINITIONS: [{ type: "function", function: { name: "fake_tool", parameters: {} } }],
	executeTool: toolsMock.executeTool,
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGeneratorConfig {
	return {
		apiKey: "sk-test",
		baseURL: "https://api.test/v1",
		model: "gpt-test",
		persona: { preset: "assistant" },
		dynamicPrompt: "DYN_SCENE_PROMPT",
		liveSummaryPrompt: "LIVE_SCENE_PROMPT",
		enableConversation: true,
		maxHistory: 5,
		enableThinking: false,
		enableSearch: false,
		enableVision: false,
		...over,
	};
}

function makeGen(over: Partial<CommentaryGeneratorConfig> = {}): {
	gen: CommentaryGenerator;
} {
	const ctx: ServiceContext = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const api = {} as BilibiliAPI;
	const gen = new CommentaryGenerator({ serviceCtx: ctx, api, config: makeConfig(over) });
	return { gen };
}

interface ChatMsg {
	role: string;
	content: unknown;
}
function msgResp(content: string | null): { choices: Array<{ message: ChatMsg }> } {
	return { choices: [{ message: { role: "assistant", content } }] };
}
function toolCallResp(name: string, args: object, id = "call_1"): unknown {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{ id, type: "function", function: { name, arguments: JSON.stringify(args) } },
					],
				},
			},
		],
	};
}

/** 读第 n 次 create() 调用的 params。 */
function createParams(n: number): {
	model: string;
	messages: ChatMsg[];
	temperature?: number;
	tools?: unknown;
	extra_body?: Record<string, unknown>;
} {
	const call = oai.create.mock.calls[n];
	if (!call) throw new Error(`create 未被调用第 ${n} 次`);
	return call[0] as ReturnType<typeof createParams>;
}

beforeEach(() => {
	oai.create.mockReset();
	oai.ctorArgs.length = 0;
	toolsMock.executeTool.mockClear();
	toolsMock.executeTool.mockResolvedValue("tool-result");
});

// ---------------------------------------------------------------------------
// callAPI 配置守卫
// ---------------------------------------------------------------------------

describe("CommentaryGenerator — 配置守卫", () => {
	it("apiKey 缺失 → comment() 抛「AI apiKey 未配置」", async () => {
		const { gen } = makeGen({ apiKey: "" });
		await expect(gen.comment("hi")).rejects.toThrow("AI apiKey 未配置");
	});

	it("baseURL 缺失 → comment() 抛「AI baseURL 未配置」", async () => {
		const { gen } = makeGen({ baseURL: "" });
		await expect(gen.comment("hi")).rejects.toThrow("AI baseURL 未配置");
	});
});

// ---------------------------------------------------------------------------
// comment()
// ---------------------------------------------------------------------------

describe("CommentaryGenerator.comment", () => {
	it("正常返回 message.content;OpenAI 用 config 的 apiKey/baseURL 构造", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("点评内容"));
		const out = await gen.comment("某 UP 发了动态");
		expect(out).toBe("点评内容");
		expect(oai.create).toHaveBeenCalledTimes(1);
		expect(oai.ctorArgs[0]).toMatchObject({
			apiKey: "sk-test",
			baseURL: "https://api.test/v1",
		});
	});

	it("content 为 null → 返回空串", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp(null));
		expect(await gen.comment("x")).toBe("");
	});

	it("scene=dynamic → system prompt 叠加 dynamicPrompt", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("ok"));
		await gen.comment("内容", "dynamic");
		const sys = createParams(0).messages[0]?.content as string;
		expect(sys).toContain("DYN_SCENE_PROMPT");
	});

	it("override.model / temperature 覆盖 config 值", async () => {
		const { gen } = makeGen({ temperature: 0.2 });
		oai.create.mockResolvedValueOnce(msgResp("ok"));
		await gen.comment("内容", "dynamic", undefined, {
			model: "override-model",
			temperature: 0.9,
		});
		const p = createParams(0);
		expect(p.model).toBe("override-model");
		expect(p.temperature).toBe(0.9);
	});

	it("enableVision=true + imageUrls → user 消息变多模态(text + image_url)", async () => {
		const { gen } = makeGen({ enableVision: true });
		oai.create.mockResolvedValueOnce(msgResp("ok"));
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);
		// 注:round 循环会把 assistant 响应 push 进同一 apiMessages 引用,故定位
		// content 为数组的那条 user 消息,而非取末元素。
		const msgs = createParams(0).messages;
		const visionMsg = msgs.find((m) => m.role === "user" && Array.isArray(m.content));
		expect(visionMsg).toBeDefined();
		const parts = visionMsg?.content as Array<{ type: string }>;
		expect(parts.some((x) => x.type === "image_url")).toBe(true);
	});

	it("enableVision=false + imageUrls → 不下挂图片(user content 仍是纯字符串)", async () => {
		const { gen } = makeGen({ enableVision: false });
		oai.create.mockResolvedValueOnce(msgResp("ok"));
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);
		const msgs = createParams(0).messages;
		const userMsg = msgs.find((m) => m.role === "user");
		expect(typeof userMsg?.content).toBe("string");
	});

	it("enableThinking=true 且首请求抛错 → 降级重试(第二次无 extra_body)", async () => {
		const { gen } = makeGen({ enableThinking: true });
		oai.create
			.mockRejectedValueOnce(new Error("thinking unsupported"))
			.mockResolvedValueOnce(msgResp("降级成功"));
		const out = await gen.comment("x");
		expect(out).toBe("降级成功");
		expect(oai.create).toHaveBeenCalledTimes(2);
		expect(createParams(0).extra_body).toMatchObject({ enable_thinking: true });
		expect(createParams(1).extra_body).toBeUndefined();
	});

	it("enableThinking=false 且请求抛错 → 直接抛出,不重试", async () => {
		const { gen } = makeGen({ enableThinking: false });
		oai.create.mockRejectedValueOnce(new Error("boom"));
		await expect(gen.comment("x")).rejects.toThrow("boom");
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("AI1:网关返回空 choices → 抛明确错误(非不可读的 TypeError)", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce({ choices: [] });
		const msg = await gen.comment("x").then(
			() => "<resolved>",
			(e: unknown) => (e as Error).message,
		);
		expect(msg).toMatch(/空 choices/);
		expect(msg).not.toMatch(/Cannot read properties/); // 不再是不可读的 TypeError
	});
});

// ---------------------------------------------------------------------------
// chat() — 会话历史 / 压缩 / 工具循环
// ---------------------------------------------------------------------------

describe("CommentaryGenerator.chat — 会话历史", () => {
	it("enableConversation=true → 第二轮携带上一轮 user+assistant", async () => {
		const { gen } = makeGen({ maxHistory: 5 });
		oai.create.mockResolvedValueOnce(msgResp("答1"));
		await gen.chat("问1", "s1");
		oai.create.mockResolvedValueOnce(msgResp("答2"));
		await gen.chat("问2", "s1");

		const msgs2 = createParams(1).messages;
		const texts = msgs2.map((m) => m.content);
		expect(texts).toContain("问1");
		expect(texts).toContain("答1");
		expect(texts).toContain("问2");
	});

	it("enableConversation=false → 调用后立即丢弃 session", async () => {
		const { gen } = makeGen({ enableConversation: false });
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chat("问", "s1");
		expect(gen.sessionCount).toBe(0);
	});

	it("历史满载(maxHistory=1)→ 触发压缩,产生额外一次 create(摘要)", async () => {
		const { gen } = makeGen({ maxHistory: 1 });
		oai.create
			.mockResolvedValueOnce(msgResp("答1")) // 主对话
			.mockResolvedValueOnce(msgResp("这是摘要")); // compressHistory
		await gen.chat("问1", "s1");

		expect(oai.create).toHaveBeenCalledTimes(2);
		const summaryUserMsg = createParams(1).messages[1]?.content as string;
		expect(summaryUserMsg).toContain("请将以上对话提炼为简短摘要");
	});

	it("tool-calling:首响应带 tool_calls → 执行工具 → 二响应返回内容", async () => {
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(toolCallResp("fake_tool", { q: "abc" }))
			.mockResolvedValueOnce(msgResp("最终回答"));
		const { result } = await gen.chat("帮我查", "s1");

		expect(result).toBe("最终回答");
		expect(toolsMock.executeTool).toHaveBeenCalledTimes(1);
		expect(toolsMock.executeTool.mock.calls[0]?.[0]).toBe("fake_tool");
		expect(toolsMock.executeTool.mock.calls[0]?.[1]).toEqual({ q: "abc" });
	});

	it("tool-calling 持续返回工具调用 → MAX_ROUNDS(8)后返回上限提示", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValue(toolCallResp("fake_tool", {}));
		const { result } = await gen.chat("死循环工具", "s1");
		expect(result).toBe("（工具调用轮次已达上限）");
		expect(oai.create).toHaveBeenCalledTimes(8);
	});

	it("工具参数 JSON 解析失败 → 不抛,作为工具错误结果继续", async () => {
		const { gen } = makeGen();
		const badArgs = {
			choices: [
				{
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "c1",
								type: "function",
								function: { name: "fake_tool", arguments: "{不是json" },
							},
						],
					},
				},
			],
		};
		oai.create.mockResolvedValueOnce(badArgs).mockResolvedValueOnce(msgResp("收尾"));
		const { result } = await gen.chat("x", "s1");
		expect(result).toBe("收尾");
		// 解析失败时 executeTool 不会被调用(在 JSON.parse 阶段就 catch)
		expect(toolsMock.executeTool).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// session 生命周期
// ---------------------------------------------------------------------------

describe("CommentaryGenerator — session 生命周期", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sessionCount 只统计未过期(TTL=2h)会话", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const { gen } = makeGen();
		oai.create.mockResolvedValue(msgResp("答"));
		await gen.chat("问", "s1");
		expect(gen.sessionCount).toBe(1);

		vi.setSystemTime(new Date("2026-01-01T02:00:01Z")); // > 2h 后
		expect(gen.sessionCount).toBe(0);
	});

	it("stop() 清空所有会话", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValue(msgResp("答"));
		await gen.chat("问", "s1");
		expect(gen.sessionCount).toBe(1);
		gen.stop();
		expect(gen.sessionCount).toBe(0);
	});

	it("clearSession 只清指定会话", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValue(msgResp("答"));
		await gen.chat("问a", "sa");
		await gen.chat("问b", "sb");
		expect(gen.sessionCount).toBe(2);
		gen.clearSession("sa");
		expect(gen.sessionCount).toBe(1);
	});

	it("flushPendingSubActions 顺序执行并吞掉单个失败", async () => {
		const { gen } = makeGen();
		const ok1 = vi.fn(async () => {});
		const bad = vi.fn(async () => {
			throw new Error("boom");
		});
		const ok2 = vi.fn(async () => {});
		await expect(gen.flushPendingSubActions([ok1, bad, ok2])).resolves.toBeUndefined();
		expect(ok1).toHaveBeenCalled();
		expect(bad).toHaveBeenCalled();
		expect(ok2).toHaveBeenCalled();
	});
});
