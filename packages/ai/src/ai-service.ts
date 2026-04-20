import type { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { type Awaitable, type Context, type Logger, Service } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import type OpenAI from "openai";
import { aiCommands } from "./commands";
import type { BilibiliNotifyAIConfig } from "./config";
import { buildSystemPrompt } from "./persona-presets";
import { executeTool, type SessionContext, type SubManagement, TOOL_DEFINITIONS } from "./tools";

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

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SessionEntry {
	messages: ConversationMessage[];
	lastActiveAt: number;
	/** 历史压缩摘要，注入到 system prompt 尾部 */
	summary?: string;
}

export type AIScene = "dynamic" | "liveSummary";

export class BilibiliNotifyAI extends Service<BilibiliNotifyAIConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static readonly inject = ["bilibili-notify"];

	private readonly aiLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly pendingSubActionsMap = new Map<string, Array<() => Promise<void>>>();
	private api!: BilibiliAPI;
	private subMgmt: SubManagement | null = null;

	private get subs() {
		return this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN)?.subs ?? null;
	}

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
		this.subMgmt = {
			addSub: internals.addSub,
			removeSub: internals.removeSub,
			updateSub: internals.updateSub,
		};

		const { preset } = this.config.persona;
		this.aiLogger.info(
			`[start] 人格预设：${preset}，模型：${this.config.model}，多轮对话：${this.config.enableConversation ? "开启" : "关闭"}`,
		);
		this.aiLogger.debug(`[start] 系统提示词（无场景）：\n${this.getSystemPrompt()}`);
	}

	protected stop(): Awaitable<void> {
		this.sessions.clear();
		this.aiLogger.info("[stop] 会话历史已清除");
	}

	/**
	 * 获取指定场景的 system prompt。
	 * 始终以人格配置为基础，场景补充说明叠加在其后。
	 */
	getSystemPrompt(scene?: AIScene, summary?: string): string {
		const personaPrompt = buildSystemPrompt(this.config.persona);
		const sceneAddition =
			scene === "dynamic"
				? this.config.dynamicPrompt
				: scene === "liveSummary"
					? this.config.liveSummaryPrompt
					: "";

		const base = sceneAddition ? `${personaPrompt}\n${sceneAddition}` : personaPrompt;
		return summary ? `${base}\n\n[之前对话摘要]\n${summary}` : base;
	}

	/**
	 * 单次 AI 调用，不保存历史。
	 * 供 dynamic/live 插件调用。
	 */
	async comment(content: string, scene?: AIScene, imageUrls?: string[]): Promise<string> {
		const systemPrompt = this.getSystemPrompt(scene);
		this.aiLogger.debug(
			`[comment] scene=${scene ?? "default"}, 内容长度=${content.length}, 图片数=${imageUrls?.length ?? 0}`,
		);
		const result = await this.callAPI(
			systemPrompt,
			[{ role: "user", content }],
			undefined,
			this.config.enableVision ? imageUrls : undefined,
		);
		this.aiLogger.debug(`[comment] 响应长度=${result.length}`);
		return result;
	}

	/**
	 * 多轮对话，按 sessionId 保存历史，自动携带工具能力。
	 * 历史满载时自动压缩最旧一半为摘要。
	 * 供 bili chat 指令使用。
	 */
	async chat(
		content: string,
		sessionId: string,
		imageUrls?: string[],
		sessionCtx?: SessionContext,
	): Promise<string> {
		const now = Date.now();
		const entry = this.sessions.get(sessionId);
		const isExpired = !entry || now - entry.lastActiveAt >= SESSION_TTL_MS;
		const history: ConversationMessage[] = isExpired ? [] : [...entry.messages];
		const prevSummary = isExpired ? undefined : entry.summary;

		history.push({ role: "user", content });

		const systemPrompt = this.getSystemPrompt(undefined, prevSummary);
		this.aiLogger.debug(
			`[chat] sessionId=${sessionId}, 历史轮次=${Math.floor(history.length / 2)}, 新消息长度=${content.length}`,
		);

		const maxMessages = this.config.maxHistory * 2;
		const trimmedHistory = history.slice(-maxMessages);

		const pendingSubActions: Array<() => Promise<void>> = [];
		this.pendingSubActionsMap.set(sessionId, pendingSubActions);

		const result = await this.callAPI(
			systemPrompt,
			trimmedHistory,
			{
				tools: TOOL_DEFINITIONS,
				onToolCall: (name, args) =>
					executeTool(
						name,
						args,
						this.api,
						this.subs, // getter — always returns current subs from core
						sessionCtx,
						this.subMgmt ?? undefined,
						pendingSubActions,
					),
			},
			this.config.enableVision ? imageUrls : undefined,
		);

		if (this.config.enableConversation) {
			trimmedHistory.push({ role: "assistant", content: result });

			let newMessages = trimmedHistory;
			let newSummary = prevSummary;

			// 历史满载时压缩最旧一半
			if (trimmedHistory.length >= maxMessages) {
				const half = Math.floor(maxMessages / 2);
				const toCompress = trimmedHistory.slice(0, half);
				newMessages = trimmedHistory.slice(half);
				newSummary = await this.compressHistory(toCompress, prevSummary);
				this.aiLogger.debug(
					`[chat] 历史已压缩，摘要长度=${newSummary.length}，保留消息=${newMessages.length}`,
				);
			}

			this.sessions.set(sessionId, {
				messages: newMessages,
				lastActiveAt: now,
				summary: newSummary,
			});
		} else {
			this.sessions.delete(sessionId);
		}

		this.aiLogger.debug(`[chat] 响应长度=${result.length}`);
		return result;
	}

	/** 清除指定用户的对话历史 */
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.aiLogger.debug(`[session] 清除会话 sessionId=${sessionId}`);
	}

	/** 执行 chat() 调用中积累的延迟订阅操作（在 AI 回复发送后调用） */
	async flushPendingSubActions(sessionId: string): Promise<void> {
		const actions = this.pendingSubActionsMap.get(sessionId);
		this.pendingSubActionsMap.delete(sessionId);
		if (!actions?.length) return;
		this.aiLogger.debug(`[deferred] sessionId=${sessionId}, 执行 ${actions.length} 个延迟操作`);
		for (const action of actions) {
			try {
				await action();
			} catch (e) {
				this.aiLogger.error(`[deferred] 延迟操作执行失败：${(e as Error).message}`);
			}
		}
	}

	/** 当前活跃（未过期）会话数 */
	get sessionCount(): number {
		const now = Date.now();
		let count = 0;
		for (const entry of this.sessions.values()) {
			if (now - entry.lastActiveAt < SESSION_TTL_MS) count++;
		}
		return count;
	}

	/** 将一段对话消息压缩为摘要，可合并上一轮摘要 */
	private async compressHistory(
		messages: ConversationMessage[],
		prevSummary?: string,
	): Promise<string> {
		const prevNote = prevSummary ? `（已有摘要：${prevSummary}）\n\n以下是新增对话：\n` : "";
		const text = messages
			.map((m) => `${m.role === "user" ? "用户" : "AI"}：${m.content}`)
			.join("\n");
		const prompt = `${prevNote}${text}\n\n请将以上对话提炼为简短摘要（100字以内），只输出摘要本身。`;
		return this.callAPI("你是对话摘要助手，只输出摘要内容，不附加任何前缀或解释。", [
			{ role: "user", content: prompt },
		]);
	}

	private async callAPI(
		systemPrompt: string,
		messages: ConversationMessage[],
		toolOptions?: {
			tools: OpenAI.ChatCompletionTool[];
			onToolCall: (name: string, args: Record<string, string>) => Promise<string>;
		},
		imageUrls?: string[],
	): Promise<string> {
		const { apiKey, baseURL, model } = this.config;
		if (!apiKey) throw new Error("AI apiKey 未配置");
		if (!baseURL) throw new Error("AI baseURL 未配置");

		this.aiLogger.debug(
			`[api] baseURL=${baseURL}, model=${model}, messages=${messages.length}, tools=${toolOptions ? "yes" : "no"}, images=${imageUrls?.length ?? 0}`,
		);
		const { default: OpenAI } = await import("openai");
		const client = new OpenAI({ apiKey, baseURL });

		const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
		];
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const isLastUser = i === messages.length - 1 && msg.role === "user" && imageUrls?.length;
			if (isLastUser && imageUrls) {
				apiMessages.push({
					role: "user",
					content: [
						{ type: "text", text: msg.content },
						...imageUrls.map((url) => ({
							type: "image_url" as const,
							image_url: { url },
						})),
					],
				});
			} else {
				apiMessages.push(msg);
			}
		}

		/** ChatCompletionCreateParams + SiliconFlow/Qwen3 扩展字段 */
		type CreateParams = OpenAI.ChatCompletionCreateParamsNonStreaming & {
			extra_body?: Record<string, unknown>;
		};
		const makeParams = (withThinking: boolean, withSearch: boolean): CreateParams => {
			const extra_body: Record<string, unknown> = {};
			if (withThinking) extra_body.enable_thinking = true;
			if (withSearch) extra_body.enable_search = true;
			return {
				model,
				messages: apiMessages,
				...(toolOptions ? { tools: toolOptions.tools, tool_choice: "auto" } : {}),
				...(Object.keys(extra_body).length > 0 ? { extra_body } : {}),
			};
		};

		const MAX_ROUNDS = 8;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			let res: Awaited<ReturnType<typeof client.chat.completions.create>>;
			try {
				res = await client.chat.completions.create(
					makeParams(this.config.enableThinking, this.config.enableSearch),
				);
			} catch (e) {
				if (this.config.enableThinking) {
					this.aiLogger.warn(`[api] thinking 模式不受支持，降级重试: ${(e as Error).message}`);
					res = await client.chat.completions.create(makeParams(false, this.config.enableSearch));
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
