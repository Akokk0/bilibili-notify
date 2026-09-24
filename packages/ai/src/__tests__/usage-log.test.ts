/**
 * token 用量日志 —— 经 `CommentaryGenerator` 的公共方法打进去,看 info 日志里
 * 真出现了那一行。
 *
 * 钉的是三件事:
 *   - **接线**:每种逻辑调用(点评三种场景 / 试推送 / 面板聊天 / 结构化生成 /
 *     起标题 / 看图)结束后各记**一行**,带得出是哪一种;
 *   - **记账**:工具环多轮加总成一行、写出轮数;失败重来的那一发不算;任何一轮
 *     缺某一格 → 总行那格写「未知」,绝不当 0;
 *   - **读法**:流式 usage 的三种落点(空 choices 块 / 最后内容块 / OpenRouter
 *     双 finish_reason)都读得到,而回复文本一字不变;include_usage 只在需要它的
 *     家 + 流式那一发上出现。
 *
 * `openai` 整体 mock,不碰任何真实接口。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommentaryGenerator, type CommentaryGeneratorConfig } from "../commentary-generator";
import { aiConfig, streamOf, textChunk } from "./harness";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const oai = vi.hoisted(() => {
	const chatCreate = vi.fn();
	const responsesCreate = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create: chatCreate } };
		responses = { create: responsesCreate };
	}
	return { chatCreate, responsesCreate, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

vi.mock("../tools", () => ({
	TOOL_DEFINITIONS: [{ type: "function", function: { name: "fake_tool", parameters: {} } }],
	DESCRIBE_IMAGE_TOOL: {
		type: "function",
		function: { name: "describe_image", parameters: {} },
	},
	// describe_image 真的转给 visionCtx.describe(照真实工具的序号语义),别的工具回一句占位 ——
	// 「看图工具那条路也是一批一行」要靠这一跳走到副模型。
	executeTool: vi.fn(
		async (
			name: string,
			args: Record<string, string>,
			_api: unknown,
			_subs: unknown,
			visionCtx?: { images: string[]; describe: (url: string) => Promise<string> },
		) =>
			name === "describe_image" && visionCtx
				? visionCtx.describe(visionCtx.images[Number(args.index) - 1])
				: "tool-result",
	),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 一台记下全部 info 日志的 generator。 */
