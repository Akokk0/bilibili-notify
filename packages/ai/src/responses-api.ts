/**
 * Responses API(`/responses`,OpenAI 2025 起的接任协议)的纯函数层 —— 把
 * callAPI 既有的 chat completions 形状折算成 responses 的请求体,不碰网络。
 *
 * 折算而不是另起一套组装:消息拼装(system prompt、会话历史、往最后一条 user
 * 挂图)在 callAPI 里已经写对过一遍,responses 分支复用那份产物,免得两条
 * 风味各养一套拼装逻辑再各自长 bug。
 *
 * 思考在这套协议里是一等公民(标准 `reasoning.effort`,与配置面的三档同词表),
 * 所以**不再走各家 chat 方言**(`buildProviderParams` 是 chat 风味专属)——
 * custom 档案也因此在 responses 风味下第一次有了能用的思考开关。
 */

import type OpenAI from "openai";
import type { BuildProviderParamsInput } from "./providers";

/**
 * 思考 → 标准 `reasoning.effort`。返回请求体**顶层**字段,与
 * `buildProviderParams` 同一姿势,方便降级重试时整块摘掉。
 *
 * 「关」位有方言差(百炼 2026-08 官方文档钉死;DeepSeek 官方文档没写关位,
 * 2026-08-13 真 key 实测钉死 —— 文档当时读成「不传即关」,上线后胶囊关了
 * 回复照样思考,实测不传默认思考 41 tokens、发 none 归零):
 * - DeepSeek / 百炼:`/responses` 上**思考默认开**,必须显式 `{effort:"none"}`
 *   才关得掉,不发等于开关失灵;
 * - OpenRouter / custom:上游是谁都有可能,`none` 不是 OpenAI 词表里的标准档,
 *   乱发换来 400;不传、交给上游默认(真被拒还有摘 reasoning 的降级重试兜底)。
 */
export function buildResponsesReasoning(input: BuildProviderParamsInput): Record<string, unknown> {
	if (!input.enableThinking) {
		const defaultsOn = input.provider === "deepseek" || input.provider === "bailian";
		return defaultsOn ? { reasoning: { effort: "none" } } : {};
	}
	return { reasoning: { effort: input.thinkingLevel } };
}

/** responses 的 input item(宽形状 —— SDK 类型对新事件/字段跟不上线上协议)。 */
export type ResponsesInputItem = Record<string, unknown>;

/**
 * chat 形状的 messages → responses 的 input items。
 *
 * role 词表(system/user/assistant)两边一致,纯文本消息原样过桥;带图的
 * user 消息把 parts 换词:`text`→`input_text`,`image_url`→`input_image`
 * (那边 `image_url` 是**裸字符串**,不是 `{url}` 包一层)。
 *
 * 工具轮的 assistant(tool_calls)/tool 消息**不在此列** —— responses 分支的
 * 工具环直接以 function_call / function_call_output item 维护自己的历史,
 * 这里只负责进环之前的底盘对话。
 */
export function toResponsesInput(
	messages: readonly OpenAI.ChatCompletionMessageParam[],
): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			items.push({ role: msg.role, content: msg.content });
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		const parts: Record<string, unknown>[] = [];
		for (const part of msg.content) {
			if (part.type === "text") {
				parts.push({ type: "input_text", text: part.text });
			} else if (part.type === "image_url") {
				parts.push({ type: "input_image", image_url: part.image_url.url, detail: "auto" });
			}
		}
		items.push({ role: msg.role, content: parts });
	}
	return items;
}

/**
 * 工具定义:chat 的嵌套形(`function:{...}`)→ responses 的扁平形。
 *
 * `strict: false` 是有意的:strict 模式要求 JSON Schema 按它的子集写
 * (required 全列、additionalProperties:false),现有八个 B 站工具 + web_search
 * 都没按那套写,开了会被 OpenAI 侧当场拒;DeepSeek 对不认识的参数静默忽略,
 * 发 false 两边都安全。缺席的 description/parameters 补 null,不让 undefined
 * 漏进序列化。
 */
export function toResponsesTools(
	tools: readonly OpenAI.ChatCompletionTool[],
): Record<string, unknown>[] {
	return tools.map((t) => ({
		type: "function",
		name: t.function.name,
		description: t.function.description ?? null,
		parameters: (t.function.parameters as Record<string, unknown> | undefined) ?? null,
		strict: false,
	}));
}

/**
 * 一轮响应(`response.output`)里的正文:message item 的 `output_text` parts
 * 逐段拼接。items 全程宽形状 —— SDK 4.104 的类型联合跟不上线上协议(reasoning
 * 事件一族整个缺席),与其对着过时的类型硬拗,不如统一按结构探测。
 */
export function responsesOutputText(items: readonly unknown[]): string {
	let text = "";
	for (const it of items) {
		const item = it as { type?: unknown; content?: unknown };
		if (item?.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			const p = part as { type?: unknown; text?: unknown };
			if (p?.type === "output_text" && typeof p.text === "string") text += p.text;
		}
	}
	return text;
}

/** 一轮响应里的工具调用。`call_id` 是回填 function_call_output 的配对钥匙。 */
export interface ResponsesFunctionCall {
	callId: string;
	name: string;
	argsJson: string;
}

export function responsesFunctionCalls(items: readonly unknown[]): ResponsesFunctionCall[] {
	const calls: ResponsesFunctionCall[] = [];
	for (const it of items) {
		const item = it as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
		if (item?.type !== "function_call") continue;
		calls.push({
			callId: typeof item.call_id === "string" ? item.call_id : "",
			name: typeof item.name === "string" ? item.name : "",
			argsJson: typeof item.arguments === "string" ? item.arguments : "{}",
		});
	}
	return calls;
}

/**
 * 非流式路径从 reasoning item 里抠思考文本,补喂给回调(流式下走
 * `response.reasoning_text.delta`,不经这里)。两种壳都认:DeepSeek 把全文
 * 放 `content[].text`,OpenAI 官方只给 `summary[].text` —— 都是「能给多少
 * 显示多少」,抠不出来就安静返回空串,绝不影响正文。
 */
export function responsesReasoningText(items: readonly unknown[]): string {
	let text = "";
	for (const it of items) {
		const item = it as { type?: unknown; summary?: unknown; content?: unknown };
		if (item?.type !== "reasoning") continue;
		for (const list of [item.content, item.summary]) {
			if (!Array.isArray(list)) continue;
			for (const entry of list) {
				const e = entry as { text?: unknown };
				if (typeof e?.text === "string") text += e.text;
			}
		}
	}
	return text;
}
