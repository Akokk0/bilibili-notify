import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Disposable, Logger, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { withLock } from "@bilibili-notify/internal";
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

const LOG_TAG = "bilibili-notify-dynamic";

/**
 * Runtime configuration for {@link DynamicEngine}. Mirrors the platform-neutral
 * subset of `BilibiliNotifyDynamicConfig`; the koishi shell maps its schema
 * fields onto this struct, the standalone runtime fills it from its own config
 * store. The `logLevel` field is intentionally dropped — adapter sets logger
 * level externally via {@link ServiceContext}.
 */
export interface DynamicEngineConfig {
	/** 推送动态时是否附带 URL（QQ 官方机器人需关闭）。 */
	dynamicUrl: boolean;
	/** 轮询动态的 cron 表达式。 */
	dynamicCron: string;
	/** 视频动态时是否将 URL 替换为 BV 号。 */
	dynamicVideoUrlToBV: boolean;
	/** 是否额外推送 DYNAMIC_TYPE_DRAW 中的图集（forward message）。 */
	pushImgsInDynamic: boolean;
	/** 内容过滤配置（含 notify：被屏蔽时是否通知）。 */
	filter: DynamicFilterConfig & { notify?: boolean };
	/**
	 * 是否启用图片卡片渲染。`false` 时跳过 puppeteer 调用,推送降级为纯文字。缺省视为 true,
	 * 保留旧 adapter 不传该字段时的既有行为。Adapter 通常用 `globals.defaults.cardStyle.enabled` 填充。
	 */
	imageEnabled?: boolean;
	/**
	 * 是否启用 AI 动态点评。`false` 时跳过 `CommentaryGenerator.comment()` 调用,推送只用原始动态文本。
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
	ai?: CommentaryGenerator;
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
	if (mod.major?.draw?.items) {
		for (const img of mod.major.draw.items as Array<{ src?: string }>) {
			if (img.src) urls.push(img.src);
		}
	}
	// 专栏/opus 图片列表
	if (mod.major?.opus?.pics) {
		for (const pic of mod.major.opus.pics) {
			if (pic.url) urls.push(pic.url);
		}
	}
	// 视频封面（archive 有 [key: string]: any）
	const archiveCover = mod.major?.archive?.cover as string | undefined;
	if (archiveCover) urls.push(archiveCover);
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
		const origMod = item.orig.modules.module_dynamic;
		const origAuthor = item.orig.modules.module_author.name;
		const origParts: string[] = [];
		if (origMod.desc?.text) origParts.push(origMod.desc.text);
		if (origMod.major?.opus?.summary?.text) origParts.push(origMod.major.opus.summary.text);
		if (origMod.major?.archive?.title) origParts.push(`视频标题：${origMod.major.archive.title}`);
		if (origParts.length > 0) parts.push(`（转发自 ${origAuthor}：${origParts.join(" ")}）`);
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
	private readonly image?: ImageRenderer;
	private readonly ai?: CommentaryGenerator;
	private readonly logger: Logger;
	private readonly getSubs: () => SubscriptionsView | null;

	private config: DynamicEngineConfig;
	private dynamicJob?: CronJob;
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
		this.logger.debug("[start] 动态引擎启动，正在等待订阅数据...");

		// 启动期已有快照则立即开跑
		const initial = this.getSubs();
		if (initial) {
			this.logger.debug("[start] 订阅已就绪，立即启动动态检测");
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

	/** 替换运行时配置（adapter 在 koishi config 变更时调用）。 */
	updateConfig(config: DynamicEngineConfig): void {
		this.config = config;
	}

	get isActive(): boolean {
		return this.dynamicJob?.running ?? false;
	}

