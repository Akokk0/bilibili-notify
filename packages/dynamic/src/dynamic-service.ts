import type { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type { BilibiliPush, SubManager, Subscriptions } from "@bilibili-notify/push";
import { PushType } from "@bilibili-notify/push";
import { CronJob } from "cron";
import { type Awaitable, type Context, h, Logger, Service } from "koishi";
// biome-ignore lint/correctness/noUnusedImports: <empty import> is needed to make sure the type augmentation works
import {} from "koishi-plugin-bilibili-notify";
import { DateTime } from "luxon";
import type { BilibiliNotifyDynamicConfig } from "./config";
import { DynamicFilterReason, filterDynamic } from "./dynamic-filter";
import type { AllDynamicInfo, Dynamic, DynamicTimelineManager } from "./types";

declare module "koishi" {
	interface Context {
		"bilibili-notify-dynamic": BilibiliNotifyDynamic;
	}
	interface Events {
		"bilibili-notify/subscription-changed"(subs: Subscriptions): void;
		"bilibili-notify/plugin-error"(source: string, message: string): void;
	}
}

const SERVICE_NAME = "bilibili-notify-dynamic";

/** Simple async lock: if the previous run is still executing, skip. */
function withLock(fn: () => Promise<void>): () => void {
	let locked = false;
	return () => {
		if (locked) return;
		locked = true;
		fn()
			.catch((err) => {
				console.error("[bilibili-notify-dynamic] Execution error:", err);
			})
			.finally(() => {
				locked = false;
			});
	};
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

	private readonly dynamicLogger: Logger;
	private api!: BilibiliAPI;
	private push!: BilibiliPush;
	private dynamicJob?: CronJob;
	private dynamicSubManager: SubManager = new Map();
	private dynamicTimelineManager: DynamicTimelineManager = new Map();

	constructor(ctx: Context, config: BilibiliNotifyDynamicConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		this.dynamicLogger = new Logger(SERVICE_NAME);
		this.dynamicLogger.level = config.logLevel;
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");
		this.api = internals.api;
		this.push = internals.push;
		this.dynamicTimelineManager = new Map();
		// If subscriptions were already loaded before this plugin started, start immediately
		if (internals.subs) {
			this.startDynamicDetector(internals.subs);
		}
		// Listen for future subscription changes from core
		this.ctx.on("bilibili-notify/subscription-changed", (subs: Subscriptions) => {
			this.startDynamicDetector(subs);
		});
	}

	protected stop(): Awaitable<void> {
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicLogger.info("动态检测任务已停止");
		}
	}

	get isActive(): boolean {
		return this.dynamicJob?.running ?? false;
	}

	startDynamicDetector(subs: Subscriptions): void {
		// Stop existing job first
		if (this.dynamicJob) {
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
				}
				dynamicSubManager.set(sub.uid, sub);
			}
		}
		// 清理已移除 UID 的时间戳记录
		for (const uid of this.dynamicTimelineManager.keys()) {
			if (!dynamicSubManager.has(uid)) {
				this.dynamicTimelineManager.delete(uid);
			}
		}

		if (dynamicSubManager.size === 0) {
			this.dynamicLogger.info("没有需要动态检测的订阅对象");
			return;
		}

		this.dynamicSubManager = dynamicSubManager;

		this.dynamicJob = new CronJob(
			this.config.dynamicCron,
			withLock(() => this.detectDynamics()),
		);
		this.dynamicJob.start();
		this.dynamicLogger.info("动态检测任务已启动");
	}

	private async detectDynamics(): Promise<void> {
		this.dynamicLogger.debug("开始获取动态信息");

		let content: AllDynamicInfo | undefined;
		try {
			content = (await this.api.getAllDynamic()) as AllDynamicInfo;
		} catch (e) {
			this.dynamicLogger.error(`获取动态失败：${e}`);
			return;
		}

		if (!content) return;

		if (content.code !== 0) {
			await this.handleApiError(content.code, content.message);
			return;
		}

		this.dynamicLogger.debug("成功获取动态信息，开始处理");

		const currentPushDyn: Record<string, Dynamic> = {};

		for (const item of content.data.items) {
			if (!item) continue;

			const postTime = item.modules.module_author.pub_ts;
			if (typeof postTime !== "number" || !Number.isFinite(postTime)) {
				this.dynamicLogger.warn(
					`跳过无效动态：pub_ts 缺失或非数字，ID=${item.id_str ?? "unknown"}`,
				);
				continue;
			}

			const uid = item.modules.module_author.mid.toString();
			const name = item.modules.module_author.name;

			const timeline = this.dynamicTimelineManager.get(uid);
			if (timeline === undefined) continue; // not subscribed

			this.dynamicLogger.debug(
				`检查动态 UP=${name} UID=${uid} 发布时间=${DateTime.fromSeconds(postTime).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);

			if (timeline >= postTime) continue; // already pushed

			// Filter
			const filterResult = filterDynamic(item, this.config.filter ?? {});
			if (filterResult.blocked) {
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
				this.dynamicLogger.error(`生成动态图片失败：${err.message}，动态检测已停止`);
				await this.push.sendErrorMsg(`生成动态图片失败：${err.message}，动态检测已停止`);
				this.dynamicJob?.stop();
				this.dynamicJob = undefined;
				this.ctx.emit(
					"bilibili-notify/plugin-error",
					SERVICE_NAME,
					`生成动态图片失败：${err.message}`,
				);
				return;
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
			if (this.api.isAIEnabled()) {
				const dynamicText = extractDynamicText(item);
				if (dynamicText) {
					try {
						aiComment = await this.api.chatWithAI(
							`${name}发布了一条动态，内容如下：\n${dynamicText}`,
						);
					} catch (e) {
						this.dynamicLogger.error(`AI 点评生成失败：${(e as Error).message}，回退到普通文字`);
					}
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

			// Track the earliest new dynamic per UID
			if (!currentPushDyn[uid]) {
				currentPushDyn[uid] = item;
			}
		}

		// Update timelines
		for (const [uid, item] of Object.entries(currentPushDyn)) {
			const postTime = item.modules.module_author.pub_ts;
			this.dynamicTimelineManager.set(uid, postTime);
			this.dynamicLogger.debug(
				`更新时间线 UID=${uid} 时间=${DateTime.fromSeconds(postTime).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);
		}

		this.dynamicLogger.debug(`本次推送 ${Object.keys(currentPushDyn).length} 条动态`);
	}

	private async handleApiError(code: number, message: string): Promise<void> {
		// Stop dynamic detector first
		this.dynamicJob?.stop();
		this.dynamicJob = undefined;
		switch (code) {
			case -101: {
				this.dynamicLogger.error("账号未登录，动态检测已停止");
				await this.push.sendPrivateMsg("账号未登录，请先登录");
				this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, "账号未登录");
				break;
			}
			case -352: {
				this.dynamicLogger.error("账号被风控，动态检测已停止");
				await this.push.sendPrivateMsg("账号被风控，请使用 `bili cap` 指令解除风控");
				this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, "账号被风控");
				break;
			}
			default: {
				this.dynamicLogger.error(`获取动态信息失败，错误码：${code}，${message}`);
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
