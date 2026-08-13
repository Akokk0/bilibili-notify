/**
 * Responses API 的纯函数层:请求体折算,不碰网络。
 *
 * 三件事:① 思考 → 标准 `reasoning.effort`(不再走各家 chat 方言,这正是上
 * responses 的动机之一);② chat 形状的 messages → responses 的 input items
 * (复用 callAPI 既有的消息组装,含挂图);③ 嵌套的 function 工具定义 → 扁平。
 *
 * 「关」位的方言差(2026-08 官方文档钉死):DeepSeek 不传 reasoning 即不思考;
 * 百炼默认 medium **思考默认开**,关必须显式 `{effort:"none"}` —— 不发等于
 * 这个开关根本关不掉,和 chat 方言里 thinkingDefaultsOn 是同一课。
 */

import type OpenAI from "openai";
import { describe, expect, it } from "vite-plus/test";
import { buildResponsesReasoning, toResponsesInput, toResponsesTools } from "../responses-api";

describe("buildResponsesReasoning", () => {
	it("开思考 → 标准 reasoning.effort,三档原样透传(DeepSeek)", () => {
		expect(
			buildResponsesReasoning({ provider: "deepseek", enableThinking: true, thinkingLevel: "low" }),
		).toEqual({ reasoning: { effort: "low" } });
		expect(
			buildResponsesReasoning({
				provider: "deepseek",
				enableThinking: true,
				thinkingLevel: "high",
			}),
		).toEqual({ reasoning: { effort: "high" } });
	});

	it("custom 也吃标准字段 —— responses 风味下思考不再是方言,custom 解禁", () => {
		expect(
			buildResponsesReasoning({
				provider: "custom",
				enableThinking: true,
				thinkingLevel: "medium",
			}),
		).toEqual({ reasoning: { effort: "medium" } });
	});

	it("关思考:OpenRouter/custom 方言未知,不传、交给上游默认", () => {
		for (const provider of ["openrouter", "custom"] as const) {
			expect(
				buildResponsesReasoning({ provider, enableThinking: false, thinkingLevel: "medium" }),
			).toEqual({});
		}
	});

	it("关思考:DeepSeek/百炼在 /responses 上默认就思考,必须显式 effort:none 才关得掉(真 key 实测)", () => {
		for (const provider of ["deepseek", "bailian"] as const) {
			expect(
				buildResponsesReasoning({ provider, enableThinking: false, thinkingLevel: "medium" }),
			).toEqual({ reasoning: { effort: "none" } });
		}
	});
});

describe("toResponsesInput", () => {
	it("system/user/assistant 的纯文本消息原样过桥(role 词表两边一致)", () => {
		expect(
			toResponsesInput([
				{ role: "system", content: "你是女仆" },
				{ role: "user", content: "早" },
				{ role: "assistant", content: "主人早～" },
			]),
		).toEqual([
			{ role: "system", content: "你是女仆" },
			{ role: "user", content: "早" },
			{ role: "assistant", content: "主人早～" },
		]);
	});

	it("带图的 user 消息:text→input_text,image_url→input_image(url 是裸字符串)", () => {
		expect(
			toResponsesInput([
				{
					role: "user",
					content: [
						{ type: "text", text: "看图" },
						{ type: "image_url", image_url: { url: "https://i0.hdslb.com/a.jpg" } },
					],
				},
			]),
		).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "看图" },
					{ type: "input_image", image_url: "https://i0.hdslb.com/a.jpg", detail: "auto" },
				],
			},
		]);
	});

	// 真实 Responses API 对 assistant 消息只收 output 词表(output_text/refusal),
	// 发 input_text 在 OpenAI 严格网关上是 400。当前调用方不会给 assistant 挂段
	// 数组(历史恒为字符串),但函数签名收整个 ChatCompletionMessageParam[] ——
	// 契约面敞着,按 role 换词把它钉死。
	it("assistant 的多段 content → output_text(那边 assistant 只收 output 词表)", () => {
		expect(
			toResponsesInput([
				{
					role: "assistant",
					content: [{ type: "text", text: "之前说过" }],
				} as unknown as OpenAI.ChatCompletionMessageParam,
			]),
		).toEqual([{ role: "assistant", content: [{ type: "output_text", text: "之前说过" }] }]);
	});
});

describe("toResponsesTools", () => {
	it("嵌套的 function 定义 → 扁平;strict 显式 false(工具 schema 没按 strict 模式写)", () => {
		expect(
			toResponsesTools([
				{
					type: "function",
					function: {
						name: "web_search",
						description: "联网搜索",
						parameters: { type: "object", properties: { query: { type: "string" } } },
					},
				},
			]),
		).toEqual([
			{
				type: "function",
				name: "web_search",
				description: "联网搜索",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				strict: false,
			},
		]);
	});

	it("description/parameters 缺席 → 补 null,不让 undefined 漏进请求体", () => {
		expect(toResponsesTools([{ type: "function", function: { name: "bare" } }])).toEqual([
			{ type: "function", name: "bare", description: null, parameters: null, strict: false },
		]);
	});
});