	/** 用最新订阅快照重启动态检测；保留已有 UID 的时间戳避免重推旧动态。 */
	startDynamicDetector(subs: SubscriptionsView): void {
		// Stop existing job first
		if (this.dynamicJob) {
			this.logger.debug("[detector] 停止旧的动态检测任务");
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

	/** Incrementally apply subscription ops without restarting the cron job. */
	applyOps(ops: SubscriptionOpView[]): void {
		let jobNeedsReconcile = false;
		for (const op of ops) {
			switch (op.type) {
				case "add": {
					if (!op.sub.dynamic) break;
					this.startDynamicForUid(op.sub.uid, op.sub);
					jobNeedsReconcile = true;
					break;
				}
				case "delete": {
					if (!this.dynamicSubManager.has(op.uid)) break;
					this.stopDynamicForUid(op.uid);
					jobNeedsReconcile = true;
					break;
				}
				case "update": {
					for (const change of op.changes) {
						if (change.scope !== "dynamic") continue;
						if (change.dynamic) {
							const fullSub = this.getSubs()?.[op.uid];
							if (fullSub) this.startDynamicForUid(op.uid, fullSub);
							jobNeedsReconcile = true;
						} else if (change.dynamic === false) {
							this.stopDynamicForUid(op.uid);
							jobNeedsReconcile = true;
						}
					}
					break;
				}
			}
		}
		if (jobNeedsReconcile) this.reconcileJob();
	}

	private startJob(): void {
		this.dynamicJob = new CronJob(
			this.config.dynamicCron,
			withLock(
				() => this.detectDynamics(),
				(err) => this.logger.error(`[detector] 动态检测执行异常：${err}`),
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
			this.logger.error(`[api] 获取动态失败：${e}`);
			return;
		}

		if (!content) return;

		if (content.code !== 0) {
			await this.handleApiError(content.code, content.message);
			return;
		}

		this.logger.debug("[detector] 成功获取动态信息，开始处理");

		const currentPushDyn: Record<string, Dynamic> = {};

		for (const item of content.data.items) {
			if (!item) continue;

			const postTime = item.modules.module_author.pub_ts;
			if (typeof postTime !== "number" || !Number.isFinite(postTime)) {
				this.logger.warn(
					`[detector] 跳过无效动态：pub_ts 缺失或非数字，ID=${item.id_str ?? "unknown"}`,
				);
				continue;
			}

			const uid = item.modules.module_author.mid.toString();
			const name = item.modules.module_author.name;

			const timeline = this.dynamicTimelineManager.get(uid);
			if (timeline === undefined) continue; // not subscribed

			this.logger.debug(
				`[detector] 检查动态 UP=${name} UID=${uid} 发布时间=${DateTime.fromSeconds(postTime).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);

			if (timeline >= postTime) continue; // already pushed

			// Track most recent processed dynamic per UID for timeline update.
			// Items are most-recent-first, so first hit wins. Tracking before
			// the filter branch ensures filter-notified dynamics also advance
			// the timeline and avoid repeated notifications on subsequent polls.
			if (!currentPushDyn[uid]) {
				currentPushDyn[uid] = item;
			}

			// Filter
			const filterResult = filterDynamic(item, this.config.filter ?? {});
			if (filterResult.blocked) {
				this.logger.debug(`[filter] 动态 ID=${item.id_str} 被过滤，原因：${filterResult.reason}`);
				if (this.config.filter?.notify) {
					const msgs: Record<DynamicFilterReason, string> = {
						[DynamicFilterReason.BlacklistKeyword]: `${name}发布了一条含有屏蔽关键字的动态`,
						[DynamicFilterReason.BlacklistForward]: `${name}转发了一条动态，已屏蔽`,
						[DynamicFilterReason.BlacklistArticle]: `${name}投稿了一条专栏，已屏蔽`,
						[DynamicFilterReason.WhitelistUnmatched]: `${name}发布了一条不在白名单范围内的动态，已屏蔽`,
					};
					await this.push.broadcastDynamic(
						uid,
						[{ type: "text", text: msgs[filterResult.reason as DynamicFilterReason] }],
						"dynamic",
					);
				}
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
				if (err.message === "直播开播动态，不做处理") continue;
				// 软降级：图片渲染失败不再永久停 cron。让流程继续走 text-only 推送，
				// 同时只在连续失败首次通知一次管理员，避免长时间无服务又不刷屏。
				this.imageFailureStreak++;
				this.logger.error(
					`[image] 生成动态图片失败 (连续 ${this.imageFailureStreak} 次): ${err.message}`,
				);
				if (!this.imageFailureNotified) {
					this.imageFailureNotified = true;
					await this.push.sendErrorMsg(
						`生成动态图片失败：${err.message}，已降级为纯文字推送，请检查图片插件状态`,
					);
					this.bus.emit("plugin-error", LOG_TAG, `生成动态图片失败：${err.message}`);
				}
				buffer = undefined;
			}
			// 渲染成功后重置失败追踪，恢复后续通知能力
			if (buffer) {
				if (this.imageFailureStreak > 0) {
					this.logger.info(`[image] 图片渲染已恢复（之前连续失败 ${this.imageFailureStreak} 次）`);
				}
				this.imageFailureStreak = 0;
				this.imageFailureNotified = false;
			}

			// Build URL suffix
			let dUrl = "";
			if (this.config.dynamicUrl) {
				if (item.type === "DYNAMIC_TYPE_AV") {
					const jumpUrl = item.modules.module_dynamic.major?.archive?.jump_url ?? "";
					if (this.config.dynamicVideoUrlToBV) {
						const bvMatch = jumpUrl.match(/BV[0-9A-Za-z]+/);
						dUrl = bvMatch ? bvMatch[0] : "";
					} else {
						dUrl = `${name}发布了新视频：https:${jumpUrl}`;
					}
				} else {
					dUrl = `${name}发布了一条动态：https://t.bilibili.com/${item.id_str}`;
				}
			}

			// AI comment
			let aiComment: string | undefined;
			if (this.ai && this.config.aiEnabled !== false) {
				const dynamicText = extractDynamicText(item);
				if (dynamicText) {
					const imageUrls = extractDynamicImages(item);
					this.logger.debug(
						`[ai] 开始生成动态点评，文本长度=${dynamicText.length}，图片数=${imageUrls.length}`,
					);
					try {
						aiComment = await this.ai.comment(
							`${name}发布了一条动态，内容如下：\n${dynamicText}`,
							"dynamic",
							imageUrls,
						);
						this.logger.debug(`[ai] 动态点评生成完毕，长度=${aiComment?.length ?? 0}`);
					} catch (e) {
						this.logger.error(`[ai] AI 点评生成失败：${(e as Error).message}，回退到普通文字`);
					}
				} else {
					this.logger.debug("[ai] 动态无可提取文本，跳过 AI 点评");
				}
			}

			// Send
			const textPart = aiComment ?? (dUrl || undefined);
			const segments: PushSegment[] = buffer
				? [
						{ type: "image", buffer, mime: "image/jpeg" },
						...(textPart ? ([{ type: "text", text: textPart }] as PushSegment[]) : []),
					]
				: [{ type: "text", text: aiComment ?? `${name}发布了一条动态${dUrl ? `：${dUrl}` : ""}` }];
			await this.push.broadcastDynamic(uid, segments, "dynamic");

			// Push extra images from draw dynamics
			if (this.config.pushImgsInDynamic && item.type === "DYNAMIC_TYPE_DRAW") {
				const pics = item.modules?.module_dynamic?.major?.opus?.pics;
				if (pics?.length) {
					await this.push.broadcastDynamic(
						uid,
						[
							{
								type: "image-group",
								forward: true,
								urls: pics.map((p) => p.url),
							},
						],
						"dynamic-images",
					);
				}
			}
		}

		// Update timelines
		for (const [uid, item] of Object.entries(currentPushDyn)) {
			const postTime = item.modules.module_author.pub_ts;
			this.dynamicTimelineManager.set(uid, postTime);
			this.logger.debug(
				`[timeline] 更新时间线 UID=${uid} 时间=${DateTime.fromSeconds(postTime).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);
		}

		this.logger.debug(`[detector] 本次推送 ${Object.keys(currentPushDyn).length} 条动态`);
	}

	private async handleApiError(code: number, message: string): Promise<void> {
		// Stop dynamic detector first
		this.dynamicJob?.stop();
		this.dynamicJob = undefined;
		switch (code) {
			case -101: {
				// auth-lost 由 api interceptor 触发的 onAuthLost 单点广播；
				// 通知主人由 server-manager.handleAuthLost 60 秒节流统一发送。
				// 这里只需停 cron 与上报 plugin-error 供运维诊断。
				this.logger.error("[api] 账号未登录，动态检测已停止");
				this.bus.emit("plugin-error", LOG_TAG, "账号未登录");
				break;
			}
			case -352: {
				this.logger.error("[api] 账号被风控，动态检测已停止");
				await this.push.sendPrivateMsg("账号被风控，请使用 `bili cap` 指令解除风控");
				this.bus.emit("plugin-error", LOG_TAG, "账号被风控");
				break;
			}
			default: {
				this.logger.error(`[api] 获取动态信息失败，错误码：${code}，${message}`);
				await this.push.sendPrivateMsg(`获取动态信息失败，错误码：${code}`);
				this.bus.emit("plugin-error", LOG_TAG, `获取动态失败，错误码：${code}`);
			}
		}
	}
}
