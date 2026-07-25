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

/** 起标题的硬超时。它只是个装饰,不值得让主人为它等到聊天那档 120s。 */
const TITLE_TIMEOUT_MS = 20_000;
/** 侧栏一行放得下的字数,超了截断加省略号。 */
const TITLE_MAX_CHARS = 16;
const TITLE_PROMPT = [
	"你是一个会话标题生成器。",
	"读完下面这轮对话,用中文起一个概括主题的短标题。",
	"要求:4 到 12 个字;只输出标题本身;不要引号、书名号、句号,也不要「标题:」之类的前缀;不要解释。",
].join("\n");

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 min — 清扫过期且不再被访问的 session

export type ConversationRole = "user" | "assistant";
/** 一条多轮对话消息。{@link CommentaryGenerator.chatStateless} 的入参元素。 */
export interface ConversationMessage {
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

	/**
	 * 无状态多轮:整段历史由调用方交出来,引擎用完即弃。
	 *
	 * 与 {@link chat} 的分工是「历史存在谁那里」。`chat()` 的历史躺在进程内存的
	 * session map 里,适合 koishi 那种「聊天窗口本身就是易失的」场景;独立端
	 * dashboard 的会话却落在磁盘上,重开浏览器记录还在 —— 这时再走 session map,
	 * 就会出现界面上明明摆着上文、女仆却完全不记得的裂缝。
	 *
	 * 因此这里**不读也不写** session map,`enableConversation` 对它没有意义;
	 * 同理也不做历史压缩 —— 压缩的产物是要存回 session 的摘要,无状态路径没有
	 * 「存回」这一步,再调一次模型写摘要纯属白烧 token。超长就按 maxHistory
	 * 截掉最旧的,截断策略与 `chat()` 一致。
	 */
	async chatStateless(
		messages: readonly ConversationMessage[],
		opts?: { sessionCtx?: SessionContext; imageUrls?: string[] },
	): Promise<{ result: string; pendingActions: Array<() => Promise<void>> }> {
		return this.chatStatelessImpl(messages, opts);
	}

	/**
	 * 与 {@link chatStateless} 同源,但正文**边生成边回调**。
	 *
	 * dashboard 的聊天用它:一次回答动辄十几秒,一次性甩出来的话,那十几秒里
	 * 页面上只有三个跳动的点,读起来像卡住了。
	 *
	 * 注意 `onDelta` 只喂**给人看的正文**。工具轮(查订阅、查直播状态)不产生
	 * 正文,那几轮自然静默 —— 表现为打字点多停一会儿,这是诚实的:那段时间
	 * 她确实在查东西而不是在说话。
	 */
	async chatStatelessStream(
		messages: readonly ConversationMessage[],
		opts: { onDelta: (text: string) => void; sessionCtx?: SessionContext; imageUrls?: string[] },
	): Promise<{ result: string; pendingActions: Array<() => Promise<void>> }> {
		return this.chatStatelessImpl(messages, opts);
	}

