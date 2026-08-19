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
 *   - session 生命周期:TTL 过期计数、stop() 清空
 *
 * 策略:`openai` 是 `await import("openai")` 动态导入 → `vi.mock` 注入 FakeOpenAI;
 * `./tools` 整体 mock 以隔离 tool 循环(不牵连真实 executeTool / api / 订阅);
 * `./persona-presets#buildSystemPrompt` 保持真实(纯函数,产物不做精确断言)。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
		provider: "custom",
		enableThinking: false,
		thinkingLevel: "high",
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
	stream?: boolean;
	/**
	 * Python SDK 独有的写法,Node 侧发出去谁也不认。留在这里只为断言它**不再出现**
	 * —— 曾经思考参数就是被塞进这个字段里,于是从来没有真正生效过。
	 */
	extra_body?: Record<string, unknown>;
	// provider 方言参数一律落在请求体顶层。
	enable_thinking?: boolean;
	thinking_budget?: number;
	thinking?: unknown;
	reasoning?: unknown;
	reasoning_effort?: string;
	top_k?: number;
	enable_search?: boolean;
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

	it("enableThinking=true 且首请求抛错 → 降级重试(第二次不带思考参数)", async () => {
		const { gen } = makeGen({ provider: "siliconflow", enableThinking: true });
		oai.create
			.mockRejectedValueOnce(new Error("thinking unsupported"))
			.mockResolvedValueOnce(msgResp("降级成功"));
		const out = await gen.comment("x");
		expect(out).toBe("降级成功");
		expect(oai.create).toHaveBeenCalledTimes(2);
		expect(createParams(0).enable_thinking).toBe(true);
		expect(createParams(1).enable_thinking).toBeUndefined();
	});

	it("enableThinking=false 且请求抛错 → 直接抛出,不重试", async () => {
		const { gen } = makeGen({ enableThinking: false });
		oai.create.mockRejectedValueOnce(new Error("boom"));
		await expect(gen.comment("x")).rejects.toThrow("boom");
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	describe("provider 方言参数上线", () => {
		it("落在请求体顶层,而不是 extra_body", async () => {
			// extra_body 是 Python SDK 的糖(它会摊平);Node 的 openai 包不认识它,
			// 会原样序列化成一个嵌套字段发出去 —— 没有任何服务商读得懂。
			const { gen } = makeGen({
				provider: "siliconflow",
				enableThinking: true,
				thinkingLevel: "medium",
			});
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await gen.comment("x");
			expect(createParams(0)).toMatchObject({ enable_thinking: true, thinking_budget: 16384 });
			expect(createParams(0).extra_body).toBeUndefined();
		});

		it("换一家就换一套写法", async () => {
			const { gen } = makeGen({
				provider: "deepseek",
				enableThinking: true,
				thinkingLevel: "high",
			});
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await gen.comment("x");
			expect(createParams(0)).toMatchObject({
				thinking: { type: "enabled" },
				reasoning_effort: "max",
			});
			expect(createParams(0).enable_thinking).toBeUndefined();
		});

		it("兜底档一个方言字段都不发", async () => {
			const { gen } = makeGen({ provider: "custom", enableThinking: true });
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await gen.comment("x");
			const p = createParams(0);
			expect(p.enable_thinking).toBeUndefined();
			expect(p.thinking).toBeUndefined();
			expect(p.reasoning).toBeUndefined();
		});
	});

	describe("额外请求参数", () => {
		it("摊进请求体顶层", async () => {
			const { gen } = makeGen({ provider: "custom", extraParams: '{"top_k": 40}' });
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await gen.comment("x");
			expect(createParams(0).top_k).toBe(40);
		});

		it("与内建参数冲突时主人写的赢", async () => {
			const { gen } = makeGen({
				provider: "siliconflow",
				enableThinking: true,
				thinkingLevel: "low",
				extraParams: '{"thinking_budget": 999}',
			});
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await gen.comment("x");
			expect(createParams(0).thinking_budget).toBe(999);
			// 没被覆盖的那半仍然生效。
			expect(createParams(0).enable_thinking).toBe(true);
		});

		it("覆盖不了 messages —— 覆盖了就是整段对话凭空消失", async () => {
			const { gen } = makeGen({ provider: "custom", extraParams: '{"messages": []}' });
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await gen.comment("正文在此");
			expect(createParams(0).messages.length).toBeGreaterThan(0);
		});

		it("写错 JSON 照常发请求,只是不带额外参数 —— 不让一个填错的框拖垮整条链路", async () => {
			const { gen } = makeGen({ provider: "custom", extraParams: "{不是 JSON}" });
			oai.create.mockResolvedValueOnce(msgResp("ok"));
			await expect(gen.comment("x")).resolves.toBe("ok");
			expect(oai.create).toHaveBeenCalledTimes(1);
		});

		it("降级重试时额外参数原样带着 —— 摘掉的只该是女仆自己加的思考参数", async () => {
			const { gen } = makeGen({
				provider: "siliconflow",
				enableThinking: true,
				extraParams: '{"top_k": 40}',
			});
			oai.create
				.mockRejectedValueOnce(new Error("thinking unsupported"))
				.mockResolvedValueOnce(msgResp("降级成功"));
			await gen.comment("x");
			expect(createParams(1).enable_thinking).toBeUndefined();
			expect(createParams(1).top_k).toBe(40);
		});
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
		const result = await gen.chat("帮我查", "s1");

		expect(result).toBe("最终回答");
		expect(toolsMock.executeTool).toHaveBeenCalledTimes(1);
		expect(toolsMock.executeTool.mock.calls[0]?.[0]).toBe("fake_tool");
		expect(toolsMock.executeTool.mock.calls[0]?.[1]).toEqual({ q: "abc" });
	});

	it("tool-calling 持续返回工具调用 → MAX_ROUNDS(8)后返回上限提示", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValue(toolCallResp("fake_tool", {}));
		const result = await gen.chat("死循环工具", "s1");
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
		const result = await gen.chat("x", "s1");
		expect(result).toBe("收尾");
		// 解析失败时 executeTool 不会被调用(在 JSON.parse 阶段就 catch)
		expect(toolsMock.executeTool).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// chatStateless()
// ---------------------------------------------------------------------------

/**
 * `chat()` 把历史存在**进程内存**的 session map 里,重启即失忆;独立端 dashboard
 * 的聊天记录却落在磁盘上,重开还在。两者搭在一起就会出现「界面上明明摆着上文,
 * 女仆却完全不记得」——`chatStateless` 就是为此存在:历史由调用方交出来,引擎
 * 一次性用完,不读也不写 session map。
 */
describe("CommentaryGenerator.chatStateless — 调用方自带历史", () => {
	it("整段历史原样送进模型,顺序不变", async () => {
		const { gen } = makeGen({ maxHistory: 5 });
		oai.create.mockResolvedValueOnce(msgResp("答2"));
		const result = await gen.chatStateless([
			{ role: "user", content: "问1" },
			{ role: "assistant", content: "答1" },
			{ role: "user", content: "问2" },
		]);

		expect(result).toBe("答2");
		// [0] 是 system prompt,其后是调用方给的三条。只断言这段前缀:callAPI 的
		// 工具循环会**就地**往同一个数组里 push 助手回复,而 mock 记的是引用,
		// 读到的是调用结束后的样子 —— 整段相等会被那条追加的记账消息带偏。
		const msgs = createParams(0).messages;
		expect(msgs[0]?.role).toBe("system");
		expect(msgs.slice(1, 4).map((m) => m.content)).toEqual(["问1", "答1", "问2"]);
	});

	it("不改调用方交出来的数组 —— callAPI 的就地追加不许漏回去", async () => {
		// 上一条测试暴露的:callAPI 拿到 messages 会往里 push。调用方(会话存储)
		// 把持久化的消息数组直接递进来,漏回去就是往磁盘记录里掺记账消息。
		const { gen } = makeGen();
		const history = [{ role: "user" as const, content: "问" }];
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chatStateless(history);
		expect(history).toEqual([{ role: "user", content: "问" }]);
	});

	it("不碰 session map —— 调用前后会话数都是 0", async () => {
		// enableConversation=true 时 chat() 会存一条;chatStateless 无论如何都不该存。
		const { gen } = makeGen({ enableConversation: true });
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chatStateless([{ role: "user", content: "问" }]);
		expect(gen.sessionCount).toBe(0);
	});

	it("历史超过 maxHistory*2 条 → 只送最近的那些", async () => {
		const { gen } = makeGen({ maxHistory: 1 }); // 上限 2 条
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chatStateless([
			{ role: "user", content: "很久以前" },
			{ role: "assistant", content: "旧答" },
			{ role: "user", content: "最新问题" },
		]);

		const texts = createParams(0).messages.map((m) => m.content);
		expect(texts).not.toContain("很久以前");
		expect(texts).toContain("旧答");
		expect(texts).toContain("最新问题");
	});

	it("截断不会触发压缩 —— 只发一次请求,不额外调模型写摘要", async () => {
		// chat() 满载时会多打一次 create 去压缩历史存回 session;无状态路径没有
		// 「存回」这一步,再去压缩就是白白多花一次 token。
		const { gen } = makeGen({ maxHistory: 1 });
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chatStateless([
			{ role: "user", content: "问1" },
			{ role: "assistant", content: "答1" },
			{ role: "user", content: "问2" },
		]);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("带工具能力:首响应 tool_calls → 执行工具 → 二响应返回内容", async () => {
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(toolCallResp("fake_tool", { q: "abc" }))
			.mockResolvedValueOnce(msgResp("最终回答"));
		const result = await gen.chatStateless([{ role: "user", content: "帮我查" }]);

		expect(result).toBe("最终回答");
		expect(toolsMock.executeTool).toHaveBeenCalledTimes(1);
		expect(toolsMock.executeTool.mock.calls[0]?.[0]).toBe("fake_tool");
	});

	it("空历史 → 直接抛,不拿一句只有 system prompt 的请求去撞模型", async () => {
		const { gen } = makeGen();
		await expect(gen.chatStateless([])).rejects.toThrow("对话历史为空");
		expect(oai.create).not.toHaveBeenCalled();
	});

	it("带独立思考设置 → 压过引擎配置,只对这一次生效", async () => {
		// 聊天页的思考配置与引擎(点评/总结)分了家:引擎开着 high,聊天自己关了,
		// 这一单就得发「关」位方言 —— 否则聊天页的开关只是个摆设。
		const { gen } = makeGen({ provider: "deepseek", enableThinking: true, thinkingLevel: "high" });
		oai.create.mockResolvedValueOnce(msgResp("回答"));
		await gen.chatStateless([{ role: "user", content: "问" }], {
			thinking: { enableThinking: false, thinkingLevel: "high" },
		});
		const params = createParams(0) as unknown as Record<string, unknown>;
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("独立设置的等级也翻译成方言 —— 引擎 high、聊天 low 各走各的", async () => {
		const { gen } = makeGen({ provider: "deepseek", enableThinking: false, thinkingLevel: "low" });
		oai.create.mockResolvedValueOnce(msgResp("回答"));
		await gen.chatStateless([{ role: "user", content: "问" }], {
			thinking: { enableThinking: true, thinkingLevel: "high" },
		});
		const params = createParams(0) as unknown as Record<string, unknown>;
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("max");
	});

	it("不带独立设置 → 照旧用引擎配置,老调用方零变化", async () => {
		const { gen } = makeGen({ provider: "deepseek", enableThinking: true, thinkingLevel: "high" });
		oai.create.mockResolvedValueOnce(msgResp("回答"));
		await gen.chatStateless([{ role: "user", content: "问" }]);
		const params = createParams(0) as unknown as Record<string, unknown>;
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("max");
	});
});

// ---------------------------------------------------------------------------
// chatStatelessStream()
// ---------------------------------------------------------------------------

/** 造一个 SDK 风格的流:async iterable of chunks。 */
function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c;
		},
	};
}
const textChunk = (text: string) => ({ choices: [{ delta: { content: text } }] });
/** tool_call 的分片:name / arguments 都是一段段来的,靠 index 归位。 */
const toolChunk = (index: number, part: Record<string, unknown>) => ({
	choices: [{ delta: { tool_calls: [{ index, ...part }] } }],
});

describe("CommentaryGenerator.summarizeTitle", () => {
	/**
	 * 侧栏那一行标题原本取首问的前 24 字。主人每次都以「你好」开场,于是每个会话
	 * 都叫「你好」,一行看下来全是同一个词,等于没有标题。改成让模型看完首轮问答
	 * 起一个短标题。
	 */
	const ROUND = [
		{ role: "user" as const, content: "本周谁最勤奋" },
		{ role: "assistant" as const, content: "小绫看了一下,是 A 君。" },
	];

	it("拿首轮问答换一句短标题", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("本周勤奋榜"));
		expect(await gen.summarizeTitle(ROUND)).toBe("本周勤奋榜");
	});

	it("不带工具 —— 起个标题不该顺手去查订阅", async () => {
		// 带上 tools 的话模型可能真去调一轮,白花一次往返还可能改动什么。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("标题"));
		await gen.summarizeTitle(ROUND);
		expect(createParams(0).tools).toBeUndefined();
	});

	it("不流式 —— 一个短标题没什么可逐字看的", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("标题"));
		await gen.summarizeTitle(ROUND);
		expect(createParams(0).stream).toBeUndefined();
	});

	it("模型爱加的引号 / 前缀 / 句号都洗掉", async () => {
		// 「标题:」这类前缀和成对引号是最常见的两种,不洗就直接进了侧栏。
		for (const [raw, want] of [
			['"本周勤奋榜"', "本周勤奋榜"],
			["「本周勤奋榜」", "本周勤奋榜"],
			["标题：本周勤奋榜", "本周勤奋榜"],
			["本周勤奋榜。", "本周勤奋榜"],
			// 多行一律取最后一行(见「模型先想后答」那条),不是拼起来。
			["  思考中…\n本周勤奋榜  ", "本周勤奋榜"],
		] as const) {
			const { gen } = makeGen();
			oai.create.mockReset();
			oai.create.mockResolvedValueOnce(msgResp(raw));
			expect(await gen.summarizeTitle(ROUND)).toBe(want);
		}
	});

	it("模型先想后答 → 取最后一行,别把思考过程当标题", async () => {
		// 推理模型常常先写一段思考再给结论,而结论在**最后**。整段压成一行再截断
		// 的话,侧栏那行会是「让我想想,这段对话在讲…」这种半截思考。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("让我想想,这段对话主要在讲订阅管理。\n\n订阅管理"));
		expect(await gen.summarizeTitle(ROUND)).toBe("订阅管理");
	});

	it("显式关思考 —— 起标题是杂务,思维链只会烧光预算让 content 空手而归", async () => {
		// 现场(2026-08-12):DeepSeek v4 **默认就开思考**,而起标题这一单原本一个
		// 方言字段都不发,于是思维链把 max_tokens 烧光,content 回来是空的 →
		// 「模型没给出标题」,每个会话都失败。起标题永远发「关」位方言,与主人的
		// 思考开关无关 —— 这是一句冷冰冰的概括,不值得烧思考的钱。
		const { gen } = makeGen({ provider: "deepseek", enableThinking: true, thinkingLevel: "high" });
		oai.create.mockResolvedValueOnce(msgResp("标题"));
		await gen.summarizeTitle(ROUND);
		expect((createParams(0) as unknown as Record<string, unknown>).thinking).toEqual({
			type: "disabled",
		});
	});

	it("自定义服务商起标题照旧一个方言字段都不发 —— 方言未知,发了几乎必然被拒", async () => {
		const { gen } = makeGen({ provider: "custom", enableThinking: false });
		oai.create.mockResolvedValueOnce(msgResp("标题"));
		await gen.summarizeTitle(ROUND);
		const params = createParams(0) as unknown as Record<string, unknown>;
		expect(params.thinking).toBeUndefined();
		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning).toBeUndefined();
	});

	it("给的 token 预算够模型想一会儿 —— 太抠会让它把额度花在思考上、正文空手而归", async () => {
		// 32 个 token 对推理模型是不够的:思考吃光预算,content 回来是空的,于是
		// 起名永远失败,而主人只看到标题一直是自己那句提问。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("标题"));
		await gen.summarizeTitle(ROUND);
		const budget = (createParams(0) as unknown as { max_tokens?: number }).max_tokens;
		expect(budget).toBeGreaterThanOrEqual(100);
	});

	it("模型话痨就截断 —— 侧栏一行放不下", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(
			msgResp("这是一个非常非常长的标题长到侧栏根本放不下还要继续说"),
		);
		const title = await gen.summarizeTitle(ROUND);
		expect(title.length).toBeLessThanOrEqual(17);
		expect(title.endsWith("…")).toBe(true);
	});

	it("模型回了空 → 抛,让调用方保留原来的标题", async () => {
		// 静默返回空串的话,侧栏那一行会变成一片空白,比「你好」更糟。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("   "));
		await expect(gen.summarizeTitle(ROUND)).rejects.toThrow();
	});

	it("空对话 → 直接抛,不拿一句只有 system prompt 的请求去撞模型", async () => {
		const { gen } = makeGen();
		await expect(gen.summarizeTitle([])).rejects.toThrow();
		expect(oai.create).not.toHaveBeenCalled();
	});
});

