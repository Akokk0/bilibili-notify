/**
 * responses 风味经 callAPI 的整条链路 —— 经 `chatStateless(Stream)` 公共接口,
 * `openai` SDK 整体 mock(`responses.create` 返回手搓的语义事件流)。
 *
 * 钉住的契约(2026-08 按官方文档核实):
 *   - 流式事件按 `type` 字符串消费:`response.output_text.delta` 是正文、
 *     `response.reasoning_text.delta` 是思考,终态在 `response.completed`
 *     的 `response.output` items 里;
 *   - 工具环:`function_call` item(`call_id`/`name`/`arguments`)→ 执行 →
 *     `function_call_output` 回填,且上一轮的**全部** output items(含
 *     reasoning)原样回传 —— 思考回传是协议契约,丢了 DeepSeek 直接 400;
 *   - 失败**不回落** chat completions:两套协议的 404 语义完全不同,静默
 *     换协议只会把「没配对」演成「有时灵有时不灵」。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	CommentaryGenerator,
	CommentaryGeneratorConfig,
	ToolTraceEvent,
} from "../commentary-generator";
import type { WebSearchResult } from "../web-search";
import { makeGen as baseGen, streamOf } from "./harness";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const oai = vi.hoisted(() => {
	const chatCreate = vi.fn();
	// 显式标注参数,否则 vi.fn 推出空参元组,.mock.calls[0][0] 触发 TS2493。
	const responsesCreate = vi.fn(async (_params: Record<string, unknown>): Promise<unknown> => {
		throw new Error("unmocked responses.create");
	});
	class FakeOpenAI {
		chat = { completions: { create: chatCreate } };
		responses = { create: responsesCreate };
	}
	return { chatCreate, responsesCreate, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

const toolsMock = vi.hoisted(() => ({
	executeTool: vi.fn(
		async (_name: string, _args: Record<string, string>): Promise<string> => "tool-result",
	),
}));
vi.mock("../tools", () => ({
	TOOL_DEFINITIONS: [
		{ type: "function", function: { name: "fake_tool", description: "假工具", parameters: {} } },
	],
	executeTool: toolsMock.executeTool,
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * 这个文件专测 responses 风味,所以那几项**必须**是自己的:方言走 deepseek、
 * apiFlavor 钉死 responses。其余全吃公共底。
 */
function makeGen(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGenerator {
	return baseGen({
		baseURL: "https://api.test",
		model: "ds-test",
		provider: "deepseek",
		thinkingLevel: "medium",
		apiFlavor: "responses",
		...over,
	});
}

const textDelta = (t: string) => ({ type: "response.output_text.delta", delta: t });
const thinkDelta = (t: string) => ({ type: "response.reasoning_text.delta", delta: t });
const completed = (items: unknown[]) => ({
	type: "response.completed",
	response: { output: items },
});
const msgItem = (text: string) => ({
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text }],
});
const fnCallItem = (name: string, args: object, callId: string) => ({
	type: "function_call",
	call_id: callId,
	name,
	arguments: JSON.stringify(args),
});

/** 第 n 次 responses.create 的请求体。 */
function params(n: number): Record<string, unknown> {
	return oai.responsesCreate.mock.calls[n][0];
}

