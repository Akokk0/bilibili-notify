import type { CookieJar } from "@bilibili-notify/http";
import {
	type Disposable,
	type FailureCode,
	fail,
	type HttpClient,
	type Logger,
	ok,
	type Result,
	retry as retryUtil,
	type ServiceContext,
	type WebSocketLike,
} from "@bilibili-notify/internal";
import { CronJob } from "cron";
import { errorMessageOf } from "../../util/error-message";
import { type BiliContext, REFRESH_TOKEN_KEY } from "../context";
import type { AllDynamicResponse } from "../dynamic/types";
import { failureFromBili } from "../error-codes";
import { t as serverText, t } from "../i18n.js";
import { ApiClient } from "./api-client";
import * as EP from "./endpoints";
import { RiskControlError } from "./risk-control";
import { createMyselfCache, type MyselfCache } from "./self-info-cache";
import type {
	LiveRoomDanmakuResponse,
	LiveRoomResponse,
	LiveUpResponse,
	LoginQrCodeResponse,
	MyselfResponse,
	RelationsResponse,
	TicketResponse,
	UserCardResponse,
	UserInfoResponse,
	VideoRef,
	VideoResponse,
} from "./types";
import { buildTicketParams, encWbi, type WbiKeys } from "./wbi";
import { createWbiBreaker, type WbiBreaker } from "./wbi-breaker";

export interface ApiHandlers {
	/**
	 * 续期成功、新 cookie 与新令牌已经**落盘之后**叫一次。载荷没有:盘上那份已经由宿主写好,
	 * 回调只剩「发总线事件」这一件事。
	 */
	onCookiesRefreshed?: () => Promise<void> | void;
	/** Fired when the upstream returns code -101 (session invalid). Debounced 60s. */
	onAuthLost?: () => void;
}

// Special UID: Bangumi Trip account has no live room; return a static room id
const BANGUMI_TRIP_UID = "11783021";
const BANGUMI_TRIP_ROOM_ID = 931774;
const AUTH_LOST_DEBOUNCE_MS = 60_000;

/**
 * 「关注这件事已经成立」的业务码。
 *
 * - `0`     —— 关注成功
 * - `22014` —— 已经关注过了(重复关注)。**这不是失败** —— 目标状态已达成。
 * - `22001` —— 不能关注自己。也当成功:主人订阅自己是合法用例,动态照样收得到
 *              (自己的动态本来就在自己的 feed 流里)。
 *
 * 这套判定是当年 koishi 插件的 subscription-loader 跑了很久验证过的,提到共享包里,
 * 免得两端各写一份、各错一份。
 */
export const FOLLOW_SUCCESS_CODES: ReadonlySet<number> = new Set([0, 22014, 22001]);

export interface ApiOptions {
	serviceCtx: ServiceContext;
	callbacks?: ApiHandlers;
	/**
	 * B 站的集成上下文(建法见 `bilibili/context.ts`):请求客户端(浏览器身份与 B 站的默认头都在里面)、
	 * 与它配对的 cookie 罐的把手、存令牌的 `secrets`。
	 */
	ctx: BiliContext;
}

export class Api {
	readonly logger: Logger;
	private readonly serviceCtx: ServiceContext;
	private readonly callbacks: ApiHandlers;

	/**
	 * cookie 罐与请求客户端都是**长期有效的同一个**(由外面建好交进来):换号 / 登出 / -101 只调罐子的
	 * `load()` / `clear()` 原地换内容,不再重建罐子与客户端。
	 */
	private readonly jar: CookieJar;
	private readonly ctx: BiliContext;
	private readonly client: ApiClient;
	/**
	 * 「留着的闸」:登录状态改了一半、没提交成功的时候罐子不许自动存(盘上会变成「新 cookie + 旧令牌」或
	 * 「空罐 + 旧令牌」)。同一时刻最多一道,再来一道就把旧的放掉换新的;下一次 `commitLogin` 成功、
	 * 或 `resumeStoredLogin()`(宿主把罐子整个换了)时放。
	 */
	private unsavedSession?: Disposable;
	private wbiKeys: WbiKeys = { imgKey: "", subKey: "" };
	private ticketJob!: CronJob;
	private refreshCookieTimer?: Disposable;
	private loginInfoLoaded = false;
	/**
	 * 已经为之记过 warn 的、没有对照的 B 站码(同一个码只记一次)。放在实例上而不是模块级:测试每条新建一个
	 * `Api` 就是干净的,不用只为测试开重置口;代价是集成重启(设置改对了当场起)时会新建一个 `Api`,
	 * 重启后第一次撞上同一个码会再记一条 —— 重启本来就是一次重新开始,可以接受。
	 */
	private readonly unknownCodesSeen = new Set<number>();
	/**
	 * 上一次报出去的 `-101` 是哪一代报的、什么时候报的。去抖按代记:同一代里 60 秒内只报一次;代换了(重新登上、
	 * 登录结束)就是另一段的事,不受上一段的窗口管 ——「失效 → 重登 → 又失效」报得出来,不论重登那次落盘成没成。
	 */
	private authLostReported?: { generation: number; at: number };
	/**
	 * 登录代:**罐子里装的是哪一段登录**。一段登录成立(`loginEstablished`:开机恢复、恢复备份、扫码确认成功)
	 * 与结束(`closeLoginSession`:登出、会话终态;`stop()` 也走一次)时各往前走一步。
	 *
	 * 凡是「发出去的时候对着某一段登录、回来的时候可能已经换了一段」的东西,都在发之前记下它、落地之前比它,
	 * 对不上就不作数:
	 * - 续期链(`checkIfTokenNeedRefresh`)入口记、每跨一次 await 比 —— 否则上一段的慢链迟到,会把新会话的 cookie
	 *   覆盖成旧的、或拿自己的 `-101` 清掉别人的罐子;
	 * - 每个请求(`ApiClient` 发之前记、`maybeFireAuthLost` 比)—— 否则带着旧 cookie 发出去的请求迟到的 `-101`
	 *   会把刚登上的登录判成失效;
	 * - 登录状态机的登录检查(`LoginFlow` 经 `loginGeneration` 读)。
	 *
	 * 全仓只有这一份:`LoginFlow` 不另持一个。它自己的 `authGeneration` 是另一件事(只在登出时走)。
	 */
	private generation = 0;
	/** Single-in-flight guard so the hourly timer + resumeStoredLogin don't run the RSA dance concurrently. */
	private refreshInFlight = false;
	/**
	 * TicketResponse 在途去重。并发签名(或 wbiGet -352 清空 wbiKeys 后多个并行
	 * 重试)会各自触发一次 ticket POST 风暴;共享同一在途 Promise 收敛为一次。
	 */
	private biliTicketInFlight?: Promise<void>;
	/** wbi 签名请求一族的熔断(见 {@link WbiBreaker})。按实例记:集成重启就是重新开始;新登录成立时清。 */
	private readonly wbiBreaker: WbiBreaker;
	/**
	 * ④ 账号身份缓存(getMyselfInfoCached 共享给直播建连 / 卡片预览)。换号 / 登出 /
	 * -101 时 invalidate。lazy 调 `this.fetchMyselfInfo`,故传 `this` 安全。
	 */
	private readonly selfInfoCache: MyselfCache = createMyselfCache(this);

