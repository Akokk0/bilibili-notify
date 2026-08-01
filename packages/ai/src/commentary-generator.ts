import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	type AIProviderId,
	type Logger,
	providerMeta,
	type ServiceContext,
	type ThinkingLevel,
} from "@bilibili-notify/internal";
import type OpenAI from "openai";
import { mergeExtraParams, parseExtraParams } from "./extra-params";
import type { PersonaKey } from "./persona-presets";
import { buildSystemPrompt } from "./persona-presets";
import { buildProviderParams } from "./providers";
import {
	DESCRIBE_IMAGE_TOOL,
	executeTool,
	type Subscriptions,
	TOOL_DEFINITIONS,
	type VisionToolContext,
} from "./tools";
import { describeImages, renderImageDescriptions, type VisionCaller } from "./vision";

/** 起标题的硬超时。它只是个装饰,不值得让主人为它等到聊天那档 120s。 */
const TITLE_TIMEOUT_MS = 20_000;
/** 侧栏一行放得下的字数,超了截断加省略号。 */
const TITLE_MAX_CHARS = 16;
const TITLE_PROMPT = [
	"你是一个会话标题生成器。",
	"读完下面这轮对话,用中文起一个概括主题的短标题。",
	"要求:4 到 12 个字;只输出标题本身;不要引号、书名号、句号,也不要「标题:」之类的前缀;不要解释。",
].join("\n");

/**
 * 视觉副模型的单张硬超时。**刻意远小于主请求的 120s** —— 看图只是点评前的一道
 * 配菜,不该让推送热路径的最坏延迟直接翻倍。超时那张按没看成算,点评照出。
 */
const VISION_TIMEOUT_MS = 60_000;

/**
 * 启动 / 配置更新时打进日志的那份提示词是**哪一版**。
 *
 * 那两处调 `getSystemPrompt()` 不传参,拿到的必然是「无场景 + 无工具」那一版,里头明写
 * 着「这一次你没有任何可调用的工具」;而 `chat()` / `chatStateless()` 真正发出去的是带
 * 工具铁律的另一版。不标清楚的话,有人排查「女仆怎么不肯调订阅工具」,翻日志看到白纸
 * 黑字禁用工具,就会去追一个在那条路径上根本不存在的 prompt bug。
 */
const PROMPT_LOG_VARIANT = "无场景 · 无工具那一版；聊天那条路发出去的会多一段工具铁律";

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

	/**
	 * 服务商。决定「开思考」翻译成哪家的方言 —— 四家四种写法,没有通用解
	 * (见 `./providers`)。`custom` 是兜底,不发任何方言参数,只认 {@link extraParams}。
	 */
	provider: AIProviderId;

	/** 开启模型的深度思考。具体发什么字段由 {@link provider} 决定。 */
	enableThinking: boolean;

	/**
	 * 思考深度,统一三档。等级枚举派(OpenRouter / DeepSeek)与 token 预算派
	 * (火山 / 硅基)各自映射,主人换 provider 时这个设置不作废。
	 */
	thinkingLevel: ThinkingLevel;

	/**
	 * 主人手写的一段 JSON,原样摊进**请求体顶层**。方言适配的兜底口:适配之外的
	 * 服务商、以及联网搜索这种分裂到没法统一的能力都走这里。写错不会拖垮请求,
	 * 只是这一次不带它(并记一条日志)。
	 */
	extraParams?: string;

	/**
	 * 开启多模态图片理解:把图**直接下挂给主模型**（需主模型自己支持视觉能力）。
	 *
	 * 配了 {@link vision} 之后这个开关就不再起作用 —— 副模型全权接管。留着它
	 * 纯粹是为了向后兼容:koishi 上已经有人把它开着在用,他们的主模型本来就
	 * 支持视觉,不该因为这次改动被迫去填一遍副模型配置。
	 */
	enableVision: boolean;

	/**
	 * 专门看图的副模型。填了 `model` 即启用,此后图一律先经它转成文字,主模型
	 * 全程只吃纯文本。
	 *
	 * 为的是 DeepSeek 这类**根本没有视觉模型**的主力:官方 API 里一个都没有,
	 * 所以副模型必然可能在另一家 —— `baseURL` / `apiKey` 才要单独开口。两者
	 * 留空则继承主模型的,聚合网关(硅基流动 / OpenRouter)上只需填一个模型名。
	 */
	vision?: {
		baseURL?: string;
		apiKey?: string;
		model?: string;
	};
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

