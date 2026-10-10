import type {
	Disposable,
	Logger,
	MessageBus,
	Post,
	PostReport,
	ServiceContext,
} from "@bilibili-notify/internal";
import { CronJob } from "cron";
import { DateTime } from "luxon";
import { errorMessageOf } from "../../util/error-message.js";
import type { Api } from "../api/index.js";
import { fetchPostImages, type ImagesDeps } from "../images";
import { emojiUrlsOf, postFromDynamic, repostAvatarUrlOf } from "./post-from-dynamic";
import type {
	PushLike,
	SubItemView,
	SubManagerView,
	SubscriptionOpView,
	SubscriptionsView,
} from "./push-like";
import type { AllDynamicResponse, Dynamic, DynamicTimelineManager } from "./types";

const LOG_TAG = "bilibili-notify-dynamic";
/**
 * 风控/瞬时错误停 cron 后的退避重启间隔。原实现:任何非鉴权错误(-509 限流、
 * 瞬时 -403、未知码)都永久 stop cron 且唯一重启路径 `auth-restored` 不会触发
 * → 动态轮询永久静默直到重启进程。退避后自动重探,瞬时错误/`bili cap` 解风控
 * 后即自愈,无需人工重启进程。
 */
const DETECTOR_RESTART_BACKOFF_MS = 5 * 60_000;

/** B 站的开播伪动态:开播由直播引擎推,动态这边不交作品。 */
const DYNAMIC_TYPE_LIVE_RCMD = "DYNAMIC_TYPE_LIVE_RCMD";

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
 * Runtime configuration for {@link DynamicEngine}. The standalone runtime fills it
 * from its config store. The `logLevel` field is intentionally dropped — the host
 * sets logger level externally via {@link ServiceContext}.
 *
 * 引擎只管生产:轮询节奏与视频链接怎么写是它自己的两样;模板 / 图集 / 出图 / AI / 过滤那些都是核心装配的事
 * (`posts/deliver-post.ts` 的 `PostSettings`,每条作品现折),不再经引擎。
 */
export interface DynamicEngineConfig {
	/** 轮询动态的 cron 表达式。 */
	dynamicCron: string;
	/** 视频动态时是否将 URL 替换为 BV 号。 */
	dynamicVideoUrlToBV: boolean;
}

export interface DynamicEngineOptions {
	serviceCtx: ServiceContext;
	bus: MessageBus;
	api: Api;
	/** 宿主给的出口:引擎只剩给主人发私信(风控 / 故障告警)这一样。 */
	push: PushLike;
	/**
	 * 抓图服务(用 B 站接口那个请求客户端建的,`runtime/engines.ts`):**交出作品之前**把作品里只有地址的图抓进图库
	 * (被过滤的、关了出图的动态也抓,代价主人知情)。必给 —— 漏给是编译不过,不是悄悄不出图。
	 */
	imageFetcher: ImagesDeps["images"];
	/**
	 * 把一条作品交给核心的作品入口(`PostQueue`)。**没有返回值**:交完就算,不等装配、不看结果,意外抛错由核心入口自己接住;
	 * 引擎只负责在交出后把时间线前移。签名就是订阅源上下文里 `ctx.reportPost` 的签名:来源只说「谁(外部 id)发了什么」,
	 * 订阅由宿主按身份查。必给。
	 */
	reportPost: (externalId: string, report: PostReport) => void;
	config: DynamicEngineConfig;
	/**
	 * Adapter 提供的订阅快照访问器。返回 null 表示订阅尚未就绪
	 * （engine 会在收到 `subscription-changed` / `auth-restored` 后再次拉取）。
	 */
	getSubs: () => SubscriptionsView | null;
}

/**
 * 链接部件的内容(不含任何前缀文案)。视频给视频页(或按设置换成 BV 号,取不到 BV 就没有链接),
 * 别的给动态页。
 */