	/** finger/spi 的 buvid3 进程内缓存(设备指纹,不随账号变)。 */
	private buvid3Cache = "";
	private buvid3Inflight: Promise<string> | undefined;

	constructor(opts: ApiOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.callbacks = opts.callbacks ?? {};
		this.logger = opts.serviceCtx.logger;
		this.ctx = opts.ctx;
		this.jar = opts.ctx.cookies.jar;
		this.client = new ApiClient({
			http: opts.ctx.http,
			generation: () => this.generation,
			onBody: (body, generation) => {
				const data = body as { code?: unknown } | undefined;
				if (data && typeof data.code === "number") this.maybeFireAuthLost(data.code, generation);
			},
		});
		this.wbiBreaker = createWbiBreaker({ now: () => Date.now(), logger: this.logger });
	}

	/** 此刻的登录代(见 `generation` 字段)。登录状态机在发登录检查之前读它、落地之前比它。 */
	get loginGeneration(): number {
		return this.generation;
	}

	/**
	 * 起每日 ticket 定时,**不联网**:ticket 在第一次 WBI 签名时由 getWbi 现取。
	 * 开机预取会让「开机那一刻连不上 B 站」变成整台 BN 起不来(见 start-offline.test.ts)。
	 */
	async start(): Promise<void> {
		this.logger.debug("[init] HTTP 客户端初始化完成");

		// Daily ticket refresh at midnight (Beijing time, where bilibili.com lives).
		this.ticketJob = new CronJob(
			"0 0 * * *",
			() => {
				this.updateBiliTicket().catch((e: Error) =>
					this.logger.error(`[init] 更新 TicketResponse 失败: ${e.message}`),
				);
			},
			null,
			false,
			"Asia/Shanghai",
		);
		this.ticketJob.start();
	}

	stop(): void {
		// 作废在途的 cookie 刷新:停下以后它不得再 commitLogin 写盘(关停返回后还落盘)。
		this.generation++;
		this.ticketJob?.stop();
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
	}

	/**
	 * 请求客户端的只读窄口(同一份 cookie 罐与身份):抓图进图库用它,不外露客户端别的口子。
	 */
	get http(): Pick<HttpClient, "fetch"> {
		return this.client.http;
	}

	/**
	 * 弹幕服的建连口(blive 的 `createSocket` 接的就是它):经长期有效的那个客户端建连,握手头由
	 * 客户端按身份与 cookie 罐装配 —— `Cookie`(这个地址该带的)在前、`User-Agent`(身份的)在后,不带
	 * `sec-ch-ua` / `Origin`。这里不再另给头:握手的 UA 与同进程的 HTTP 请求是同一份身份。
	 */
	openDanmakuSocket(url: string): WebSocketLike {
		const opened = this.client.websocket(url);
		// 客户端把错地址当失败回;blive 的 `createSocket` 今天就是同步抛,这里翻回去,blive 那一层不动。
		if (!opened.ok) throw new Error(opened.message);
		return opened.socket;
	}

	// ---- Initialization ----

	/**
	 * Response-interceptor path: only `-101` (session invalid) from an arbitrary
	 * endpoint counts as login loss. `-352` etc. seen here are transient
	 * risk-control on data endpoints, NOT session death — must not widen this
	 * gate or every throttled data call would spuriously log the user out.
	 *
	 * `generation` 是这次请求发出去之前记的登录代。对不上此刻的:这份 `-101` 问的是上一段登录(带着旧 cookie
	 * 发出去、新登录成立之后才回来),不作数 —— 也不碰去抖的记账,免得它吃掉这一段自己的第一次 `-101`。
	 */
	private maybeFireAuthLost(code: number, generation = this.generation): void {
		if (code !== -101) return;
		if (generation !== this.generation) {
			this.logger.debug("[auth] 迟到的 -101 问的是上一段登录,不作数");
			return;
		}
		this.fireAuthLost(generation);
	}

	/**
	 * Debounced `onAuthLost` dispatch (60s, per login generation). The caller has already decided the
	 * state is terminal — either interceptor `-101`, or a failed cookie-refresh
	 * chain (the authoritative session-liveness check; if it can't refresh, the
	 * session is unrecoverable and the user must re-scan).
	 *
	 * `generation`:报的是哪一段登录。去抖只管同一段里的重复。
	 */
	private fireAuthLost(generation: number): void {
		const now = Date.now();
		const last = this.authLostReported;
		if (last && last.generation === generation && now - last.at < AUTH_LOST_DEBOUNCE_MS) return;
		this.authLostReported = { generation, at: now };
		try {
			this.callbacks.onAuthLost?.();
		} catch (e) {
			this.logger.warn(`[auth] onAuthLost 回调抛错: ${e}`);
		}
	}

	/**
	 * 会话终态清理 —— `-101`(B1)/ B2 终态码 / confirm 终态码 共用。②3:此前
	 * 仅 B1 做了 timer dispose + loginInfoLoaded 清理,B2/confirm 只 emit 没清,
	 * 死会话每小时继续 RSA 轮换、isLoginInfoLoaded 仍误报已登录。收敛到一处。
	 */
	private async terminateSession(logMsg: string): Promise<void> {
		this.logger.warn(logMsg);
		// 报的是刚结束的那一段(与拦截器在同一段里报过的那次互相去抖),所以先记下代再往前走。
		const ended = this.generation;
		this.closeLoginSession();
		this.fireAuthLost(ended);
		// 先拿一道闸留着再清罐:空罐不许自动存成「空罐 + 旧令牌」,盘上留着上一对(与今天一样)。
		this.keepUnsaved(this.ctx.cookies.hold());
		this.jar.clear();
	}

	/**
	 * 一段登录结束(登出、会话终态)时请求客户端这一头该做的:代往前走(作废在途的续期链,这一段发出去的请求
	 * 迟到的 `-101` 也不再作数)、摘掉每小时的续期定时器、标成没载入、清账号身份缓存。清不清罐子、报不报失效是
	 * 调用方各自的事。
	 */
	private closeLoginSession(): void {
		this.generation++;
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
		this.loginInfoLoaded = false;
		this.selfInfoCache.invalidate();
	}