function makeGen(over: Partial<CommentaryGeneratorConfig> = {}): {
	gen: CommentaryGenerator;
	info: string[];
} {
	const info: string[] = [];
	const serviceCtx: ServiceContext = {
		logger: { info: (m: string) => info.push(m), warn() {}, error() {}, debug() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const gen = new CommentaryGenerator({
		serviceCtx,
		api: {} as BilibiliAPI,
		config: aiConfig(over),
	});
	return { gen, info };
}

/** 只要 `[usage]` 那几行 —— 别的 info(启动、改配置)不关这里的事。 */
const usageLines = (info: string[]) => info.filter((l) => l.startsWith("[usage]"));

/** chat completions 的一份 usage。 */
function chatUsage(input: number, cached: number, output: number, reasoning: number) {
	return {
		prompt_tokens: input,
		completion_tokens: output,
		prompt_tokens_details: { cached_tokens: cached },
		completion_tokens_details: { reasoning_tokens: reasoning },
	};
}

function msgResp(content: string, usage?: unknown) {
	return {
		choices: [{ message: { role: "assistant", content } }],
		...(usage === undefined ? {} : { usage }),
	};
}

beforeEach(() => {
	oai.chatCreate.mockReset();
	oai.responsesCreate.mockReset();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("用量日志 —— 接线", () => {
	it("动态点评结束后,info 里记一行用量", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate.mockResolvedValueOnce(msgResp("好", chatUsage(12345, 11000, 321, 120)));

		await gen.comment("一条动态", "dynamic");

		expect(usageLines(info)).toEqual([
			"[usage] 动态点评 · 模型=gpt-test · 1 轮 · 输入 12345(缓存命中 11000)· 输出 321(思考 120)",
		]);
	});
});

describe("用量日志 —— 每种逻辑调用有自己的标签", () => {
	const nonStream = () =>
		oai.chatCreate.mockResolvedValueOnce(msgResp("好", chatUsage(10, 0, 2, 0)));
	const stream = () => oai.chatCreate.mockResolvedValueOnce(streamOf([textChunk("好")]));
	const history = [{ role: "user" as const, content: "在吗" }];

	it.each<[string, string, (gen: CommentaryGenerator) => Promise<unknown>, () => void]>([
		["comment(dynamic)", "动态点评", (gen) => gen.comment("x", "dynamic"), nonStream],
		["comment(liveSummary)", "下播总结", (gen) => gen.comment("x", "liveSummary"), nonStream],
		["comment() 无场景(锐评等)", "其他点评", (gen) => gen.comment("x"), nonStream],
		["chat()", "试推送", (gen) => gen.chat("x"), nonStream],
		["chatStateless()", "面板聊天", (gen) => gen.chatStateless(history), nonStream],
		[
			"chatStatelessStream()",
			"面板聊天",
			(gen) => gen.chatStatelessStream(history, { onDelta() {} }),
			stream,
		],
		["generateRaw()", "结构化生成", (gen) => gen.generateRaw("sys", "user"), stream],
	])("%s → %s", async (_method, label, call, arrange) => {
		const { gen, info } = makeGen();
		arrange();

		await call(gen);

		const lines = usageLines(info);
		expect(lines).toHaveLength(1);
		expect(lines[0].startsWith(`[usage] ${label} · 模型=gpt-test · 1 轮 · `)).toBe(true);
	});

	it("per-UP 覆盖了模型 → 行里写的是这次真用的那个", async () => {
		const { gen, info } = makeGen();
		nonStream();

		await gen.comment("x", "dynamic", undefined, { model: "per-up-model" });

		expect(usageLines(info)[0]).toContain("· 模型=per-up-model ·");
	});
});

/** 带一个工具调用的非流式响应。 */
function toolCallResp(usage?: unknown) {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "c1", type: "function", function: { name: "fake_tool", arguments: "{}" } },
					],
				},
			},
		],
		...(usage === undefined ? {} : { usage }),
	};
}

