import type {
	Disposable,
	Failure,
	Logger,
	Post,
	PostReport,
	Result,
	ServiceContext,
	SourceAuth,
	SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { CronJob } from "cron";
import { DateTime } from "luxon";
import { errorMessageOf } from "../../util/error-message.js";
import type { Api } from "../api/index.js";
import { fetchPostImages, type ImagesDeps, runLimited } from "../images";
import { watchLoginEdges } from "../login-edges.js";
import type { ProblemLayers } from "../problem-layers";
import { PROBLEM_TEXTS } from "../problem-texts";
import { emojiUrlsOf, postFromDynamic, repostAvatarUrlOf } from "./post-from-dynamic";
import type { AllDynamicResponse, Dynamic, DynamicAnchors } from "./types";

/**
 * 风控/瞬时错误停 cron 后的退避重启间隔。原实现:任何非鉴权错误(限流 -509 等
 * 风控类、瞬时 -403、未知码)都永久 stop cron 且登录恢复不会触发重启
 * → 动态轮询永久静默直到重启进程。退避后自动重探,瞬时错误/风控解除
 * 后即自愈,无需人工重启进程。
 */
const DETECTOR_RESTART_BACKOFF_MS = 5 * 60_000;

/** 动态这一路在上报器里的路名(风控按路记)。 */
const RISK_PATH = "dynamic";
/** 拉动态撞上风控以外的错误码时报给问题表的 code。 */
const FETCH_FAILED_CODE = "dynamic_fetch_failed";

/**
 * 一轮里同时在生产的创作者链不超过这么多条。要有上限:每条作品内部已经最多同时抓 3 张图
 * (`FETCH_CONCURRENCY`),链数不设限的话叠起来会把对图床的并发无限放大。
 */
const POST_PRODUCE_CONCURRENCY = 4;

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

/**
 * B 站给的不带时区的发布时间文字(`pub_time`)是北京时间;按进程本地时区读会在海外机器上错位。这里的 `UTC+8` 是 B 站数据格式,不跟全局时区设置。
 */
function parsePubTimeFallback(
	raw: unknown,
	now = DateTime.now().setZone("UTC+8"),
): number | undefined {
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
		let dt = DateTime.fromFormat(normalized, fmt, { zone: "UTC+8" });
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
 * Runtime configuration for {@link DynamicPoller}. The standalone runtime fills it
 * from its config store. The `logLevel` field is intentionally dropped — the host
 * sets logger level externally via {@link ServiceContext}.
 *
 * 动态轮询只管生产:轮询节奏与视频链接怎么写是它自己的两样;模板 / 图集 / 出图 / AI / 过滤那些都是核心装配的事
 * (`posts/deliver-post.ts` 的 `PostSettings`,每条作品现折),不再经动态轮询。
 */
export interface DynamicPollerSettings {
	timezone: string;
	/** 轮询动态的 cron 表达式。 */
	dynamicCron: string;
	/** 视频动态时是否将 URL 替换为 BV 号。 */
	dynamicVideoUrlToBV: boolean;
}

export interface DynamicPollerOptions {
	logger: Logger;
	/** 可回收的定时器(退避重启用);公共上下文里没有定时器。 */
	setTimeout: ServiceContext["setTimeout"];
	auth: Pick<SourceAuth, "state" | "onChange">;
	api: Api;
	/**
	 * 分层上报器(`bilibili/problem-layers.ts`):拉动态撞风控、别的错误码都经它报给问题表,拉成功与停下时清。
	 * 它的方法都不往外抛,所以调用点不必再包 try。
	 */
	problems: Pick<ProblemLayers, "reportRisk" | "resolveRisk" | "reportFailure" | "resolveFailure">;
	/**
	 * 抓图口(来源上下文给的 `ctx.fetchImage`,走 B 站集成自己的请求客户端):**交出作品之前**把作品里只有地址的图抓进图库
	 * (被过滤的、关了出图的动态也抓,代价主人知情)。必给 —— 漏给是编译不过,不是悄悄不出图。
	 */
	fetchImage: ImagesDeps["images"]["fetchImage"];
	/**
	 * 把一条作品交给核心的作品入口(`PostQueue`)。**没有返回值**:交完就算,不等装配、不看结果,意外抛错由核心入口自己接住;
	 * 动态轮询只负责在交出后把时间线前移。签名就是订阅源上下文里 `ctx.reportPost` 的签名:来源只说「谁(外部 id)发了什么」,
	 * 订阅由宿主按身份查。必给。
	 */
	reportPost: (externalId: string, report: PostReport) => void;
	settings: DynamicPollerSettings;
	/** 名单,现读(签名就是来源上下文的 `ctx.subscriptions`)。 */
	subscriptions: () => readonly SourceSubscriptionView[];
}

/**
 * 链接部件的内容(不含任何前缀文案)。视频给视频页(或按设置换成 BV 号,取不到 BV 就没有链接),
 * 别的给动态页。卡片页预览(`bilibili/preview.ts`)也用它。
 */
export function dynamicLink(item: Dynamic, isVideo: boolean, videoUrlToBV: boolean): string {
	if (!isVideo) return `https://t.bilibili.com/${item.id_str}`;
	const jumpUrl = item.modules.module_dynamic.major?.archive?.jump_url ?? "";
	if (!videoUrlToBV) return `https:${jumpUrl}`;
	const bvMatch = jumpUrl.match(/BV[0-9A-Za-z]+/);
	return bvMatch ? bvMatch[0] : "";
}

/**
 * 平台中立的动态轮询与生产核心。
 *
 * - 不依赖任何宿主框架;宿主(B 站来源,`bilibili/source.ts`)提供 logger / setTimeout / 登录口 / 分层上报器 /
 *   reportPost / 名单(`subscriptions`)。名单是动态轮询唯一的订阅输入:启停与「名单可能变了」都由来源调进来。
 * - 只管生产:拉 feed、判新、翻成中立作品、抓图、交给核心入口。怎么消费(过滤、出卡、点评、推送、图集)不归它。
 */
export class DynamicPoller {
	private readonly setTimeout: ServiceContext["setTimeout"];
	private readonly auth: Pick<SourceAuth, "state" | "onChange">;
	private readonly api: Api;
	private readonly problems: DynamicPollerOptions["problems"];
	private readonly fetchImage: ImagesDeps["images"]["fetchImage"];
	private readonly reportPost: (externalId: string, report: PostReport) => void;
	private readonly logger: Logger;
	private readonly subscriptions: () => readonly SourceSubscriptionView[];

	private settings: DynamicPollerSettings;
	private dynamicJob?: CronJob;
	/** 风控/瞬时错误后的一次性退避重启句柄;非 undefined 表示已排程,不叠加。 */
	private detectorRestartTimer?: Disposable;
	/**
	 * -352 风控态边沿标记,**只管日志等级**(上报每次撞都叫,幂等)。进入风控记一次 error;退避重探仍
	 * 风控 → debug;成功拉取(code 0)→ info 一次并清除。避免在退避重试热路径反复刷 error(Q1)。
	 */
	private riskControlled = false;
	/**
	 * 瞬时错误(瞬时 -403 / 4101132 之类未知码 / 回应形状不对)的边沿标记,存着当前故障的错误码(字符串),**只管日志等级**
	 * (上报每次失败都叫)。作用与 {@link riskControlled} 对称:同一个码连续失败只记一次 warn,换了码当新故障
	 * 再记;成功拉取时靠它判断「此前真的坏过」,记一行 info。
	 */
	private transientErrorCode: string | null = null;
	/**
	 * 登录已失效,等登录恢复。**不许重启 cron** —— 与 `detectorRestartTimer` 并列成为 `reconcileJob` 的门。
	 * 少了它,登录失效停掉 cron 之后随便一次订阅增删就会把它重新建起来,再去撞一次 -101。
	 * (要不要告诉主人登录失效由宿主看登录状态报,不看这个标记。)
	 */
	private authLost = false;
	/**
	 * 检测器的代:每次拆掉检测器(`stop()` / `suspendDetector()` / `restartDetector()`)就 +1。
	 * 在途的那一轮开跑时记下当时的代,每个 await 之后再比一次 —— 变了说明这一轮的结果已经不算数:
	 * 不处理错误、不排退避重启、不交作品。拆锁(`releaseDetectLock`)只能让下一轮进来,管不住在途那一轮。
	 */
	private detectorGeneration = 0;
	/** 这一路还在跑(生命周期内)。`start` 置位、`stop` 复位;起 cron 前必须过这道门。 */
	private running = false;
	/**
	 * 推送名单兼锚点表:作品开关开着的 uid → 「看到哪一刻为止」(秒)。**只有这一张表**:在表里才为它翻译、抓图、交作品;
	 * 进表那一刻锚点 = 现在,离开(退订、停用、关作品开关、全局作品开关关掉)就删。
	 *
	 * 为什么不再另留一张「覆盖每个订阅」的锚点表(主人定,已定 18):那样关着作品开关的人锚点照常前移还是冻结,取决于
	 * cron 停没停 —— 名单里没别人开着作品时 cron 停、锚点冻结,再打开会把关着期间的动态全补推;有别人开着时 cron 不停、
	 * 锚点前移,再打开就不补。同一个操作两种结果,看不出规律。现在一律:关了再开不补推关着期间的动态。
	 */
	private postAnchors: DynamicAnchors = new Map();
	/**
	 * 上次**成功**拉到动态列表的时刻。`undefined` = 起来以后一次都没成功过。
	 *
	 * 只记成功、不记尝试:独立端的 `/status` 拿它回答「还在跑吗」,而连着失败三小时
	 * 的系统若报「1 分钟前抓过」,这一项就从答案变成了骗局 —— 那恰好是主人掏出手机
	 * 问状态的场合。
	 */
	private lastSuccessfulFetchAt?: number;
	private authWatch?: Disposable;

	constructor(opts: DynamicPollerOptions) {
		this.logger = opts.logger;
		this.setTimeout = opts.setTimeout;
		this.auth = opts.auth;
		this.api = opts.api;
		this.problems = opts.problems;
		this.fetchImage = opts.fetchImage;
		this.reportPost = opts.reportPost;
		this.settings = opts.settings;
		this.subscriptions = opts.subscriptions;
	}

	/** 启动钩子。由来源的 `start` 调;名单现读,启动时就能开跑。 */
	start(): void {
		this.postAnchors = new Map();
		this.running = true;

		this.logger.info("[start] 动态轮询启动，立即启动检测");
		this.restartDetector();

		// 名单变动由来源经 `syncSubscriptions()` 通知;动态轮询自己只在登录恢复时重建检测器。
		this.authWatch = watchLoginEdges(this.auth, {
			onRestored: () => {
				this.authLost = false;
				// 前缀与登录失效那条、以及直播引擎的同一对日志统一成 [auth]:
				// 这是登录生命周期事件,不是检测器自己的事。
				this.logger.info("[auth] 账号登录已恢复，正在重启动态检测");
				this.restartDetector();
			},

			// 与直播引擎的掉线 → `teardown()` 对称。此前动态这边没接,cron 照跑到
			// 下一轮自己撞上 -101 —— 主人于是先收到一条「账号登录已失效」,过一会儿又收到
			// 一条听着像新故障的「账号未登录」,而那一轮请求本来就注定失败。
			onLost: () => {
				this.authLost = true;
				this.suspendDetector();
				this.logger.warn("[auth] 账号登录已失效，动态检测已暂停（登录恢复后重启）");
			},
		});
	}

	/** 停止钩子。停止 cron、释放事件订阅。 */
	stop(): void {
		// 在途那一轮就此作废:它的错误与作品都不再算数(见 detectorGeneration)。
		this.running = false;
		this.detectorGeneration++;
		// 全停 = lifecycle 结束;下次 start 是全新 episode,风控边沿复位重新武装。
		// (不在 restartDetector 复位 —— -352 自身退避重启也走那里,复位会
		// 破坏边沿、每退避周期重刷 error,正是 Q7 要消除的。)
		this.riskControlled = false;
		// 同理:登录失效的抑制标记也只在一个 lifecycle 内有效。
		this.authLost = false;
		// 瞬时错误边沿同理 —— 留着的话下次 start 后第一次成功拉取会报一句
		// 上个 lifecycle 的「已恢复」。
		this.transientErrorCode = null;
		// 这一路不再跑了:问题表里属于它的风控与请求失败不再适用。
		this.dropProblems();
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
			this.logger.info("[stop] 动态检测任务已停止");
		}
		this.releaseDetectLock();
		// 表清空:关停那一刻还在抓图的那条动态过不了交出前的重校,不会在停下之后再上报。
		this.postAnchors = new Map();
		this.authWatch?.dispose();
		this.authWatch = undefined;
	}

	/**
	 * 替换运行时配置(宿主在 dashboard 编辑后调用)。
	 * `dynamicCron` 变化时会自动停掉旧 CronJob 并按新表达式重新 schedule —— 否则
	 * 配置已经写进 this.settings,但 node-cron 句柄还在跑旧节奏,纯粹的字段更新
	 * 是看不见的 bug。
	 */
	updateSettings(settings: DynamicPollerSettings): void {
		const cronChanged =
			this.settings.dynamicCron !== settings.dynamicCron ||
			this.settings.timezone !== settings.timezone;
		this.settings = settings;
		if (cronChanged && this.dynamicJob) {
			this.logger.info(
				`[detector] schedule changed: cron="${settings.dynamicCron}" timezone="${settings.timezone}"`,
			);
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
			if (this.postAnchors.size > 0) this.startJob();
		} else if (cronChanged) {
			// 没有 job:要么没名单,要么上一个 cron 写坏了起不来。走 reconcileJob 补一次,
			// 它自带「退避窗口内不提前起」「登录失效不起」两道门。
			this.reconcileJob();
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

	/**
	 * 重启动态检测:作废退避计时、停旧 job、按名单对一遍锚点表、表非空才起新 job。
	 * 只留给 `start`、登录恢复、退避到点三处 —— 名单一动走 {@link syncSubscriptions},别重启 cron(会打乱相位)。
	 */
	private restartDetector(): void {
		// 旧检测器在途的那一轮就此作废:新检测器会重新拉一遍,旧结果再交就算重复。
		this.detectorGeneration++;
		// 一次显式启动取代任何待执行的退避重启,避免双重启动。
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		// Stop existing job first
		if (this.dynamicJob) {
			this.logger.info("[detector] 停止旧的动态检测任务");
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
		}

		this.applyRoster();

		if (this.postAnchors.size === 0) {
			this.logger.info("[detector] 没有需要动态检测的订阅对象");
			// 这一路不再跑了,不会再有「下一次结果」:它报的风控与拉取失败不再适用,不清的话永远挂着
			this.dropProblems();
			return;
		}
		this.logger.debug(`[detector] 动态检测 UID 列表：${[...this.postAnchors.keys()].join(", ")}`);
		this.startJob();
	}

	/**
	 * 把锚点表照名单对一遍(名单现读):名单里作品开关开着的人进表(锚点 = 此刻),不在了的(退订、停用、关作品开关、
	 * 全局作品开关关掉)删掉。已在表里的人锚点不动。离开就删,是为了再进来时从「现在」起算 —— 留着旧锚点,
	 * 关着期间发的动态会在重新打开时被补推出来。
	 * 回这次进、出表的人数。
	 */
	private applyRoster(): { opened: number; removed: number } {
		const next = new Set<string>();
		for (const sub of this.subscriptions()) {
			if (sub.features.has("post")) next.add(sub.externalId);
		}
		let opened = 0;
		let removed = 0;
		for (const uid of [...this.postAnchors.keys()]) {
			if (next.has(uid)) continue;
			this.postAnchors.delete(uid);
			removed++;
			this.logger.debug(`[detector] 清理已移除 UID：${uid} 的时间戳`);
		}
		for (const uid of next) {
			if (this.postAnchors.has(uid)) continue;
			this.postAnchors.set(uid, Math.floor(DateTime.now().toSeconds()));
			opened++;
			this.logger.debug(`[detector] 初始化 UID：${uid} 时间戳`);
		}
		return { opened, removed };
	}

	/**
	 * 名单可能变了(来源收到「名单可能变了」就叫它):重新对一遍,有人进出推送名单才记汇总并校一次 cron,
	 * 没有进出什么都不做。**不重启 cron** —— 只走 `reconcileJob`(认退避窗口与 `authLost` 两道门)。
	 */
	syncSubscriptions(): void {
		const { opened, removed } = this.applyRoster();
		if (opened === 0 && removed === 0) return;
		// per-UID 进出不逐条记 info(批量变更不刷屏),这里收口一条汇总。
		this.logger.info(
			`[roster] 动态订阅变更已应用：+${opened} 开启 / -${removed} 移除（当前 ${this.postAnchors.size} 个动态订阅）`,
		);
		this.reconcileJob();
	}

	/**
	 * `dynamicCron` 是 dashboard 里的自由文本框,没有格式校验;`new CronJob` 对无法
	 * 解析的表达式同步抛错(如 "Field (minute) cannot be parsed"),此前未捕获会
	 * 让整个独立端进程在启动期崩溃退出,且不写 pino 日志(catch 在更外层的
	 * `console.error` 才第一次留痕)——用户报告的"升级后后端起不来,清空数据才恢复"
	 * 即此:坏值持久化进 globals.json 后,后续每次启动都复现同一次崩溃。捕获后
	 * 仅跳过本次建 job(动态检测保持关闭态),不放倒整个动态轮询/进程。
	 */
	private startJob(): void {
		// 起 cron 的唯一一道门:这一路已经停了,或者登录失效等着恢复,都不起。
		// reconcileJob / 退避到点 / updateSettings 三条路都从这里过。
		if (!this.running || this.authLost) return;
		let job: CronJob;
		try {
			job = new CronJob(
				this.settings.dynamicCron,
				() => void this.runDetectLocked(),
				null,
				false,
				this.settings.timezone,
			);
		} catch (err) {
			this.logger.error(
				`[detector] dynamicCron="${this.settings.dynamicCron}" 无法解析,动态检测未启动：${errorMessageOf(err)}`,
			);
			// 起不来也是「这一路不再跑了」:之前报的风控 / 拉取失败不会再有下一次结果去清它
			this.dropProblems();
			return;
		}
		this.dynamicJob = job;
		this.dynamicJob.start();
		this.logger.info("[detector] 动态检测任务已启动");
	}

	/**
	 * 登录失效时停掉检测循环,但**保留事件订阅** —— 与 `stop()` 的区别就在这:
	 * 这里还等着登录恢复把它拉起来。
	 *
	 * 挂着的退避重启必须一并作废:`scheduleDetectorRestart` 到点是直接调
	 * `restartDetector`,绕过 `reconcileJob` —— 上一轮 -352 排下的计时会在五分钟后
	 * 把 cron 重新建起来,拿一个已经死掉的会话再去撞一次。这里连同在途那一轮一起
	 * 作废(代 +1),它落定之后也排不出新的退避;起 cron 那一道门在 `startJob`。
	 *
	 * 面向运维的那条日志由调用方打(登录失效是 warn,-101 是 error),这里不重复。
	 */
	private suspendDetector(): void {
		// 挂着的退避重启与在途那一轮一起作废:它们到点 / 落定时都不许再把 cron 拉起来。
		this.detectorGeneration++;
		this.detectorRestartTimer?.dispose();
		this.detectorRestartTimer = undefined;
		if (this.dynamicJob) {
			this.dynamicJob.stop();
			this.dynamicJob = undefined;
		}
		this.releaseDetectLock();
	}

	private reconcileJob(): void {
		if (this.postAnchors.size === 0) {
			if (this.dynamicJob?.isActive) {
				this.dynamicJob.stop();
				this.dynamicJob = undefined;
				this.logger.info("[detector] 订阅清空，动态检测任务已停止");
			}
			// 名单空了,这一路不再跑:撞过风控 / 拉取失败而 job 已停着的(退避中)也要清,见 restartDetector
			this.dropProblems();
		} else if (!this.dynamicJob?.isActive && !this.detectorRestartTimer) {
			// detectorRestartTimer 非空 = 正处于 -352/瞬时错误的退避窗口。提前 startJob
			// 会去戳仍在风控的端点,击穿退避(退避的全部意义就是不放大风控)。到点后
			// scheduleDetectorRestart 的回调会用最新快照重启,订阅变更不会丢。
			// 「登录失效别起」「已经停了别起」两道门收在 startJob 自己身上,所有起 cron 的路共用。
			this.logger.debug(`[detector] 动态检测 UID 列表：${[...this.postAnchors.keys()].join(", ")}`);
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

	/** 这一轮的代已经变了(拆过检测器):结果不算数,记一行 debug 丢掉。 */
	private discardStaleRound(): void {
		this.logger.debug("[detector] 检测器已停止或重启，本轮结果作废");
	}

	/**
	 * 带锁跑一轮。同一时刻只有一轮在跑(此前是 `withLock`,换成握着 promise 是为了让
	 * `detectNow` 等得到这一轮结束)。异常记日志、锁必释放 —— 锁卡死的症状是 cron tick
	 * 全部静默丢弃,动态从此不再推。
	 */
	private runDetectLocked(): Promise<void> {
		if (this.detectInFlight) return this.detectInFlight;
		let round: Promise<void>;
		round = this.detectDynamics()
			.catch((err: unknown) => {
				this.logger.error(`[detector] 动态检测执行异常：${errorMessageOf(err)}`);
			})
			.finally(() => {
				// 只在锁仍然是这一轮时才清:拆过检测器又起了新一轮的话,旧一轮落定不能把新锁清掉,
				// 否则下一个 tick 就会和在新一轮并跑,可能重复交同一条动态。
				if (this.detectInFlight === round) this.detectInFlight = null;
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
		const generation = this.detectorGeneration;
		this.logger.debug("[detector] 开始获取动态信息");

		let content: Result<{ data: AllDynamicResponse["data"] }>;
		try {
			content = await this.api.fetchAllDynamic();
		} catch (e) {
			if (this.detectorGeneration !== generation) {
				this.discardStaleRound();
				return;
			}
			// Q3:per-tick 拉取失败,cron 下一 tick 自重试、系统继续 → warn 不冒充事故。
			this.logger.warn(`[api] 获取动态失败：${errorMessageOf(e)}`);
			return;
		}

		if (this.detectorGeneration !== generation) {
			this.discardStaleRound();
			return;
		}

		if (!content.ok) {
			this.handleApiError(content);
			return;
		}

		this.noteFetchSucceeded();
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

		// 过了闸、等着生产的动态,按创作者分组(Map 保持各位第一次出现的次序,组内保持动态流的次序)。
		const pending = new Map<string, Array<{ item: Dynamic; postTime: number }>>();

		for (const item of content.data.items) {
			if (!item) continue;

			const author = item.modules?.module_author;
			const uid = parseUid(author?.mid);
			if (!uid) {
				this.logger.debug(`[detector] 跳过无作者 UID 的动态，ID=${item.id_str ?? "unknown"}`);
				continue;
			}

			if (!this.postAnchors.has(uid)) continue; // 不在要推的人里(没订阅 / 停用 / 作品开关关着)

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

			const group = pending.get(uid);
			if (group) group.push({ item, postTime });
			else pending.set(uid, [{ item, postTime }]);
		}

		// 一位创作者的图抓得慢,不该堵住别人:组内照旧一条接一条(交出的先后与动态流一致),组与组之间同时跑(有上限)。
		// 一轮仍是所有链都跑完才算结束、锚点在这之后才回写。`produce` 自己不抛;这里再兜一层,
		// 免得意外的拒绝把整轮拖垮 —— 出错那条照样前移(恰好一次)。
		await runLimited(
			[...pending].map(([uid, entries]) => async () => {
				for (const { item, postTime } of entries) {
					try {
						await this.produce(item, uid, postTime, generation);
					} catch (e) {
						this.logger.error(
							`[detector] 生产动态时意外出错 UID=${uid} ID=${item.id_str ?? "?"}：${errorMessageOf(e)}`,
						);
					}
					markAdvance(uid, postTime);
				}
			}),
			POST_PRODUCE_CONCURRENCY,
		);

		// per-uid 锚点单调推进:取 max(现值, 本轮记下的最大 pub_ts),绝不回退。
		for (const [uid, latest] of advanced) {
			// 本轮抓图途中名单对过、已经不在表里的 UID(退订、停用、关作品开关):锚点已被清掉,这里再 set 等于
			// 复活孤儿锚点,跳过(A7)。
			if (!this.postAnchors.has(uid)) {
				this.logger.debug(`[timeline] UID=${uid} 已退订，跳过时间线回写（不复活）`);
				continue;
			}
			const existing = this.postAnchors.get(uid) ?? 0;
			if (latest <= existing) continue;
			this.postAnchors.set(uid, latest);
			this.logger.debug(
				`[timeline] 更新时间线 UID=${uid} 时间=${DateTime.fromSeconds(latest).toFormat("yyyy-MM-dd HH:mm:ss")}`,
			);
		}

		this.logger.debug(`[detector] 本次处理了 ${advanced.size} 个 UP 的动态`);
	}

	/**
	 * 这条动态还轮得到处理吗:这个人在表里(锚点在),而且锚点仍早于它的发布时间。循环开头(越过时间线闸)与抓图之后的重校共用这一个判据。
	 * 退订、停用、关作品开关:锚点没了;删了 / 停用 / 关了开关后又加回来:锚点被重置成「现在」(晚于旧动态)—— 都不再是 true。
	 */
	private isDue(uid: string, postTime: number): boolean {
		const timeline = this.postAnchors.get(uid);
		return timeline !== undefined && timeline < postTime;
	}

	/**
	 * 生产一条动态:翻成中立作品 → 覆写发布时间 → 抓图 → 重校还轮不轮得到它 → 交给核心入口。
	 * 任何一步出错只记 warn(翻译失败的动态重试也是同一个结果;入口抛了核心不替来源重放),调用方照常前移锚点。
	 */
	private async produce(
		item: Dynamic,
		uid: string,
		postTime: number,
		generation: number,
	): Promise<void> {
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
			// 发布时间用动态轮询自己算的:它有 pub_time 文字兜底(「3分钟前」「昨天 12:00」),翻译里只有 pub_ts,
			// 缺了落在纪元 —— 统计与卡上的时间都吃交出去的这一份(统计取 `post.publishedAt`)。
			post = { ...post, publishedAt: new Date(postTime * 1000).toISOString() };
			// 交出之前先把图抓好:核心出卡零网络。被过滤的、关了出图的动态也抓(代价主人知情)。
			// 转发的原作者头像与正文表情的地址只在原始动态里,与配图一起抓;外层作者的头像由核心出卡时按订阅资料补。
			const withImages = await fetchPostImages(
				post,
				{ images: { fetchImage: this.fetchImage }, logger: this.logger },
				{ repostAvatarUrl: repostAvatarUrlOf(item), emojiUrls: emojiUrlsOf(item) },
			);
			// 抓图的 await 期间名单可能已去掉该 UID(退订、停用、关作品开关、停下),或「删了再加」成另一条订阅:动态轮询只交 uid,
			// 接线按身份现查订阅 —— 不重校的话旧动态会被推给新订阅。把进门时的闸再过一遍(锚点还在且仍早于这条动态),
			// 不交,锚点由调用方照常前移。不用对象身份:update / 重建名单也会换对象,那样会把同一条订阅的动态丢掉。
			// 抓图那几个 await 期间检测器可能已经被拆掉(停下 / 登录失效 / 重启):旧一轮的结果不再算数。
			if (this.detectorGeneration !== generation) {
				this.logger.debug(`[detector] 检测器已停止或重启，放弃交出 UID=${uid} 的这条动态`);
				return;
			}
			if (!this.isDue(uid, postTime)) {
				this.logger.debug(`[detector] UID=${uid} 在抓图途中已退订/被替换，这条动态不交`);
				return;
			}
			this.reportPost(uid, {
				postId: item.id_str,
				url: dynamicLink(item, item.type === "DYNAMIC_TYPE_AV", this.settings.dynamicVideoUrlToBV),
				post: withImages,
			});
		} catch (e) {
			this.logger.warn(
				`[detector] 交出作品失败 UID=${uid} ID=${item.id_str ?? "?"}：${errorMessageOf(e)}`,
			);
		}
	}

	/**
	 * 拉动态失败的善后。请求层已经把 B 站的数字码翻成标准码(`bilibili/error-codes.ts`):
	 * `unauthorized` 是真鉴权失效,`rate_limited`(-352 / -412 / -799 / -509)是风控,其余
	 * (表外码、回应形状不对)当一时的请求失败。
	 */
	private handleApiError(failure: Failure): void {
		const { code, message } = failure;
		// 日志与问题句里给人看的错误码:B 站的数字码;回应形状不对这类没有数字码的,退回标准码。
		const errorCode = failure.upstreamCode ?? code;
		// Stop dynamic detector first
		this.dynamicJob?.stop();
		this.dynamicJob = undefined;
		switch (code) {
			case "unauthorized": {
				// 真鉴权失效:停 cron,靠登录恢复重启(不退避盲重试 ——
				// 对死会话每 5 分钟刷一次毫无意义且放大风控)。登录失效由请求层的拦截器
				// 报给登录流。要不要告诉主人登录失效,由宿主看登录状态决定,
				// 这里不再发告警。
				this.logger.error("[api] 账号未登录，动态检测已停止（登录恢复后重启）");
				this.authLost = true;
				// -101 既不是风控拦截、也换了一种性质的失败:这一路之前报过的风控与请求失败不再适用
				// (不是风控解除,不对主人说「风控已解除」)。通常登录一失效未登录层就已经把它们抹了,
				// 这里兜住「-101 到了而登录状态没跟着变」。
				this.dropProblems();
				// 上面只停了 job,挂着的退避重启还得作废 —— 见 suspendDetector。
				this.suspendDetector();
				// 登录失效是与风控不同的独立 episode,会停 cron 待登录恢复。
				// 清掉风控边沿:恢复后若再遇 -352 是全新 episode,必须重新告警
				// (否则跨 auth-loss 的新风控会被陈旧 flag 静默 —— 审计发现的缺口)。
				this.riskControlled = false;
				// 瞬时错误边沿同理清掉。登录恢复后的第一次成功拉取属于登录恢复
				// 那条线(上层自己会通知),不该由这里拿着跨 episode 的陈旧错误码报喜。
				this.transientErrorCode = null;
				break;
			}
			case "rate_limited": {
				// 风控:**非永久**。解除风控不会发任何事件,此前 cron
				// 永久静默直到重启进程。退避后自动重探,解除即自愈。
				// Q7 边沿(只管日志):进入风控记一次 error;退避重探仍风控 → debug;成功拉取 → info 清除。
				// 上报每次撞都叫(幂等):高层清掉后低层不会自己冒回来,要靠下一次撞见再报。
				if (this.watching()) {
					this.problems.reportRisk(RISK_PATH, {
						notify: PROBLEM_TEXTS.riskControlled.notify.dynamic,
					});
				}
				if (!this.riskControlled) {
					this.riskControlled = true;
					this.logger.error("[api] 账号被风控，动态检测暂停，将退避后自动重试");
				} else {
					this.logger.debug("[api] 仍处于风控态，退避后继续重探(不重复告警)");
				}
				this.scheduleDetectorRestart("风控");
				break;
			}
			default: {
				// 瞬时错误(-403 / 未知码 / 回应形状不对):不可永久停 cron。
				// 退避后自动重试,瞬时抖动自愈,无需人工重启进程 → Q3 warn 不冒充事故。
				// 这一次的结果不是风控拦截:这一路的风控(如果挂着)清掉。但动态其实仍在失败,不是解除,
				// 不对主人说「风控已解除」(`notify: false`)。每次失败都报(幂等),
				// 边沿去重只管日志:同一个码连续失败只记一次 warn,换了码才当新故障再记。
				this.problems.resolveRisk(RISK_PATH, { notify: false });
				if (this.watching()) {
					this.problems.reportFailure({
						code: FETCH_FAILED_CODE,
						message: () => PROBLEM_TEXTS.dynamicFetchFailed.text(errorCode),
						notify: PROBLEM_TEXTS.dynamicFetchFailed.notify,
						// 每个退避周期都会再撞一次、再报一次:高层开着时不必存
						lasting: false,
					});
				}
				const errorKey = String(errorCode);
				if (this.transientErrorCode !== errorKey) {
					this.transientErrorCode = errorKey;
					this.logger.warn(
						`[api] 获取动态信息失败，错误码：${errorKey}，${message}，将退避后自动重试`,
					);
				} else {
					this.logger.debug(`[api] 仍是错误码 ${errorKey}，退避后继续重试(不重复告警)`);
				}
				this.scheduleDetectorRestart(`错误码 ${errorKey}`);
			}
		}
	}

	/**
	 * 这一路还在跑吗:名单里有人要盯。名单空了(退订光了、停下了)之后才回来的那一轮(在途时名单被清空)
	 * 带回的失败不再上报 —— 该清的已经清过,这时再报就没有「下一次结果」去清它,风控要一直挂到退避到点。
	 */
	private watching(): boolean {
		return this.postAnchors.size > 0;
	}

	/**
	 * 这一路不再跑了(停下、名单空了、起不来、登录失效):它报的风控与拉取失败**不再适用**,不是解除 ——
	 * 都用 `notify: false` 清,不对主人说「风控已解除」「已恢复」。
	 */
	private dropProblems(): void {
		this.problems.resolveRisk(RISK_PATH, { notify: false });
		this.problems.resolveFailure({ code: FETCH_FAILED_CODE }, { notify: false });
	}

	/**
	 * 一次真正拉成功了:这一路的风控与请求失败清掉(问题表据此补「已恢复」),并复位两个日志边沿。
	 *
	 * 时机是**这一次真的拉成功了**,不是「重启了检测任务」—— 重启只是把 cron 挂回去,故障还在的话下一轮
	 * 照样失败,那会儿说"好了"就是骗人。清是幂等的,从没坏过时也叫,什么都不发生。
	 * 此前真的坏过(边沿标记还在)就记一行 info。
	 */
	private noteFetchSucceeded(): void {
		// 真解除:最后一路这样清掉会补「风控已解除」
		this.problems.resolveRisk(RISK_PATH);
		this.problems.resolveFailure({ code: FETCH_FAILED_CODE });
		const parts: string[] = [];
		if (this.riskControlled) parts.push("风控已解除");
		if (this.transientErrorCode !== null) parts.push(`此前错误码：${this.transientErrorCode}`);
		if (parts.length === 0) return;
		this.riskControlled = false;
		this.transientErrorCode = null;
		this.logger.info(`[api] ${parts.join("，")}，动态检测恢复正常`);
	}

	/**
	 * 风控/瞬时错误后排一次性退避重启。已有待执行的不叠加(`detectorRestartTimer`
	 * 非空即跳过)。到点按最新名单重启检测;`stop()` / 显式 `restartDetector`
	 * 会作废本计时(避免 dispose 后 / 重启后仍触发陈旧重启)。
	 */
	private scheduleDetectorRestart(reason: string): void {
		if (this.detectorRestartTimer) return;
		this.logger.info(
			`[detector] ${reason},将在 ${DETECTOR_RESTART_BACKOFF_MS / 1000}s 后自动重试动态检测`,
		);
		this.detectorRestartTimer = this.setTimeout(() => {
			this.detectorRestartTimer = undefined;
			this.logger.info("[detector] 退避计时到,重启动态检测");
			this.restartDetector();
		}, DETECTOR_RESTART_BACKOFF_MS);
	}
}