beforeEach(() => {
	oai.chatCreate.mockReset();
	oai.responsesCreate.mockReset();
	toolsMock.executeTool.mockClear();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("responses 风味:路由与请求形状", () => {
	it("走 responses.create 而非 chat.completions;input/扁平工具/tool_choice 齐备", async () => {
		oai.responsesCreate.mockResolvedValueOnce(
			streamOf([textDelta("好"), completed([msgItem("好")])]),
		);
		const gen = makeGen();
		const out = await gen.chatStatelessStream([{ role: "user", content: "早" }], {
			onDelta: () => {},
		});
		expect(out).toBe("好");
		expect(oai.chatCreate).not.toHaveBeenCalled();

		const p = params(0);
		expect(p.model).toBe("ds-test");
		expect(p.stream).toBe(true);
		expect(p.messages).toBeUndefined();
		// mock 存的是 input 数组的**引用**,取轮后环会往里 push 本轮产物 ——
		// 所以不按「最后一条」断言,按角色找。
		const input = p.input as Array<Record<string, unknown>>;
		expect(input[0]?.role).toBe("system");
		expect(input.find((it) => it.role === "user")).toMatchObject({ role: "user", content: "早" });
		const tools = p.tools as Array<Record<string, unknown>>;
		expect(tools[0]).toMatchObject({ type: "function", name: "fake_tool", strict: false });
		expect(p.tool_choice).toBe("auto");
	});

	it("非流式(chatStateless):不带 stream,从 output items 取正文", async () => {
		oai.responsesCreate.mockResolvedValueOnce({ output: [msgItem("纯文本答案")] });
		const gen = makeGen({ extraParams: '{"max_output_tokens":100}' });
		const out = await gen.chatStateless([{ role: "user", content: "hi" }]);
		expect(out).toBe("纯文本答案");
		expect(params(0).stream).toBeUndefined();
		// 主人手写的额外参数照常摊进请求体顶层
		expect(params(0).max_output_tokens).toBe(100);
	});
});

describe("responses 风味:流式分流与思考参数", () => {
	it("正文走 onDelta、思考走 onReasoning,互不混淆", async () => {
		oai.responsesCreate.mockResolvedValueOnce(
			streamOf([
				thinkDelta("先想"),
				thinkDelta("再想"),
				textDelta("答"),
				completed([msgItem("答")]),
			]),
		);
		const gen = makeGen();
		const deltas: string[] = [];
		const thinks: string[] = [];
		const out = await gen.chatStatelessStream([{ role: "user", content: "问" }], {
			onDelta: (t) => deltas.push(t),
			onReasoning: (t) => thinks.push(t),
		});
		expect(out).toBe("答");
		expect(deltas).toEqual(["答"]);
		expect(thinks).toEqual(["先想", "再想"]);
	});

	it("per-message 思考开 → 标准 reasoning.effort;关(deepseek)→ 显式 effort:none(实测不发=默认思考)", async () => {
		oai.responsesCreate.mockResolvedValueOnce(streamOf([completed([msgItem("a")])]));
		const gen = makeGen();
		await gen.chatStatelessStream([{ role: "user", content: "1" }], {
			onDelta: () => {},
			thinking: { enableThinking: true, thinkingLevel: "high" },
		});
		expect(params(0).reasoning).toEqual({ effort: "high" });

		oai.responsesCreate.mockResolvedValueOnce(streamOf([completed([msgItem("b")])]));
		await gen.chatStatelessStream([{ role: "user", content: "2" }], { onDelta: () => {} });
		expect(params(1).reasoning).toEqual({ effort: "none" });
	});

	it("流式不可用且没吐过字 → 回落非流式,正文补喂回调", async () => {
		oai.responsesCreate
			.mockRejectedValueOnce(new Error("stream unsupported"))
			.mockResolvedValueOnce({ output: [msgItem("回落成功")] });
		const gen = makeGen();
		const deltas: string[] = [];
		const out = await gen.chatStatelessStream([{ role: "user", content: "hi" }], {
			onDelta: (t) => deltas.push(t),
		});
		expect(out).toBe("回落成功");
		expect(deltas).toEqual(["回落成功"]);
		expect(params(0).stream).toBe(true);
		expect(params(1).stream).toBeUndefined();
	});

	it("reasoning 参数被拒且没吐过字 → 摘掉 reasoning 重试(额外参数保留)", async () => {
		// chatStateless 没有 onDelta → 不会先试流式,第一发即非流式:一共两发。
		oai.responsesCreate
			.mockRejectedValueOnce(new Error("reasoning not supported"))
			.mockResolvedValueOnce({ output: [msgItem("ok")] });
		const gen = makeGen({
			enableThinking: true,
			thinkingLevel: "low",
			extraParams: '{"top_k":5}',
		});
		const out = await gen.chatStateless([{ role: "user", content: "hi" }]);
		expect(out).toBe("ok");
		// 第一发带 reasoning,重试那发不带;两发都带主人的额外参数
		expect(params(0).reasoning).toEqual({ effort: "low" });
		expect(params(0).top_k).toBe(5);
		const last = oai.responsesCreate.mock.calls.length - 1;
		expect(params(last).reasoning).toBeUndefined();
		expect(params(last).top_k).toBe(5);
	});
});

describe("responses 风味:工具环", () => {
	it("function_call → 执行 → function_call_output 回填;上一轮 output(含 reasoning)原样回传", async () => {
		oai.responsesCreate
			.mockResolvedValueOnce(
				streamOf([
					completed([
						{ type: "reasoning", summary: [] },
						fnCallItem("web_search", { query: "天气" }, "fc_9"),
						fnCallItem("fake_tool", { uid: 123 }, "fc_10"),
					]),
				]),
			)
			.mockResolvedValueOnce(streamOf([textDelta("答案"), completed([msgItem("答案")])]));

		const gen = makeGen();
		const found: WebSearchResult[] = [
			{ title: "T", url: "https://x.example", snippet: "s", siteName: "X 站" },
		];
		gen.setWebSearchSource(() => ({
			backend: "bocha",
			search: async () => found,
			// 找图那条路(皮肤工坊专用)与生成器无关,这里给个空实现占位。
		}));

		const events: ToolTraceEvent[] = [];
		const out = await gen.chatStatelessStream([{ role: "user", content: "查天气" }], {
			onDelta: () => {},
			onToolEvent: (ev) => events.push(ev),
			webSearch: true,
		});
		expect(out).toBe("答案");

		// 第二轮请求体:上一轮全部 output items + 两条 function_call_output
		const input2 = params(1).input as Array<Record<string, unknown>>;
		expect(input2.some((it) => it.type === "reasoning")).toBe(true);
		expect(input2.some((it) => it.type === "function_call")).toBe(true);
		const outputs = input2.filter((it) => it.type === "function_call_output");
		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toMatchObject({ call_id: "fc_9" });
		expect(String(outputs[0]?.output)).toContain("T");
		expect(outputs[1]).toEqual({
			type: "function_call_output",
			call_id: "fc_10",
			output: "tool-result",
		});
		// fake_tool 的数字参数被归一成字符串(与 chat 风味同一课)
		expect(toolsMock.executeTool.mock.calls[0]?.[1]).toEqual({ uid: "123" });

		// 痕迹两拍,web_search 的 end 带结构化来源
		expect(events.filter((e) => e.phase === "start")).toHaveLength(2);
		const ends = events.filter((e) => e.phase === "end");
		expect(ends[0]).toMatchObject({
			ok: true,
			sources: [{ title: "T", url: "https://x.example", siteName: "X 站" }],
		});
	});
});

describe("responses 风味:失败语义", () => {
	it("请求失败不回落 chat completions —— 静默换协议只会把配置错演成玄学", async () => {
		oai.responsesCreate.mockRejectedValueOnce(Object.assign(new Error("404"), { status: 404 }));
		const gen = makeGen();
		await expect(gen.chatStateless([{ role: "user", content: "hi" }])).rejects.toThrow();
		expect(oai.chatCreate).not.toHaveBeenCalled();
	});
});