describe("用量日志 —— 一次逻辑调用只记一行,各轮加总", () => {
	it("工具环两轮 → 一行、2 轮、四格各自加总(缓存不并进输入)", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockResolvedValueOnce(toolCallResp(chatUsage(100, 80, 10, 4)))
			.mockResolvedValueOnce(msgResp("查到了", chatUsage(150, 100, 20, 6)));

		await gen.chat("帮我查查");

		expect(usageLines(info)).toEqual([
			"[usage] 试推送 · 模型=gpt-test · 2 轮 · 输入 250(缓存命中 180)· 输出 30(思考 10)",
		]);
	});

	it("有一轮没报缓存命中 → 总行那格写「未知」,其余照加 —— 半截的和不许冒充准数", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockResolvedValueOnce(toolCallResp(chatUsage(100, 80, 10, 4)))
			.mockResolvedValueOnce(msgResp("查到了", { prompt_tokens: 150, completion_tokens: 20 }));

		await gen.chat("帮我查查");

		expect(usageLines(info)).toEqual([
			"[usage] 试推送 · 模型=gpt-test · 2 轮 · 输入 250(缓存命中 未知)· 输出 30(思考 未知)",
		]);
	});

	it("有一轮压根没带 usage → 四格全「未知」,轮数照写", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockResolvedValueOnce(toolCallResp())
			.mockResolvedValueOnce(msgResp("查到了", chatUsage(150, 100, 20, 6)));

		await gen.chat("帮我查查");

		expect(usageLines(info)).toEqual([
			"[usage] 试推送 · 模型=gpt-test · 2 轮 · 输入 未知(缓存命中 未知)· 输出 未知(思考 未知)",
		]);
	});

	it("一轮 usage 都没拿到 → 照样记一行,数字全写「未知」", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate.mockResolvedValueOnce(msgResp("好"));

		await gen.comment("x", "dynamic");

		expect(usageLines(info)).toEqual([
			"[usage] 动态点评 · 模型=gpt-test · 1 轮 · 输入 未知(缓存命中 未知)· 输出 未知(思考 未知)",
		]);
	});

	it("流式不可用回落非流式 → 只算回落那一发(失败的流式那一发不算一轮)", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockRejectedValueOnce(new Error("stream is not supported"))
			.mockResolvedValueOnce(msgResp("好", chatUsage(50, 0, 5, 0)));

		await gen.chatStatelessStream([{ role: "user", content: "在吗" }], { onDelta() {} });

		expect(usageLines(info)).toEqual([
			"[usage] 面板聊天 · 模型=gpt-test · 1 轮 · 输入 50(缓存命中 0)· 输出 5(思考 0)",
		]);
	});

	it("方言参数被拒、摘掉重来 → 只算重来成功的那一发", async () => {
		const { gen, info } = makeGen({ provider: "deepseek", enableThinking: true });
		oai.chatCreate
			.mockRejectedValueOnce(Object.assign(new Error("unknown field thinking"), { status: 400 }))
			.mockResolvedValueOnce(msgResp("好", chatUsage(60, 30, 6, 0)));

		await gen.comment("x", "dynamic");

		expect(oai.chatCreate).toHaveBeenCalledTimes(2);
		expect(usageLines(info)).toEqual([
			"[usage] 动态点评 · 模型=gpt-test · 1 轮 · 输入 60(缓存命中 30)· 输出 6(思考 0)",
		]);
	});

	it("按 Retry-After 重来 → 只算重来成功的那一发", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockRejectedValueOnce(
				Object.assign(new Error("429"), { status: 429, headers: { "retry-after": "0" } }),
			)
			.mockResolvedValueOnce(msgResp("好", chatUsage(70, 0, 7, 0)));

		await gen.comment("x", "dynamic");

		expect(oai.chatCreate).toHaveBeenCalledTimes(2);
		expect(usageLines(info)).toEqual([
			"[usage] 动态点评 · 模型=gpt-test · 1 轮 · 输入 70(缓存命中 0)· 输出 7(思考 0)",
		]);
	});

	it("第一发就被拒 → 不记 —— 没有哪一轮的 token 看得见", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate.mockRejectedValueOnce(Object.assign(new Error("402"), { status: 402 }));

		await expect(gen.comment("x", "dynamic")).rejects.toThrow();

		expect(usageLines(info)).toEqual([]);
	});

	it("工具环第二轮失败 → 第一轮已经花掉的照记,标「未完成」", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockResolvedValueOnce(toolCallResp(chatUsage(100, 80, 10, 4)))
			.mockRejectedValueOnce(Object.assign(new Error("402"), { status: 402 }));

		await expect(gen.chat("帮我查查")).rejects.toThrow();

		expect(usageLines(info)).toEqual([
			"[usage] 试推送 · 模型=gpt-test · 1 轮 · 输入 100(缓存命中 80)· 输出 10(思考 4)· 未完成",
		]);
	});
});