function dynamicLink(item: Dynamic, isVideo: boolean, videoUrlToBV: boolean): string {
	if (!isVideo) return `https://t.bilibili.com/${item.id_str}`;
	const jumpUrl = item.modules.module_dynamic.major?.archive?.jump_url ?? "";
	if (!videoUrlToBV) return `https:${jumpUrl}`;
	const bvMatch = jumpUrl.match(/BV[0-9A-Za-z]+/);
	return bvMatch ? bvMatch[0] : "";
}

/**
 * 平台中立的动态轮询与生产核心。
 *
 * - 不依赖任何宿主框架;宿主(独立端 runtime)提供 ServiceContext / MessageBus / PushLike / reportPost。
 * - 只管生产:拉 feed、判新、翻成中立作品、抓图、交给核心入口。怎么消费(过滤、出卡、点评、推送、图集)不归它。
 */
export class DynamicEngine {
	private readonly serviceCtx: ServiceContext;
	private readonly bus: MessageBus;
	private readonly api: Api;
	private readonly push: PushLike;
	private readonly imageFetcher: ImagesDeps["images"];
	private readonly reportPost: (externalId: string, report: PostReport) => void;
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
	/**
	 * 瞬时错误(-509 / 瞬时 -403 / 4101132 之类未知码)的边沿标记,存着当前故障的
	 * 错误码。作用与 {@link riskControlled} 对称:
	 *
	 * 1. **不重复打扰** —— 同一个码连续失败只告警一次。退避周期是 300s,持续故障
	 *    一小时就是十几条私聊,而每条的信息量和第一条一模一样。换了码 = 换了故障,
	 *    重新告警。
	 * 2. **知道该不该报喜** —— 成功拉取时靠它判断「此前真的坏过」,否则每个 cron
	 *    tick 都会报一次"已恢复"。
	 */
	private transientErrorCode: number | null = null;
	/**
	 * 登录已失效,等 `auth-restored`。两个作用:
	 *
	 * 1. **不许重启 cron** —— 与 `detectorRestartTimer` 并列成为 `reconcileJob` 的门。
	 *    少了它,auth-lost 停掉 cron 之后随便一次订阅增删就会把它重新建起来,
	 *    再去撞一次 -101。
	 * 2. **不再报「账号未登录」** —— 上层收到 `auth-lost` 已经私聊过主人「账号登录
	 *    已失效,请到控制台重新扫码登录」,那句话还带着该怎么办;这里再报一句
	 *    `[bilibili-notify-dynamic] 账号未登录` 不带新信息,只会让人以为又坏了一处。
	 *
	 * 反过来,**没有** auth-lost 的 -101 必须照常报:`auth-lost` 只在真的丢掉一个好
	 * 会话时才发(login-flow 的 wasLoggedIn 门),进程起来时 cookie 就已过期的话根本
	 * 没有那个事件,这条 engine-error 是唯一的通知路径。
	 */
	private authLost = false;
	private dynamicSubManager: SubManagerView = new Map();
	private dynamicTimelineManager: DynamicTimelineManager = new Map();
	/**
	 * 上次**成功**拉到动态列表的时刻。`undefined` = 起来以后一次都没成功过。
	 *
	 * 只记成功、不记尝试:独立端的 `/status` 拿它回答「还在跑吗」,而连着失败三小时
	 * 的系统若报「1 分钟前抓过」,这一项就从答案变成了骗局 —— 那恰好是主人掏出手机
	 * 问状态的场合。
	 */
	private lastSuccessfulFetchAt?: number;
	private readonly busHandles: Disposable[] = [];