/**
 * 一次工具调用的两拍。dashboard 的聊天靠它把「她正在查什么」讲出来。
 *
 * 工具轮**不产生给人看的正文**,所以那几秒在界面上跟「模型卡住了」长得一模一样。
 * 分 start / end 两拍而不是查完一次性报:查订阅要走一趟 B 站,慢起来好几秒,
 * 那正是最需要反馈的一刻。
 */
export type ToolTraceEvent =
	| {
			phase: "start";
			/** 本次调用内唯一,end 靠它认回自己的 start。 */
			id: string;
			name: string;
			/** 已按 `onToolCall` 那份规则归一成字符串,与真正交给工具的完全一致。 */
			args: Record<string, string>;
	  }
	| { phase: "end"; id: string; ok: boolean };

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
	/** 已报过的告警键;去重用,见 {@link warnOnce}。 */
	private readonly warned = new Set<string>();

	constructor(opts: CommentaryGeneratorOptions) {
		this.api = opts.api;
		this.config = opts.config;
		this.serviceCtx = opts.serviceCtx;
		this.logger = opts.serviceCtx.logger;
	}

	/**
	 * 注入订阅**查询**能力(adapter 在启动后调用)。不调用时 `list_subscriptions`
	 * 之类的工具会一口咬定「当前没有订阅」—— 那种答案比不会答更糟,因为它听起来
	 * 像个事实,所以每个 adapter 都必须接。
	 *
	 * 只有查询,没有写入:工具表是只读的(见 tools.ts 的 `executeTool` 文档)。
	 */
	setSubscriptionsSource(getSubs: () => Subscriptions | null): void {
		this.subsAccessor = getSubs;
	}

	/** 替换运行时配置（adapter 在 koishi config / dashboard 编辑后调用）。 */
	updateConfig(config: CommentaryGeneratorConfig): void {
		this.config = config;
		const { preset, name, traits } = config.persona;
		this.logger.info(
			`[update] 人格预设：${preset}，名字：${name ?? "(默认)"}，模型：${config.model}，性格：${traits ?? "(默认)"}`,
		);
		this.logger.debug(
			`[update] 新系统提示词（${PROMPT_LOG_VARIANT}）：\n${this.getSystemPrompt()}`,
		);
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
		this.logger.debug(`[start] 系统提示词（${PROMPT_LOG_VARIANT}）：\n${this.getSystemPrompt()}`);
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
	getSystemPrompt(
		scene?: AIScene,
		summary?: string,
		override?: CommentaryCallOverride,
		/**
		 * 调用方会渲染 Markdown 吗?只有 dashboard 的聊天会,所以只有那一条路传它。
		 * 缺省(推送、koishi 群聊、点评、总结)一律保持「只用纯文本」那条叮嘱。
		 */
		opts?: {
			allowMarkdown?: boolean;
			/**
			 * 这条路真的给模型挂了工具吗?只有 `chat()` / `chatStateless()` 会。
			 * 缺省(点评、总结、推送)一律告诉模型「你没有工具」—— 否则它会照着工具
			 * 铁律去演一遍「我先查查订阅列表」,而手上根本没有那个工具。
			 */
			withTools?: boolean;
		},
	): string {
		const persona = override?.persona ?? this.config.persona;
		const personaPrompt = buildSystemPrompt({
			...persona,
			allowMarkdown: opts?.allowMarkdown,
			withTools: opts?.withTools,
		});
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
		const shaped = await this.resolveImages(content, imageUrls);
		const result = await this.callAPI(
			systemPrompt,
			[{ role: "user", content: shaped.content }],
			undefined,
			shaped.passthrough,
			override,
		);
		this.logger.debug(`[comment] 响应长度=${result.length}`);
		return result;
	}

	/** 视觉副模型的模型名;没配 / 只填了空白 = 没启用。 */
	private visionModel(): string | undefined {
		return this.config.vision?.model?.trim() || undefined;
	}

	/**
	 * 图能不能直接下挂给主模型。
	 *
	 * `enableVision` 是主人的**意愿**,还得过服务商能力位这一关:DeepSeek 官方接口
	 * 里一个视觉模型都没有,往它发 `image_url` 的下场是整条点评 400。
	 *
	 * 把关的地方必须在这儿而不是只在界面上 —— 两端都已经不给 DeepSeek 摆这个开关了,
	 * 但**老配置里残留的 `true` 仍然读得到**,而藏起开关的同时主人连关掉它的入口都
	 * 没有了。兜底档(自定义)当作支持:主人自己接的网关,女仆无从判断,按他说的办。
	 */
	private mainModelCanSeeImages(): boolean {
		return this.config.enableVision && providerMeta(this.config.provider).supportsVision;
	}

	/**
	 * 图片的分流口 —— 这次点评的图到底走哪条路。
	 *
	 *   - 配了副模型 → 先转文字拼进正文,主模型收到的是**纯字符串**
	 *   - 没配 → 一字不变地维持现有行为(`enableVision` 说了算)
	 *
	 * 副模型全军覆没时 `renderImageDescriptions` 返回空串,正文原样送出 ——
	 * 不为一张图没看成就丢掉整条点评。
	 */
	private async resolveImages(
		content: string,
		imageUrls: string[] | undefined,
	): Promise<{ content: string; passthrough?: string[] }> {
		const model = this.visionModel();
		if (!model || !imageUrls?.length) {
			return { content, passthrough: this.mainModelCanSeeImages() ? imageUrls : undefined };
		}

		const call = await this.makeVisionCaller();
		const descriptions = await describeImages(imageUrls, {
			call,
			model,
			// 正文当背景:副模型才分得清眼前这张是梗图、直播截图还是作品图。
			contextText: content,
			timeoutMs: VISION_TIMEOUT_MS,
			onWarn: (msg, reason) => this.warnVisionOnce(msg, reason),
		});

		const block = renderImageDescriptions(descriptions);
		const ok = descriptions.filter((d) => d !== null).length;
		this.logger.debug(`[vision] ${ok}/${imageUrls.length} 张图转成了文字`);
		// **不**回填 passthrough:主模型可能根本不支持多模态(这功能就是为它做的),
		// 把图再下挂一份等于让它 400。
		return { content: block ? `${content}\n\n${block}` : content };
	}

	/**
	 * 多轮聊天里的看图装备:要挂哪些工具、给不给 visionCtx、以及告诉主模型「有图」
	 * 的那句话。
	 *
	 * 那句 `note` 不是客套 —— 主模型看不见图,不明说它根本不知道有东西可看,
	 * 于是永远不会去调 `describe_image`。
	 */
	private chatVision(imageUrls: string[] | undefined): {
		tools: OpenAI.ChatCompletionTool[];
		ctx?: VisionToolContext;
		note: string;
	} {
		const model = this.visionModel();
		if (!model || !imageUrls?.length) return { tools: TOOL_DEFINITIONS, note: "" };

		const n = imageUrls.length;
		return {
			tools: [...TOOL_DEFINITIONS, DESCRIBE_IMAGE_TOOL],
			ctx: {
				images: imageUrls,
				describe: async (url) => {
					const call = await this.makeVisionCaller();
					const [text] = await describeImages([url], {
						call,
						model,
						timeoutMs: VISION_TIMEOUT_MS,
						onWarn: (msg, reason) => this.warnVisionOnce(msg, reason),
					});
					if (text === null) throw new Error("视觉模型没能识别这张图");
					return text;
				},
			},
			note: `（本条消息附带了 ${n} 张图片。你看不见它们,需要时请用 describe_image 工具按序号 1~${n} 逐张查看。）`,
		};
	}

	/**
	 * 同一件事只报一次。这些告警都长在热路径上(每张图、每轮请求都会重新撞一遍),
	 * 原样打日志会把日志刷成一片。`key` 相同即视为同一件事。
	 */
	private warnOnce(key: string, msg: string): void {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.logger.warn(this.sanitizeErr(msg));
	}

	/** 视觉失败按「失败原因」去重。 */
	private warnVisionOnce(msg: string, reason: string): void {
		this.warnOnce(`vision:${reason}`, msg);
	}

	/**
	 * 造一个连到副模型的调用口子。client 只建一次,由所有图共用。
	 *
	 * `baseURL` / `apiKey` 留空则继承主模型的 —— 聚合网关(硅基流动 / OpenRouter)
	 * 上主模型与视觉模型同 key 同址,那种情况下只需填一个模型名。
	 */
	private async makeVisionCaller(): Promise<VisionCaller> {
		const cfg = this.config.vision;
		const baseURL = cfg?.baseURL?.trim() || this.config.baseURL;
		const apiKey = cfg?.apiKey?.trim() || this.config.apiKey;
		if (!apiKey) throw new Error("视觉模型 apiKey 未配置(且主模型的也是空的)");
		if (!baseURL) throw new Error("视觉模型 baseURL 未配置(且主模型的也是空的)");

		const { default: OpenAI } = await import("openai");
		const client = new OpenAI({ apiKey, baseURL, timeout: VISION_TIMEOUT_MS });
		return async ({ url, prompt, model }) => {
			const res = await client.chat.completions.create({
				model,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: prompt },
							{ type: "image_url", image_url: { url } },
						],
					},
				],
			});
			const choice = res.choices?.[0];
			if (!choice) throw new Error("视觉模型返回空 choices(疑似命中内容审查或上游异常)");
			return choice.message.content ?? "";
		};
	}

	/**
	 * 多轮对话，按 sessionId 保存历史，自动携带工具能力。
	 * 历史满载时自动压缩最旧一半为摘要。
	 * 供 bili chat 指令使用。
	 */
	async chat(content: string, sessionId: string, imageUrls?: string[]): Promise<string> {
		// ②8:排在同 sessionId 上一次 chat 之后再跑(读-改-写历史原子化)。
		const prior = this.chatChains.get(sessionId) ?? Promise.resolve();
		const task = prior.catch(() => {}).then(() => this.chatImpl(content, sessionId, imageUrls));
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
	): Promise<string> {
		const now = Date.now();
		const entry = this.sessions.get(sessionId);
		const isExpired = !entry || now - entry.lastActiveAt >= SESSION_TTL_MS;
		// 机会式清理:过期项被重新访问时立即移除(不再等下一轮 sweep);真正的
		// 无界增长由 start() 的周期 sweep 兜底(过期且永不再访问的 session)。
		if (entry && isExpired) this.sessions.delete(sessionId);
		const history: ConversationMessage[] = isExpired ? [] : [...entry.messages];
		const prevSummary = isExpired ? undefined : entry.summary;

		// 多轮场景走 tool 而不是管线:群里发完图往往还要追问「左下角那个是什么」,
		// 一次性描述接不住。代价是主模型得会调工具 —— 但这条路本来就是给「主人
		// 主动发图并追问」用的,不像点评那样必须无条件可靠。
		const vision = this.chatVision(imageUrls);
		// 提示**只发不存**。存进历史的话,下一轮(通常没图)那句「本条消息附带 2 张
		// 图片,请用 describe_image 查看」还赖在上下文里,而工具这一轮压根没下发 ——
		// 女仆会照着提示去调一个不存在的工具,或者干脆声称自己看过图。
		history.push({ role: "user", content });

		// withTools:下面 callAPI 是真的把 TOOL_DEFINITIONS 挂上去的,这条路才该收工具铁律。
		const systemPrompt = this.getSystemPrompt(undefined, prevSummary, undefined, {
			withTools: true,
		});
		this.logger.debug(
			`[chat] sessionId=${sessionId}, 历史轮次=${Math.floor(history.length / 2)}, 新消息长度=${content.length}`,
		);

		const maxMessages = this.config.maxHistory * 2;
		const trimmedHistory = history.slice(-maxMessages);

		const result = await this.callAPI(
			systemPrompt,
			withVisionNote(trimmedHistory, vision),
			{
				tools: vision.tools,
				onToolCall: (name, args) =>
					executeTool(name, args, this.api, () => this.getSubs(), vision.ctx),
			},
			// 配了副模型就不再把图下挂给主模型 —— 它可能根本不支持多模态。
			vision.ctx ? undefined : this.mainModelCanSeeImages() ? imageUrls : undefined,
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
		return result;
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
		opts?: { imageUrls?: string[] },
	): Promise<string> {
		return this.chatStatelessImpl(messages, opts);
	}

	/**
	 * 与 {@link chatStateless} 同源,但正文**边生成边回调**。
	 *
	 * dashboard 的聊天用它:一次回答动辄十几秒,一次性甩出来的话,那十几秒里
	 * 页面上只有三个跳动的点,读起来像卡住了。
	 *
	 * 注意 `onDelta` 只喂**给人看的正文**。工具轮(查订阅、查直播状态)不产生
	 * 正文,那几轮自然静默 —— 想知道那段时间她在查什么,听 `onToolEvent`。
	 */
	async chatStatelessStream(
		messages: readonly ConversationMessage[],
		opts: {
			onDelta: (text: string) => void;
			/** 工具轮的旁听席,见 {@link ToolTraceEvent}。不传就什么都不报。 */
			onToolEvent?: (ev: ToolTraceEvent) => void;
			imageUrls?: string[];
		},
	): Promise<string> {
		return this.chatStatelessImpl(messages, opts);
	}

	private async chatStatelessImpl(
		messages: readonly ConversationMessage[],
		opts?: {
			imageUrls?: string[];
			onDelta?: (text: string) => void;
			onToolEvent?: (ev: ToolTraceEvent) => void;
		},
	): Promise<string> {
		if (messages.length === 0) throw new Error("对话历史为空");

		// slice 顺带把调用方的数组复制了一份,这一点是必需的而非顺手:callAPI 的
		// 工具循环会**就地**往 messages 里 push 助手回复 / 工具结果,直接把持久化
		// 的消息数组递进去,那些记账消息就会漏回调用方,跟着存进磁盘。
		const trimmed = messages.slice(-this.config.maxHistory * 2);
		// 这一路的收件人是 dashboard 的聊天界面,它渲染 Markdown。**只有这里**这么传 ——
		// 推送、koishi 群聊、点评、总结都落在缺省那一侧,继续拿到「只用纯文本」。
		const systemPrompt = this.getSystemPrompt(undefined, undefined, undefined, {
			allowMarkdown: true,
			withTools: true,
		});
		this.logger.debug(`[chat-stateless] 历史=${messages.length} 条,实发=${trimmed.length} 条`);

		// 与 chatImpl 同样的多轮口径。dashboard 目前还传不了图,所以这条路上
		// `vision.ctx` 恒为 undefined —— 接在这里是为了图片上传做好之后不必再回来
		// 补一遍,而不是现在就生效。
		const vision = this.chatVision(opts?.imageUrls);
		const result = await this.callAPI(
			systemPrompt,
			withVisionNote(trimmed, vision),
			{
				tools: vision.tools,
				onToolCall: (name, args) =>
					executeTool(name, args, this.api, () => this.getSubs(), vision.ctx),
				onToolEvent: opts?.onToolEvent,
			},
			vision.ctx ? undefined : this.mainModelCanSeeImages() ? opts?.imageUrls : undefined,
			undefined,
			opts?.onDelta,
		);

		this.logger.debug(`[chat-stateless] 响应长度=${result.length}`);
		return result;
	}

	/** 清除指定用户的对话历史 */
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.logger.debug(`[session] 清除会话 sessionId=${sessionId}`);
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
		// 两把 key 都要抹:视觉副模型常常在另一家,它的 key 同样会出现在 SDK 的
		// 错误原文里,而这些错误会经日志 WS 外泄到 dashboard。
		for (const key of [this.config.apiKey, this.config.vision?.apiKey]) {
			if (key && key.length >= 6) msg = msg.split(key).join("***");
		}
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
			onToolEvent?: (ev: ToolTraceEvent) => void;
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

		/**
		 * ChatCompletionCreateParams + provider 方言字段。方言一律落在**请求体顶层**
		 * —— 曾经它们被塞进 `extra_body`,那是 Python SDK 的糖,Node 的 openai 包
		 * 会原样序列化成一个谁都不认识的嵌套字段,于是从未真正生效过。
		 */
		type CreateParams = OpenAI.ChatCompletionCreateParamsNonStreaming & Record<string, unknown>;

		// 主人手写的那段 JSON 解析一次,两轮(首发 + 降级重试)共用。
		const extra = parseExtraParams(this.config.extraParams);
		if (!extra.ok && extra.error) this.warnOnce("extra-params", `[api] ${extra.error}`);
		if (extra.dropped?.length) {
			this.warnOnce(
				`extra-params-dropped:${extra.dropped.join(",")}`,
				`[api] 额外请求参数里的 ${extra.dropped.join(" / ")} 被忽略了 —— 这些字段是请求的骨架,覆盖它们会让对话或工具静默失灵`,
			);
		}

		const thinkingParams = buildProviderParams({
			provider: this.config.provider,
			enableThinking: this.config.enableThinking,
			thinkingLevel: this.config.thinkingLevel,
		});

		/**
		 * `withProviderParams=false` 是**降级重试**用的:那时的判断是「这个网关根本
		 * 不认这套方言」,所以一个方言字段都不发 —— 注意这跟「思考开关拨到关」不是
		 * 一回事,后者对 DeepSeek 这类默认开思考的家还得显式发一条禁用。
		 * 主人手写的额外参数两轮都带着:那是他自己写的,不该被女仆悄悄摘掉。
		 */
		const makeParams = (withProviderParams: boolean): CreateParams => ({
			model,
			messages: apiMessages,
			...(temperature !== undefined ? { temperature } : {}),
			...(toolOptions ? { tools: toolOptions.tools, tool_choice: "auto" } : {}),
			...mergeExtraParams(withProviderParams ? thinkingParams : {}, extra.value),
		});

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
			const base = makeParams(true);
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
				// 只要这轮真发了方言参数就值得摘掉重来一次 —— 不限于「开着思考」:
				// DeepSeek / 火山这类默认开思考的家,连「关」位都要发一条显式禁用,
				// 那条同样可能被某些兼容网关拒掉。
				if (Object.keys(thinkingParams).length > 0 && emitted === 0) {
					this.logger.warn(
						`[api] 服务商方言参数不受支持，摘掉后重试(主人手写的额外参数保留): ${this.sanitizeErr(e)}`,
					);
					try {
						const res = await client.chat.completions.create(makeParams(false));
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

			for (let i = 0; i < message.tool_calls.length; i++) {
				const toolCall = message.tool_calls[i];
				const name = toolCall.function.name;
				// 痕迹 id 用「第几轮-第几个」自己编,**不用** `toolCall.id`:那是网关
				// 给的,流式下常常整个缺席(streamOnce 里的 slot 初值就是空串),几个
				// 工具会共用一个空 id,end 事件于是全配到同一条痕迹上。
				const traceId = `${round}-${i}`;

				// 参数先解析出来给 start 用。解析失败不在这儿抛 —— 下面那段要靠
				// `parseErr` 保持原有语义:参数坏了就**不执行**工具,只把错误当结果回去。
				let args: Record<string, string> = {};
				let parseErr: Error | null = null;
				try {
					// :461 LLM 常把 uid 输出成数字(`{"uid":12345}`)。裸 as
					// Record<string,string> 是谎言 → 下游用 args.uid 当字符串与
					// 订阅 key("12345")比对失配。逐值强制 String 归一。
					const rawArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
					args = Object.fromEntries(
						Object.entries(rawArgs).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]),
					);
				} catch (e) {
					parseErr = e as Error;
				}

				// 执行**之前**报一声。查订阅要走一趟 B 站,慢起来好几秒,而那正是最
				// 需要反馈的一刻;等查完再说等于什么都没说。
				toolOptions.onToolEvent?.({ phase: "start", id: traceId, name, args });

				let result: string;
				let ok: boolean;
				if (parseErr) {
					result = `工具执行失败: ${parseErr.message}`;
					ok = false;
				} else {
					try {
						this.logger.debug(`[tool] 执行 ${name}(${JSON.stringify(args)})`);
						result = await toolOptions.onToolCall(name, args);
						ok = true;
					} catch (e) {
						result = `工具执行失败: ${(e as Error).message}`;
						ok = false;
					}
				}
				toolOptions.onToolEvent?.({ phase: "end", id: traceId, ok });
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
 * 把「本条消息有几张图、怎么看」那句提示挂到**最后一条 user 消息**上,返回一份
 * 新数组 —— 原数组不动,因为那一份是要存进会话历史的。
 *
 * 提示只发不存:存下去的话,下一轮(通常没图)它还赖在上下文里,而 describe_image
 * 那一轮压根没下发,女仆会照着提示去调一个不存在的工具。
 */
function withVisionNote(
	messages: readonly ConversationMessage[],
	vision: { ctx?: unknown; note: string },
): ConversationMessage[] {
	if (!vision.ctx) return [...messages];
	const last = messages.length - 1;
	return messages.map((m, i) =>
		i === last && m.role === "user" ? { ...m, content: `${m.content}\n\n${vision.note}` } : m,
	);
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