	private async chatStatelessImpl(
		messages: readonly ConversationMessage[],
		opts?: {
			sessionCtx?: SessionContext;
			imageUrls?: string[];
			onDelta?: (text: string) => void;
		},
	): Promise<{ result: string; pendingActions: Array<() => Promise<void>> }> {
		if (messages.length === 0) throw new Error("对话历史为空");

		// slice 顺带把调用方的数组复制了一份,这一点是必需的而非顺手:callAPI 的
		// 工具循环会**就地**往 messages 里 push 助手回复 / 工具结果,直接把持久化
		// 的消息数组递进去,那些记账消息就会漏回调用方,跟着存进磁盘。
		const trimmed = messages.slice(-this.config.maxHistory * 2);
		const systemPrompt = this.getSystemPrompt();
		this.logger.debug(`[chat-stateless] 历史=${messages.length} 条,实发=${trimmed.length} 条`);

		const pendingActions: Array<() => Promise<void>> = [];
		const result = await this.callAPI(
			systemPrompt,
			trimmed,
			{
				tools: TOOL_DEFINITIONS,
				onToolCall: (name, args) =>
					executeTool(
						name,
						args,
						this.api,
						() => this.getSubs(),
						opts?.sessionCtx,
						this.subMgmt ?? undefined,
						pendingActions,
					),
			},
			this.config.enableVision ? opts?.imageUrls : undefined,
			undefined,
			opts?.onDelta,
		);

		this.logger.debug(`[chat-stateless] 响应长度=${result.length}`);
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
	/**
	 * 看完首轮问答,起一个短标题。
	 *
	 * 不走 {@link callAPI}:那条路会挂上完整人格提示词和一整套工具,女仆会用她的
	 * 口吻**回答**这段对话,而不是给个标题;工具还可能真被调起来,白花一次往返。
	 * 这里要的是一句冷冰冰的概括,所以自带最小 system prompt、不给工具、不流式。
	 *
	 * 失败一律抛,由调用方决定退回原标题 —— 起不出名字是小事,不该连累已经聊完
	 * 的那一轮。
	 */
	async summarizeTitle(exchange: readonly ConversationMessage[]): Promise<string> {
		if (exchange.length === 0) throw new Error("没有可总结的对话");
		const { apiKey, baseURL, model } = this.config;
		if (!apiKey) throw new Error("AI apiKey 未配置");
		if (!baseURL) throw new Error("AI baseURL 未配置");

		const { default: OpenAI } = await import("openai");
		const client = new OpenAI({ apiKey, baseURL, timeout: TITLE_TIMEOUT_MS });
		let res: OpenAI.ChatCompletion;
		try {
			res = await client.chat.completions.create({
				model,
				// 低温:标题要的是概括,不是发挥。
				temperature: 0.2,
				// 别抠。推理模型会先想一段再给结论,预算太小就全花在思考上、正文
				// 空手而归 —— 起名永远失败,而主人只看到标题一直是自己那句提问。
				// 反正只调这一次,多给点无所谓。
				max_tokens: 256,
				messages: [
					{ role: "system", content: TITLE_PROMPT },
					{
						role: "user",
						content: exchange
							.map((m) => `${m.role === "user" ? "问" : "答"}:${m.content}`)
							.join("\n"),
					},
				],
			});
		} catch (e) {
			throw CommentaryGenerator.rejectionOf(e) ?? new Error(this.sanitizeErr(e));
		}

		const title = clipTitle(stripTitleDecoration(res.choices?.[0]?.message?.content ?? ""));
		// 空标题比「你好」更糟 —— 侧栏那一行会变成一片空白,看着像会话坏了。
		if (!title) throw new Error("模型没给出标题");
		return title;
	}

	/**
	 * 账户层面的拒绝 —— 说人话地描述它,拿不准就返回 null。
	 *
	 * 这几种错误的共同点是**换个参数重来一样会被拒**:拒绝发生在账单和鉴权那一层,
	 * 跟请求体里有没有 `stream`、开没开 thinking 毫无关系。所以它们既不该触发回落
	 * 非流式,也不该触发 thinking 降级 —— 那只是把同一个错误再撞一次。
	 *
	 * 更要紧的是**别把原因说错**:硅基流动余额用完时回的是干巴巴一句
	 * `402 status code (no body)`,若还套上「流式不可用」的措辞,主人只会以为是
	 * 流式坏了,去翻代码而不是去充值。
	 */
	private static rejectionOf(e: unknown): Error | null {
		const status = (e as { status?: unknown } | null)?.status;
		const msg =
			status === 401
				? "AI 网关拒绝:API Key 无效或已失效(401)"
				: status === 402
					? "AI 网关拒绝:账户余额不足或配额已用尽(402)"
					: status === 403
						? "AI 网关拒绝:无权访问该模型(403)"
						: status === 429
							? "AI 网关拒绝:请求过于频繁,已被限流(429)"
							: null;
		// 带上 status 再抛:外层那条 thinking 降级路径也要靠它认出「重来也没用」。
		return msg ? Object.assign(new Error(msg), { status }) : null;
	}

	private sanitizeErr(e: unknown): string {
		let msg = e instanceof Error ? e.message : String(e);
		const key = this.config.apiKey;
		if (key && key.length >= 6) msg = msg.split(key).join("***");
		return msg.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
	}

	/**
	 * 流式地取回**一轮**响应,把 content 分片喂给 onDelta,并把 tool_call 分片
	 * 按 index 拼回完整的调用。
	 *
	 * 两件事在流式下与非流式截然不同,都得自己收拾:
	 * ① 正文是一小段一小段来的 —— 累加即可;
	 * ② tool_call 的**函数名和参数同样是分片的**,而且靠 `index` 归位而不是 `id`
	 *    (id 只在第一片里出现)。不按 index 累加就会拿到半个函数名,工具永远
	 *    调不起来 —— 而且不报错,只是安静地什么都没查到。
	 */
	private async streamOnce(
		client: OpenAI,
		params: OpenAI.ChatCompletionCreateParamsStreaming,
		onDelta: (text: string) => void,
	): Promise<OpenAI.ChatCompletionMessage> {
		const stream = await client.chat.completions.create(params);
		let content = "";
		const slots: Array<{ id: string; name: string; args: string }> = [];
		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta;
			if (!delta) continue;
			// 首块通常只带 role、没有 content。回调一个空串会让页面白闪一下。
			if (delta.content) {
				content += delta.content;
				onDelta(delta.content);
			}
			for (const tc of delta.tool_calls ?? []) {
				let slot = slots[tc.index];
				if (!slot) {
					slot = { id: "", name: "", args: "" };
					slots[tc.index] = slot;
				}
				if (tc.id) slot.id = tc.id;
				if (tc.function?.name) slot.name += tc.function.name;
				if (tc.function?.arguments) slot.args += tc.function.arguments;
			}
		}
		const toolCalls = slots.filter(Boolean).map((s) => ({
			id: s.id,
			type: "function" as const,
			function: { name: s.name, arguments: s.args },
		}));
		return {
			role: "assistant",
			content: content || null,
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		} as OpenAI.ChatCompletionMessage;
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
		/**
		 * 给了就走流式,正文分片实时回调。工具轮**不**产生给人看的正文,所以
		 * 那几轮自然什么都不回调。
		 */
		onDelta?: (text: string) => void,
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

		/** 本次调用总共已经吐给调用方多少字 —— 决定了出错时还能不能悄悄重来。 */
		let emitted = 0;
		const emit = onDelta
			? (text: string) => {
					emitted += text.length;
					onDelta(text);
				}
			: undefined;

		/**
		 * 取一轮响应。开了流式就走流式,并在**还没吐过任何字**时容许回落非流式 ——
		 * 有些 OpenAI 兼容网关不支持 stream,不该让整个聊天用不了;而这一刻页面上
		 * 还是空的,悄悄重来一次对主人完全无感。
		 *
		 * 反过来,一旦吐过字再断,就必须把错误抛出去:那时页面上已经有半句话了,
		 * 静默重来会让那半句凭空变成另一段,比直接报错更难懂。
		 */
		const fetchRound = async (): Promise<OpenAI.ChatCompletionMessage> => {
			const base = makeParams(this.config.enableThinking, this.config.enableSearch);
			if (emit) {
				try {
					return await this.streamOnce(
						client,
						{ ...base, stream: true } as OpenAI.ChatCompletionCreateParamsStreaming,
						emit,
					);
				} catch (e) {
					if (emitted > 0) throw new Error(this.sanitizeErr(e));
					// 账单 / 鉴权那一层的拒绝跟 stream 无关,回落也是白撞一次。
					const rejection = CommentaryGenerator.rejectionOf(e);
					if (rejection) throw rejection;
					this.logger.warn(`[api] 流式不可用,回落非流式: ${this.sanitizeErr(e)}`);
				}
			}
			const res = await client.chat.completions.create(base);
			// AI1:兼容网关命中内容审查 / 上游异常时会返回空 choices。直接
			// res.choices[0].message 会抛不可读的 "Cannot read properties of
			// undefined";给出明确可诊断的错误,让调用方 catch 后回退纯文字。
			const choice = res.choices?.[0];
			if (!choice) {
				throw new Error("AI 网关返回空 choices(疑似命中内容审查或上游异常),无法生成");
			}
			// 回落路径下这一轮的正文是一次性到手的。仍然把它交给 onDelta ——
			// 调用方只认「分片流」这一种形状,不必为「有时候流、有时候不流」分叉。
			if (emit && choice.message.content) emit(choice.message.content);
			return choice.message;
		};

		const MAX_ROUNDS = 8;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			let message: OpenAI.ChatCompletionMessage;
			try {
				message = await fetchRound();
			} catch (e) {
				// 账单 / 鉴权那一层的拒绝原样抛出去。降级重试换的只是 thinking 参数,
				// 对「没钱了」毫无帮助 —— 白撞一次,还会把原因说成「thinking 不受支持」。
				const rejection = CommentaryGenerator.rejectionOf(e);
				if (rejection) throw rejection;
				// :384 OpenAI SDK 错误原文常含 baseURL / Authorization: Bearer
				// <apikey> 片段;callAPI 的错误会经 engine-error / log WS 外泄到
				// dashboard。脱敏后再 warn / 抛出。
				if (this.config.enableThinking && emitted === 0) {
					this.logger.warn(`[api] thinking 模式不受支持，降级重试: ${this.sanitizeErr(e)}`);
					try {
						const res = await client.chat.completions.create(
							makeParams(false, this.config.enableSearch),
						);
						const choice = res.choices?.[0];
						if (!choice) {
							throw new Error("AI 网关返回空 choices(疑似命中内容审查或上游异常),无法生成");
						}
						if (emit && choice.message.content) emit(choice.message.content);
						message = choice.message;
					} catch (e2) {
						throw new Error(this.sanitizeErr(e2));
					}
				} else {
					throw new Error(this.sanitizeErr(e));
				}
			}

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

/**
 * 洗掉模型爱加的装饰:包裹的引号、「标题:」这类前缀、结尾的句号。
 *
 * 提示词里已经说了不要,但各家模型的听话程度差很多 —— 这些装饰一旦漏进去就
 * 直接显示在侧栏那一行上,所以不指望提示词,在这儿兜住。
 */
function stripTitleDecoration(raw: string): string {
	// 先按行取**最后一个非空行**。推理模型常先写一段思考再给结论,而结论在最后;
	// 整段压成一行再截断的话,侧栏那行会变成半截思考。
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	let s = (lines[lines.length - 1] ?? "").replace(/\s+/g, " ");
	s = s.replace(/^(?:标题|title)\s*[:：]\s*/i, "");
	// 成对的引号才剥,只有一边的多半是内容的一部分。
	const pairs: Array<[string, string]> = [
		['"', '"'],
		["'", "'"],
		["「", "」"],
		["《", "》"],
		["“", "”"],
		["‘", "’"],
	];
	for (const [open, close] of pairs) {
		if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) {
			s = s.slice(open.length, -close.length).trim();
			break;
		}
	}
	return s.replace(/[。.!！?？]+$/, "").trim();
}

/** 超长就截断加省略号 —— 侧栏一行放不下。 */
function clipTitle(text: string): string {
	return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS)}…`;
}