	constructor(opts: DynamicEngineOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.bus = opts.bus;
		this.api = opts.api;
		this.push = opts.push;
		this.imageFetcher = opts.imageFetcher;
		this.reportPost = opts.reportPost;
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

		// `subscription-changed` 的载荷是 `{ ops }`（参见 internal/platform.ts BusEvents）。
		// 宿主应当先调用 engine.applyOps(ops) 再 emit MessageBus 事件用于其他下游;
		// engine 自身只需在 auth-restored 时重建快照。
		this.busHandles.push(
			this.bus.on("auth-restored", () => {
				this.authLost = false;
				const subs = this.getSubs();
				if (!subs) return;
				// 前缀与 auth-lost 那条、以及直播引擎的同一对日志统一成 [auth]:
				// 这是登录生命周期事件,不是检测器自己的事。
				this.logger.info("[auth] 账号登录已恢复，正在重启动态检测");
				this.startDynamicDetector(subs);
			}),
		);

		// 与直播引擎的 `auth-lost` → `teardown()` 对称。此前动态这边没接,cron 照跑到
		// 下一轮自己撞上 -101 —— 主人于是先收到一条「账号登录已失效」,过一会儿又收到
		// 一条听着像新故障的「账号未登录」,而那一轮请求本来就注定失败。
		this.busHandles.push(
			this.bus.on("auth-lost", () => {
				this.authLost = true;
				this.suspendDetector();
				this.logger.warn("[auth] 账号登录已失效，动态检测已暂停（待 auth-restored 重启）");
			}),
		);

		this.serviceCtx.onDispose(() => this.stop(), "stop");
	}

