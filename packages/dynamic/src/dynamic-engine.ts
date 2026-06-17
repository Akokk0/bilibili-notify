import type { AIScene, CommentaryCallOverride } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type {
	Disposable,
	ForwardImage,
	Logger,
	MessageBus,
	ServiceContext,
} from "@bilibili-notify/internal";
import { interpolate, withLock } from "@bilibili-notify/internal";
import { CronJob } from "cron";
import { DateTime } from "luxon";
import { DynamicFilterReason, filterDynamic } from "./dynamic-filter";
import type {
	PushLike,
	PushSegment,
	SubItemView,
	SubManagerView,
	SubscriptionOpView,
	SubscriptionsView,
} from "./push-like";
import type { AllDynamicInfo, Dynamic, DynamicFilterConfig, DynamicTimelineManager } from "./types";

interface CommentaryClient {
	comment(
		content: string,
		scene?: AIScene,
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string>;
}

const LOG_TAG = "bilibili-notify-dynamic";
/**
 * 风控/瞬时错误停 cron 后的退避重启间隔。原实现:任何非鉴权错误(-509 限流、
 * 瞬时 -403、未知码)都永久 stop cron 且唯一重启路径 `auth-restored` 不会触发
 * → 动态轮询永久静默直到重启进程。退避后自动重探,瞬时错误/`bili cap` 解风控
 * 后即自愈,无需人工重启进程。
 */
const DETECTOR_RESTART_BACKOFF_MS = 5 * 60_000;

/**
 * 动态推送文本模板的内建兜底,仅在 adapter 未填 config.dynamicTemplate /
 * videoTemplate 时使用(真实 adapter 都会从 globals.defaults.templates 填充)。
 * 与 `@bilibili-notify/internal` 的 `DEFAULT_TEMPLATES.dynamic/.dynamicVideo`
 * 保持一致。变量 `{name}`(UP 名) / `{url}`(链接,未启用 URL 时为空)。
 */
const DEFAULT_DYNAMIC_TEXT = {
	dynamic: "{name}发布了一条动态：{url}",
	video: "{name}发布了新视频：{url}",
} as const;

/**
 * 渲染动态推送文本:`{name}` / `{url}` 插值 + `\n` 展开。`url` 为空(未启用 URL)
 * 时连同 `{url}` 的前导分隔符一起去掉,避免行尾残留孤立的「：」。两个推送分支
 * (有图 / 无图)都走此函数 → 文字内容一致。
 */
function renderDynamicText(template: string, name: string, url: string): string {
	const tmpl = url ? template : template.replace(/\s*[：:]?\s*\{url\}/g, "");
	return interpolate(tmpl, { name, url }).replaceAll("\\n", "\n");
}

function parseUid(raw: unknown): string | undefined {
	if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

function normalizeUnixSeconds(raw: unknown): number | undefined {
	if (typeof raw !== "number" && typeof raw !== "string") return undefined;
	if (typeof raw === "string" && !/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	if (n > 10_000_000_000) {
		const seconds = Math.floor(n / 1000);
		return seconds <= 10_000_000_000 ? seconds : undefined;
	}
	return Math.floor(n);
}

function parsePubTimeFallback(raw: unknown, now = DateTime.now()): number | undefined {
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	if (!text) return undefined;
	if (text === "刚刚") return Math.floor(now.toSeconds());

	const relative = text.match(/^(\d+)(秒|分钟|小时)前$/);
	if (relative) {
		const amount = Number(relative[1]);
		if (!Number.isFinite(amount)) return undefined;
		const unit = relative[2] === "秒" ? "seconds" : relative[2] === "分钟" ? "minutes" : "hours";
		return Math.floor(now.minus({ [unit]: amount }).toSeconds());
	}

	const normalized = text
		.replace(/[年月]/g, "-")
		.replace(/日/g, "")
		.replace(/\//g, "-")
		.replace(/\s+/g, " ");
	const formats = ["yyyy-M-d H:mm:ss", "yyyy-M-d H:mm", "yyyy-M-d", "M-d H:mm:ss", "M-d H:mm"];
	for (const fmt of formats) {
		let dt = DateTime.fromFormat(normalized, fmt);
		if (!dt.isValid) continue;
		if (!fmt.startsWith("yyyy")) {
			dt = dt.set({ year: now.year });
			if (dt > now.plus({ days: 1 })) dt = dt.minus({ years: 1 });
		}
		return Math.floor(dt.toSeconds());
	}

	const yesterday = normalized.match(/^昨天\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (yesterday) {
		const hour = Number(yesterday[1]);
		const minute = Number(yesterday[2]);
		const second = Number(yesterday[3] ?? 0);
		const dt = now.minus({ days: 1 }).set({ hour, minute, second, millisecond: 0 });
		return dt.isValid ? Math.floor(dt.toSeconds()) : undefined;
	}

	return undefined;
}

function getDynamicPostTime(author: Dynamic["modules"]["module_author"]): number | undefined {
	return normalizeUnixSeconds(author.pub_ts) ?? parsePubTimeFallback(author.pub_time);
}

/**
 * Runtime configuration for {@link DynamicEngine}. Mirrors the platform-neutral
 * subset of `BilibiliNotifyDynamicConfig`; the koishi shell maps its schema
 * fields onto this struct, the standalone runtime fills it from its own config
 * store. The `logLevel` field is intentionally dropped — adapter sets logger
 * level externally via {@link ServiceContext}.
 */
export interface DynamicEngineConfig {
	/** 轮询动态的 cron 表达式。 */
	dynamicCron: string;
	/** 视频动态时是否将 URL 替换为 BV 号。 */
	dynamicVideoUrlToBV: boolean;
	/**
	 * 非视频动态的推送文本模板。变量 `{name}`(UP 名) / `{url}`(动态链接)。
	 * 要不要带链接由模板里有没有 `{url}` 决定(per-UP / 全局模板可编辑);`{url}` 在
	 * url 为空(如视频转 BV 无匹配)时,引擎会顺带去掉相邻分隔符。缺省时回退到内建文案。
	 * Adapter 通常用 `globals.defaults.templates.dynamic` 填充。
	 */
	dynamicTemplate?: string;
	/**
	 * 视频投稿的推送文本模板。变量 `{name}` / `{url}`(视频链接或 BV)。
	 * 缺省时回退到内建文案。Adapter 通常用 `globals.defaults.templates.dynamicVideo` 填充。
	 */
	videoTemplate?: string;
	/**
	 * DYNAMIC_TYPE_DRAW 图集图片推送行为。enable=false 时跳过图集广播,
	 * 只发文本/卡片。forward=true 时走合并转发(聊天记录卡片,走 OneBot
	 * send_group_forward_msg,部分 OneBot 实现/NapCat 长消息通道不稳);
	 * forward=false 多图合并到一条普通 send_group_msg。单图永远不走合并转发。
	 */
	imageGroup: {
		enable: boolean;
		forward: boolean;
	};
	/** 内容过滤配置（含 notify：被屏蔽时是否通知）。 */
	filter: DynamicFilterConfig & { notify?: boolean };
	/**
	 * 是否启用图片卡片渲染。`false` 时跳过 puppeteer 调用,推送降级为纯文字。缺省视为 true,
	 * 保留旧 adapter 不传该字段时的既有行为。Adapter 通常用 `globals.defaults.cardStyle.enabled` 填充。
	 */
	imageEnabled?: boolean;
	/**
	 * 是否启用 AI 动态点评。`false` 时跳过 `CommentaryClient.comment()` 调用,推送只用原始动态文本。
	 * 缺省视为 true。Adapter 通常用 `globals.defaults.ai.enabled` 填充。
	 */
	aiEnabled?: boolean;
}

export interface DynamicEngineOptions {
	serviceCtx: ServiceContext;
	bus: MessageBus;
	api: BilibiliAPI;
	push: PushLike;
	/** 可选注入：图片渲染器；缺失时降级为纯文字推送。 */
	image?: ImageRenderer;
	/** 可选注入：AI 点评生成器；缺失时跳过 AI 文案生成。 */
	ai?: CommentaryClient;
	config: DynamicEngineConfig;
	/**
	 * Adapter 提供的订阅快照访问器。返回 null 表示订阅尚未就绪
	 * （engine 会在收到 `subscription-changed` / `auth-restored` 后再次拉取）。
	 */
	getSubs: () => SubscriptionsView | null;
}

/** 从动态数据中提取图片 URL，用于多模态 AI 点评（最多 4 张） */
function extractDynamicImages(item: Dynamic): string[] {
	const mod = item.modules.module_dynamic;
	const urls: string[] = [];
	// 图文动态（draw，纯图片帖）
	// P2:这些字段经 as-cast 绕过索引类型,运行时可能是对象。`typeof===string`
	// 运行时守卫,杜绝对象被 push 进 string[] 后当图片 URL 喂多模态 AI。
	if (mod.major?.draw?.items) {
		for (const img of mod.major.draw.items as Array<{ src?: unknown }>) {
			if (typeof img.src === "string" && img.src) urls.push(img.src);
		}
	}
	// 专栏/opus 图片列表
	if (mod.major?.opus?.pics) {
		for (const pic of mod.major.opus.pics) {
			if (typeof pic.url === "string" && pic.url) urls.push(pic.url);
		}
	}
	// 视频封面（archive 有 [key: string]: any）
	const archiveCover: unknown = mod.major?.archive?.cover;
	if (typeof archiveCover === "string" && archiveCover) urls.push(archiveCover);
	return urls.slice(0, 4);
}

/** 从动态数据中提取纯文本内容，用于 AI 点评 */
function extractDynamicText(item: Dynamic): string {
	const mod = item.modules.module_dynamic;
	const parts: string[] = [];

	// 正文描述
	if (mod.desc?.text) parts.push(mod.desc.text);

	// 专栏/opus 摘要
	if (mod.major?.opus?.summary?.text) {
		if (mod.major.opus.title) parts.push(`标题：${mod.major.opus.title}`);
		parts.push(mod.major.opus.summary.text);
	}

	// 视频标题
	if (mod.major?.archive?.title) parts.push(`视频标题：${mod.major.archive.title}`);

	// 转发内容
	if (item.orig) {
		// 转发源可能是 tombstone(原动态被删/不可见):modules / module_author
		// 整段缺失。此前裸取 .modules.module_author.name 抛 TypeError → 该 UID
		// 锚永不前移,每轮重试永久卡死。全程可选链 + 兜底,与本函数其余处一致。
		const origMod = item.orig.modules?.module_dynamic;
		const origAuthor = item.orig.modules?.module_author?.name;
		const origParts: string[] = [];
		if (origMod?.desc?.text) origParts.push(origMod.desc.text);
		if (origMod?.major?.opus?.summary?.text) origParts.push(origMod.major.opus.summary.text);
		if (origMod?.major?.archive?.title) origParts.push(`视频标题：${origMod.major.archive.title}`);
		if (origParts.length > 0)
			parts.push(`（转发自 ${origAuthor ?? "未知"}：${origParts.join(" ")}）`);
	}

	return parts.join("\n").trim();
}

/**
 * 平台中立的动态轮询/过滤/渲染核心。
 *
 * - 不依赖 koishi runtime；adapter 提供 ServiceContext / MessageBus / PushLike。
 * - image / ai 通过 **构造期注入**（不在 detect 循环内做服务查找），缺失时降级。
 * - 时间线、过滤、API 错误处理逻辑与原 koishi 版 BilibiliNotifyDynamic 一致。
 */
export class DynamicEngine {
	private readonly serviceCtx: ServiceContext;
	private readonly bus: MessageBus;
	private readonly api: BilibiliAPI;
	private readonly push: PushLike;
	private image?: ImageRenderer;
	private ai?: CommentaryClient;
	private readonly logger: Logger;
	private readonly getSubs: () => SubscriptionsView | null;

	private config: DynamicEngineConfig;
	private dynamicJob?: CronJob;
	/** 风控/瞬时错误后的一次性退避重启句柄;非 undefined 表示已排程,不叠加。 */
	private detectorRestartTimer?: Disposable;
	/**
	 * -352 风控态边沿标记。进入风控只 error+DM+engine-error 一次;退避重探仍
	 * 风控 → debug(不重复告警);成功拉取(code 0)→ info 一次并清除。避免在
	 * 退避重试热路径反复刷 error(Q1)。
	 */
	private riskControlled = false;
	private dynamicSubManager: SubManagerView = new Map();
	private dynamicTimelineManager: DynamicTimelineManager = new Map();
	/** 连续图片渲染失败计数，达到阈值时仅通知一次但不停 cron */
	private imageFailureStreak = 0;
	private imageFailureNotified = false;
	private readonly busHandles: Disposable[] = [];

	constructor(opts: DynamicEngineOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.bus = opts.bus;
		this.api = opts.api;
		this.push = opts.push;
		this.image = opts.image;
		this.ai = opts.ai;
		this.config = opts.config;
		this.getSubs = opts.getSubs;
		this.logger = opts.serviceCtx.logger;
	}

	/** 启动钩子。Adapter 在 ServiceContext 就绪、订阅可访问后调用。 */
	start(): void {
		this.dynamicTimelineManager = new Map();

		// 启动期已有快照则立即开跑
		const initial = this.getSubs();
		this.logger.info(
			`[start] 动态引擎启动（${initial ? "订阅已就绪，立即启动检测" : "等待订阅数据"}）`,
		);
		if (initial) {
			this.startDynamicDetector(initial);
		} else {
			this.logger.debug("[start] 订阅尚未就绪，等待 subscription-changed 事件");
		}

		// `subscription-changed` 是无负载事件（参见 internal/platform.ts BiliEvents）。
		// adapter 收到 koishi 端的 ops 后，应当先调用 engine.applyOps(ops) 再 emit
		// MessageBus 事件用于其他下游；engine 自身只需在 auth-restored 时重建快照。
		this.busHandles.push(
			this.bus.on("auth-restored", () => {
				const subs = this.getSubs();
				if (!subs) return;
				this.logger.info("[detector] 收到 auth-restored，重启动态检测");
				this.startDynamicDetector(subs);
			}),
		);

		this.serviceCtx.onDispose(() => this.stop());
	}

	/** 停止钩子。停止 cron、释放事件订阅。 */
	stop(): void {
		// 全停 = lifecycle 结束;下次 start 是全新 episode,风控边沿复位重新武装。
		// (不在 startDynamicDetector 复位 —— -352 自身退避重启也走那里,复位会
		// 破坏边沿、每退避周期重刷 error,正是 Q7 要消除的。)
		this.riskControlled = false;
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
			this.logger.info("[stop] 动态检测任务已停止");
		}
		while (this.busHandles.length > 0) {
			const h = this.busHandles.pop();
			h?.dispose();
		}
	}

	/**
	 * 替换运行时配置(adapter 在 koishi config / dashboard 编辑后调用)。
	 * `dynamicCron` 变化时会自动停掉旧 CronJob 并按新表达式重新 schedule —— 否则
	 * 配置已经写进 this.config,但 node-cron 句柄还在跑旧节奏,纯粹的字段更新
	 * 是看不见的 bug。
	 */
	updateConfig(config: DynamicEngineConfig): void {
		const cronChanged = this.config.dynamicCron !== config.dynamicCron;
		this.config = config;
		if (cronChanged && this.dynamicJob) {
			this.logger.info(`[detector] dynamicCron 已更新为 "${config.dynamicCron}",重启检测任务`);
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
			if (this.dynamicSubManager.size > 0) this.startJob();
		}
	}

	/**
	 * 热替换 CommentaryClient 实例。adapter 在用户运行时打开 / 关闭 / 更换 AI
	 * 配置后调用,引擎随后的动态点评会立即用新实例 (或回退到纯文字) ,无需重启 server。
	 */
	setAi(ai: CommentaryClient | undefined): void {
		this.ai = ai;
	}

	/**
	 * 热替换 ImageRenderer 实例。与 setAi 对称:adapter 在 image 服务上下线时
	 * 调用,引擎随后的卡片渲染会立即用新实例 (或回退到纯文字) ,无需重启 server。
	 *
	 * 主要给 koishi adapter 用 —— sibling service (-image) 启停时通过 ctx.inject
	 * 后置注入。独立端 imageRenderer 是 engine 同进程一次性 wire,不会动态消失,
	 * 不需要调用本方法 (cardStyle 热更走 imageRenderer.updateConfig)。
	 */
	setImage(image: ImageRenderer | undefined): void {
		this.image = image;
	}

	get isActive(): boolean {
		return this.dynamicJob?.running ?? false;
	}

	/** 用最新订阅快照重启动态检测；保留已有 UID 的时间戳避免重推旧动态。 */
	startDynamicDetector(subs: SubscriptionsView): void {
		// 一次显式启动取代任何待执行的退避重启,避免双重启动。
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		// Stop existing job first
		if (this.dynamicJob) {
			this.logger.info("[detector] 停止旧的动态检测任务");
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
		}

		// Build sub manager with only dynamic-enabled subs
		const dynamicSubManager: SubManagerView = new Map();
		for (const sub of Object.values(subs)) {
			if (sub.dynamic) {
				// 只为新增 UID 设置初始时间戳，保留已有 UID 的时间戳避免重推旧动态
				if (!this.dynamicTimelineManager.has(sub.uid)) {
					this.dynamicTimelineManager.set(sub.uid, Math.floor(DateTime.now().toSeconds()));
					this.logger.debug(`[detector] 初始化 UID：${sub.uid} 时间戳`);
				}
				dynamicSubManager.set(sub.uid, sub);
			}
		}
		// 清理已移除 UID 的时间戳记录
		for (const uid of this.dynamicTimelineManager.keys()) {
			if (!dynamicSubManager.has(uid)) {
				this.dynamicTimelineManager.delete(uid);
				this.logger.debug(`[detector] 清理已移除 UID：${uid} 的时间戳`);
			}
		}

		if (dynamicSubManager.size === 0) {
			this.logger.info("[detector] 没有需要动态检测的订阅对象");
			return;
		}
		this.logger.debug(`[detector] 动态检测 UID 列表：${[...dynamicSubManager.keys()].join(", ")}`);

		this.dynamicSubManager = dynamicSubManager;
		this.startJob();
	}

	private startDynamicForUid(uid: string, sub: SubItemView): void {
		if (!this.dynamicTimelineManager.has(uid)) {
			this.dynamicTimelineManager.set(uid, Math.floor(DateTime.now().toSeconds()));
			this.logger.debug(`[ops] 初始化 UID：${uid} 时间戳`);
		}
		this.dynamicSubManager.set(uid, structuredClone(sub));
		this.logger.debug(`[ops] 开启动态订阅 UID：${uid}`);
	}

	private stopDynamicForUid(uid: string): void {
		if (!this.dynamicSubManager.has(uid)) return;
		this.dynamicSubManager.delete(uid);
		this.dynamicTimelineManager.delete(uid);
		this.logger.debug(`[ops] 移除动态订阅 UID：${uid}`);
	}

	/**
	 * UID 是否仍订阅。detectDynamics 在 image/AI/broadcast 等多个 await 处挂起,
	 * `applyOps`(由 adapter 在 subscription-changed 时调,**不**在 withLock 内)
	 * 可在挂起期 stopDynamicForUid 删表。每个 dispatch / 时间线回写前用它重校,
	 * 否则会给已退订 UID 推送、并把其时间线“复活”进而长期抑制再订阅后的动态。
	 */
	private stillSubscribed(uid: string, expected?: SubItemView): boolean {
		if (!this.dynamicSubManager.has(uid)) return false;
		// P2:仅 has(uid) 无法分辨「同 uid 被 delete + re-add」—— 跨 await 期间
		// applyOps 删旧 sub 再加一个新 SubItemView(新对象引用/新配置),会把本轮
		// 早先捕获的陈旧 item 当作新订阅推出。给定 expected 时按对象身份比对。
		return expected === undefined || this.dynamicSubManager.get(uid) === expected;
	}

	/** Incrementally apply subscription ops without restarting the cron job. */
	applyOps(ops: SubscriptionOpView[]): void {
		let jobNeedsReconcile = false;
		// per-UID 开/移除走 debug(见 startDynamicForUid/stopDynamicForUid);本批次
		// 收口一条 info 汇总,批量变更不再 N×info 刷屏(Q1「info 绝不循环每项」)。
		let opened = 0;
		let removed = 0;
		for (const op of ops) {
			switch (op.type) {
				case "add": {
					if (!op.sub.dynamic) break;
					this.startDynamicForUid(op.sub.uid, op.sub);
					opened++;
					jobNeedsReconcile = true;
					break;
				}
				case "delete": {
					if (!this.dynamicSubManager.has(op.uid)) break;
					this.stopDynamicForUid(op.uid);
					removed++;
					jobNeedsReconcile = true;
					break;
				}
				case "update": {
					for (const change of op.changes) {
						if (change.scope !== "dynamic") continue;
						if (change.dynamic) {
							const fullSub = this.getSubs()?.[op.uid];
							if (fullSub) {
								this.startDynamicForUid(op.uid, fullSub);
								opened++;
							}
							jobNeedsReconcile = true;
						} else if (change.dynamic === false) {
							// 与 delete 同护栏:UID 未在动态订阅表才跳过,避免 stopDynamicForUid
							// no-op 时仍报 -1 移除 + 触发一次无谓 reconcileJob(审计 nit)。
							if (!this.dynamicSubManager.has(op.uid)) continue;
							this.stopDynamicForUid(op.uid);
							removed++;
							jobNeedsReconcile = true;
						}
					}
					break;
				}
			}
		}
		if (jobNeedsReconcile) {
			this.logger.info(
				`[ops] 动态订阅变更已应用：+${opened} 开启 / -${removed} 移除（当前 ${this.dynamicSubManager.size} 个动态订阅）`,
			);
			this.reconcileJob();
		}
	}

	private startJob(): void {
		this.dynamicJob = new CronJob(
			this.config.dynamicCron,
			withLock(
				() => this.detectDynamics(),
				(err) =>
					this.logger.error(
						`[detector] 动态检测执行异常：${err instanceof Error ? err.message : String(err)}`,
					),
			),
		);
		this.dynamicJob.start();
		this.logger.info("[detector] 动态检测任务已启动");
	}

	private reconcileJob(): void {
		if (this.dynamicSubManager.size === 0) {
			if (this.dynamicJob?.running) {
				this.dynamicJob.stop();
				this.dynamicJob = undefined;
				this.logger.info("[detector] 订阅清空，动态检测任务已停止");
			}
		} else if (!this.dynamicJob?.running) {
			this.logger.debug(
				`[detector] 动态检测 UID 列表：${[...this.dynamicSubManager.keys()].join(", ")}`,
			);
			this.startJob();
		}
	}

	private async detectDynamics(): Promise<void> {
		this.logger.debug("[detector] 开始获取动态信息");

		let content: AllDynamicInfo | undefined;
		try {
			content = (await this.api.getAllDynamic()) as AllDynamicInfo;
		} catch (e) {
			// Q3:per-tick 拉取失败,cron 下一 tick 自重试、系统继续 → warn 不冒充事故。
			this.logger.warn(`[api] 获取动态失败：${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		if (!content) return;

		if (content.code !== 0) {
			await this.handleApiError(content.code, content.message);
			return;
		}

		if (this.riskControlled) {
			this.riskControlled = false;
			this.logger.info("[api] 风控已解除，动态检测恢复正常");
		}
		this.logger.debug("[detector] 成功获取动态信息，开始处理");

		// DY1:per-uid 记账 —— 成功处理(含被过滤/开播伪动态/已发)的 pub_ts 进
		// okTs,投递抛错的进 failTs。write-back 时只把锚点单调推进到「早于本 uid
		// 最早失败项」的最大成功 pub_ts,既不因单条 reject 整轮 abort 导致已发项
		// 下轮重推,也绝不越过失败项静默丢动态。
		const okTs: Record<string, number[]> = {};
		const failTs: Record<string, number[]> = {};
		const markOk = (u: string, ts: number) => {
			const arr = okTs[u];
			if (arr) arr.push(ts);
			else okTs[u] = [ts];
		};
		const markFail = (u: string, ts: number) => {
			const arr = failTs[u];
			if (arr) arr.push(ts);
			else failTs[u] = [ts];
		};

		for (const item of content.data.items) {
			if (!item) continue;

			const author = item.modules?.module_author;
			const uid = parseUid(author?.mid);
			if (!uid) {
				this.logger.debug(`[detector] 跳过无作者 UID 的动态，ID=${item.id_str ?? "unknown"}`);
				continue;
			}

			const timeline = this.dynamicTimelineManager.get(uid);
			if (timeline === undefined) continue; // not subscribed

			const postTime = getDynamicPostTime(author);
			if (postTime === undefined) {
				const rawPubTs = (author as { pub_ts?: unknown }).pub_ts;
				this.logger.warn(
					`[detector] 跳过无效动态：无法解析发布时间，UID=${uid} ID=${item.id_str ?? "unknown"} type=${item.type ?? "unknown"} pub_ts_type=${typeof rawPubTs} pub_ts=${JSON.stringify(rawPubTs)} pub_time=${JSON.stringify(author.pub_time)}`,
				);
				continue;
			}

			const name = author.name;

			this.logger.debug(
				`[detector] 检查动态 UP=${name} UID=${uid} 发布时间=${DateTime.fromSeconds(postTime).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);

			if (timeline >= postTime) continue; // already pushed

			// P2:捕获本轮处理起点的 sub 对象引用,跨 await 后用它做身份校验,
			// 区分「仍是同一订阅」与「同 uid 被 delete+re-add 成另一个」。
			const subAtCapture = this.dynamicSubManager.get(uid);

			// DY1:每条 qualifying item 必须恰好 markOk 或 markFail 一次。投递抛
			// 错只标记本条 fail 并 continue,绝不让异常冒泡 abort 整轮(否则同轮
			// 已成功发出的早项下轮重推)。
			try {
				// Filter — per-UP filter override (从 SubItemView 上拿) 优先于 engine 的全局 filter。
				// adapter 已通过 resolve(sub, defaults).filters 完成 inherit / partial 折叠，这里
				// 拿到的是完整 DynamicFilterConfig。空过滤器（{}）也算 override 生效，结果是「该 UP
				// 单独关掉所有屏蔽规则」—— 与全局 filter 完全脱钩，符合用户意图。
				const subForFilter = this.dynamicSubManager.get(uid);
				const effFilter = subForFilter?.filter ?? this.config.filter ?? {};
				const filterResult = filterDynamic(item, effFilter, this.logger);
				if (filterResult.blocked) {
					this.logger.debug(`[filter] 动态 ID=${item.id_str} 被过滤，原因：${filterResult.reason}`);
					if (effFilter.notify && this.stillSubscribed(uid, subAtCapture)) {
						const msgs: Record<DynamicFilterReason, string> = {
							[DynamicFilterReason.BlacklistKeyword]: `${name}发布了一条含有屏蔽关键字的动态`,
							[DynamicFilterReason.BlacklistForward]: `${name}转发了一条动态，已屏蔽`,
							[DynamicFilterReason.BlacklistArticle]: `${name}投稿了一条专栏，已屏蔽`,
							[DynamicFilterReason.BlacklistDraw]: `${name}发布了一条图文动态，已屏蔽`,
							[DynamicFilterReason.BlacklistAv]: `${name}投稿了一条视频，已屏蔽`,
							[DynamicFilterReason.WhitelistUnmatched]: `${name}发布了一条不在白名单范围内的动态，已屏蔽`,
						};
						// P2:屏蔽提示是 best-effort。此前广播抛错冒泡到外层 catch→
						// markFail,锚点不前移 → 下轮重判重发,"已屏蔽"提示重复轰炸。
						// 自包 try/catch:发不出就算了,绝不因此重试。
						try {
							await this.push.broadcastDynamic(
								uid,
								[{ type: "text", text: msgs[filterResult.reason as DynamicFilterReason] }],
								"dynamic",
							);
						} catch (e) {
							this.logger.warn(
								`[filter] 屏蔽提示发送失败(忽略,不重试以免重复轰炸): ${(e as Error).message}`,
							);
						}
					}
					// 被过滤(含 notify 已发/已忽略)= 已处理,推进锚点避免下轮重判。
					markOk(uid, postTime);
					continue;
				}

				// Render card
				const sub = this.dynamicSubManager.get(uid);
				let buffer: Buffer | undefined;
				try {
					if (this.image && this.config.imageEnabled !== false) {
						// dynamic-engine 与 image-engine 的 Dynamic 类型同源同构（皆为 Bilibili
						// 动态接口的子集，仅声明字段不同），运行时是同一对象。这里用 unknown
						// 中转的类型断言避开两份独立 .d.ts 的结构性差异。
						buffer = await this.image.generateDynamicCard(
							item as unknown as Parameters<ImageRenderer["generateDynamicCard"]>[0],
							sub?.customCardStyle?.enable ? sub.customCardStyle : undefined,
						);
					}
				} catch (e) {
					const err = e as Error;
					if (err.message === "直播开播动态，不做处理") {
						// 开播伪动态由 live 引擎处理,这里视为已处理,推进锚点。
						markOk(uid, postTime);
						continue;
					}
					// 软降级：图片渲染失败不再永久停 cron。让流程继续走 text-only 推送，
					// 同时只在连续失败首次通知一次管理员，避免长时间无服务又不刷屏。
					this.imageFailureStreak++;
					this.logger.error(
						`[image] 生成动态图片失败 (连续 ${this.imageFailureStreak} 次): ${err.message}`,
					);
					if (!this.imageFailureNotified) {
						// notify-once:此前在 await sendErrorMsg 之前就置 notified=true,
						// 一旦该次通知 reject,notified 永远为 true 而通知从未真正送达 ——
						// 后续失败被静默抑制。改为通知成功后才置位,失败则下轮重试通知。
						try {
							await this.push.sendErrorMsg(
								`生成动态图片失败：${err.message}，已降级为纯文字推送，请检查图片插件状态`,
							);
							this.bus.emit("engine-error", LOG_TAG, `生成动态图片失败：${err.message}`);
							this.imageFailureNotified = true;
						} catch (notifyErr) {
							this.logger.warn(
								`[image] 失败通知发送失败,下轮将重试通知: ${(notifyErr as Error).message}`,
							);
						}
					}
					buffer = undefined;
				}
				// 渲染成功后重置失败追踪，恢复后续通知能力
				if (buffer) {
					if (this.imageFailureStreak > 0) {
						this.logger.info(
							`[image] 图片渲染已恢复（之前连续失败 ${this.imageFailureStreak} 次）`,
						);
					}
					this.imageFailureStreak = 0;
					this.imageFailureNotified = false;
				}

				// Build bare URL (模板的 {url} 变量,不含任何前缀文案)。链接恒计算 ——
				// 要不要展示由模板里有没有 {url} 决定。视频转 BV 无匹配等 url 为空的情形,
				// renderDynamicText 会去掉模板里 {url} 的尾随分隔符。
				const isVideo = item.type === "DYNAMIC_TYPE_AV";
				let url: string;
				if (isVideo) {
					const jumpUrl = item.modules.module_dynamic.major?.archive?.jump_url ?? "";
					if (this.config.dynamicVideoUrlToBV) {
						const bvMatch = jumpUrl.match(/BV[0-9A-Za-z]+/);
						url = bvMatch ? bvMatch[0] : "";
					} else {
						url = `https:${jumpUrl}`;
					}
				} else {
					url = `https://t.bilibili.com/${item.id_str}`;
				}

				// AI comment — adapter 在 SubItemView 上可附 per-UP aiOverride，传给 comment()
				// 后仅对该次调用生效；缺失时 fall through 到 CommentaryClient 的全局 config。
				let aiComment: string | undefined;
				if (this.ai && this.config.aiEnabled !== false) {
					const dynamicText = extractDynamicText(item);
					if (dynamicText) {
						const imageUrls = extractDynamicImages(item);
						const subForAi = this.dynamicSubManager.get(uid);
						this.logger.debug(
							`[ai] 开始生成动态点评，文本长度=${dynamicText.length}，图片数=${imageUrls.length}${subForAi?.aiOverride ? "，命中 per-UP override" : ""}`,
						);
						try {
							aiComment = await this.ai.comment(
								`${name}发布了一条动态，内容如下：\n${dynamicText}`,
								"dynamic",
								imageUrls,
								subForAi?.aiOverride,
							);
							this.logger.debug(`[ai] 动态点评生成完毕，长度=${aiComment?.length ?? 0}`);
						} catch (e) {
							this.logger.error(`[ai] AI 点评生成失败：${(e as Error).message}，回退到普通文字`);
						}
					} else {
						this.logger.debug("[ai] 动态无可提取文本，跳过 AI 点评");
					}
				}

				// 跨 image/AI 多个 await 后重校:期间 applyOps 可能已退订该 UID。
				// 仍 dispatch 会给已退订用户推送,且下方时间线回写会“复活”其时间线。
				if (!this.stillSubscribed(uid, subAtCapture)) {
					this.logger.debug(`[detector] UID=${uid} 在本轮处理中已退订/被替换，跳过推送`);
					continue;
				}

				// Send —— 文字内容在「有图」「无图」两条分支完全一致:有 AI 点评用点评,
				// 否则按模板(per-UP override ?? engine 全局 config ?? 内建兜底)渲染。
				const tmpl = isVideo
					? (sub?.customVideoTemplate ?? this.config.videoTemplate ?? DEFAULT_DYNAMIC_TEXT.video)
					: (sub?.customDynamicTemplate ??
						this.config.dynamicTemplate ??
						DEFAULT_DYNAMIC_TEXT.dynamic);
				const text = aiComment ?? renderDynamicText(tmpl, name, url);
				const segments: PushSegment[] = buffer
					? [
							{ type: "image", buffer, mime: "image/jpeg" },
							...(text ? ([{ type: "text", text }] as PushSegment[]) : []),
						]
					: [{ type: "text", text }];
				await this.push.broadcastDynamic(uid, segments, "dynamic");

				// Push extra images from draw dynamics. DYNAMIC_TYPE_DRAW 的原图在
				// major.draw.items[].src;部分 opus 包裹的图文帖图在 major.opus.pics[].url。
				// 此前只读 opus.pics → 纯 DRAW 帖(图在 draw.items)图组被静默丢弃。
				//
				// per-UP override 优先于 engine config:adapter 折叠 sub.overrides.imageGroup
				// 后塞进 SubItemView 的 `imageGroupEnable` / `imageGroupForward`,undefined 时
				// 继承全局 config.imageGroup.{enable,forward}。
				const subForImgs = this.dynamicSubManager.get(uid);
				const effEnable = subForImgs?.imageGroupEnable ?? this.config.imageGroup.enable;
				if (effEnable && item.type === "DYNAMIC_TYPE_DRAW") {
					const major = item.modules?.module_dynamic?.major;
					const images: ForwardImage[] = [];
					// draw.items / opus.pics 均带 width/height(B站图集元数据)——透传给需要
					// 原始尺寸的平台(QQ 原生 markdown 多图 `![#宽px #高px]`),其余平台只用 url。
					for (const it of (major?.draw?.items ?? []) as Array<{
						src?: string;
						width?: number;
						height?: number;
					}>) {
						if (it.src) images.push({ url: it.src, width: it.width, height: it.height });
					}
					for (const pic of major?.opus?.pics ?? []) {
						if (pic.url) images.push({ url: pic.url, width: pic.width, height: pic.height });
					}
					if (images.length) {
						const effForward = subForImgs?.imageGroupForward ?? this.config.imageGroup.forward;
						// 单张图永远不走合并转发(1 张图包成「聊天记录」卡片无意义)。
						const forward = effForward && images.length > 1;
						await this.push.broadcastDynamic(
							uid,
							[
								{
									type: "image-group",
									forward,
									images,
								},
							],
							"dynamic-images",
						);
					}
				}
				markOk(uid, postTime);
			} catch (e) {
				markFail(uid, postTime);
				this.logger.warn(
					`[detector] 推送失败 UID=${uid} ID=${item.id_str ?? "?"}：${(e as Error).message}`,
				);
			}
		}

		// DY1:per-uid 锚点单调推进 —— 只推进到「严格早于本 uid 最早失败项」的
		// 最大成功 pub_ts;无失败则推进到最大成功项。max(existing,…) 绝不回退,
		// 失败项及其后(更早)成功项下轮重试/重推,绝不静默越过失败项丢动态。
		for (const uid of new Set([...Object.keys(okTs), ...Object.keys(failTs)])) {
			// applyOps 本轮删过的 UID:时间线已被 stopDynamicForUid 删除,这里
			// 再 set 等于复活孤儿锚点,跳过(A7)。
			if (!this.stillSubscribed(uid)) {
				this.logger.debug(`[timeline] UID=${uid} 已退订，跳过时间线回写（不复活）`);
				continue;
			}
			const fails = failTs[uid] ?? [];
			const minFail = fails.length ? Math.min(...fails) : Number.POSITIVE_INFINITY;
			const safeOks = (okTs[uid] ?? []).filter((t) => t < minFail);
			if (safeOks.length === 0) continue;
			const existing = this.dynamicTimelineManager.get(uid) ?? 0;
			const next = Math.max(existing, ...safeOks);
			if (next <= existing) continue;
			this.dynamicTimelineManager.set(uid, next);
			this.logger.debug(
				`[timeline] 更新时间线 UID=${uid} 时间=${DateTime.fromSeconds(next).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);
		}

		this.logger.debug(`[detector] 本次成功处理 ${Object.keys(okTs).length} 个 UP 的动态`);
	}

	private async handleApiError(code: number, message: string): Promise<void> {
		// Stop dynamic detector first
		this.dynamicJob?.stop();
		this.dynamicJob = undefined;
		switch (code) {
			case -101: {
				// 真鉴权失效:停 cron,靠 auth-restored 重启(不退避盲重试 ——
				// 对死会话每 5 分钟刷一次毫无意义且放大风控)。auth-lost 由 api
				// interceptor 单点广播,主人通知由上层 60s 节流统一发送。
				this.logger.error("[api] 账号未登录，动态检测已停止（待 auth-restored 重启）");
				this.bus.emit("engine-error", LOG_TAG, "账号未登录");
				// auth-loss 是与风控不同的独立 episode,会停 cron 待 auth-restored。
				// 清掉风控边沿:恢复后若再遇 -352 是全新 episode,必须重新告警
				// (否则跨 auth-loss 的新风控会被陈旧 flag 静默 —— 审计发现的缺口)。
				this.riskControlled = false;
				break;
			}
			case -352: {
				// 风控:**非永久**。`bili cap` 解除风控不会发任何事件,此前 cron
				// 永久静默直到重启进程。退避后自动重探,解除即自愈。
				// Q7 边沿:进入风控只 error+DM+engine-error 一次;退避重探仍风控 →
				// debug(不重复刷 error / 不重复打扰 master);成功拉取 → info 清除。
				if (!this.riskControlled) {
					this.riskControlled = true;
					this.logger.error("[api] 账号被风控，动态检测暂停，将退避后自动重试");
					await this.push.sendPrivateMsg("账号被风控，请使用 `bili cap` 指令解除风控");
					this.bus.emit("engine-error", LOG_TAG, "账号被风控");
				} else {
					this.logger.debug("[api] 仍处于风控态，退避后继续重探(不重复告警)");
				}
				this.scheduleDetectorRestart("风控");
				break;
			}
			default: {
				// 瞬时错误(-509 限流 / 瞬时 -403 / 未知码):不可永久停 cron。
				// 退避后自动重试,瞬时抖动自愈,无需人工重启进程 → Q3 warn 不冒充事故。
				this.logger.warn(`[api] 获取动态信息失败，错误码：${code}，${message}，将退避后自动重试`);
				await this.push.sendPrivateMsg(`获取动态信息失败，错误码：${code}`);
				this.bus.emit("engine-error", LOG_TAG, `获取动态失败，错误码：${code}`);
				this.scheduleDetectorRestart(`错误码 ${code}`);
			}
		}
	}

	/**
	 * 风控/瞬时错误后排一次性退避重启。已有待执行的不叠加(`detectorRestartTimer`
	 * 非空即跳过)。到点取最新订阅快照重启检测;`stop()` / 显式 `startDynamicDetector`
	 * 会作废本计时(避免 dispose 后 / 重启后仍触发陈旧重启)。
	 */
	private scheduleDetectorRestart(reason: string): void {
		if (this.detectorRestartTimer) return;
		this.logger.info(
			`[detector] ${reason},将在 ${DETECTOR_RESTART_BACKOFF_MS / 1000}s 后自动重试动态检测`,
		);
		this.detectorRestartTimer = this.serviceCtx.setTimeout(() => {
			this.detectorRestartTimer = undefined;
			const subs = this.getSubs();
			if (!subs) {
				this.logger.debug("[detector] 退避重启:订阅快照不可用,跳过本次(等下个触发)");
				return;
			}
			this.logger.info("[detector] 退避计时到,重启动态检测");
			this.startDynamicDetector(subs);
		}, DETECTOR_RESTART_BACKOFF_MS);
	}
}