	/** 把这道闸记成「留着的」;已经有一道的,先拿新的再放旧的(中间不空档)。 */
	private keepUnsaved(hold: Disposable): void {
		const previous = this.unsavedSession;
		this.unsavedSession = hold;
		previous?.dispose();
	}

	private releaseUnsaved(): void {
		this.unsavedSession?.dispose();
		this.unsavedSession = undefined;
	}

	/** 扫码流程拿的闸:登录回应的 Set-Cookie 先进罐子、令牌后到,这中间不许自动存。放闸是拿的人自己的事。 */
	holdLoginSaves(): Disposable {
		return this.ctx.cookies.hold();
	}

	/**
	 * 登录状态的唯一提交口:罐子此刻的内容 + 令牌(没有就删)合成**同一次原子写**。扫码成功(经
	 * `commitScannedLogin`)、续期成功、登出都走它。成功就把留着的闸放掉;失败回结果,并留一道闸 —— 盘上还是上一对,
	 * 罐子里的新状态不许被零散的自动存单独写出去(下一次提交成功才放)。
	 *
	 * 它只管写盘,**不代表一段登录成立**(续期是同一段、登出是结束):登录代、续期定时器、`-101` 的去抖都不在这里动。
	 */
	async commitLogin(refreshToken: string | undefined): Promise<Result> {
		// 令牌到手、还没存进 `secrets`(落盘成功后宿主才按 `secrets` 登记)的这段空档,日志不能露出它:
		// 同步登记,在第一个 await 之前。扫码登录与续期两条路都经这里。
		if (refreshToken) this.ctx.redact(refreshToken);
		const result = await this.ctx.cookies.commit([
			refreshToken
				? { kind: "set", key: REFRESH_TOKEN_KEY, value: refreshToken }
				: { kind: "delete", key: REFRESH_TOKEN_KEY },
		]);
		if (result.ok) this.releaseUnsaved();
		else this.keepUnsaved(this.ctx.cookies.hold());
		return result;
	}

	// ---- Cookie management ----

	addCookie(cookieStr: string): void {
		this.jar.setFromSetCookie(
			`${cookieStr}; path=/; domain=.bilibili.com`,
			"https://www.bilibili.com",
		);
	}

