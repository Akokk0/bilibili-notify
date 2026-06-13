import type { BilibiliAPI } from "@bilibili-notify/api";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import type OpenAI from "openai";
import type { PersonaKey } from "./persona-presets";
import { buildSystemPrompt } from "./persona-presets";
import {
	executeTool,
	type SessionContext,
	type SubManagement,
	type Subscriptions,
	TOOL_DEFINITIONS,
} from "./tools";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 min — 清扫过期且不再被访问的 session

type ConversationRole = "user" | "assistant";
interface ConversationMessage {
	role: ConversationRole;
	content: string;
}

interface SessionEntry {
	messages: ConversationMessage[];
	lastActiveAt: number;
	/** 历史压缩摘要，注入到 system prompt 尾部 */
	summary?: string;
}

export type AIScene = "dynamic" | "liveSummary";

/** 平台中立的人格配置（与 koishi 端 PersonaConfig 字段保持一致，但不依赖 koishi Schema）。 */
export interface PersonaConfig {
	/** 基础人格预设 */
	preset: PersonaKey;
	/** AI 名字，留空则跟随预设默认值 */
	name?: string;
	/** 称呼用户的方式 */
	addressUser?: string;
	/** AI 的自称 */
	addressSelf?: string;
	/** 性格特点，逗号分隔 */
	traits?: string;
	/** 口头禅 */
	catchphrase?: string;
	/** preset 为 custom 时的基础描述 */
	customBase?: string;
	/** 追加到任何预设末尾的额外提示词（高级） */
	extraPrompt?: string;
}

/**
 * CommentaryGenerator 的运行时配置。
 * 与 koishi 端 BilibiliNotifyAIConfig 字段对应，但不包含 logLevel
 * （由 adapter 在外部配置 logger）。
 */
export interface CommentaryGeneratorConfig {
	apiKey: string;
	baseURL: string;
	model: string;
	/**
	 * chat.completions.create 的 temperature 参数（0–2）。未设置时不传该参数，
	 * 由 OpenAI 兼容服务自身决定默认值。adapter 通常用 `globals.defaults.ai.temperature` 填充。
	 */
	temperature?: number;

	/** 结构化人格配置 */
	persona: PersonaConfig;

	/** 动态点评时追加到人格提示词之后的场景说明 */
	dynamicPrompt: string;
	/** 直播总结时追加到人格提示词之后的场景说明 */
	liveSummaryPrompt: string;

	/** 开启后，chat 将记忆对话历史 */
	enableConversation: boolean;
	/** 多轮对话保留的最大历史轮次（每轮=一问一答） */
	maxHistory: number;

	/** 开启模型的思考模式（仅 Qwen3 等支持 enable_thinking 的模型有效） */
	enableThinking: boolean;

	/** 开启模型内置的联网搜索（仅 SiliconFlow 等支持 enable_search 的提供商有效） */
	enableSearch: boolean;

	/** 开启多模态图片理解（需模型支持视觉能力） */
	enableVision: boolean;
}

/**
 * 单次 comment() 调用的运行时覆盖。dynamic / live 引擎在 per-UP 推送上下文里构造
 * 一份只包含「与全局不同」的字段的 override，传给 comment() 后仅对该次调用生效。
 *
 * 未指定的字段都从 CommentaryGenerator.config 取，model/temperature 也走同一规则。
 * persona 是「整体替换」而非字段级合并 —— adapter 在产生 override 之前已经做完
 * preset / inherit / partial 折叠（见 `@bilibili-notify/internal#resolve`)。
 */
export interface CommentaryCallOverride {
	persona?: PersonaConfig;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
	temperature?: number;
	model?: string;
	/**
	 * per-UP 指定的 AstrBot 人格 id。仅 AstrBot bridge 消费(覆盖全局 --ai-persona-id);
	 * 自带 OpenAI 的 CommentaryGenerator 忽略此字段。
	 */
	personaId?: string;
}