describe("CommentaryGenerator.chatStatelessStream — 真流式", () => {
	it("逐块回调 onDelta,拼起来等于最终结果", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(
			streamOf([textChunk("主人"), textChunk("晚上好"), textChunk("~")]),
		);

		const seen: string[] = [];
		const result = await gen.chatStatelessStream([{ role: "user", content: "在吗" }], {
			onDelta: (t) => seen.push(t),
		});

		expect(seen).toEqual(["主人", "晚上好", "~"]);
		expect(result).toBe("主人晚上好~");
	});

	it("确实开了 stream —— 不是拿完整响应再假装逐字吐", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await gen.chatStatelessStream([{ role: "user", content: "在吗" }], { onDelta: () => {} });
		expect(createParams(0)).toMatchObject({ stream: true });
	});

	it("空 delta 块被跳过,不回调空串", async () => {
		// 首块常常只带 role、没有 content;真回调一个空串,前端那边会白闪一下。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(
			streamOf([{ choices: [{ delta: { role: "assistant" } }] }, textChunk("好")]),
		);
		const seen: string[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: (t) => seen.push(t),
		});
		expect(seen).toEqual(["好"]);
	});

	it("工具轮:分片拼出完整的 name/arguments,执行后继续流式吐正文", async () => {
		// 流式下 tool_call 的函数名和参数是**一小段一小段**来的,不按 index 累加
		// 就会拿到半个函数名,工具永远调不起来。
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(
				streamOf([
					toolChunk(0, { id: "c1", function: { name: "fake_", arguments: '{"q":' } }),
					toolChunk(0, { function: { name: "tool", arguments: '"abc"}' } }),
				]),
			)
			.mockResolvedValueOnce(streamOf([textChunk("查到了")]));

		const result = await gen.chatStatelessStream([{ role: "user", content: "帮我查" }], {
			onDelta: () => {},
		});

		expect(result).toBe("查到了");
		expect(toolsMock.executeTool.mock.calls[0]?.[0]).toBe("fake_tool");
		expect(toolsMock.executeTool.mock.calls[0]?.[1]).toEqual({ q: "abc" });
	});

	it("工具轮本身不吐正文 —— 那一轮没有给人看的内容", async () => {
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(
				streamOf([toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } })]),
			)
			.mockResolvedValueOnce(streamOf([textChunk("答案")]));
		const seen: string[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: (t) => seen.push(t),
		});
		expect(seen).toEqual(["答案"]);
	});

	/**
	 * 思考流 —— DeepSeek 式「先想后说」的那段草稿。
	 *
	 * 方言两派:DeepSeek / 硅基 / 火山 / 百炼在 delta 上吐 `reasoning_content`,
	 * OpenRouter 吐 `reasoning`。两个都认,但**只认字符串**:有网关会把这些字段
	 * 塞成对象,盲拼会得到一串 [object Object]。
	 */
	describe("思考流(onReasoning)", () => {
		const thinkChunk = (text: string) => ({ choices: [{ delta: { reasoning_content: text } }] });

		it("reasoning_content 分片走 onReasoning,不混进正文", async () => {
			const { gen } = makeGen();
			oai.create.mockResolvedValueOnce(
				streamOf([thinkChunk("主人问的是"), thinkChunk("天气"), textChunk("晚上好")]),
			);
			const think: string[] = [];
			const text: string[] = [];
			const result = await gen.chatStatelessStream([{ role: "user", content: "在吗" }], {
				onDelta: (t) => text.push(t),
				onReasoning: (t) => think.push(t),
			});
			// 思考一个字都不能漏进正文 —— 正文是要落盘、要当上下文回传给模型的。
			expect(result).toBe("晚上好");
			expect(text).toEqual(["晚上好"]);
			expect(think).toEqual(["主人问的是", "天气"]);
		});

		it("OpenRouter 方言(delta.reasoning)同样认", async () => {
			const { gen } = makeGen();
			oai.create.mockResolvedValueOnce(
				streamOf([{ choices: [{ delta: { reasoning: "想想" } }] }, textChunk("好")]),
			);
			const think: string[] = [];
			await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
				onReasoning: (t) => think.push(t),
			});
			expect(think).toEqual(["想想"]);
		});

		it("字段不是字符串(某些网关塞对象)→ 跳过,不吐 [object Object]", async () => {
			const { gen } = makeGen();
			oai.create.mockResolvedValueOnce(
				streamOf([
					{ choices: [{ delta: { reasoning_content: { detail: "x" } } }] },
					textChunk("好"),
				]),
			);
			const think: string[] = [];
			await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
				onReasoning: (t) => think.push(t),
			});
			expect(think).toEqual([]);
		});

		// 摘方言重试那一轮曾只喂正文不喂思考 —— 与 fetchRound 的非流式回落(补喂
		// 思考)不一致:兼容网关拒掉方言参数时,模型照想、token 照烧、字段就在
		// message 上,dashboard 的思考块却无声消失。
		it("摘方言重试的那一轮,message 上的思考也要补喂 onReasoning", async () => {
			// 开着思考才有方言参数可摘 —— 默认档的关位一个字段都不发,进不了重试分支。
			const { gen } = makeGen({ provider: "siliconflow", enableThinking: true });
			oai.create
				.mockRejectedValueOnce(new Error("dialect unsupported")) // 流式
				.mockRejectedValueOnce(new Error("dialect unsupported")) // 非流式回落
				.mockResolvedValueOnce({
					choices: [{ message: { role: "assistant", content: "答", reasoning_content: "想了想" } }],
				}); // 摘掉方言的重试
			const think: string[] = [];
			const text: string[] = [];
			const result = await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: (t) => text.push(t),
				onReasoning: (t) => think.push(t),
			});
			expect(result).toBe("答");
			expect(text).toEqual(["答"]);
			expect(think).toEqual(["想了想"]);
		});

		it("工具轮的思考同样上报 —— 她决定去查什么的过程也是思考", async () => {
			const { gen } = makeGen();
			oai.create
				.mockResolvedValueOnce(
					streamOf([
						thinkChunk("得查一下订阅"),
						toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } }),
					]),
				)
				.mockResolvedValueOnce(streamOf([thinkChunk("查到了,整理一下"), textChunk("答案")]));
			const think: string[] = [];
			await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
				onReasoning: (t) => think.push(t),
			});
			expect(think).toEqual(["得查一下订阅", "查到了,整理一下"]);
		});

		it("回落非流式时,message 上的 reasoning_content 一次性交出来", async () => {
			const { gen } = makeGen();
			oai.create.mockRejectedValueOnce(new Error("stream is not supported")).mockResolvedValueOnce({
				choices: [
					{ message: { role: "assistant", content: "整段", reasoning_content: "整段思考" } },
				],
			});
			const think: string[] = [];
			await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
				onReasoning: (t) => think.push(t),
			});
			expect(think).toEqual(["整段思考"]);
		});

		it("吐过思考再断 → 不再静默回落 —— 屏幕上已经有字了", async () => {
			// emitted 的语义是「主人看见过任何输出没有」。思考也是输出:回落重来
			// 会让同一段思考再播一遍,或者接上一段完全不同的正文。
			const { gen } = makeGen();
			async function* broken() {
				yield thinkChunk("想到一半");
				throw new Error("connection reset");
			}
			oai.create.mockResolvedValueOnce({ [Symbol.asyncIterator]: broken });
			await expect(
				gen.chatStatelessStream([{ role: "user", content: "x" }], {
					onDelta: () => {},
					onReasoning: () => {},
				}),
			).rejects.toThrow(/connection reset/);
			expect(oai.create).toHaveBeenCalledTimes(1);
		});

		it("没人听思考(不传 onReasoning)→ 一切照旧", async () => {
			const { gen } = makeGen();
			oai.create.mockResolvedValueOnce(streamOf([thinkChunk("想想"), textChunk("好")]));
			const result = await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
			});
			expect(result).toBe("好");
		});

		/**
		 * DeepSeek v4 的硬性契约:思考 + 工具调用时,工具轮的后续请求必须把
		 * `reasoning_content` 原样回传,缺了直接 400(官方 thinking_mode 文档)。
		 * 流式下这条消息是我们自己拼的,漏掉字段就等于每一次「边想边查」都必炸。
		 */
		it("思考 + 工具调用:工具轮把 reasoning_content 原样带回给 API", async () => {
			const { gen } = makeGen();
			oai.create
				.mockResolvedValueOnce(
					streamOf([
						thinkChunk("得查一下订阅"),
						toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } }),
					]),
				)
				.mockResolvedValueOnce(streamOf([textChunk("答案")]));
			await gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
				onReasoning: () => {},
			});
			const echoed = createParams(1).messages.find(
				(m) => (m as { role?: string }).role === "assistant",
			) as unknown as Record<string, unknown>;
			expect(echoed.reasoning_content).toBe("得查一下订阅");
		});

		it("回传不看有没有人听 —— 它是 API 契约,不是显示需求", async () => {
			// koishi 那条路不传 onReasoning,但它同样挂工具;漏了回传,主人在 koishi
			// 群里用思考模型一样会 400。
			const { gen } = makeGen();
			oai.create
				.mockResolvedValueOnce(
					streamOf([
						thinkChunk("想想"),
						toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } }),
					]),
				)
				.mockResolvedValueOnce(streamOf([textChunk("好")]));
			await gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} });
			const echoed = createParams(1).messages.find(
				(m) => (m as { role?: string }).role === "assistant",
			) as unknown as Record<string, unknown>;
			expect(echoed.reasoning_content).toBe("想想");
		});

		it("没思考的工具轮不凭空多一个字段", async () => {
			const { gen } = makeGen();
			oai.create
				.mockResolvedValueOnce(
					streamOf([toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } })]),
				)
				.mockResolvedValueOnce(streamOf([textChunk("好")]));
			await gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} });
			const echoed = createParams(1).messages.find(
				(m) => (m as { role?: string }).role === "assistant",
			) as unknown as Record<string, unknown>;
			expect("reasoning_content" in echoed).toBe(false);
		});
	});

	it("网关不支持流式 → 回落非流式,一次性把整段交出去", async () => {
		// 一个不支持 stream 的兼容网关不该让聊天整个用不了。此时还没吐过任何字,
		// 悄悄重来一次对主人是无感的。
		const { gen } = makeGen();
		oai.create
			.mockRejectedValueOnce(new Error("stream is not supported"))
			.mockResolvedValueOnce(msgResp("整段回复"));

		const seen: string[] = [];
		const result = await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: (t) => seen.push(t),
		});
		expect(result).toBe("整段回复");
		expect(seen).toEqual(["整段回复"]);
		expect(createParams(1)).not.toMatchObject({ stream: true });
	});

	/**
	 * 账户层面的拒绝(余额 / 鉴权 / 限流)不该被当成「网关不支持流式」。
	 *
	 * 硅基流动余额用完时回的就是 `402 status code (no body)`。回落非流式一样会被
	 * 拒 —— 拒绝发生在账单那一层,跟请求体里有没有 stream 毫无关系。硬回落只是把
	 * 同一个错误再撞一次,还把真正的原因藏在「流式不可用」这句话后面:主人看着
	 * 日志会以为是流式坏了,去翻代码而不是去充值。
	 */
	const httpErr = (status: number, msg: string) => Object.assign(new Error(msg), { status });

	it("402 余额不足 → 直接说是余额,不回落再撞一次", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValueOnce(httpErr(402, "402 status code (no body)"));

		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow(/余额|配额/);
		// 只发了一次 —— 没有白撞第二次。
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("401 key 无效 → 同样不回落,而且说的是 key 不是流式", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValueOnce(httpErr(401, "401 Unauthorized"));
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow(/API Key/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("429 限流 → 不回落,立刻重来只会加剧", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValueOnce(httpErr(429, "429 Too Many Requests"));
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow(/频繁|限流/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("开着 thinking 时 402 也不再降级重试一次", async () => {
		// thinking 降级那条路同样是「换个参数重来」,对账单问题一样白搭。
		const { gen } = makeGen({ enableThinking: true });
		oai.create.mockRejectedValue(httpErr(402, "402 status code (no body)"));
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow(/余额|配额/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	/**
	 * 超时与账户拒绝同类:**换个参数重来一样会超时**。
	 *
	 * 真机现场(2026-08-19 07:45:20 → 07:57:22):皮肤生成那趟非流式调用超时,先被
	 * 当成「网关不支持流式」回落一次,再被当成「方言参数不受支持」摘掉
	 * enable_thinking 整轮重来 —— 叠上 SDK 默认的 maxRetries=2,一道 120s 的闸硬生生
	 * 等成 12 分 02 秒,主人最后只等来一句 `Request timed out.`。
	 */
	const timeoutErr = () => {
		// SDK 那个类不设 name,认得出它的只有 constructor.name 与那句 message。
		class APIConnectionTimeoutError extends Error {}
		return new APIConnectionTimeoutError("Request timed out.");
	};

	it("超时 → 既不回落非流式也不摘方言参数,只发一次", async () => {
		// siliconflow 连「思考关着」都要发一条 enable_thinking:false,方言降级那条
		// 分支于是必然命中 —— 它不是偶发路径,是这家网关的常态。
		const { gen } = makeGen({ provider: "siliconflow", enableThinking: false });
		oai.create.mockRejectedValue(timeoutErr());
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow(/超时/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("504 这类上游超时同样只发一次 —— 重来一趟一样会卡在那儿", async () => {
		const { gen } = makeGen({ provider: "siliconflow", enableThinking: false });
		oai.create.mockRejectedValue(httpErr(504, "504 Gateway Timeout"));
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow(/超时/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("500 之类的上游抖动仍然回落 —— 那确实可能换条路就好了", async () => {
		const { gen } = makeGen();
		oai.create
			.mockRejectedValueOnce(httpErr(500, "500 Internal Server Error"))
			.mockResolvedValueOnce(msgResp("整段回复"));
		const result = await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
		});
		expect(result).toBe("整段回复");
	});

	it("已经吐出字之后再断 → 抛错,不静默吞掉半截回复", async () => {
		// 这时候页面上已经有半句话了,悄悄重来会让那半句凭空变成另一段。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield textChunk("前半句");
				throw new Error("connection reset");
			},
		});
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "x" }], { onDelta: () => {} }),
		).rejects.toThrow("connection reset");
	});

	/**
	 * 首字节之后的看门狗。
	 *
	 * SDK 的 `timeout` 靠 `setTimeout(abort)` + fetch resolve 时 `clearTimeout` 实现
	 * (`openai/core.js:386`),而 **fetch 在响应头到达时就 resolve** —— 流式一开,
	 * 那道闸当场失效,后面整段生成没有任何死线,模型 hang 住就是永远转圈。
	 *
	 * 所以死线得换个问法:**慢不算错,卡住才算错**。
	 */
	const hangingStream = (opts?: { signal?: AbortSignal }, lead?: string) => ({
		async *[Symbol.asyncIterator]() {
			if (lead) yield textChunk(lead);
			// 真 SDK 在 signal abort 时就是这么炸的。
			await new Promise((_res, rej) => {
				opts?.signal?.addEventListener("abort", () => rej(new Error("Request was aborted.")));
			});
		},
	});

	it("流开了之后卡住 —— 静默超过看门狗就断,而且只发一次", async () => {
		vi.useFakeTimers();
		try {
			const { gen } = makeGen({ provider: "siliconflow", enableThinking: false });
			oai.create.mockImplementation(async (_p: unknown, opts?: { signal?: AbortSignal }) =>
				hangingStream(opts, "开头"),
			);
			const caught = gen
				.chatStatelessStream([{ role: "user", content: "x" }], {
					onDelta: () => {},
				})
				.then(
					() => null,
					(e: Error) => e,
				);
			await vi.advanceTimersByTimeAsync(70_000);
			expect((await caught)?.message).toMatch(/卡住|超时/);
			// 卡住和超时同类:换个姿势重来一样会卡。
			expect(oai.create).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("第一片的宽限**更长** —— 网关排队、模型先想很久,都不算卡住", async () => {
		// 片与片之间静默一分钟一定是死了;但**第一片**之前静默一分钟很正常 ——
		// 网关在排队,或者推理模型正闷头想。拿片间那一档去卡首片,等于把慢网关
		// 和长思考一律误杀,比原先那道 120s 的闸还严。
		vi.useFakeTimers();
		try {
			const { gen } = makeGen({ provider: "siliconflow", enableThinking: false });
			oai.create.mockImplementation(async (_p: unknown, opts?: { signal?: AbortSignal }) =>
				hangingStream(opts),
			);
			const caught = gen
				.chatStatelessStream([{ role: "user", content: "x" }], {
					onDelta: () => {},
				})
				.then(
					() => null,
					(e: Error) => e,
				);
			// 片间那一档早就过了,首片这一档还没到 —— 不许掐。
			await vi.advanceTimersByTimeAsync(90_000);
			expect(await Promise.race([caught, Promise.resolve("still-running")])).toBe("still-running");
			// 首片这一档也过了 —— 这才是真卡住。
			await vi.advanceTimersByTimeAsync(120_000);
			expect((await caught)?.message).toMatch(/卡住|超时/);
			expect(oai.create).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("每来一片就重新计时 —— 慢不算卡住", async () => {
		// 片与片之间各等 40s,总共 120s 早就超过看门狗那一档,但从没静默满一整档。
		// 皮肤生成正是这个形状:很长,但一直在出字。
		vi.useFakeTimers();
		try {
			const { gen } = makeGen();
			oai.create.mockImplementation(async () => ({
				async *[Symbol.asyncIterator]() {
					for (const t of ["一", "二", "三"]) {
						await new Promise((res) => setTimeout(res, 40_000));
						yield textChunk(t);
					}
				},
			}));
			const done = gen.chatStatelessStream([{ role: "user", content: "x" }], {
				onDelta: () => {},
			});
			await vi.advanceTimersByTimeAsync(200_000);
			expect(await done).toBe("一二三");
			// 收尾要把看门狗撤掉,别把定时器漏在外面。
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("空历史 → 直接抛,与 chatStateless 同约定", async () => {
		const { gen } = makeGen();
		await expect(gen.chatStatelessStream([], { onDelta: () => {} })).rejects.toThrow(
			"对话历史为空",
		);
	});
});

// ---------------------------------------------------------------------------
// chatStatelessStream — 工具调用痕迹
// ---------------------------------------------------------------------------

/**
 * 工具轮**不产生正文**,所以在主人那边表现为打字点原地多停几秒 —— 她在查东西,
 * 界面上却和「模型卡住了」长得一模一样。`onToolEvent` 就是把这几秒讲出来。
 *
 * 分 start / end 两拍而不是查完一次性报:查订阅要走一趟 B 站,慢的时候好几秒,
 * 而那正是最需要反馈的一刻 —— 等查完再说,等于什么都没说。
 */
describe("CommentaryGenerator.chatStatelessStream — 工具调用痕迹", () => {
	interface Ev {
		phase: string;
		id: string;
		name?: string;
		args?: Record<string, string>;
		ok?: boolean;
	}

	/** 第一轮调一个工具,第二轮出正文。 */
	function toolThenText(name: string, args: object, text = "查到了") {
		oai.create
			.mockResolvedValueOnce(
				streamOf([toolChunk(0, { id: "c1", function: { name, arguments: JSON.stringify(args) } })]),
			)
			.mockResolvedValueOnce(streamOf([textChunk(text)]));
	}

	it("每个工具调用发一对 start / end", async () => {
		const { gen } = makeGen();
		toolThenText("fake_tool", { uid: "123" });

		const seen: Ev[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "帮我查" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e as Ev),
		});

		expect(seen.map((e) => e.phase)).toEqual(["start", "end"]);
		expect(seen[0]).toMatchObject({ name: "fake_tool", args: { uid: "123" } });
		expect(seen[1]).toMatchObject({ ok: true });
	});

	it("start 在工具执行**之前**发出 —— 等查完再说等于没说", async () => {
		const { gen } = makeGen();
		toolThenText("fake_tool", {});
		const order: string[] = [];
		toolsMock.executeTool.mockImplementationOnce(async () => {
			order.push("执行");
			return "r";
		});

		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
			onToolEvent: (e) => order.push(e.phase),
		});

		expect(order).toEqual(["start", "执行", "end"]);
	});

	it("end 用同一个 id 认回它的 start —— 一轮里两个工具不能串台", async () => {
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(
				streamOf([
					toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } }),
					toolChunk(1, { id: "c2", function: { name: "other_tool", arguments: "{}" } }),
				]),
			)
			.mockResolvedValueOnce(streamOf([textChunk("好了")]));

		const seen: Ev[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e as Ev),
		});

		const starts = seen.filter((e) => e.phase === "start");
		expect(starts.map((e) => e.name)).toEqual(["fake_tool", "other_tool"]);
		expect(new Set(starts.map((e) => e.id)).size).toBe(2);
		// 每个 start 都配得上一个同 id 的 end。
		for (const s of starts) {
			expect(seen.some((e) => e.phase === "end" && e.id === s.id)).toBe(true);
		}
	});

	it("跨轮的 id 也不重复 —— 否则第二轮的痕迹会盖掉第一轮的", async () => {
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(
				streamOf([toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{}" } })]),
			)
			.mockResolvedValueOnce(
				streamOf([toolChunk(0, { id: "c2", function: { name: "fake_tool", arguments: "{}" } })]),
			)
			.mockResolvedValueOnce(streamOf([textChunk("好了")]));

		const seen: Ev[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e as Ev),
		});

		const ids = seen.filter((e) => e.phase === "start").map((e) => e.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("工具执行失败 → end 的 ok 是假,对话照常继续", async () => {
		const { gen } = makeGen();
		toolThenText("fake_tool", {}, "虽然没查到,但…");
		toolsMock.executeTool.mockRejectedValueOnce(new Error("B 站超时"));

		const seen: Ev[] = [];
		const result = await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e as Ev),
		});

		expect(result).toBe("虽然没查到,但…");
		expect(seen.find((e) => e.phase === "end")).toMatchObject({ ok: false });
	});

	it("参数没解析出来也要发 start —— 她确实伸手够过这个工具", async () => {
		// 这条路上 executeTool 压根不会被调用(在 JSON.parse 就 catch 了)。若只在
		// 执行前发 start,主人看到的就是一段无缘无故的空白等待。
		const { gen } = makeGen();
		oai.create
			.mockResolvedValueOnce(
				streamOf([
					toolChunk(0, { id: "c1", function: { name: "fake_tool", arguments: "{不是json" } }),
				]),
			)
			.mockResolvedValueOnce(streamOf([textChunk("收尾")]));

		const seen: Ev[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e as Ev),
		});

		expect(seen.map((e) => e.phase)).toEqual(["start", "end"]);
		expect(seen[0]).toMatchObject({ name: "fake_tool", args: {} });
		expect(seen[1]).toMatchObject({ ok: false });
		expect(toolsMock.executeTool).not.toHaveBeenCalled();
	});

	it("入参里的数字归一成字符串 —— 与交给工具的那份完全一致", async () => {
		// 模型常把 uid 输出成数字。界面上和工具里拿到的必须是同一个值,否则
		// 「查了 UID 12345」和实际查的对不上号。
		const { gen } = makeGen();
		toolThenText("fake_tool", { uid: 12345 });

		const seen: Ev[] = [];
		await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e as Ev),
		});

		expect(seen[0]?.args).toEqual({ uid: "12345" });
		expect(toolsMock.executeTool.mock.calls[0]?.[1]).toEqual({ uid: "12345" });
	});

	it("不传 onToolEvent 照常跑 —— 它是可选的旁听席", async () => {
		const { gen } = makeGen();
		toolThenText("fake_tool", {});
		const result = await gen.chatStatelessStream([{ role: "user", content: "x" }], {
			onDelta: () => {},
		});
		expect(result).toBe("查到了");
	});
});