describe("用量日志 —— 流式 chat completions 的三种 usage 落点", () => {
	/** 跑一次流式面板聊天,交回:返回值、onDelta 收到的分片、用量行。 */
	async function runStream(chunks: unknown[]) {
		const { gen, info } = makeGen();
		oai.chatCreate.mockResolvedValueOnce(streamOf(chunks));
		const deltas: string[] = [];
		const text = await gen.chatStatelessStream([{ role: "user", content: "在吗" }], {
			onDelta: (t) => deltas.push(t),
		});
		return { text, deltas, lines: usageLines(info) };
	}
	const WANT =
		"[usage] 面板聊天 · 模型=gpt-test · 1 轮 · 输入 12345(缓存命中 11000)· 输出 321(思考 120)";

	it("OpenAI / 百炼 / 方舟:usage 单独一块、在 finish_reason 那块之后、choices 是空数组", async () => {
		const { text, deltas, lines } = await runStream([
			{ choices: [{ delta: { role: "assistant", content: "" } }], usage: null },
			{ ...textChunk("主人"), usage: null },
			{ ...textChunk("晚上好"), usage: null },
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
			{ choices: [], usage: chatUsage(12345, 11000, 321, 120) },
		]);

		expect(text).toBe("主人晚上好");
		expect(deltas).toEqual(["主人", "晚上好"]);
		expect(lines).toEqual([WANT]);
	});

	it("DeepSeek:usage 挂在最后一个带 choice 的内容块上", async () => {
		const { text, deltas, lines } = await runStream([
			textChunk("主人"),
			{
				choices: [{ delta: { content: "晚上好" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 12345,
					completion_tokens: 321,
					prompt_cache_hit_tokens: 11000,
					completion_tokens_details: { reasoning_tokens: 120 },
				},
			},
		]);

		expect(text).toBe("主人晚上好");
		expect(deltas).toEqual(["主人", "晚上好"]);
		expect(lines).toEqual([WANT]);
	});

	it("OpenRouter:usage 块带一个空 delta 的 choice、finish_reason 出现两次 —— 正文不重复", async () => {
		const { text, deltas, lines } = await runStream([
			textChunk("主人"),
			textChunk("晚上好"),
			{ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: "stop" }] },
			{
				choices: [{ delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
				usage: chatUsage(12345, 11000, 321, 120),
			},
		]);

		expect(text).toBe("主人晚上好");
		expect(deltas).toEqual(["主人", "晚上好"]);
		expect(lines).toEqual([WANT]);
	});

	it("流在 usage 之前就断了(没有 usage 块)→ 那一轮照算,数字写「未知」", async () => {
		const { text, lines } = await runStream([textChunk("主人"), textChunk("晚上好")]);

		expect(text).toBe("主人晚上好");
		expect(lines).toEqual([
			"[usage] 面板聊天 · 模型=gpt-test · 1 轮 · 输入 未知(缓存命中 未知)· 输出 未知(思考 未知)",
		]);
	});

	it("流式工具环两轮 → 每轮各自的 usage 块都算进去", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate
			.mockResolvedValueOnce(
				streamOf([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "c1", function: { name: "fake_tool", arguments: "{}" } },
									],
								},
							},
						],
					},
					{ choices: [], usage: chatUsage(100, 80, 10, 4) },
				]),
			)
			.mockResolvedValueOnce(
				streamOf([textChunk("查到了"), { choices: [], usage: chatUsage(150, 100, 20, 6) }]),
			);

		await gen.chatStatelessStream([{ role: "user", content: "查查" }], { onDelta() {} });

		expect(usageLines(info)).toEqual([
			"[usage] 面板聊天 · 模型=gpt-test · 2 轮 · 输入 250(缓存命中 180)· 输出 30(思考 10)",
		]);
	});
});