	/** 停止钩子。停止 cron、释放事件订阅。 */
	stop(): void {
		// 全停 = lifecycle 结束;下次 start 是全新 episode,风控边沿复位重新武装。
		// (不在 startDynamicDetector 复位 —— -352 自身退避重启也走那里,复位会
		// 破坏边沿、每退避周期重刷 error,正是 Q7 要消除的。)
		this.riskControlled = false;
		// 同理:登录失效的抑制标记也只在一个 lifecycle 内有效。
		this.authLost = false;
		// 瞬时错误边沿同理 —— 留着的话下次 start 后第一次成功拉取会报一句
		// 上个 lifecycle 的「已恢复」。
		this.transientErrorCode = null;
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
			this.logger.info("[stop] 动态检测任务已停止");
		}
		this.releaseDetectLock();
		while (this.busHandles.length > 0) {
			const h = this.busHandles.pop();
			h?.dispose();
		}
	}

	/**
	 * 替换运行时配置(宿主在 dashboard 编辑后调用)。
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
	 * 上次成功拉到动态列表的时刻(epoch ms),`undefined` = 一次都还没成功。
	 * 独立端的 `/status` 用它回答「还在跑吗」。
	 */
	lastFetchAt(): number | undefined {
		return this.lastSuccessfulFetchAt;
	}

	get isActive(): boolean {
		return this.dynamicJob?.isActive ?? false;
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

		// 两张表的口径**刻意不同**:
		//   dynamicTimelineManager —— 「已观测」锚点,覆盖**每一个订阅**
		//   dynamicSubManager      —— 推送订阅表,只收动态推送开着的
		// per-UP 开关只决定产不产作品:名单外的订阅不翻译、不抓图、不交,时间线照常前移。两者曾是同一张表,
		// 于是关掉开关的 UP 在检测循环里 `timeline === undefined` 就被 continue 掉,锚点也不前移。
		const dynamicSubManager: SubManagerView = new Map();
		for (const sub of Object.values(subs)) {
			// 只为新增 UID 设置初始时间戳，保留已有 UID 的时间戳避免重推旧动态
			if (!this.dynamicTimelineManager.has(sub.uid)) {
				this.dynamicTimelineManager.set(sub.uid, Math.floor(DateTime.now().toSeconds()));
				this.logger.debug(`[detector] 初始化 UID：${sub.uid} 时间戳`);
			}
			if (sub.post) dynamicSubManager.set(sub.uid, sub);
		}
		// 清理已**退订** UID 的时间戳记录 —— 判据是「还在不在订阅里」,不是「推送开没开」。
		for (const uid of this.dynamicTimelineManager.keys()) {
			if (!subs[uid]) {
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

	/** 建「已观测」锚点(缺则以此刻为起点)。每一个订阅都要有,与推送开关无关。 */
	private ensureTimelineAnchor(uid: string): void {
		if (this.dynamicTimelineManager.has(uid)) return;
		this.dynamicTimelineManager.set(uid, Math.floor(DateTime.now().toSeconds()));
		this.logger.debug(`[ops] 初始化 UID：${uid} 时间戳`);
	}

	private startDynamicForUid(uid: string, sub: SubItemView): void {
		this.ensureTimelineAnchor(uid);
		this.dynamicSubManager.set(uid, structuredClone(sub));
		this.logger.debug(`[ops] 开启动态订阅 UID：${uid}`);
	}

	/**
	 * 退出**推送**订阅。刻意不动锚点 —— 它现在覆盖全部订阅,这位 UP 只是关了动态
	 * 推送,统计还要继续记。真退订时由调用方(applyOps 的 delete 分支)删锚点。
	 */
	private stopDynamicForUid(uid: string): void {
		if (!this.dynamicSubManager.has(uid)) return;
		this.dynamicSubManager.delete(uid);
		this.logger.debug(`[ops] 移除动态订阅 UID：${uid}`);
	}

	/** Incrementally apply subscription ops without restarting the cron job. */
	applyOps(ops: SubscriptionOpView[]): void {
		let jobNeedsReconcile = false;
		// per-UID 开/移除走 debug(见 startDynamicForUid/stopDynamicForUid);本批次
		// 收口一条 info 汇总,批量变更不再 N×info 刷屏(Q1「info 绝不循环每项」)。
		let opened = 0;
		let removed = 0;
		for (const op of ops) {
			switch (op.kind) {
				case "add": {
					// 锚点覆盖全部订阅(统计口径),推送订阅表只收开着开关的。
					this.ensureTimelineAnchor(op.sub.uid);
					if (!op.sub.post) break;
					this.startDynamicForUid(op.sub.uid, op.sub);
					opened++;
					jobNeedsReconcile = true;
					break;
				}
				case "delete": {
					// 真退订:锚点无论推送开关开没开都要清。漏掉的话会留下一个没人再清的
					// 孤儿,重新订阅时把它当「已看到这个时刻为止」,长期抑制该 UP 的动态。
					this.dynamicTimelineManager.delete(op.uid);
					if (!this.dynamicSubManager.has(op.uid)) break;
					this.stopDynamicForUid(op.uid);
					removed++;
					jobNeedsReconcile = true;
					break;
				}
				case "update": {
					for (const change of op.changes) {
						if (change.scope !== "dynamic") continue;
						if (change.post) {
							const fullSub = this.getSubs()?.[op.uid];
							if (fullSub) {
								this.startDynamicForUid(op.uid, fullSub);
								opened++;
							}
							jobNeedsReconcile = true;
						} else if (change.post === false) {
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

	/**
	 * `dynamicCron` 是 dashboard 里的自由文本框,没有格式校验;`new CronJob` 对无法
	 * 解析的表达式同步抛错(如 "Field (minute) cannot be parsed"),此前未捕获会
	 * 让整个独立端进程在启动期崩溃退出,且不写 pino 日志(catch 在更外层的
	 * `console.error` 才第一次留痕)——用户报告的"升级后后端起不来,清空数据才恢复"
	 * 即此:坏值持久化进 globals.json 后,后续每次启动都复现同一次崩溃。捕获后
	 * 仅跳过本次建 job(动态检测保持关闭态),不放倒整个引擎/进程。
	 */
	private startJob(): void {
		let job: CronJob;
		try {
			job = new CronJob(this.config.dynamicCron, () => void this.runDetectLocked());
		} catch (err) {
			this.logger.error(
				`[detector] dynamicCron="${this.config.dynamicCron}" 无法解析,动态检测未启动：${errorMessageOf(err)}`,
			);
			return;
		}
		this.dynamicJob = job;
		this.dynamicJob.start();
		this.logger.info("[detector] 动态检测任务已启动");
	}

	/**
	 * 登录失效时停掉检测循环,但**保留事件订阅** —— 与 `stop()` 的区别就在这:
	 * 这里还等着 `auth-restored` 把它拉起来。
	 *
	 * 挂着的退避重启必须一并作废:`scheduleDetectorRestart` 到点是直接调
	 * `startDynamicDetector`,绕过 `reconcileJob`,所以 `authLost` 那道门拦不住它 ——
	 * 上一轮 -352 排下的计时会在五分钟后把 cron 重新建起来,拿一个已经死掉的会话
	 * 再去撞一次。
	 *
	 * 面向运维的那条日志由调用方打(auth-lost 是 warn,-101 是 error),这里不重复。
	 */
	private suspendDetector(): void {
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
		}
		this.releaseDetectLock();
	}

	private reconcileJob(): void {
		if (this.dynamicSubManager.size === 0) {
			if (this.dynamicJob?.isActive) {
				this.dynamicJob.stop();
				this.dynamicJob = undefined;
				this.logger.info("[detector] 订阅清空，动态检测任务已停止");
			}
		} else if (!this.dynamicJob?.isActive && !this.detectorRestartTimer && !this.authLost) {
			// 两个「此刻别启动」的理由,少一个都会让 applyOps 把 cron 提前拉起来:
			//
			// · detectorRestartTimer 非空 = 正处于 -352/瞬时错误的退避窗口。提前 startJob
			//   会去戳仍在风控的端点,击穿退避(退避的全部意义就是不放大风控)。到点后
			//   scheduleDetectorRestart 的回调会用最新快照重启,订阅变更不会丢。
			// · authLost = 登录已经失效,等 auth-restored。这时候拉起来只是再撞一次 -101。
			this.logger.debug(
				`[detector] 动态检测 UID 列表：${[...this.dynamicSubManager.keys()].join(", ")}`,
			);
			this.startJob();
		}
	}

	/** 正在跑的那一轮;cron tick 撞上就跳过,`detectNow` 撞上就排在后面。 */
	private detectInFlight: Promise<void> | null = null;

	/**
	 * 拆掉检测器时松开锁。这把锁挂在实例上,活得比 cron job 长 —— 一轮要是永远不落定
	 * (渲染闸堆住之类),它会把之后所有 tick 静默丢掉,而且**重启也救不回来**:登录恢复、
	 * 改 cron 都只是重建 job,锁还是那一把。此前锁是随 job 一起新建的闭包,重建即重新武装;
	 * 这里补回那个性质 —— 拆检测器 = 这一轮不再算数。
	 */
	private releaseDetectLock(): void {
		this.detectInFlight = null;
	}

	/**
	 * 带锁跑一轮。同一时刻只有一轮在跑(此前是 `withLock`,换成握着 promise 是为了让
	 * `detectNow` 等得到这一轮结束)。异常记日志、锁必释放 —— 锁卡死的症状是 cron tick
	 * 全部静默丢弃,动态从此不再推。
	 */
	private runDetectLocked(): Promise<void> {
		if (this.detectInFlight) return this.detectInFlight;
		const round = this.detectDynamics()
			.catch((err: unknown) => {
				this.logger.error(`[detector] 动态检测执行异常：${errorMessageOf(err)}`);
			})
			.finally(() => {
				this.detectInFlight = null;
			});
		this.detectInFlight = round;
		return round;
	}

	/**
	 * 立刻跑一轮(devtools「现在就跑」)。撞上在跑的那轮就**等它跑完再跑一轮**,不是跳过 ——
	 * 调用方多半是刚往 feed 里塞了东西才来的,而在跑的那轮拉 feed 在塞之前,跳过等于白塞。
	 * 回的 promise 在属于这次调用的那一轮结束时落定。
	 */
	detectNow(): Promise<void> {
		const current = this.detectInFlight;
		return current ? current.then(() => this.runDetectLocked()) : this.runDetectLocked();
	}

	private async detectDynamics(): Promise<void> {
		this.logger.debug("[detector] 开始获取动态信息");

		let content: AllDynamicResponse | undefined;
		try {
			content = (await this.api.fetchAllDynamic()) as AllDynamicResponse;
		} catch (e) {
			// Q3:per-tick 拉取失败,cron 下一 tick 自重试、系统继续 → warn 不冒充事故。
			this.logger.warn(`[api] 获取动态失败：${errorMessageOf(e)}`);
			return;
		}

		if (!content) return;

		if (content.code !== 0) {
			await this.handleApiError(content.code, content.message);
			return;
		}

		await this.announceRecovery();
		// 记在这里而不是入口:上面那两个 return(网络抛错 / 接口错误码)都不算抓到。
		this.lastSuccessfulFetchAt = Date.now();
		this.logger.debug("[detector] 成功获取动态信息，开始处理");

		// per-uid 记账:每条越过时间线闸的动态**恰好前移一次** —— 交出去的、翻译失败的、抓图/入口出错的、
		// 开播伪动态、名单外的,一律记它的 pub_ts。作品交出去就算(核心不替来源重放,留着不前移只会下一轮重交一遍)。
		// 回写时每个 uid 取 max(现值, 本轮记下的最大 pub_ts),绝不回退。
		const advanced = new Map<string, number>();
		const markAdvance = (u: string, ts: number) => {
			advanced.set(u, Math.max(advanced.get(u) ?? 0, ts));
		};

		for (const item of content.data.items) {
			if (!item) continue;

			const author = item.modules?.module_author;
			const uid = parseUid(author?.mid);
			if (!uid) {
				this.logger.debug(`[detector] 跳过无作者 UID 的动态，ID=${item.id_str ?? "unknown"}`);
				continue;
			}

			if (!this.dynamicTimelineManager.has(uid)) continue; // not subscribed

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

			if (!this.isDue(uid, postTime)) continue; // already pushed

			// 开播伪动态:开播由直播引擎推,动态这边不交作品(推进锚点就算处理完)。按类型认、放在翻译之前 ——
			// 翻译对它会抛。
			if (item.type === DYNAMIC_TYPE_LIVE_RCMD) {
				markAdvance(uid, postTime);
				continue;
			}

			// 这位 UP 关了动态推送(不在推送名单里):生产就到此为止 —— 不翻译、不抓图、不交。
			// 锚点仍要推进 —— 不推进的话每一轮都会把同一条重新判一遍。
			if (!this.dynamicSubManager.has(uid)) {
				markAdvance(uid, postTime);
				continue;
			}

			await this.produce(item, uid, postTime);
			markAdvance(uid, postTime);
		}

		// per-uid 锚点单调推进:取 max(现值, 本轮记下的最大 pub_ts),绝不回退。
		for (const [uid, latest] of advanced) {
			// applyOps 本轮退订过的 UID:锚点已被 delete 分支清掉,这里再 set 等于
			// 复活孤儿锚点,跳过(A7)。判据用锚点本身而不是推送订阅表 —— 后者不含
			// 「关了动态推送但仍订阅」的 UP,拿它判会让这些 UP 的锚点永不推进。
			if (!this.dynamicTimelineManager.has(uid)) {
				this.logger.debug(`[timeline] UID=${uid} 已退订，跳过时间线回写（不复活）`);
				continue;
			}
			const existing = this.dynamicTimelineManager.get(uid) ?? 0;
			if (latest <= existing) continue;
			this.dynamicTimelineManager.set(uid, latest);
			this.logger.debug(
				`[timeline] 更新时间线 UID=${uid} 时间=${DateTime.fromSeconds(latest).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);
		}

		this.logger.debug(`[detector] 本次处理了 ${advanced.size} 个 UP 的动态`);
	}

	/**
	 * 这条动态还轮得到处理吗:时间线锚点在,而且仍早于它的发布时间。循环开头(越过时间线闸)与抓图之后的重校共用这一个判据。
	 * 「订阅被删」锚点没了;「删了又加回来」锚点被重置成「现在」(晚于旧动态)—— 两种都不再是 true;
	 * 而 update / 名单整份重建 / 关了又开作品推送只换名单里的对象、不动锚点,仍是 true。
	 */
	private isDue(uid: string, postTime: number): boolean {
		const timeline = this.dynamicTimelineManager.get(uid);
		return timeline !== undefined && timeline < postTime;
	}

	/**
	 * 生产一条动态:翻成中立作品 → 覆写发布时间 → 抓图 → 重校还轮不轮得到它 → 交给核心入口。
	 * 任何一步出错只记 warn(翻译失败的动态重试也是同一个结果;入口抛了核心不替来源重放),调用方照常前移锚点。
	 */
	private async produce(item: Dynamic, uid: string, postTime: number): Promise<void> {
		// 翻译只做一次(ADR-0021 决策 43)。翻译是宽容的、不该抛;真抛了(接口出了没见过的残条)是这条动态本身没法判,
		// 重试也是同一个结果 —— 记一笔 warn 跳过,别让它卡住这位 UP、也别每一轮把同批更新的动态再处理一遍。
		let post: Post;
		try {
			post = postFromDynamic(item);
		} catch (e) {
			this.logger.warn(
				`[detector] 动态翻译失败,已跳过 UID=${uid} ID=${item.id_str ?? "?"}：${errorMessageOf(e)}`,
			);
			return;
		}
		try {
			// 发布时间用引擎自己算的:它有 pub_time 文字兜底(「3分钟前」「昨天 12:00」),翻译里只有 pub_ts,
			// 缺了落在纪元 —— 统计与卡上的时间都吃交出去的这一份(统计取 `post.publishedAt`)。
			post = { ...post, publishedAt: new Date(postTime * 1000).toISOString() };
			// 交出之前先把图抓好:核心出卡零网络。被过滤的、关了出图的动态也抓(代价主人知情)。
			// 转发的原作者头像与正文表情的地址只在原始动态里,与配图一起抓;外层作者的头像由核心出卡时按订阅资料补。
			const withImages = await fetchPostImages(
				post,
				{ images: this.imageFetcher, logger: this.logger },
				{ repostAvatarUrl: repostAvatarUrlOf(item), emojiUrls: emojiUrlsOf(item) },
			);
			// 抓图的 await 期间 applyOps 可能已退订该 UID,或「删了再加」成另一条订阅:引擎只交 uid,接线按身份
			// 现查订阅 —— 不重校的话旧动态会被推给新订阅。把进门时的两道闸再过一遍(名单里还有它、锚点还在且仍早于
			// 这条动态),不交,锚点由调用方照常前移。不用对象身份:update / 重建名单也会换对象,那样会把同一条订阅的动态丢掉。
			if (!this.dynamicSubManager.has(uid) || !this.isDue(uid, postTime)) {
				this.logger.debug(`[detector] UID=${uid} 在抓图途中已退订/被替换，这条动态不交`);
				return;
			}
			this.reportPost(uid, {
				postId: item.id_str,
				url: dynamicLink(item, item.type === "DYNAMIC_TYPE_AV", this.config.dynamicVideoUrlToBV),
				post: withImages,
			});
		} catch (e) {
			this.logger.warn(
				`[detector] 交出作品失败 UID=${uid} ID=${item.id_str ?? "?"}：${errorMessageOf(e)}`,
			);
		}
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
				// 已经收过 auth-lost 就闭嘴:上层那条「账号登录已失效,请到控制台重新
				// 扫码登录」既先到又更有用,这里再报一句只是同一件事的第二次通知。
				// 详见 `authLost` 字段说明 —— 没有 auth-lost 的 -101 仍必须报。
				if (!this.authLost)
					this.bus.emit("engine-error", { source: LOG_TAG, message: "账号未登录" });
				this.authLost = true;
				// 上面只停了 job,挂着的退避重启还得作废 —— 见 suspendDetector。
				this.suspendDetector();
				// auth-loss 是与风控不同的独立 episode,会停 cron 待 auth-restored。
				// 清掉风控边沿:恢复后若再遇 -352 是全新 episode,必须重新告警
				// (否则跨 auth-loss 的新风控会被陈旧 flag 静默 —— 审计发现的缺口)。
				this.riskControlled = false;
				// 瞬时错误边沿同理清掉。登录恢复后的第一次成功拉取属于 auth-restored
				// 那条线(上层自己会通知),不该由这里拿着跨 episode 的陈旧错误码报喜。
				this.transientErrorCode = null;
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
					await this.tellMaster("账号被风控，请使用 `bili cap` 指令解除风控");
					this.bus.emit("engine-error", { source: LOG_TAG, message: "账号被风控" });
				} else {
					this.logger.debug("[api] 仍处于风控态，退避后继续重探(不重复告警)");
				}
				this.scheduleDetectorRestart("风控");
				break;
			}
			default: {
				// 瞬时错误(-509 限流 / 瞬时 -403 / 未知码):不可永久停 cron。
				// 退避后自动重试,瞬时抖动自愈,无需人工重启进程 → Q3 warn 不冒充事故。
				// 边沿去重同 -352:同一个码连续失败只告警一次,换了码才当新故障重报。
				if (this.transientErrorCode !== code) {
					this.transientErrorCode = code;
					this.logger.warn(`[api] 获取动态信息失败，错误码：${code}，${message}，将退避后自动重试`);
					await this.tellMaster(`获取动态信息失败，错误码：${code}`);
					this.bus.emit("engine-error", {
						source: LOG_TAG,
						message: `获取动态失败，错误码：${code}`,
					});
				} else {
					this.logger.debug(`[api] 仍是错误码 ${code}，退避后继续重试(不重复告警)`);
				}
				this.scheduleDetectorRestart(`错误码 ${code}`);
			}
		}
	}

	/**
	 * 私聊通知主人,发不出去只记一句 warn。
	 *
	 * 调用方全在关键控制流上:告警之后还要 `scheduleDetectorRestart` 排退避重启,
	 * 报喜之后还要接着处理这一轮的动态。裸 `await` 的话,私聊通道自己坏掉(master
	 * 不可达 / 适配器抛错)就会把后面的活儿一起带走 —— 尤其告警那条,`handleApiError`
	 * 开头已经 stop 了 job,退避重启再排不上,动态检测就**再也不会自己起来**了。
	 */
	private async tellMaster(text: string): Promise<void> {
		try {
			await this.push.sendPrivateMsg(text);
		} catch (e) {
			this.logger.warn(`[push] 通知主人失败：${errorMessageOf(e)}`);
		}
	}

	/**
	 * 成功拉取后的「好了」通知 —— 只在此前真的报过故障时说一次。
	 *
	 * 报错走私聊,恢复也得走私聊。否则主人手里只剩一条报错:退避重启、任务已启动
	 * 这些都只进日志,IM 里再无下文,分不清是自愈了还是还坏着只是不再吭声。
	 *
	 * 说的时机是**这一次真的拉成功了**,不是「重启了检测任务」—— 重启只是把 cron
	 * 挂回去,故障还在的话下一轮照样失败,那会儿报喜就是骗人。
	 *
	 * 只私聊、不发 `engine-error`:那个事件在独立端会点亮 AlertShell 的红色告警面板,
	 * 拿它报喜语义是反的。
	 */
	private async announceRecovery(): Promise<void> {
		const parts: string[] = [];
		if (this.riskControlled) parts.push("风控已解除");
		if (this.transientErrorCode !== null) parts.push(`此前错误码：${this.transientErrorCode}`);
		if (parts.length === 0) return;
		this.riskControlled = false;
		this.transientErrorCode = null;
		const detail = parts.join("，");
		this.logger.info(`[api] ${detail}，动态检测恢复正常`);
		await this.tellMaster(`动态检测已恢复正常（${detail}）`);
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