// ---------------------------------------------------------------------------
// 「只用纯文本」按调用方分叉
// ---------------------------------------------------------------------------

/**
 * dashboard 的聊天要渲染 Markdown,推送渠道不渲染。所以那条约束只对**对话**这一路
 * 摘掉,其余全部原样保留。
 *
 * 这一组的重心在推送侧:那才是一旦搞错就会把字面 `**加粗**` 送进主人群里的一侧。
 */
describe("CommentaryGenerator — Markdown 约束的作用域", () => {
	const PLAIN_TEXT_RULE = "只用纯文本";
	/** 取第 n 次调用实际发出去的 system prompt。 */
	const sysPrompt = (n: number) => createParams(n).messages[0]?.content as string;

	it("dashboard 流式聊天:摘掉那条约束", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await gen.chatStatelessStream([{ role: "user", content: "在吗" }], { onDelta: () => {} });
		expect(sysPrompt(0)).not.toContain(PLAIN_TEXT_RULE);
	});

	it("动态点评:约束照旧 —— 这一路直奔 QQ / Telegram", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("点评"));
		await gen.comment("某 UP 发了动态", "dynamic");
		expect(sysPrompt(0)).toContain(PLAIN_TEXT_RULE);
	});

	it("koishi 侧的 chat():约束照旧 —— 那边是群消息,不渲染 Markdown", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chat("问", "s1");
		expect(sysPrompt(0)).toContain(PLAIN_TEXT_RULE);
	});

	it("非流式 chatStateless:同样摘掉 —— 它与流式是同一个 dashboard 入口", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("答"));
		await gen.chatStateless([{ role: "user", content: "在吗" }]);
		expect(sysPrompt(0)).not.toContain(PLAIN_TEXT_RULE);
	});

	it("起标题那一跳不吃人格提示词,与这条约束无关", async () => {
		// summarizeTitle 用的是自己的提示词(TITLE_PROMPT),这里只是钉住它没被顺手
		// 接上人格那一段 —— 侧栏标题不该带口头禅。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("本周勤奋榜"));
		await gen.summarizeTitle([
			{ role: "user", content: "本周谁最勤奋" },
			{ role: "assistant", content: "让我看看" },
		]);
		expect(sysPrompt(0)).not.toContain(PLAIN_TEXT_RULE);
		expect(sysPrompt(0)).toContain("标题");
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
});