describe("stream_options.include_usage —— 只在要它的家 + 流式那一发上", () => {
	const history = [{ role: "user" as const, content: "在吗" }];
	/** 第 n 次 chat.completions.create 的请求体。 */
	const chatParams = (n: number) => oai.chatCreate.mock.calls[n][0] as Record<string, unknown>;

	it.each(["bailian", "volcengine"] as const)("%s 流式:带上,不然拿不到用量", async (provider) => {
		const { gen } = makeGen({ provider });
		oai.chatCreate.mockResolvedValueOnce(streamOf([textChunk("好")]));

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(chatParams(0)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
	});

	it.each(["deepseek", "openrouter", "siliconflow", "custom"] as const)(
		"%s 流式:不发 —— 不开也给 / 参数已废弃 / 文档没有 / 网关未知",
		async (provider) => {
			const { gen } = makeGen({ provider });
			oai.chatCreate.mockResolvedValueOnce(streamOf([textChunk("好")]));

			await gen.chatStatelessStream(history, { onDelta() {} });

			expect(chatParams(0).stream).toBe(true);
			expect(chatParams(0)).not.toHaveProperty("stream_options");
		},
	);

	it("非流式请求不带 —— DeepSeek 这类家对非流式带它直接 400", async () => {
		const { gen } = makeGen({ provider: "bailian" });
		oai.chatCreate.mockResolvedValueOnce(msgResp("好"));

		await gen.comment("x", "dynamic");

		expect(chatParams(0)).not.toHaveProperty("stream_options");
	});

	it("流式失败回落非流式:回落那一发不带", async () => {
		const { gen } = makeGen({ provider: "bailian" });
		oai.chatCreate
			.mockRejectedValueOnce(new Error("stream is not supported"))
			.mockResolvedValueOnce(msgResp("好"));

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(chatParams(0)).toHaveProperty("stream_options");
		expect(chatParams(1).stream).toBeUndefined();
		expect(chatParams(1)).not.toHaveProperty("stream_options");
	});

	it("方言降级重试那一发不带", async () => {
		const { gen } = makeGen({ provider: "bailian", enableThinking: true });
		oai.chatCreate
			.mockRejectedValueOnce(Object.assign(new Error("unknown field"), { status: 400 }))
			.mockResolvedValueOnce(msgResp("好"));

		await gen.comment("x", "dynamic");

		expect(oai.chatCreate).toHaveBeenCalledTimes(2);
		expect(chatParams(1)).not.toHaveProperty("stream_options");
	});

	it("主人在额外参数里自己写了 stream_options → 主人的赢(与其它额外参数同一条规矩)", async () => {
		const { gen } = makeGen({
			provider: "bailian",
			extraParams: JSON.stringify({ stream_options: { include_usage: false } }),
		});
		oai.chatCreate.mockResolvedValueOnce(streamOf([textChunk("好")]));

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(chatParams(0).stream_options).toEqual({ include_usage: false });
	});

	it("responses 风味不带 —— 那边的 stream_options 只有 include_obfuscation,用量本来就在终态事件里", async () => {
		const { gen } = makeGen({ provider: "bailian", apiFlavor: "responses" });
		oai.responsesCreate.mockResolvedValueOnce(
			streamOf([
				{ type: "response.output_text.delta", delta: "好" },
				{ type: "response.completed", response: { output: [] } },
			]),
		);

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(oai.responsesCreate.mock.calls[0][0]).not.toHaveProperty("stream_options");
	});
});

describe("用量日志 —— responses 风味", () => {
	const history = [{ role: "user" as const, content: "在吗" }];
	const respUsage = {
		input_tokens: 900,
		output_tokens: 70,
		input_tokens_details: { cached_tokens: 512 },
		output_tokens_details: { reasoning_tokens: 30 },
	};
	const msgItem = (text: string) => ({
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
	});
	const fnCallItem = { type: "function_call", call_id: "k1", name: "fake_tool", arguments: "{}" };
	const WANT = "[usage] 面板聊天 · 模型=gpt-test · 1 轮 · 输入 900(缓存命中 512)· 输出 70(思考 30)";

	it("流式:从 response.completed 的 response.usage 读", async () => {
		const { gen, info } = makeGen({ apiFlavor: "responses" });
		oai.responsesCreate.mockResolvedValueOnce(
			streamOf([
				{ type: "response.output_text.delta", delta: "好" },
				{ type: "response.completed", response: { output: [msgItem("好")], usage: respUsage } },
			]),
		);

		const text = await gen.chatStatelessStream(history, { onDelta() {} });

		expect(text).toBe("好");
		expect(usageLines(info)).toEqual([WANT]);
	});

	it("流式:response.incomplete 的 usage 是 null → 不炸,那一轮照算、数字写「未知」", async () => {
		const { gen, info } = makeGen({ apiFlavor: "responses" });
		oai.responsesCreate.mockResolvedValueOnce(
			streamOf([
				{ type: "response.output_text.delta", delta: "好" },
				{ type: "response.incomplete", response: { output: [msgItem("好")], usage: null } },
			]),
		);

		const text = await gen.chatStatelessStream(history, { onDelta() {} });

		expect(text).toBe("好");
		expect(usageLines(info)).toEqual([
			"[usage] 面板聊天 · 模型=gpt-test · 1 轮 · 输入 未知(缓存命中 未知)· 输出 未知(思考 未知)",
		]);
	});

	it("流式:response.done(OpenRouter 示例的写法)上的 usage 也认", async () => {
		const { gen, info } = makeGen({ apiFlavor: "responses" });
		oai.responsesCreate.mockResolvedValueOnce(
			streamOf([
				{ type: "response.output_text.delta", delta: "好" },
				{ type: "response.completed", response: { output: [msgItem("好")] } },
				{ type: "response.done", response: { usage: respUsage } },
			]),
		);

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(usageLines(info)).toEqual([WANT]);
	});

	it("非流式:从响应顶层的 usage 读", async () => {
		const { gen, info } = makeGen({ apiFlavor: "responses" });
		oai.responsesCreate.mockResolvedValueOnce({ output: [msgItem("好")], usage: respUsage });

		await gen.chatStateless(history);

		expect(usageLines(info)).toEqual([WANT]);
	});

	it("流式不可用回落非流式 → 只算回落那一发", async () => {
		const { gen, info } = makeGen({ apiFlavor: "responses" });
		oai.responsesCreate
			.mockRejectedValueOnce(new Error("stream is not supported"))
			.mockResolvedValueOnce({ output: [msgItem("好")], usage: respUsage });

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(usageLines(info)).toEqual([WANT]);
	});

	it("工具环两轮 → 一行、2 轮、加总", async () => {
		const { gen, info } = makeGen({ apiFlavor: "responses" });
		oai.responsesCreate
			.mockResolvedValueOnce(
				streamOf([
					{ type: "response.completed", response: { output: [fnCallItem], usage: respUsage } },
				]),
			)
			.mockResolvedValueOnce(
				streamOf([
					{ type: "response.output_text.delta", delta: "好" },
					{ type: "response.completed", response: { output: [msgItem("好")], usage: respUsage } },
				]),
			);

		await gen.chatStatelessStream(history, { onDelta() {} });

		expect(usageLines(info)).toEqual([
			"[usage] 面板聊天 · 模型=gpt-test · 2 轮 · 输入 1800(缓存命中 1024)· 输出 140(思考 60)",
		]);
	});
});

describe("用量日志 —— 不走 callAPI 的两条副路", () => {
	it("起标题:记一行,模型是主模型", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate.mockResolvedValueOnce(msgResp("晚上问好", chatUsage(40, 0, 4, 0)));

		await gen.summarizeTitle([
			{ role: "user", content: "在吗" },
			{ role: "assistant", content: "在的主人" },
		]);

		expect(usageLines(info)).toEqual([
			"[usage] 起标题 · 模型=gpt-test · 1 轮 · 输入 40(缓存命中 0)· 输出 4(思考 0)",
		]);
	});

	it("起标题请求失败 → 不记", async () => {
		const { gen, info } = makeGen();
		oai.chatCreate.mockRejectedValueOnce(Object.assign(new Error("402"), { status: 402 }));

		await expect(gen.summarizeTitle([{ role: "user", content: "在吗" }])).rejects.toThrow();

		expect(usageLines(info)).toEqual([]);
	});

	it("看图:一次 describeImages 不管几张只记一行,单位是「张」,各张加总;点评另记一行", async () => {
		const { gen, info } = makeGen({ vision: { model: "qwen-vl" } });
		oai.chatCreate
			// 副模型先看图(两张按序发出),主模型后点评(comment 的图片分流在 callAPI 之前)。
			.mockResolvedValueOnce(msgResp("一只猫", chatUsage(800, 0, 30, 0)))
			.mockResolvedValueOnce(msgResp("一只狗", chatUsage(600, 100, 20, 5)))
			.mockResolvedValueOnce(msgResp("好可爱", chatUsage(200, 100, 10, 0)));

		await gen.comment("看我的猫狗", "dynamic", ["https://img/cat.jpg", "https://img/dog.jpg"]);

		expect(usageLines(info)).toEqual([
			"[usage] 看图 · 模型=qwen-vl · 2 张 · 输入 1400(缓存命中 100)· 输出 50(思考 5)",
			"[usage] 动态点评 · 模型=gpt-test · 1 轮 · 输入 200(缓存命中 100)· 输出 10(思考 0)",
		]);
	});

	it("看图:一批里有一张失败 → 成功的照加,标「未完成」", async () => {
		const { gen, info } = makeGen({ vision: { model: "qwen-vl" } });
		oai.chatCreate
			.mockRejectedValueOnce(new Error("拉不动图"))
			.mockResolvedValueOnce(msgResp("一只狗", chatUsage(600, 100, 20, 5)))
			.mockResolvedValueOnce(msgResp("好可爱", chatUsage(200, 100, 10, 0)));

		await gen.comment("看我的猫狗", "dynamic", ["https://img/cat.jpg", "https://img/dog.jpg"]);

		expect(usageLines(info)[0]).toBe(
			"[usage] 看图 · 模型=qwen-vl · 1 张 · 输入 600(缓存命中 100)· 输出 20(思考 5)· 未完成",
		);
	});

	it("看图:回来了但是空 choices(审查 / 上游异常)→ 不算成功那张,标「未完成」", async () => {
		const { gen, info } = makeGen({ vision: { model: "qwen-vl" } });
		oai.chatCreate
			.mockResolvedValueOnce({ choices: [], usage: chatUsage(900, 0, 0, 0) })
			.mockResolvedValueOnce(msgResp("一只狗", chatUsage(600, 100, 20, 5)))
			.mockResolvedValueOnce(msgResp("好可爱", chatUsage(200, 100, 10, 0)));

		await gen.comment("看我的猫狗", "dynamic", ["https://img/cat.jpg", "https://img/dog.jpg"]);

		expect(usageLines(info)[0]).toBe(
			"[usage] 看图 · 模型=qwen-vl · 1 张 · 输入 600(缓存命中 100)· 输出 20(思考 5)· 未完成",
		);
	});

	it("看图:一张都没成功返回 → 不记看图那行,点评照记", async () => {
		const { gen, info } = makeGen({ vision: { model: "qwen-vl" } });
		oai.chatCreate
			.mockRejectedValueOnce(new Error("拉不动图"))
			.mockRejectedValueOnce(new Error("拉不动图"))
			.mockResolvedValueOnce(msgResp("好可爱", chatUsage(200, 100, 10, 0)));

		await gen.comment("看我的猫狗", "dynamic", ["https://img/cat.jpg", "https://img/dog.jpg"]);

		expect(usageLines(info)).toEqual([
			"[usage] 动态点评 · 模型=gpt-test · 1 轮 · 输入 200(缓存命中 100)· 输出 10(思考 0)",
		]);
	});

	it("聊天里的 describe_image 工具那条路同样一批一行(一次调用看一张 → 1 张)", async () => {
		const { gen, info } = makeGen({ vision: { model: "qwen-vl" } });
		oai.chatCreate
			// 主模型第一轮:要看第 1 张图。
			.mockResolvedValueOnce({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "c1",
									type: "function",
									function: { name: "describe_image", arguments: '{"index":1}' },
								},
							],
						},
					},
				],
				usage: chatUsage(300, 0, 15, 0),
			})
			// 副模型描述那一张。
			.mockResolvedValueOnce(msgResp("一只猫", chatUsage(800, 0, 30, 0)))
			// 主模型第二轮:作答。
			.mockResolvedValueOnce(msgResp("是只猫", chatUsage(400, 300, 10, 0)));

		await gen.chatStateless([{ role: "user", content: "这是什么" }], {
			imageUrls: ["https://img/cat.jpg", "https://img/dog.jpg"],
		});

		expect(usageLines(info)).toEqual([
			"[usage] 看图 · 模型=qwen-vl · 1 张 · 输入 800(缓存命中 0)· 输出 30(思考 0)",
			"[usage] 面板聊天 · 模型=gpt-test · 2 轮 · 输入 700(缓存命中 300)· 输出 25(思考 0)",
		]);
	});

	it("注入工具交回的图转文字(toolImagesFor)同样一批一行", async () => {
		const { gen, info } = makeGen({ vision: { model: "qwen-vl" } });
		oai.chatCreate
			.mockResolvedValueOnce(
				streamOf([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "c1", function: { name: "shoot", arguments: "{}" } },
									],
								},
							},
						],
					},
				]),
			)
			.mockResolvedValueOnce(msgResp("截图一", chatUsage(800, 0, 30, 0)))
			.mockResolvedValueOnce(msgResp("截图二", chatUsage(600, 100, 20, 5)))
			.mockResolvedValueOnce(streamOf([textChunk("看过了")]));

		await gen.chatStatelessStream([{ role: "user", content: "截个图看看" }], {
			onDelta() {},
			extraTools: [
				{
					definition: { type: "function", function: { name: "shoot", parameters: {} } },
					execute: async () => ({
						text: "截好了",
						images: ["https://img/a.png", "https://img/b.png"],
					}),
				},
			],
		});

		expect(usageLines(info)[0]).toBe(
			"[usage] 看图 · 模型=qwen-vl · 2 张 · 输入 1400(缓存命中 100)· 输出 50(思考 5)",
		);
	});
});
