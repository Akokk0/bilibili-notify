import type { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type { Subscriptions } from "@bilibili-notify/push";
import { type Awaitable, type Context, type Logger, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import type OpenAI from "openai";
import { aiCommands } from "./commands";
import type { BilibiliNotifyAIConfig } from "./config";
import { buildSystemPrompt } from "./persona-presets";
import { executeTool, TOOL_DEFINITIONS } from "./tools";

declare module "koishi" {
	interface Context {
		"bilibili-notify-ai": BilibiliNotifyAI;
	}
}

const SERVICE_NAME = "bilibili-notify-ai";

type ConversationRole = "user" | "assistant";
interface ConversationMessage {
	role: ConversationRole;
	content: string;
}

export type AIScene = "dynamic" | "liveSummary";

export class BilibiliNotifyAI extends Service<BilibiliNotifyAIConfig> {
	static readonly [Service.provide] = SERVICE_NAME;

	private readonly aiLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private readonly sessions = new Map<string, ConversationMessage[]>();
	private api!: BilibiliAPI;
	private subs: Subscriptions | null = null;

	constructor(ctx: Context, config: BilibiliNotifyAIConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		this.aiLogger.level = config.logLevel;
		aiCommands.call(this);
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");
		this.api = internals.api;
		this.subs = internals.subs;
		this.ctx.on("bilibili-notify/subscription-changed", (subs) => {
			this.subs = subs;
		});

		const { preset } = this.config.persona;
		this.aiLogger.info(
			`AI 插件已启动，人格预设：${preset}，模型：${this.config.model}，多轮对话：${this.config.enableConversation ? "开启" : "关闭"}`,
		);
		this.aiLogger.debug(`[start] 系统提示词（无场景）：\n${this.getSystemPrompt()}`);
	}

	protected stop(): Awaitable<void> {
		this.sessions.clear();
		this.aiLogger.info("AI 插件已停止，会话历史已清除");
	}

	/**
	 * 获取指定场景的 system prompt。
	 * 始终以人格配置为基础，场景补充说明叠加在其后。
	 */
	getSystemPrompt(scene?: AIScene): string {
		const personaPrompt = buildSystemPrompt(this.config.persona);
		const sceneAddition =
			scene === "dynamic"
				? this.config.dynamicPrompt
				: scene === "liveSummary"
					? this.config.liveSummaryPrompt
					: "";

		return sceneAddition ? `${personaPrompt}\n${sceneAddition}` : personaPrompt;
	}

	/**
	 * 单次 AI 调用，不保存历史。
	 * 供 dynamic/live 插件调用。
	 */
	async comment(content: string, scene?: AIScene): Promise<string> {
		const systemPrompt = this.getSystemPrompt(scene);
		this.aiLogger.debug(`[comment] scene=${scene ?? "default"}, 内容长度=${content.length}`);
		const result = await this.callAPI(systemPrompt, [{ role: "user", content }]);
		this.aiLogger.debug(`[comment] 响应长度=${result.length}`);
		return result;
	}

	/**
	 * 多轮对话，按 sessionId 保存历史，自动携带工具能力。
	 * 供 bili chat 指令使用。
	 */
	async chat(content: string, sessionId: string): Promise<string> {
		const history = this.sessions.get(sessionId) ?? [];
		history.push({ role: "user", content });

		const systemPrompt = this.getSystemPrompt();
		this.aiLogger.debug(
			`[chat] sessionId=${sessionId}, 历史轮次=${Math.floor(history.length / 2)}, 新消息长度=${content.length}`,
		);

		const maxMessages = this.config.maxHistory * 2;
		const trimmedHistory = history.slice(-maxMessages);

		const result = await this.callAPI(systemPrompt, trimmedHistory, {
			tools: TOOL_DEFINITIONS,
			onToolCall: (name, args) => executeTool(name, args, this.api, this.subs),
		});

		history.push({ role: "assistant", content: result });
		this.sessions.set(sessionId, history.slice(-maxMessages));
		this.aiLogger.debug(`[chat] 响应长度=${result.length}`);
		return result;
	}

	/** 清除指定用户的对话历史 */
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.aiLogger.debug(`[clearSession] sessionId=${sessionId}`);
	}

	/** 当前活跃会话数 */
	get sessionCount(): number {
		return this.sessions.size;
	}

	private async callAPI(
		systemPrompt: string,
		messages: ConversationMessage[],
		toolOptions?: {
			tools: OpenAI.ChatCompletionTool[];
			onToolCall: (name: string, args: Record<string, string>) => Promise<string>;
		},
	): Promise<string> {
		const { apiKey, baseURL, model } = this.config;
		if (!apiKey) throw new Error("AI apiKey 未配置");
		if (!baseURL) throw new Error("AI baseURL 未配置");

		this.aiLogger.debug(
			`[API] baseURL=${baseURL}, model=${model}, messages=${messages.length}, tools=${toolOptions ? "yes" : "no"}`,
		);
		const { default: OpenAI } = await import("openai");
		const client = new OpenAI({ apiKey, baseURL });

		const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...messages,
		];

		/** ChatCompletionCreateParams + SiliconFlow/Qwen3 扩展字段 */
		type CreateParams = OpenAI.ChatCompletionCreateParamsNonStreaming & {
			extra_body?: Record<string, unknown>;
		};
		const makeParams = (withThinking: boolean): CreateParams => ({
			model,
			messages: apiMessages,
			...(toolOptions ? { tools: toolOptions.tools, tool_choice: "auto" } : {}),
			...(withThinking ? { extra_body: { enable_thinking: true } } : {}),
		});

		const MAX_ROUNDS = 8;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			let res: Awaited<ReturnType<typeof client.chat.completions.create>>;
			try {
				res = await client.chat.completions.create(makeParams(this.config.enableThinking));
			} catch (e) {
				if (this.config.enableThinking) {
					this.aiLogger.warn(`[API] thinking 模式不受支持，降级重试: ${(e as Error).message}`);
					res = await client.chat.completions.create(makeParams(false));
				} else {
					throw e;
				}
			}

			const message = res.choices[0].message;
			apiMessages.push(message);

			if (!message.tool_calls?.length) {
				return message.content ?? "";
			}

			this.aiLogger.debug(`[tool] 第 ${round + 1} 轮，调用 ${message.tool_calls.length} 个工具`);
			if (!toolOptions) break;

			for (const toolCall of message.tool_calls) {
				let result: string;
				try {
					const args = JSON.parse(toolCall.function.arguments) as Record<string, string>;
					this.aiLogger.debug(`[tool] 执行 ${toolCall.function.name}(${JSON.stringify(args)})`);
					result = await toolOptions.onToolCall(toolCall.function.name, args);
				} catch (e) {
					result = `工具执行失败: ${(e as Error).message}`;
				}
				this.aiLogger.debug(`[tool] ${toolCall.function.name} 结果长度=${result.length}`);
				apiMessages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					content: result,
				});
			}
		}

		return "（工具调用轮次已达上限）";
	}
}
