import type { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type { BilibiliPush, SubItem, SubManager, Subscriptions } from "@bilibili-notify/push";
import { PushType } from "@bilibili-notify/push";
import { CronJob } from "cron";
import { type Awaitable, type Context, h, type Logger, Service } from "koishi";
import type { SubscriptionOp } from "koishi-plugin-bilibili-notify";
import type {} from "koishi-plugin-bilibili-notify-ai";
import { DateTime } from "luxon";
import { dynamicCommands } from "./commands";
import type { BilibiliNotifyDynamicConfig } from "./config";
import { DynamicFilterReason, filterDynamic } from "./dynamic-filter";
import type { AllDynamicInfo, Dynamic, DynamicTimelineManager } from "./types";

declare module "koishi" {
	interface Context {
		"bilibili-notify-dynamic": BilibiliNotifyDynamic;
	}
	interface Events {
		"bilibili-notify/subscription-changed"(ops: SubscriptionOp[]): void;
		"bilibili-notify/plugin-error"(source: string, message: string): void;
	}
}

const SERVICE_NAME = "bilibili-notify-dynamic";

/** Simple async lock: if the previous run is still executing, skip. */
function withLock(fn: () => Promise<void>, onError?: (err: unknown) => void): () => void {
	let locked = false;
	return () => {
		if (locked) return;
		locked = true;
		fn()
			.catch((err) => {
				onError?.(err);
			})
			.finally(() => {
				locked = false;
			});
	};
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

export class BilibiliNotifyDynamic extends Service<BilibiliNotifyDynamicConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static readonly inject = ["bilibili-notify"];

	private readonly dynamicLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private api!: BilibiliAPI;
	private push!: BilibiliPush;
	private dynamicJob?: CronJob;
	private dynamicSubManager: SubManager = new Map();
	private dynamicTimelineManager: DynamicTimelineManager = new Map();
	/** 连续图片渲染失败计数，达到阈值时仅通知一次但不停 cron */
	private imageFailureStreak = 0;
	private imageFailureNotified = false;

	constructor(ctx: Context, config: BilibiliNotifyDynamicConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		this.dynamicLogger.level = config.logLevel;
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");
		this.api = internals.api;
		this.push = internals.push;
		this.dynamicTimelineManager = new Map();
		this.dynamicLogger.debug("[start] 动态插件启动，正在等待订阅数据...");
		// If subscriptions were already loaded before this plugin started, start immediately
		if (internals.subs) {
			this.dynamicLogger.debug("[start] 订阅已就绪，立即启动动态检测");
			this.startDynamicDetector(internals.subs);
		} else {
			this.dynamicLogger.debug("[start] 订阅尚未就绪，等待 subscription-changed 事件");
		}
		// Listen for future subscription changes from core (incremental ops)
		this.ctx.on("bilibili-notify/subscription-changed", (ops: SubscriptionOp[]) => {
			this.applyOps(ops);
		});
		// Register commands
		dynamicCommands.call(this);
	}

	protected stop(): Awaitable<void> {
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicLogger.info("[stop] 动态检测任务已停止");
		}
	}

	get isActive(): boolean {
		return this.dynamicJob?.running ?? false;
	}

	startDynamicDetector(subs: Subscriptions): void {
		// Stop existing job first
		if (this.dynamicJob) {
			this.dynamicLogger.debug("[detector] 停止旧的动态检测任务");
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
		}

		// Build sub manager with only dynamic-enabled subs
		const dynamicSubManager: SubManager = new Map();
		for (const sub of Object.values(subs)) {
			if (sub.dynamic) {
				// 只为新增 UID 设置初始时间戳，保留已有 UID 的时间戳避免重推旧动态
				if (!this.dynamicTimelineManager.has(sub.uid)) {
					this.dynamicTimelineManager.set(sub.uid, Math.floor(DateTime.now().toSeconds()));
					this.dynamicLogger.debug(`[detector] 初始化 UID：${sub.uid} 时间戳`);
				}
				dynamicSubManager.set(sub.uid, sub);
			}
		}
		// 清理已移除 UID 的时间戳记录
		for (const uid of this.dynamicTimelineManager.keys()) {
			if (!dynamicSubManager.has(uid)) {
				this.dynamicTimelineManager.delete(uid);
				this.dynamicLogger.debug(`[detector] 清理已移除 UID：${uid} 的时间戳`);
			}
		}

		if (dynamicSubManager.size === 0) {
			this.dynamicLogger.info("[detector] 没有需要动态检测的订阅对象");
			return;
		}
		this.dynamicLogger.debug(
			`[detector] 动态检测 UID 列表：${[...dynamicSubManager.keys()].join(", ")}`,
		);

		this.dynamicSubManager = dynamicSubManager;
		this.startJob();
	}

	private startDynamicForUid(uid: string, sub: SubItem): void {
		if (!this.dynamicTimelineManager.has(uid)) {
			this.dynamicTimelineManager.set(uid, Math.floor(DateTime.now().toSeconds()));
			this.dynamicLogger.debug(`[ops] 初始化 UID：${uid} 时间戳`);
		}
		this.dynamicSubManager.set(uid, structuredClone(sub));
		this.dynamicLogger.debug(`[ops] 开启动态订阅 UID：${uid}`);
	}

	private stopDynamicForUid(uid: string): void {
		if (!this.dynamicSubManager.has(uid)) return;
		this.dynamicSubManager.delete(uid);
		this.dynamicTimelineManager.delete(uid);
		this.dynamicLogger.debug(`[ops] 移除动态订阅 UID：${uid}`);
	}

	/** Incrementally apply subscription ops without restarting the cron job. */
	private applyOps(ops: SubscriptionOp[]): void {
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
							const fullSub =
								this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN)?.subs?.[op.uid];
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
				(err) => this.dynamicLogger.error(`[detector] 动态检测执行异常：${err}`),
			),
		);
		this.dynamicJob.start();
		this.dynamicLogger.info("[detector] 动态检测任务已启动");
	}

	private reconcileJob(): void {
		if (this.dynamicSubManager.size === 0) {
			if (this.dynamicJob?.running) {
				this.dynamicJob.stop();
				this.dynamicJob = undefined;
				this.dynamicLogger.info("[detector] 订阅清空，动态检测任务已停止");
			}
		} else if (!this.dynamicJob?.running) {
			this.dynamicLogger.debug(
				`[detector] 动态检测 UID 列表：${[...this.dynamicSubManager.keys()].join(", ")}`,
			);
			this.startJob();
		}
	}

	private async detectDynamics(): Promise<void> {
		this.dynamicLogger.debug("[detector] 开始获取动态信息");

		let content: AllDynamicInfo | undefined;
		try {
			content = (await this.api.getAllDynamic()) as AllDynamicInfo;
		} catch (e) {
			this.dynamicLogger.error(`[api] 获取动态失败：${e}`);
			return;
		}

		if (!content) return;

		if (content.code !== 0) {
			await this.handleApiError(content.code, content.message);
			return;
		}

		this.dynamicLogger.debug("[detector] 成功获取动态信息，开始处理");

		const currentPushDyn: Record<string, Dynamic> = {};

		for (const item of content.data.items) {
			if (!item) continue;

			const postTime = item.modules.module_author.pub_ts;
			if (typeof postTime !== "number" || !Number.isFinite(postTime)) {
				this.dynamicLogger.warn(
					`[detector] 跳过无效动态：pub_ts 缺失或非数字，ID=${item.id_str ?? "unknown"}`,
				);
				continue;
			}

			const uid = item.modules.module_author.mid.toString();
			const name = item.modules.module_author.name;

			const timeline = this.dynamicTimelineManager.get(uid);
			if (timeline === undefined) continue; // not subscribed

			this.dynamicLogger.debug(
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
				this.dynamicLogger.debug(
					`[filter] 动态 ID=${item.id_str} 被过滤，原因：${filterResult.reason}`,
				);
				if (this.config.filter?.notify) {
					const msgs: Record<DynamicFilterReason, string> = {
						[DynamicFilterReason.BlacklistKeyword]: `${name}发布了一条含有屏蔽关键字的动态`,
						[DynamicFilterReason.BlacklistForward]: `${name}转发了一条动态，已屏蔽`,
						[DynamicFilterReason.BlacklistArticle]: `${name}投稿了一条专栏，已屏蔽`,
						[DynamicFilterReason.WhitelistUnmatched]: `${name}发布了一条不在白名单范围内的动态，已屏蔽`,
					};
					await this.push.broadcastToTargets(
						uid,
						h("message", msgs[filterResult.reason as DynamicFilterReason]),
						PushType.Dynamic,
					);
				}
				continue;
			}

			// Render card
			const sub = this.dynamicSubManager.get(uid);
			// biome-ignore lint/suspicious/noExplicitAny: optional image service
			const imageService = (this.ctx as any)["bilibili-notify-image"];
			// biome-ignore lint/suspicious/noExplicitAny: image buffer
			let buffer: any;
			try {
				if (imageService?.generateDynamicCard) {
					buffer = await imageService.generateDynamicCard(
						item,
						sub?.customCardStyle?.enable ? sub.customCardStyle : undefined,
					);
				}
			} catch (e) {
				const err = e as Error;
				if (err.message === "直播开播动态，不做处理") continue;
				// 软降级：图片渲染失败不再永久停 cron。让流程继续走 text-only 推送，
				// 同时只在连续失败首次通知一次管理员，避免长时间无服务又不刷屏。
				this.imageFailureStreak++;
				this.dynamicLogger.error(
					`[image] 生成动态图片失败 (连续 ${this.imageFailureStreak} 次): ${err.message}`,
				);
				if (!this.imageFailureNotified) {
					this.imageFailureNotified = true;
					await this.push.sendErrorMsg(
						`生成动态图片失败：${err.message}，已降级为纯文字推送，请检查图片插件状态`,
					);
					this.ctx.emit(
						"bilibili-notify/plugin-error",
						SERVICE_NAME,
						`生成动态图片失败：${err.message}`,
					);
				}
				buffer = undefined;
			}
			// 渲染成功后重置失败追踪，恢复后续通知能力
			if (buffer) {
				if (this.imageFailureStreak > 0) {
					this.dynamicLogger.info(
						`[image] 图片渲染已恢复（之前连续失败 ${this.imageFailureStreak} 次）`,
					);
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
			const aiService = this.ctx.get("bilibili-notify-ai");
			if (aiService) {
				const dynamicText = extractDynamicText(item);
				if (dynamicText) {
					const imageUrls = extractDynamicImages(item);
					this.dynamicLogger.debug(
						`[ai] 开始生成动态点评，文本长度=${dynamicText.length}，图片数=${imageUrls.length}`,
					);
					try {
						aiComment = await aiService.comment(
							`${name}发布了一条动态，内容如下：\n${dynamicText}`,
							"dynamic",
							imageUrls,
						);
						this.dynamicLogger.debug(`[ai] 动态点评生成完毕，长度=${aiComment?.length ?? 0}`);
					} catch (e) {
						this.dynamicLogger.error(
							`[ai] AI 点评生成失败：${(e as Error).message}，回退到普通文字`,
						);
					}
				} else {
					this.dynamicLogger.debug("[ai] 动态无可提取文本，跳过 AI 点评");
				}
			}

			// Send
			const textPart = aiComment ?? (dUrl || undefined);
			const msgContent = buffer
				? [h.image(buffer, "image/jpeg"), ...(textPart ? [h.text(textPart)] : [])]
				: [h.text(aiComment ?? `${name}发布了一条动态${dUrl ? `：${dUrl}` : ""}`)];
			await this.push.broadcastToTargets(uid, h("message", msgContent), PushType.Dynamic);

			// Push extra images from draw dynamics
			if (this.config.pushImgsInDynamic && item.type === "DYNAMIC_TYPE_DRAW") {
				const pics = item.modules?.module_dynamic?.major?.opus?.pics;
				if (pics?.length) {
					const picsMsg = h(
						"message",
						{ forward: true },
						pics.map((p) => h.img(p.url)),
					);
					await this.push.broadcastToTargets(uid, picsMsg, PushType.Dynamic);
				}
			}
		}

		// Update timelines
		for (const [uid, item] of Object.entries(currentPushDyn)) {
			const postTime = item.modules.module_author.pub_ts;
			this.dynamicTimelineManager.set(uid, postTime);
			this.dynamicLogger.debug(
				`[timeline] 更新时间线 UID=${uid} 时间=${DateTime.fromSeconds(postTime).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);
		}

		this.dynamicLogger.debug(`[detector] 本次推送 ${Object.keys(currentPushDyn).length} 条动态`);
	}

	private async handleApiError(code: number, message: string): Promise<void> {
		// Stop dynamic detector first
		this.dynamicJob?.stop();
		this.dynamicJob = undefined;
		switch (code) {
			case -101: {
				this.dynamicLogger.error("[api] 账号未登录，动态检测已停止");
				await this.push.sendPrivateMsg("账号未登录，请先登录");
				this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, "账号未登录");
				break;
			}
			case -352: {
				this.dynamicLogger.error("[api] 账号被风控，动态检测已停止");
				await this.push.sendPrivateMsg("账号被风控，请使用 `bili cap` 指令解除风控");
				this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, "账号被风控");
				break;
			}
			default: {
				this.dynamicLogger.error(`[api] 获取动态信息失败，错误码：${code}，${message}`);
				await this.push.sendPrivateMsg(`获取动态信息失败，错误码：${code}`);
				this.ctx.emit(
					"bilibili-notify/plugin-error",
					SERVICE_NAME,
					`获取动态失败，错误码：${code}`,
				);
			}
		}
	}
}