	getCookiesJson(): string | undefined {
		try {
			return JSON.stringify(this.jar.serialize());
		} catch (e) {
			this.logger.warn(`[cookie] 获取 cookies 失败: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	private getCSRF(): string | undefined {
		return this.jar.getValue("bili_jct");
	}

	/**
	 * 恢复存着的登录(开机一次;恢复备份之后由宿主叫一次)。cookie 罐已经由宿主装好 / 换好,令牌在 `secrets` 里;
	 * 剩下的都在 `loginEstablished` 里。
	 */
	async resumeStoredLogin(): Promise<void> {
		await this.loginEstablished({ kind: "stored" });
	}

	/**
	 * 扫码确认成功:登录回应的 Set-Cookie 已经在罐子里,令牌刚从响应体里拿到(没有就是 `undefined`)。
	 * 调用方必须在认出「确认成功」的**同一拍**里调它(中间不隔 await)—— 登录代在这里面第一个 await 之前就往前走。
	 * 回的是落盘的结果;落盘失败照样是一段新登录(内存里已经登上了),只是这一段没有续期。
	 */
	commitScannedLogin(refreshToken: string | undefined): Promise<Result> {
		return this.loginEstablished({ kind: "scanned", refreshToken });
	}

	/**
	 * **一段登录成立** —— 请求客户端这一头唯一的口。开机恢复、恢复备份(`resumeStoredLogin`)、扫码确认成功
	 * (`commitScannedLogin`)三条路都经它,该发生的事只在这里写一遍:
	 *
	 * 1. 清账号身份缓存(可能换了号);
	 * 2. 登录代往前走:上一段在途的续期链、上一段发出去还没回来的请求与登录检查,从这一刻起都不作数;
	 * 3. 摘掉上一段的续期定时器,标成已载入;
	 * 4. 让这一段的登录状态在盘上站住 —— 存着的(`stored`)本来就在盘上,只放掉上一串留着的闸、补占位的 buvid3;
	 *    扫出来的(`scanned`)在这里提交(罐子 + 令牌同一次原子写);
	 * 5. 这一段有令牌就起每小时的续期。存着的 cookie 可能已经该刷了,所以立刻探一次;刚扫出来的不用探。
	 *
	 * 1–3 在第一个 await 之前同步做完。**登录代在哪一刻走**:登录回应的 Set-Cookie 在响应头到的那一刻就进了罐子,
	 * 而我们要等响应体解析完、认出「确认成功」才知道登上了 —— 代就在认出的那一拍走(落盘之前,不等落盘)。
	 * 所以新代的请求带的一定是新 cookie;漏的一格是「Set-Cookie 进罐 → 认出确认成功」之间(一个响应体的工夫)
	 * 发出去的请求:带的是新 cookie、记的是旧代,它若回 `-101` 会被当成上一段的丢掉。偏的方向是少报一次,
	 * 新登录真有问题时下一个请求照样报;反方向(把旧 cookie 的 `-101` 算到新登录头上)没有。
	 */
	private async loginEstablished(
		from: { kind: "stored" } | { kind: "scanned"; refreshToken: string | undefined },
	): Promise<Result> {
		this.selfInfoCache.invalidate();
		this.wbiBreaker.reset();
		const generation = ++this.generation;
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
		this.loginInfoLoaded = true;

		let saved: Result = ok();
		if (from.kind === "stored") this.adoptStoredJar();
		else saved = await this.commitLogin(from.refreshToken);

		// 没落盘:`secrets` 里要么没有令牌、要么还是上一段的 —— 拿它配这一段的 cookie 去刷,只会把刚登上的会话刷成终态。
		// 落盘期间又换了一段(登出、恢复备份):续期归那一段自己起。
		if (!saved.ok || generation !== this.generation) return saved;
		if (this.ctx.secrets.get<string>(REFRESH_TOKEN_KEY)) {
			if (from.kind === "stored") this.triggerRefreshCheck();
			this.enableRefreshCookiesInterval();
		}
		return saved;
	}

	/** 宿主把罐子整个装好 / 换好之后的收拾:放掉上一串留着的闸、补占位的 buvid3。 */
	private adoptStoredJar(): void {
		// 罐子整个换了:上一串没提交成功的登录状态已经不存在了,留着的闸该放。
		this.releaseUnsaved();

		const cookies = this.jar.serialize();
		const biliJctCookie = cookies.find((c) => c.key === "bili_jct");
		// 罐里有 bili_jct 而没有 buvid3 时补一条占位的(有些接口要它)—— 并进同一批:`load` 是替换语义。
		if (biliJctCookie && !cookies.some((c) => c.key === "buvid3")) {
			this.jar.load([
				...cookies,
				{
					key: "buvid3",
					value: "some_non_empty_value",
					expires: biliJctCookie.expires,
					domain: biliJctCookie.domain,
					path: biliJctCookie.path,
					secure: biliJctCookie.secure,
				},
			]);
		}

		this.logger.debug(
			`[cookie] 载入 ${cookies.length} 条 Cookie,bili_jct=${biliJctCookie ? "存在" : "缺失"},refreshToken=${this.ctx.secrets.get(REFRESH_TOKEN_KEY) === undefined ? "缺失" : "存在"}`,
		);
	}

	/**
	 * Guarded fire-and-forget entry to {@link checkIfTokenNeedRefresh} used by
	 * the two internal triggers (resumeStoredLogin / hourly timer). Skips if a refresh
	 * is already running so the RSA/correspond/confirm dance never overlaps.
	 *
	 * 令牌**触发那一刻**现读 `ctx.secrets`,不关进闭包:续期成功之后新令牌已经提交进去,下一次触发带的是新的,
	 * 不是开机那一刻的旧令牌(旧令牌在确认那一步已被作废)。读不到就不触发。
	 */
	private triggerRefreshCheck(): void {
		const refreshToken = this.ctx.secrets.get<string>(REFRESH_TOKEN_KEY);
		if (!refreshToken) {
			this.logger.debug("[cookie] 没有续期令牌,不触发刷新检查");
			return;
		}
		if (this.refreshInFlight) {
			this.logger.debug("[cookie] 刷新检查已在进行,跳过本次触发");
			return;
		}
		this.refreshInFlight = true;
		// 登记进 track:刷新链最后一步要把新 cookie 与新令牌提交落盘,
		// 关停得等它落完再让各写道关门。失败在交进去之前接住。
		this.serviceCtx.track(
			this.checkIfTokenNeedRefresh(refreshToken, this.getCSRF() ?? "")
				.catch((e: Error) => this.logger.warn(`[cookie] Cookie 刷新检查失败: ${e.message}`))
				.finally(() => {
					this.refreshInFlight = false;
				}),
		);
	}

	isLoginInfoLoaded(): boolean {
		return this.loginInfoLoaded;
	}

	/**
	 * 清空内存 cookie jar(登出)。调用方此前只删盘 cookie 而不清
	 * 这里,导致 api 仍以 stale SESSDATA/bili_jct 发已认证请求,直到进程重启
	 * (安全缺陷,P0-2)。原地 `clear()` 罐子(客户端与罐子都是长期有效的同一个,
	 * 在途请求迟到的 Set-Cookie 由 HttpClient 按罐子的 epoch 挡掉,写不进来),
	 * 停掉刷新定时器(登出后已无 refreshToken 可刷),标记未登录。
	 */
	async clearCookies(): Promise<void> {
		// 这一段登录结束:作废任何 in-flight refresh(登出后它不得再 commitLogin 写盘)、停续期、清账号身份缓存。
		this.closeLoginSession();
		this.jar.clear();
		this.logger.info("[cookie] 内存 cookie jar 已清空");
	}

	private enableRefreshCookiesInterval(): void {
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = this.serviceCtx.setInterval(
			() => this.triggerRefreshCheck(),
			3_600_000,
		);
	}

	// ---- Cookie refresh ----

	async checkIfTokenNeedRefresh(
		refreshToken: string,
		csrf: string,
		generation = this.generation,
	): Promise<void> {
		// 入口 + 每次跨 await 后比对 generation(登录代):一段登录成立(开机恢复 / 恢复备份 / 扫码确认成功)或结束
		// (登出 / 会话终态 / stop)都会让它往前走,本轮(及其重试链)随即作废,绝不把过期结果写回。
		if (generation !== this.generation) {
			this.logger.debug("[cookie] 刷新已被更新的 cookie 状态取代,跳过本轮");
			return;
		}
		// 这一串刷新进行中,罐子不许自动存中间状态。闸怎么处置**只在下面的 finally 里决定一次**:
		// 默认放(这一串没走到会改罐子的那一步,或被取代了);走过刷新 POST 之后改成「留」,
		// 提交成功才改回放。别在每个 return / throw 前各写一遍 —— 漏一处就是盘上悄悄变成「新 cookie + 旧令牌」。
		const hold = this.ctx.cookies.hold();
		let fate: "release" | "keep" = "release";
		try {
			try {
				// 传真实 bili_jct(优先 live jar,回退调用方传入值),不是 refreshToken。
				const info = await this.fetchCookieInfo(this.getCSRF() ?? csrf);
				// 跨 await 后必须重校 generation(②修不全:此前缺这一处,旧 refreshToken
				// 在重登/登出后仍用新 jar 继续刷新)。
				if (generation !== this.generation) {
					this.logger.debug("[cookie] 刷新已被更新的 cookie 状态取代(fetchCookieInfo 后),跳过本轮");
					return;
				}
				// 续期只在会话真死(请求层翻成 unauthorized,即 -101)时登出;风控、没对照的码、回应形状不对都当
				// 一时失败,跳过本轮等下个 interval。死会话由普通请求撞 -101 时清(拦截器 → 登录失效)。
				const probed = this.resultOf<{ refresh?: boolean } | undefined>(info, "fetchCookieInfo");
				if (!probed.ok) {
					if (probed.code === "unauthorized") {
						// 探测即 -101:会话已死,直接终态,不再跑 RSA 链。
						await this.terminateSession(serverText("bilibili.api.api.text.1"));
						return;
					}
					this.logger.warn(
						`[cookie] fetchCookieInfo 失败 code=${probed.upstreamCode ?? probed.code} msg=${probed.message},跳过本轮(不判定登录失效,等下轮再试)`,
					);
					return;
				}
				if (!probed.data?.refresh) return;
			} catch (e) {
				// P2:此前这里还有一层 3 次 ×3s 递归重试,而内层 fetchCookieInfo 已被
				// this.retry(4 次指数退避)包住 → 双层乘积最坏 ~16 次 HTTP,且整段
				// 占住 refreshInFlight 阻塞 hourly timer 数分钟。内层 retry 已足够吸收
				// 瞬时抖动;失败即放弃本轮,等下个 interval 再探(绝不 fall through
				// 强制刷新 —— 一次抖动触发整条 RSA 轮换会放大风控)。
				this.logger.warn(`[cookie] 刷新探测失败,跳过本轮(不强制刷新): ${(e as Error).message}`);
				return;
			}

			// Generate correspond path via RSA-OAEP
			const publicKey = await crypto.subtle.importKey(
				"jwk",
				{
					kty: "RSA",
					n: "y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE",
					e: "AQAB",
				},
				{ name: "RSA-OAEP", hash: "SHA-256" },
				true,
				["encrypt"],
			);

			const ts = Date.now();
			const data = new TextEncoder().encode(`refresh_${ts}`);
			const encrypted = new Uint8Array(
				await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, data),
			);
			const correspondPath = encrypted.reduce(
				(str, c) => str + c.toString(16).padStart(2, "0"),
				"",
			);
			// 加密那两步也跨了 await。罐子只有一个、换号原地换(⑭a 起),换号之后这条旧链再发请求,带的就是新号的 cookie,
			// 回来的 Set-Cookie 会被当成新会话的收进去 —— 每跨一次 await 都比对,换了就不再发。
			if (generation !== this.generation) {
				this.logger.debug("[cookie] 刷新在算 correspond 期间被取代,丢弃");
				return;
			}

			const html = await this.client.get(`${EP.COOKIE_REFRESH_CORRESPOND_PATH}/${correspondPath}`);
			if (generation !== this.generation) {
				this.logger.debug("[cookie] 刷新在取 correspond 页期间被取代,丢弃");
				return;
			}
			// jsdom 时代取 getElementById("1-name").textContent;页面即
			// `<div id="1-name">{refresh_csrf}</div>`,正则等价且免掉整棵 jsdom 依赖树。
			const refreshCsrf =
				typeof html === "string"
					? (/id="1-name"[^>]*>([^<]*)</.exec(html)?.[1]?.trim() ?? null)
					: null;
			if (!refreshCsrf) {
				// correspond 页面没解析出 refresh_csrf(B 站返回异常 / 结构变更):
				// 绝不 POST 一个 null refresh_csrf(必失败且语义不明)。抛可重试错,
				// triggerRefreshCheck 记 warn,下个 interval 再探(generation/timer 不动)。
				throw new Error(serverText("bilibili.api.api.text.2"));
			}

			const refreshBody = await this.client.postForm(EP.COOKIE_REFRESH_URL, {
				csrf,
				refresh_csrf: refreshCsrf,
				source: "main_web",
				refresh_token: refreshToken,
			});
			const refreshed = this.resultOf<{ refresh_token: string }>(refreshBody, "cookie refresh");
			// 新令牌一到手就登记要在日志里遮掉:从这里到提交(`commitLogin`)之间隔着确认 POST 和几处 await,
			// 这段里的日志与错误不能带着它的明文。
			const newRefreshToken: unknown = refreshed.ok ? refreshed.data?.refresh_token : undefined;
			if (typeof newRefreshToken === "string" && newRefreshToken) this.ctx.redact(newRefreshToken);

			// RSA/correspond/refresh 这串网络往返期间若 cookie 状态已被替换,
			// 后面的 jar 重置 / 持久化都基于过期前提,丢弃本轮。
			if (generation !== this.generation) {
				this.logger.debug("[cookie] 刷新结果在网络往返期间被取代,丢弃");
				return;
			}
			// 刷新 POST 走过了:罐里可能已经是新 cookie、新令牌还没存。从这里起,除非提交成功或会话终态(`terminateSession`
			// 自己另留一道),这道闸都留着。
			fate = "keep";

			if (!refreshed.ok) {
				const shownCode = refreshed.upstreamCode ?? refreshed.code;
				if (refreshed.code !== "unauthorized") {
					// 只有 -101 才是会话终态;风控、没对照的码、回应形状不对都是一时失败。不判定登录失效、
					// 不拆 timer —— 抛可重试错(triggerRefreshCheck 记 warn),闸留着,下个 interval 再试。
					// 死会话由普通请求撞 -101 时清;把别的码也当终态,会把瞬时风控误升级成被动登出。
					this.logger.warn(
						`[cookie] 刷新失败 code=${shownCode} msg=${refreshed.message},跳过本轮(不判定登录失效,等下轮再试)`,
					);
					throw new Error(serverText("bilibili.api.api.text.3", { value0: shownCode }));
				}
				// 终态(-101):②3 —— B2 此前只 emit 不清理,死会话每小时
				// 继续 RSA 轮换、isLoginInfoLoaded 误报。统一走 terminateSession 清净。
				fate = "release";
				await this.terminateSession(
					serverText("bilibili.api.api.text.4", { value0: shownCode, value1: refreshed.message }),
				);
				throw new Error(
					serverText("bilibili.api.api.text.5", { value0: shownCode, value1: refreshed.message }),
				);
			}

			const newCsrf = this.getCSRF();
			if (!newCsrf) throw new Error(serverText("bilibili.api.api.text.6"));

			const accepted = this.resultOf<unknown>(
				await this.client.postForm(EP.COOKIE_REFRESH_CONFIRM_URL, {
					csrf: newCsrf,
					refresh_token: refreshToken,
				}),
				"cookie refresh confirm",
			);

			// confirm POST 返回之后、看码之前先比代数(与刷新那一步同序):被取代的链不许走风控 / 终态分支 ——
			// 终态会清别人的罐子、判定登录失效、留闸;下面接着就是写盘,同样不能用过期 generation 的结果覆盖更新的登录态。
			if (generation !== this.generation) {
				this.logger.debug("[cookie] 刷新确认返回时已被取代,丢弃(不看码、不回写)");
				fate = "release";
				return;
			}

			if (!accepted.ok) {
				const shownCode = accepted.upstreamCode ?? accepted.code;
				if (accepted.code !== "unauthorized") {
					// confirm 步:同刷新那一步,只有 -101 是终态,别的退避等下轮(不判定登录失效/不拆 timer)。
					this.logger.warn(`[cookie] 刷新确认失败 code=${shownCode},跳过本轮(等下轮再试)`);
					throw new Error(serverText("bilibili.api.api.text.7", { value0: shownCode }));
				}
				// confirm 终态:新旧 cookie 状态不可信,清罐 + 判定登录失效(②3 同款)。
				fate = "release";
				await this.terminateSession(serverText("bilibili.api.api.text.8", { value0: shownCode }));
				throw new Error(serverText("bilibili.api.api.text.9", { value0: shownCode }));
			}

			// 提交:罐子此刻的内容(新 cookie)+ 新令牌,同一次原子写。失败时内存里已是新 cookie、盘上仍是上一对,
			// 响亮记 error;闸留着,下一次提交成功才放。
			const committed = await this.commitLogin(refreshed.data.refresh_token);
			if (!committed.ok) {
				this.logger.error(
					`[cookie] 刷新后的登录状态存盘失败(内存 cookie 已更新,盘上为旧值,下次启动将回退): ${committed.message}`,
				);
				return;
			}
			fate = "release";
			// 事件在提交成功之后才发。回调抛了不算这一轮刷新失败(盘已经写好了)。
			try {
				await this.callbacks.onCookiesRefreshed?.();
			} catch (e) {
				this.logger.error(`[cookie] onCookiesRefreshed 回调抛了: ${errorMessageOf(e)}`);
			}
		} finally {
			if (fate === "keep") this.keepUnsaved(hold);
			else hold.dispose();
		}
	}

	// ---- WBI signature ----

	private updateBiliTicket(): Promise<void> {
		// 在途去重:并发调用共享同一 Promise,只打一次 ticket POST。
		if (this.biliTicketInFlight) return this.biliTicketInFlight;
		const p = this.doUpdateBiliTicket().finally(() => {
			if (this.biliTicketInFlight === p) this.biliTicketInFlight = undefined;
		});
		this.biliTicketInFlight = p;
		return p;
	}

	private async doUpdateBiliTicket(): Promise<void> {
		const csrf = this.getCSRF();
		const ticket = await this.getBiliTicket(csrf);
		if (ticket.code !== 0) {
			throw new Error(serverText("bilibili.api.api.text.10", { value0: ticket.message }));
		}
		const extract = (url: string) => url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("."));
		this.wbiKeys = {
			imgKey: extract(ticket.data.nav.img),
			subKey: extract(ticket.data.nav.sub),
		};
	}

	private async getBiliTicket(csrf?: string): Promise<TicketResponse> {
		const params = buildTicketParams(csrf);
		const resp = await this.client.postForm(`${EP.TICKET_URL}?${params.toString()}`, {});
		return resp as TicketResponse;
	}

	private async getWbi(params: Record<string, string | number | object>): Promise<string> {
		if (!this.wbiKeys.imgKey) {
			await this.updateBiliTicket();
		}
		return encWbi(params, this.wbiKeys);
	}

	/**
	 * WBI 签名 GET。B3:`getWbi` 仅在 imgKey 为空时才刷新 key,服务端轮换 WBI
	 * 后既有 key 仍非空 → 所有签名请求一路 `-352` 直到午夜 ticket cron。这里在
	 * 响应 `code === -352` 时清空 wbiKeys 强制重取 ticket,并重试一次。
	 *
	 * 整段包在 {@link wbiBreaker} 里:持续风控开闸之后当场回 {@link RiskControlError},不出网、也不清 wbiKeys。
	 */
	private async wbiGet(endpoint: string, params: Record<string, string | number | object>) {
		return this.wbiBreaker.run(async () => {
			const once = async () => {
				const wbi = await this.getWbi(params);
				// biome-ignore lint/suspicious/noExplicitAny: 保持 axios 时代的宽松返回契约,下游各自 cast 收窄
				return (await this.client.get(`${endpoint}?${wbi}`)) as any;
			};
			const data = await once();
			if (data && typeof data === "object" && data.code === -352) {
				this.logger.debug("[wbi] 签名请求返回 -352（WBI key 疑似轮换），刷新 wbiKeys 后重试一次");
				this.wbiKeys = { imgKey: "", subKey: "" }; // 强制下次 getWbi 重新拉 ticket
				const retried = await once();
				// P2:二次仍 -352 时此前**静默返回 -352 body**,外层 this.retry 只认
				// 抛错、感知不到业务码 → 调用方拿到一个看似成功的 -352 响应。抛错让
				// 外层 retry 重走(含重取 ticket),最终把持续风控如实暴露给调用方。
				if (retried && typeof retried === "object" && retried.code === -352) {
					// 抛「持续风控」类型 —— 外层 retry 的 shouldRetry 据此 fail-fast,
					// 不再把刷新+重试整轮跑 3 遍放大请求量(风控收敛)。
					throw new RiskControlError(serverText("bilibili.api.api.text.11"), -352);
				}
				return retried;
			}
			return data;
		});
	}

	// ---- Request helpers ----

	private retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
		return retryUtil(() => fn(), {
			attempts: 4, // 1 initial + 3 retries
			baseDelayMs: 200,
			shouldRetry: (error) => !(error instanceof RiskControlError),
			onRetry: (err, attempt) => {
				const message = errorMessageOf(err);
				this.logger.warn(`[retry] ${label}() 第 ${attempt} 次失败: ${message}`);
			},
		});
	}

	/**
	 * 回 `Result` 的公有方法共用的请求收口:先经 {@link retry},再用 {@link resultOf} 翻 B 站码。
	 *
	 * {@link RiskControlError} 无论来自 HTTP 412 风控页,还是 wbi 请求刷新签名后仍持续 -352,
	 * 都翻成 `rate_limited`,不再向外抛。持续 -352 的错误自带 `upstreamCode: -352`,原样保留;
	 * HTTP 412 是传输层状态,不带 `upstreamCode`。调用方(如直播预检与搜人)只看标准码。
	 * 连不上、超时及其他异常仍原样抛给调用方,由各自的失败边界处理。
	 */
	private async retryResult<D>(
		request: () => Promise<unknown>,
		label: string,
		own?: Readonly<Record<number, FailureCode>>,
		successCodes?: ReadonlySet<number>,
	): Promise<Result<{ data: D }>> {
		try {
			const body = await this.retry(request, label);
			return this.resultOf<D>(body, label, own, successCodes);
		} catch (error) {
			if (!(error instanceof RiskControlError)) throw error;
			const upstreamCode = error.upstreamCode;
			return upstreamCode === undefined
				? fail("rate_limited", error.message)
				: fail("rate_limited", error.message, { upstreamCode });
		}
	}

	/**
	 * GET + retry,返回响应体(等价旧 axios 的 `.data`)。默认 `any` 沿袭 axios
	 * 时代的宽松返回契约 —— 下游(dynamic/live/login-flow)各自 cast 收窄,
	 * 改成 unknown 会波及全部调用方签名。
	 */
	// biome-ignore lint/suspicious/noExplicitAny: 见上,兼容旧返回契约
	private getJson<T = any>(url: string, label: string): Promise<T> {
		return this.retry(async () => (await this.client.get(url)) as T, label);
	}

	/**
	 * 把 B 站的一份回应体翻成结果形状(请求层只在这一处查码表,ADR-0026 决策 4):code 0(或接口自己
	 * 认的 `successCodes`,如关注的「已关注」)→ `ok`,B 站的 `data` 原样铺在 `ok` 旁;非 0 → 标准码 + 原话 + `upstreamCode`({@link failureFromBili});
	 * 回应不是对象、没有数字 code(HTML 页、形状变了)→ `unavailable`,不带 `upstreamCode`。
	 * 表外的码每个记一条带原话的 warn,取证用 —— 认得了再往 `error-codes.ts` 里加一行。
	 * `-403` 这类不进共用表、由接口自己判的码从 `own` 给;命中的不记表外 warn。
	 *
	 * 只翻 B 站**回了**的码;连不上、超时、非 2xx 仍然是抛错,由调用方各自的 catch 接。
	 */
	private resultOf<D>(
		body: unknown,
		label: string,
		own?: Readonly<Record<number, FailureCode>>,
		successCodes?: ReadonlySet<number>,
	): Result<{ data: D }> {
		const reply =
			typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
		if (reply === null || typeof reply.code !== "number") {
			return fail("unavailable", t("bilibili.response.malformed"));
		}
		const { code } = reply;
		if (code === 0 || successCodes?.has(code)) return ok({ data: reply.data as D });
		const message =
			typeof reply.message === "string" && reply.message !== ""
				? reply.message
				: t("bilibili.response.codeOnly", { code });
		const standard = own?.[code];
		const failure = standard
			? fail(standard, message, { upstreamCode: code })
			: failureFromBili(code, message);
		if (failure.code === "unknown" && !this.unknownCodesSeen.has(code)) {
			this.unknownCodesSeen.add(code);
			this.logger.warn(`[api] ${label}() 收到没有对照的错误码 ${code}：${message}`);
		}
		return failure;
	}

	// ---- Public API methods ----

	async fetchAllDynamic(): Promise<Result<{ data: AllDynamicResponse["data"] }>> {
		return this.retryResult<AllDynamicResponse["data"]>(
			() => this.client.get(EP.ALL_DYNAMIC_URL),
			"fetchAllDynamic",
		);
	}

	async fetchUserSpaceDynamic(uid: string) {
		return this.getJson(
			`${EP.USER_SPACE_DYNAMIC_URL}&host_mid=${encodeURIComponent(uid)}`,
			"fetchUserSpaceDynamic",
		);
	}

	async fetchLoginQrCode(): Promise<Result<{ data: LoginQrCodeResponse["data"] }>> {
		return this.retryResult<LoginQrCodeResponse["data"]>(
			() => this.client.get(EP.LOGIN_QR_CODE_URL),
			"fetchLoginQrCode",
			{ [-403]: "rate_limited" },
		);
	}

	async fetchLoginStatus(qrcodeKey: string) {
		return this.getJson(
			`${EP.LOGIN_STATUS_URL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
			"fetchLoginStatus",
		);
	}

	/**
	 * 裸探当前账号信息。**每次都真发请求**，不缓存 —— `LoginFlow` 的启动探活 /
	 * 健康检查靠它探 -101 会话死活，缓存会掩盖会话失效。需要账号身份但不要求实时
	 * 的调用方(直播建连 / 卡片预览)请改用 {@link getMyselfInfoCached}。
	 */
	async fetchMyselfInfo(): Promise<MyselfResponse> {
		return this.getJson(EP.MYSELF_INFO_URL, "fetchMyselfInfo");
	}

	/**
	 * 短 TTL + 在途合流的账号身份缓存。一个登录会话内「自己的信息」是常量,却被
	 * 多处反复要(直播重连风暴 / 卡片预览);共享一份缓存收敛掉重复请求。换号 /
	 * 登出 / -101 时由本类精准 invalidate,不靠 TTL 硬扛陈旧身份。
	 */
	getMyselfInfoCached(): Promise<MyselfResponse> {
		return this.selfInfoCache.get();
	}

	async fetchUserCard(
		uid: string,
		withPhoto = false,
	): Promise<Result<{ data: UserCardResponse["data"] }>> {
		return this.retryResult<UserCardResponse["data"]>(
			() =>
				this.client.get(
					`${EP.USER_CARD_URL}?mid=${encodeURIComponent(uid)}${withPhoto ? "&photo=true" : ""}`,
				),
			"fetchUserCard",
			{ [-404]: "not_found", [-403]: "rate_limited" },
		);
	}

	async fetchUserInfo(
		uid: string,
		griskId?: string,
	): Promise<Result<{ data: UserInfoResponse["data"] }>> {
		return this.retryResult<UserInfoResponse["data"]>(async () => {
			if (uid === BANGUMI_TRIP_UID) {
				return {
					code: 0,
					data: { live_room: { roomid: BANGUMI_TRIP_ROOM_ID } },
				};
			}
			const params: Record<string, string> = { mid: uid };
			if (griskId) params.grisk_id = griskId;
			return this.wbiGet(EP.USER_INFO_URL, params);
		}, "fetchUserInfo");
	}

	async fetchLiveRoomInfo(roomId: string): Promise<LiveRoomResponse> {
		return this.getJson(
			`${EP.LIVE_ROOM_INFO_URL}?room_id=${encodeURIComponent(roomId)}`,
			"fetchLiveRoomInfo",
		);
	}

	/**
	 * 真 buvid3(设备指纹,与登录态无关)。弹幕连接认证包要用它 —— cookie 罐里那条
	 * 是 resumeStoredLogin 填的占位假值,不能进认证包。成功后进程内缓存;失败返回空串
	 * 且不缓存(认证包缺 buvid 仍可尝试,下次调用重试)。
	 */
	async getBuvid3(): Promise<string> {
		if (this.buvid3Cache) return this.buvid3Cache;
		// 在途合流(同 createMyselfCache 模式):启动时 N 个房间并发 bootstrap,
		// 缓存落位前各自联网等于把 N 条相同请求同时打在风控敏感面上。
		if (!this.buvid3Inflight) {
			this.buvid3Inflight = this.fetchBuvid3().finally(() => {
				this.buvid3Inflight = undefined;
			});
		}
		return this.buvid3Inflight;
	}

	private async fetchBuvid3(): Promise<string> {
		try {
			const res = await this.getJson<{ code: number; data?: { b_3?: string } }>(
				EP.FINGER_SPI_URL,
				"getBuvid3",
			);
			const b3 = res?.data?.b_3;
			if (typeof b3 === "string" && b3) {
				this.buvid3Cache = b3;
				return b3;
			}
		} catch (e) {
			this.logger.warn(`[conn] finger/spi 获取 buvid3 失败: ${(e as Error).message}`);
		}
		return "";
	}

	async getMasterInfo(uid: string): Promise<LiveUpResponse> {
		return this.getJson(`${EP.MASTER_INFO_URL}?uid=${encodeURIComponent(uid)}`, "getMasterInfo");
	}

	async fetchLiveRoomInfoStreamKey(
		roomId: string,
	): Promise<Result<{ data: LiveRoomDanmakuResponse["data"] }>> {
		// getDanmuInfo 现已强制 wbi 签名，裸 GET 一律被风控拦成 -352。必须走
		// wbiGet（自动加 wts + w_rid，并自带 -352 → 刷新 wbiKeys 重试一次的自愈）。
		return this.retryResult<LiveRoomDanmakuResponse["data"]>(
			() => this.wbiGet(EP.LIVE_ROOM_INFO_STREAM_KEY_URL, { id: roomId }),
			"fetchLiveRoomInfoStreamKey",
		);
	}

	async fetchUserInfoInLive(
		uid: string,
		upUid: string,
	): Promise<Result<{ data: { face?: string } | null }>> {
		return this.retryResult<{ face?: string } | null>(
			() =>
				this.client.get(
					`${EP.USER_INFO_IN_LIVE_URL}?uid=${encodeURIComponent(uid)}&ruid=${encodeURIComponent(upUid)}`,
				),
			"fetchUserInfoInLive",
		);
	}

	async fetchUserUpstat(
		uid: string,
	): Promise<Result<{ data: { archive?: { view?: number }; likes?: number } }>> {
		return this.retryResult<{ archive?: { view?: number }; likes?: number }>(
			() => this.client.get(`${EP.USER_UPSTAT_URL}?mid=${encodeURIComponent(uid)}`),
			"fetchUserUpstat",
		);
	}

	async fetchUserNavnum(uid: string): Promise<Result<{ data: { video?: number; upos?: number } }>> {
		return this.retryResult<{ video?: number; upos?: number }>(
			() => this.client.get(`${EP.USER_NAVNUM_URL}?mid=${encodeURIComponent(uid)}`),
			"fetchUserNavnum",
		);
	}

	async fetchUserVideos(
		uid: string,
		ps = 5,
	): Promise<
		Result<{
			data: {
				list?: {
					vlist?: Array<{ title?: string; play?: number; created?: number }>;
				};
			};
		}>
	> {
		return this.retryResult<{
			list?: {
				vlist?: Array<{ title?: string; play?: number; created?: number }>;
			};
		}>(
			() => this.wbiGet(EP.USER_VIDEOS_URL, { mid: uid, order: "pubdate", ps }),
			"fetchUserVideos",
		);
	}

	/**
	 * 单个视频的信息。接口 code 非 0(-404 不存在 / 62002 不可见 / 62012 仅自己可见…)
	 * 直接抛,带上对方的 message —— 调用方(链接解析)对任何失败都保持沉默,只记日志。
	 */
	async fetchVideoInfo(ref: VideoRef): Promise<VideoResponse> {
		const query =
			"bvid" in ref ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
		// wire 上的 data 字段远不止这些;`VideoResponse` 就是「我们用得到的那几个」的那份声明,
		// 下面逐字段抄一遍 —— 照单全收但不透传。
		const result = await this.getJson<{ code: number; message?: string; data?: VideoResponse }>(
			`${EP.VIDEO_INFO_URL}?${query}`,
			"fetchVideoInfo",
		);
		if (result.code !== 0 || !result.data) {
			throw new Error(
				serverText("bilibili.api.api.text.12", {
					value0: result.code,
					value1: result.message ?? "unknown",
				}),
			);
		}
		const d = result.data;
		return {
			bvid: d.bvid,
			aid: d.aid,
			title: d.title,
			pic: d.pic,
			desc: d.desc,
			duration: d.duration,
			pubdate: d.pubdate,
			tname: d.tname,
			owner: { mid: d.owner.mid, name: d.owner.name, face: d.owner.face },
			stat: {
				view: d.stat.view,
				danmaku: d.stat.danmaku,
				reply: d.stat.reply,
				favorite: d.stat.favorite,
				coin: d.stat.coin,
				share: d.stat.share,
				like: d.stat.like,
			},
		};
	}

	/**
	 * 把 b23.tv 短链解成落地地址。只认 b23.tv 输入、只认落在 bilibili.com 的目标 ——
	 * 短链是别人贴的,跟到哪儿就是让谁指挥我们。拿不到重定向、落到别处,一律 null。
	 */
	async resolveShortLink(url: string): Promise<string | null> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		if (parsed.hostname !== "b23.tv") return null;
		const location = await this.client.redirectLocation(parsed.toString());
		if (!location) return null;
		try {
			const host = new URL(location).hostname;
			if (host !== "bilibili.com" && !host.endsWith(".bilibili.com")) return null;
		} catch {
			return null;
		}
		return location;
	}

	async searchByType(
		searchType: string,
		keyword: string,
		opts?: { page?: number; pageSize?: number },
	): Promise<Result<{ data: unknown }>> {
		return this.retryResult<unknown>(
			async () => {
				const params: Record<string, string> = { search_type: searchType, keyword };
				if (opts?.page) params.page = String(opts.page);
				if (opts?.pageSize) params.page_size = String(opts.pageSize);
				return this.wbiGet(EP.SEARCH_BY_TYPE_URL, params);
			},
			"searchByType",
			{ [-403]: "rate_limited" },
		);
	}

	/**
	 * 查询"cookie 是否需要刷新"。该端点的 `csrf` 参数语义是 **bili_jct**(非
	 * refresh_token);此前误传 refreshToken,虽然该读接口靠 SESSDATA 鉴权、
	 * csrf 可选,传错多被服务端忽略,但与官方契约不符且一旦服务端开始校验
	 * 该参数即会整条刷新探测失效。统一传真实 bili_jct csrf。
	 */
	async fetchCookieInfo(csrf: string) {
		return this.getJson(
			`${EP.COOKIE_INFO_URL}?csrf=${encodeURIComponent(csrf)}`,
			"fetchCookieInfo",
		);
	}

	async follow(uid: string): Promise<Result<{ data: unknown }>> {
		// csrf(bili_jct)在每次尝试时现取:刷新轮换之后的重试要用新值。
		return this.retryResult<unknown>(
			() =>
				this.client.postForm(EP.RELATION_MODIFY_URL, {
					fid: uid,
					act: 1,
					re_src: 11,
					csrf: this.getCSRF(),
				}),
			"follow",
			undefined,
			FOLLOW_SUCCESS_CODES,
		);
	}

	/**
	 * 批量查询与多个 UP 的关系(已关注 / 未关注 / 被拉黑)。
	 *
	 * 用途:启动时一次问清「哪些订阅还没关注」,只对缺的补 follow —— 而不是对每个订阅
	 * 都盲发一次写请求。`relation/modify` 是写接口,风控比读严得多,订阅一多就很容易撞。
	 *
	 * 调用方必须把它当**优化**而非正确性依赖:失败 / 结构不符时要能降级成直接 follow
	 * (follow 本身幂等,22014=已关注)。
	 */
	async fetchRelations(uids: string[]): Promise<Result<{ data: RelationsResponse["data"] }>> {
		if (!uids.length) return ok({ data: {} });
		const list = uids.map((f) => encodeURIComponent(f)).join(",");
		return this.retryResult<RelationsResponse["data"]>(
			() => this.client.get(`${EP.RELATIONS_URL}?fids=${list}`),
			"fetchRelations",
		);
	}
}