export interface CommentaryProvider {
	comment(
		content: string,
		scene?: AIScene,
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string>;
}

export interface CommentaryGeneratorOptions {
	serviceCtx: ServiceContext;
	api: BilibiliAPI;
	config: CommentaryGeneratorConfig;
}

/**
 * 平台中立的 AI 点评 / 多轮对话核心。
 * 不依赖 koishi runtime；adapter 负责配置 logger、提供 BilibiliAPI 与可选的订阅管理钩子。
 */
export class CommentaryGenerator implements CommentaryProvider {
	private readonly logger: Logger;
	private readonly serviceCtx: ServiceContext;
	private readonly api: BilibiliAPI;
	private config: CommentaryGeneratorConfig;
	private readonly sessions = new Map<string, SessionEntry>();
	/**
	 * ②8:per-sessionId 串行链。同会话并发 chat() 若不排队,二者各读 entry、
	 * 各 await callAPI/compressHistory,最后 sessions.set 后写覆盖前写丢历史。
	 * 用链(排队)而非丢弃式锁 —— 第二条用户消息必须被响应,不能丢。
	 */
	private readonly chatChains = new Map<string, Promise<void>>();
	/** 周期清扫 handle;`start()` arm、`stop()` dispose。 */
	private sweepHandle?: { dispose(): void };

	private subsAccessor: (() => Subscriptions | null) | null = null;
	private subMgmt: SubManagement | null = null;

	constructor(opts: CommentaryGeneratorOptions) {
		this.api = opts.api;
		this.config = opts.config;
		this.serviceCtx = opts.serviceCtx;
		this.logger = opts.serviceCtx.logger;
	}

	/**
	 * 注入订阅查询 / 管理能力。Koishi adapter 在 BilibiliNotifyServerManager 启动后调用。
	 * 不调用此方法时，chat() 内的订阅相关工具会返回"功能不可用"。
	 */
	setSubManagement(opts: { getSubs: () => Subscriptions | null; subMgmt?: SubManagement }): void {
		this.subsAccessor = opts.getSubs;
		this.subMgmt = opts.subMgmt ?? null;
	}

	/** 替换运行时配置（adapter 在 koishi config / dashboard 编辑后调用）。 */
	updateConfig(config: CommentaryGeneratorConfig): void {
		this.config = config;
		const { preset, name, traits } = config.persona;
		this.logger.info(
			`[update] 人格预设：${preset}，名字：${name ?? "(默认)"}，模型：${config.model}，性格：${traits ?? "(默认)"}`,
		);
		this.logger.debug(`[update] 新系统提示词（无场景）：\n${this.getSystemPrompt()}`);
	}

	/** 删除所有已过 TTL 的 session(无界增长根因:过期项此前从不 delete)。 */
	private pruneExpiredSessions(now: number): void {
		let pruned = 0;
		for (const [id, e] of this.sessions) {
			if (now - e.lastActiveAt >= SESSION_TTL_MS) {
				this.sessions.delete(id);
				pruned++;
			}
		}
		if (pruned > 0) this.logger.debug(`[session] 清扫过期会话 ${pruned} 个`);
	}

	/** 启动钩子:打印人格信息 + arm 过期会话周期清扫。 */
	start(): void {
		this.sweepHandle?.dispose();
		this.sweepHandle = this.serviceCtx.setInterval(
			() => this.pruneExpiredSessions(Date.now()),
			SESSION_SWEEP_INTERVAL_MS,
		);
		const { preset } = this.config.persona;
		this.logger.info(
			`[start] 人格预设：${preset}，模型：${this.config.model}，多轮对话：${this.config.enableConversation ? "开启" : "关闭"}`,
		);
		this.logger.debug(`[start] 系统提示词（无场景）：\n${this.getSystemPrompt()}`);
	}

	/** 停止钩子，停清扫定时器并清空会话历史。 */
	stop(): void {
		this.sweepHandle?.dispose();
		this.sweepHandle = undefined;
		this.sessions.clear();
		this.logger.info("[stop] 会话历史已清除");
	}

	private getSubs(): Subscriptions | null {
		return this.subsAccessor ? this.subsAccessor() : null;
	}