// ---------------------------------------------------------------------------
// P2-F: 过期 session 周期清扫(无界增长根因 — 过期项此前从不 delete)
// ---------------------------------------------------------------------------

describe("CommentaryGenerator — 过期 session 清扫 (P2-F)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("start() arm 周期 sweep;过期且不再访问的 session 被真正 delete(非仅跳过计数)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		let sweepFn: (() => void) | undefined;
		let sweepMs = 0;
		let intervalDisposed = false;
		const ctx: ServiceContext = {
			logger: { info() {}, warn() {}, error() {}, debug() {} },
			setInterval: (fn, ms) => {
				sweepFn = fn;
				sweepMs = ms;
				return {
					dispose() {
						intervalDisposed = true;
					},
				};
			},
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
		};
		const gen = new CommentaryGenerator({
			serviceCtx: ctx,
			api: {} as BilibiliAPI,
			config: makeConfig(),
		});
		gen.start();
		expect(typeof sweepFn).toBe("function");
		expect(sweepMs).toBe(10 * 60 * 1000);

		oai.create.mockResolvedValue(msgResp("答"));
		await gen.chat("问", "s-leak");
		expect((gen as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(1);

		// 越过 TTL(2h)且永不再访问 → sessionCount 已不计,但 Map 仍持有(泄漏点)
		vi.setSystemTime(new Date("2026-01-01T02:00:01Z"));
		expect(gen.sessionCount).toBe(0);
		expect((gen as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(1);

		// 周期 sweep 触发 → 真正从 Map 删除
		sweepFn?.();
		expect((gen as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);

		gen.stop();
		expect(intervalDisposed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// P2: ②8 chat() 同会话串行化 + :384 错误脱敏
// ---------------------------------------------------------------------------

describe("CommentaryGenerator — ②8 chat 串行化 / :384 脱敏 (P2)", () => {
	it("②8:同 sessionId 并发 chat 串行化,前一轮历史不丢", async () => {
		const { gen } = makeGen({ maxHistory: 10 });
		// 每次 create 在 microtask 后才 resolve,放大并发交错窗口。
		oai.create.mockImplementation(async () => {
			await new Promise((r) => setImmediate(r));
			return msgResp("R");
		});
		// 不在两次之间 await —— 并发进入 chat()。
		const c1 = gen.chat("M1", "S");
		const c2 = gen.chat("M2", "S");
		await Promise.all([c1, c2]);

		// 第三轮:其 messages 必须同时含 M1 与 M2(串行化 → 无写覆盖丢历史)。
		oai.create.mockImplementationOnce(async () => msgResp("R3"));
		await gen.chat("M3", "S");
		const lastMsgs = createParams(oai.create.mock.calls.length - 1).messages.map((m) => m.content);
		expect(lastMsgs).toContain("M1");
		expect(lastMsgs).toContain("M2");
		expect(lastMsgs).toContain("M3");
	});

	it(":384:OpenAI 错误经 chat 外抛前已抹掉 apiKey / Bearer", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValueOnce(
			new Error("401 POST https://api.test/v1 — Authorization: Bearer sk-test-LEAKED"),
		);
		const msg = await gen.chat("x", "s-err").then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(msg).not.toContain("sk-test");
		expect(msg).toContain("Bearer ***");
	});
});

describe("CommentaryGenerator.generateRaw(无人格结构化生成)", () => {
	it("system 原样直达、不叠人格/场景、不挂工具;返回正文", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(streamOf([textChunk('{"a":1}')]));
		const out = await gen.generateRaw("RAW_SYSTEM", "RAW_USER");
		expect(out).toBe('{"a":1}');
		const params = oai.create.mock.calls.at(-1)?.[0] as {
			messages: ChatMsg[];
			tools?: unknown;
		};
		expect(params.messages[0]).toEqual({ role: "system", content: "RAW_SYSTEM" });
		expect(params.messages[1]).toEqual({ role: "user", content: "RAW_USER" });
		expect(params.tools).toBeUndefined();
	});

	it("走流式 —— 别让整段生成压在一道死线上", async () => {
		// 非流式时网关要整份生成完才回响应头,SDK 那道闸于是压满全程;流式一开,
		// 首字节几秒就到,剩下的交给分片看门狗。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(streamOf([textChunk('{"a"'), textChunk(":1}")]));
		expect(await gen.generateRaw("S", "U")).toBe('{"a":1}');
		expect(createParams(0)).toMatchObject({ stream: true });
	});

	it("按累计字符数报进度 —— 主人能看见她在写", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(streamOf([textChunk("12345"), textChunk("678")]));
		const seen: number[] = [];
		await gen.generateRaw("S", "U", (chars) => seen.push(chars));
		expect(seen).toEqual([5, 8]);
	});

	it("兜底死线放到 300s,而且**不**让 SDK 偷偷重试", async () => {
		// 走了流式之后,SDK 这道闸只管到响应头 —— 剩下的交给分片看门狗。留着它是
		// 兜「网关连响应头都不给」那一种死法。maxRetries 归零则是因为重试改不了慢。
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(streamOf([textChunk("{}")]));
		await gen.generateRaw("S", "U");
		expect(oai.ctorArgs.at(-1)).toMatchObject({ timeout: 300_000, maxRetries: 0 });
	});

	it("聊天 / 点评那档照旧 120s —— 放宽只给结构化生成", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("点评"));
		await gen.comment("x");
		expect(oai.ctorArgs.at(-1)).toMatchObject({ timeout: 120_000, maxRetries: 0 });
	});
});

// ---------------------------------------------------------------------------
// 抖一下就好的失败
// ---------------------------------------------------------------------------

describe("CommentaryGenerator — 限流时按网关点名的时间回来", () => {
	/**
	 * `maxRetries: 0` 真正弄丢的只有这一样:SDK 的默认重试**会认 Retry-After**。
	 *
	 * 「429 不重来」本身是 2026-07-25 就立下的决定(见上面那节),理由是**立刻**
	 * 重来只会加剧 —— 那条完全成立,这里不推翻它。只有网关自己回了 Retry-After
	 * 才重来,并严格按它给的时间等:那不是「立刻重来」,是「按它说的点回来」。
	 */
	const limited = (retryAfter?: string) =>
		Object.assign(new Error("429 Too Many Requests"), {
			status: 429,
			...(retryAfter !== undefined ? { headers: { "retry-after": retryAfter } } : {}),
		});

	it("网关给了 Retry-After → 等它说的那么久,重来一次", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValueOnce(limited("0")).mockResolvedValueOnce(msgResp("点评"));
		expect(await gen.comment("x")).toBe("点评");
		expect(oai.create).toHaveBeenCalledTimes(2);
	});

	it("没给 Retry-After → 不重来(既有决定:立刻重来只会加剧)", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValue(limited());
		await expect(gen.comment("x")).rejects.toThrow(/频繁|限流/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("Retry-After 长得离谱 → 封顶,不让主人对着转圈等十分钟", async () => {
		// 假时钟只推进到封顶值:没封顶的话这一轮推不完,测试当场超时 —— 这就是
		// 断言本身,不必真等 600 秒。
		vi.useFakeTimers();
		try {
			const { gen } = makeGen();
			oai.create.mockRejectedValue(limited("600"));
			const settled = expect(gen.comment("x")).rejects.toThrow(/频繁|限流/);
			await vi.advanceTimersByTimeAsync(20_000);
			await settled;
			expect(oai.create).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("401 不重来 —— key 无效,重一万次也是无效", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValue(Object.assign(new Error("401"), { status: 401 }));
		await expect(gen.comment("x")).rejects.toThrow(/401|Key/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("超时不重来 —— 重一趟同样慢,只是把主人的等待翻倍", async () => {
		const { gen } = makeGen();
		oai.create.mockRejectedValue(new Error("Request timed out."));
		await expect(gen.comment("x")).rejects.toThrow(/超时/);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});

	it("已经吐过字之后再断 → 绝不重来(那半句会凭空变成另一段)", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield textChunk("半句");
				throw limited("0");
			},
		});
		const seen: string[] = [];
		await expect(
			gen.chatStatelessStream([{ role: "user", content: "在吗" }], {
				onDelta: (t) => seen.push(t),
			}),
		).rejects.toThrow();
		expect(seen).toEqual(["半句"]);
		expect(oai.create).toHaveBeenCalledTimes(1);
	});
});

describe("CommentaryGenerator — 副路两把闸也别放大超时", () => {
	/**
	 * 主路的 maxRetries 归零了,标题与视觉这两个副 client 当时漏了 —— 一道 60s 的
	 * 视觉闸叠上 SDK 默认的两次重试就是 180s,而视觉在推送热路径上(动态带图就走
	 * 它)。这两条都是**可降级**的增补(标题没了就用默认标题、图描述不出来就不描述),
	 * 拿延迟换成功率不划算:归零,快速失败。
	 */
	it("标题客户端 maxRetries 归零", async () => {
		const { gen } = makeGen();
		oai.create.mockResolvedValueOnce(msgResp("标题"));
		await gen.summarizeTitle([
			{ role: "user", content: "本周谁最勤奋" },
			{ role: "assistant", content: "是 A 君。" },
		]);
		expect(oai.ctorArgs.at(-1)).toMatchObject({ maxRetries: 0 });
	});

	it("视觉客户端 maxRetries 归零", async () => {
		const { gen } = makeGen({ vision: { model: "v-test" } });
		oai.create.mockResolvedValue(msgResp("一张图"));
		await gen.comment("看图说话", "dynamic", ["https://img.test/a.png"]);
		const visionCtor = oai.ctorArgs.find((a) => (a as { timeout?: number }).timeout === 60_000);
		expect(visionCtor).toMatchObject({ maxRetries: 0 });
	});
});