	/**
	 * 获取指定场景的 system prompt。
	 * 始终以人格配置为基础，场景补充说明叠加在其后。
	 * `override` 用于 per-call 覆盖 persona/prompt，未指定字段回退到 this.config。
	 */
	getSystemPrompt(scene?: AIScene, summary?: string, override?: CommentaryCallOverride): string {
		const persona = override?.persona ?? this.config.persona;
		const personaPrompt = buildSystemPrompt(persona);
		const dynamicPrompt = override?.dynamicPrompt ?? this.config.dynamicPrompt;
		const liveSummaryPrompt = override?.liveSummaryPrompt ?? this.config.liveSummaryPrompt;
		const sceneAddition =
			scene === "dynamic" ? dynamicPrompt : scene === "liveSummary" ? liveSummaryPrompt : "";

		const base = sceneAddition ? `${personaPrompt}\n${sceneAddition}` : personaPrompt;
		return summary ? `${base}\n\n[之前对话摘要]\n${summary}` : base;
	}

	/**
	 * 单次 AI 调用，不保存历史。
	 * 供 dynamic/live 插件调用。`override` 可携带 per-UP 的 persona/prompt/model/temperature。
	 */
	async comment(
		content: string,
		scene?: AIScene,
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string> {
		const systemPrompt = this.getSystemPrompt(scene, undefined, override);
		this.logger.debug(
			`[comment] scene=${scene ?? "default"}, 内容长度=${content.length}, 图片数=${imageUrls?.length ?? 0}${override ? ", override=yes" : ""}`,
		);
		const result = await this.callAPI(
			systemPrompt,
			[{ role: "user", content }],
			undefined,
			this.config.enableVision ? imageUrls : undefined,
			override,
		);
		this.logger.debug(`[comment] 响应长度=${result.length}`);
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
	): Promise<{ result: string; pendingActions: Array<() => Promise<void>> }> {
		// ②8:排在同 sessionId 上一次 chat 之后再跑(读-改-写历史原子化)。
		const prior = this.chatChains.get(sessionId) ?? Promise.resolve();
		const task = prior
			.catch(() => {})
			.then(() => this.chatImpl(content, sessionId, imageUrls, sessionCtx));
		const tail = task.then(
			() => {},
			() => {},
		);
		this.chatChains.set(sessionId, tail);
		tail
			.then(() => {
				// 空闲即回收 map 项,避免 sessionId 无界增长。
				if (this.chatChains.get(sessionId) === tail) this.chatChains.delete(sessionId);
			})
			.catch(() => {});
		return task;
	}

	private async chatImpl(
		content: string,
		sessionId: string,
		imageUrls?: string[],
		sessionCtx?: SessionContext,
	): Promise<{ result: string; pendingActions: Array<() => Promise<void>> }> {
		const now = Date.now();
		const entry = this.sessions.get(sessionId);
		const isExpired = !entry || now - entry.lastActiveAt >= SESSION_TTL_MS;
		// 机会式清理:过期项被重新访问时立即移除(不再等下一轮 sweep);真正的
		// 无界增长由 start() 的周期 sweep 兜底(过期且永不再访问的 session)。
		if (entry && isExpired) this.sessions.delete(sessionId);
		const history: ConversationMessage[] = isExpired ? [] : [...entry.messages];
		const prevSummary = isExpired ? undefined : entry.summary;

		history.push({ role: "user", content });

		const systemPrompt = this.getSystemPrompt(undefined, prevSummary);
		this.logger.debug(
			`[chat] sessionId=${sessionId}, 历史轮次=${Math.floor(history.length / 2)}, 新消息长度=${content.length}`,
		);

		const maxMessages = this.config.maxHistory * 2;
		const trimmedHistory = history.slice(-maxMessages);

		const pendingActions: Array<() => Promise<void>> = [];

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
						() => this.getSubs(),
						sessionCtx,
						this.subMgmt ?? undefined,
						pendingActions,
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
				this.logger.debug(
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

		this.logger.debug(`[chat] 响应长度=${result.length}`);
		return { result, pendingActions };
	}

	/** 清除指定用户的对话历史 */
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.logger.debug(`[session] 清除会话 sessionId=${sessionId}`);
	}

	/** 执行 chat() 返回的延迟订阅操作（在 AI 回复发送后调用） */
	async flushPendingSubActions(pendingActions: Array<() => Promise<void>>): Promise<void> {
		if (!pendingActions.length) return;
		this.logger.debug(`[deferred] 执行 ${pendingActions.length} 个延迟操作`);
		for (const action of pendingActions) {
			try {
				await action();
			} catch (e) {
				this.logger.error(`[deferred] 延迟操作执行失败：${(e as Error).message}`);
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

	/** :384 错误脱敏:抹掉 apiKey 明文与 `Bearer <token>`,再进日志 / 外抛。 */
	private sanitizeErr(e: unknown): string {
		let msg = e instanceof Error ? e.message : String(e);
		const key = this.config.apiKey;
		if (key && key.length >= 6) msg = msg.split(key).join("***");
		return msg.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
	}

	private async callAPI(
		systemPrompt: string,
		messages: ConversationMessage[],
		toolOptions?: {
			tools: OpenAI.ChatCompletionTool[];
			onToolCall: (name: string, args: Record<string, string>) => Promise<string>;
		},
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string> {
		const { apiKey, baseURL } = this.config;
		const model = override?.model ?? this.config.model;
		const temperature = override?.temperature ?? this.config.temperature;
		if (!apiKey) throw new Error("AI apiKey 未配置");
		if (!baseURL) throw new Error("AI baseURL 未配置");

		this.logger.debug(
			`[api] baseURL=${baseURL}, model=${model}, temperature=${temperature ?? "default"}, messages=${messages.length}, tools=${toolOptions ? "yes" : "no"}, images=${imageUrls?.length ?? 0}`,
		);
		const { default: OpenAI } = await import("openai");
		// 单次 chat.completions.create 的硬超时。下播总结/动态点评偶发的 LLM 长尾(模型 hang
		// 或服务端 stuck)会让 Promise.all 整体派发卡住,影响 dispatchWordCloudAndSummary
		// 与 dispatchDynamic 的后续逻辑。120s 给模型留充足思考空间,超过即 reject,上层
		// 走 catch 路径(logger.warn + 降级文字)。tool-calling 多轮独立计时,不累加。
		const PER_REQUEST_TIMEOUT_MS = 120_000;
		const client = new OpenAI({ apiKey, baseURL, timeout: PER_REQUEST_TIMEOUT_MS });

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
				...(temperature !== undefined ? { temperature } : {}),
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
				// :384 OpenAI SDK 错误原文常含 baseURL / Authorization: Bearer
				// <apikey> 片段;callAPI 的错误会经 engine-error / log WS 外泄到
				// dashboard。脱敏后再 warn / 抛出。
				if (this.config.enableThinking) {
					this.logger.warn(`[api] thinking 模式不受支持，降级重试: ${this.sanitizeErr(e)}`);
					try {
						res = await client.chat.completions.create(makeParams(false, this.config.enableSearch));
					} catch (e2) {
						throw new Error(this.sanitizeErr(e2));
					}
				} else {
					throw new Error(this.sanitizeErr(e));
				}
			}

			// AI1:兼容网关命中内容审查 / 上游异常时会返回空 choices。直接
			// res.choices[0].message 会抛不可读的 "Cannot read properties of
			// undefined";给出明确可诊断的错误,让调用方 catch 后回退纯文字。
			const choice = res.choices?.[0];
			if (!choice) {
				throw new Error("AI 网关返回空 choices(疑似命中内容审查或上游异常),无法生成");
			}
			const message = choice.message;
			apiMessages.push(message);

			if (!message.tool_calls?.length) {
				return message.content ?? "";
			}

			this.logger.debug(`[tool] 第 ${round + 1} 轮，调用 ${message.tool_calls.length} 个工具`);
			if (!toolOptions) break;

			for (const toolCall of message.tool_calls) {
				let result: string;
				try {
					// :461 LLM 常把 uid 输出成数字(`{"uid":12345}`)。裸 as
					// Record<string,string> 是谎言 → 下游用 args.uid 当字符串与
					// 订阅 key("12345")比对失配。逐值强制 String 归一。
					const rawArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
					const args: Record<string, string> = Object.fromEntries(
						Object.entries(rawArgs).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]),
					);
					this.logger.debug(`[tool] 执行 ${toolCall.function.name}(${JSON.stringify(args)})`);
					result = await toolOptions.onToolCall(toolCall.function.name, args);
				} catch (e) {
					result = `工具执行失败: ${(e as Error).message}`;
				}
				this.logger.debug(`[tool] ${toolCall.function.name} 结果长度=${result.length}`);
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
