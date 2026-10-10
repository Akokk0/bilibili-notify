import type { Cookie, CookieJar, HttpClient, WebSocketLike } from "@bilibili-notify/http";
import {
	type Disposable,
	type Logger,
	retry as retryUtil,
	type ServiceContext,
} from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import { CronJob } from "cron";
import { ApiClient } from "./api-client";
import * as EP from "./endpoints";
import { createMyselfCache, type MyselfCache } from "./self-info-cache";
import type {
	LiveRoomDanmakuResponse,
	LiveRoomResponse,
	MasterInfoData,
	MyselfResponse,
	RelationStatResponse,
	RelationsResponse,
	TicketResponse,
	UserCardResponse,
	UserCardsResponse,
	VideoRef,
	VideoResponse,
} from "./types";
import { buildTicketParams, encWbi, type WbiKeys } from "./wbi";

interface CookiesRefreshedPayload {
	cookiesJson: string;
	refreshToken: string;
}

export interface ApiHandlers {
	/**
	 * Persist refreshed cookies. May be async — the refresh path `await`s it and
	 * loudly logs a reject (in-memory jar is already updated; only disk lagged),
	 * instead of the old `void`-typed fire-and-forget that let a persistence
	 * failure pass as a successful refresh with an unhandled rejection.
	 */
	onCookiesRefreshed?: (payload: CookiesRefreshedPayload) => Promise<void> | void;
	/** Fired when the upstream returns code -101 (session invalid). Debounced 60s. */
	onAuthLost?: () => void;
}

// Special UID: Bangumi Trip account has no live room; return a static room id
const BANGUMI_TRIP_UID = "11783021";
const BANGUMI_TRIP_ROOM_ID = 931774;
const AUTH_LOST_DEBOUNCE_MS = 60_000;

/**
 * cookie 刷新失败码分类(②4 裁决:**判别式**)。
 * - `"ok"`:code 0
 * - `"risk-control"`:`-352` / `-403` —— 风控/限流,**非会话终态**。退避等下个
 *   interval 自愈,绝不 auth-lost、绝不拆 refresh timer(误升级会把瞬时风控
 *   变成被动登出 —— 这正是 ②4 对前修复方向的反向质疑)
 * - `"terminal"`:`-101` 及其它非 0 码 —— 会话不可恢复,auth-lost + 清终态
 */
export type RefreshOutcome = "ok" | "risk-control" | "terminal";
export function classifyRefreshCode(code: number): RefreshOutcome {
	if (code === 0) return "ok";
	if (code === -352 || code === -403) return "risk-control";
	return "terminal";
}

/**
 * 持续风控错误(wbi 签名请求刷新 wbiKeys 重试后仍 -352)。标记成独立类型,让外层
 * `this.retry` 的 `shouldRetry` 识别并 **fail-fast** —— 持续风控再快速重试 3 轮只会
 * 放大打在被限流账号上的请求量。区别于瞬时网络错误(仍应退避重试)。
 */
export class RiskControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RiskControlError";
	}
}

export interface ApiOptions {
	serviceCtx: ServiceContext;
	callbacks?: ApiHandlers;
	/**
	 * 现成的请求客户端与它用的 cookie 罐(建法见 `default-headers.ts` 的 `createBiliHttp`):
	 * 浏览器身份与 B 站的默认头都在客户端里。两者必须是配对的 —— 客户端就是用这只罐子建的。
	 */
	http: HttpClient;
	jar: CookieJar;
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
	private readonly client: ApiClient;
	private wbiKeys: WbiKeys = { imgKey: "", subKey: "" };
	private ticketJob!: CronJob;
	private refreshCookieTimer?: Disposable;
	private loginInfoLoaded = false;
	private authLostFiredAt = 0;
	/**
	 * Bumped on every event that supersedes the cookie state a refresh was
	 * started against (loadCookies re-entry / clearCookies / -101 reset). An
	 * in-flight `checkIfTokenNeedRefresh` captures the value at entry and aborts
	 * before applying side effects if it changed — otherwise a slow refresh from
	 * a previous login lands late and `onCookiesRefreshed` overwrites the new
	 * session's cookies with stale ones.
	 */
	private refreshGeneration = 0;
	/** Single-in-flight guard so the hourly timer + loadCookies don't run the RSA dance concurrently. */
	private refreshInFlight = false;
	/**
	 * TicketResponse 在途去重。并发签名(或 wbiGet -352 清空 wbiKeys 后多个并行
	 * 重试)会各自触发一次 ticket POST 风暴;共享同一在途 Promise 收敛为一次。
	 */
	private biliTicketInFlight?: Promise<void>;
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
		this.jar = opts.jar;
		this.client = new ApiClient({
			http: opts.http,
			onBody: (body) => {
				const data = body as { code?: unknown } | undefined;
				if (data && typeof data.code === "number") this.maybeFireAuthLost(data.code);
			},
		});
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
		// 作废在途的 cookie 刷新:停下以后它不得再 onCookiesRefreshed 回写(关停返回后还落盘)。
		this.refreshGeneration++;
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
		return this.client.websocket(url);
	}

	// ---- Initialization ----

	/**
	 * Response-interceptor path: only `-101` (session invalid) from an arbitrary
	 * endpoint counts as auth-lost. `-352` etc. seen here are transient
	 * risk-control on data endpoints, NOT session death — must not widen this
	 * gate or every throttled data call would spuriously log the user out.
	 */
	private maybeFireAuthLost(code: number): void {
		if (code !== -101) return;
		this.fireAuthLost();
	}

	/**
	 * Debounced `onAuthLost` dispatch (60s). The caller has already decided the
	 * state is terminal — either interceptor `-101`, or a failed cookie-refresh
	 * chain (the authoritative session-liveness check; if it can't refresh, the
	 * session is unrecoverable and the user must re-scan).
	 */
	private fireAuthLost(): void {
		const now = Date.now();
		if (now - this.authLostFiredAt < AUTH_LOST_DEBOUNCE_MS) return;
		this.authLostFiredAt = now;
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
		this.refreshGeneration++;
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
		this.loginInfoLoaded = false;
		this.selfInfoCache.invalidate(); // 会话终态:账号身份不再有效,清缓存
		this.fireAuthLost();
		this.jar.clear();
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

	/** Load cookies from CookieData (decrypted by StorageManager) */
	async loadCookies(data: CookieData): Promise<void> {
		let cookies: Cookie[];
		try {
			const parsed = JSON.parse(data.cookiesJson);
			if (!Array.isArray(parsed)) throw new Error("cookiesJson 不是数组");
			cookies = parsed as Cookie[];
		} catch (e) {
			// 损坏的 cookiesJson 不得让整条启动链 reject 裸 SyntaxError —— 记 error
			// 后按「未登录」继续(等用户重新扫码),不 crash 进程。
			this.logger.error(
				`[cookie] cookiesJson 解析失败,本次不加载(需重新登录): ${(e as Error).message}`,
			);
			return;
		}
		this.logger.debug(
			`[cookie] 正在写入 ${cookies.length} 条 Cookie，refreshToken=${data.refreshToken ? "存在" : "缺失"}`,
		);

		this.selfInfoCache.invalidate(); // 换号:上一账号的身份缓存必须清掉

		const biliJctCookie = cookies.find((c) => c.key === "bili_jct");

		// 重载 / 换号:`load` 整罐换成这一批,旧 SESSDATA/bili_jct 绝不残留参与后续请求
		// (否则换号后旧会话 cookie 仍被发出,与 clearCookies 同源)。
		// Add a dummy buvid3 cookie if bili_jct is present (required by some APIs) —— 并进
		// 同一批:`load` 是替换语义,分两次调第二次会把第一批全抹掉。
		this.jar.load(
			biliJctCookie
				? [
						...cookies,
						{
							key: "buvid3",
							value: "some_non_empty_value",
							expires: biliJctCookie.expires,
							domain: biliJctCookie.domain,
							path: biliJctCookie.path,
							secure: biliJctCookie.secure,
						},
					]
				: cookies,
		);

		this.loginInfoLoaded = true;
		this.logger.debug(`[cookie] Cookie 写入完成，bili_jct=${biliJctCookie ? "存在" : "缺失"}`);

		// 重入(re-login / hot-reload):作废上一轮可能仍 in-flight 的 refresh,
		// 否则它完成时会用旧 jar 的 cookie 覆盖刚写入的新登录态。
		this.refreshGeneration++;

		if (data.refreshToken) {
			const csrf = biliJctCookie?.value ?? "";
			this.triggerRefreshCheck(data.refreshToken, csrf);
			this.enableRefreshCookiesInterval(data.refreshToken, csrf);
		}
	}

	/**
	 * Guarded fire-and-forget entry to {@link checkIfTokenNeedRefresh} used by
	 * the two internal triggers (loadCookies / hourly timer). Skips if a refresh
	 * is already running so the RSA/correspond/confirm dance never overlaps.
	 */
	private triggerRefreshCheck(refreshToken: string, csrf: string): void {
		if (this.refreshInFlight) {
			this.logger.debug("[cookie] 刷新检查已在进行,跳过本次触发");
			return;
		}
		this.refreshInFlight = true;
		// 登记进 track:刷新链最后一步要把新 cookie 落到 secrets/cookies.json(`onCookiesRefreshed`),
		// 关停得等它落完再让各写道关门。失败在交进去之前接住。
		this.serviceCtx.track(
			this.checkIfTokenNeedRefresh(refreshToken, csrf)
				.catch((e: Error) => this.logger.warn(`[cookie] Cookie 刷新检查失败: ${e.message}`))
				.finally(() => {
					this.refreshInFlight = false;
				}),
		);
	}

	markLoginInfoLoaded(): void {
		this.loginInfoLoaded = true;
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
		// 作废任何 in-flight refresh —— 登出后它不得再 onCookiesRefreshed 回写。
		this.refreshGeneration++;
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
		this.jar.clear();
		this.loginInfoLoaded = false;
		this.selfInfoCache.invalidate(); // 登出:清账号身份缓存
		this.logger.info("[cookie] 内存 cookie jar 已清空");
	}

	private enableRefreshCookiesInterval(refreshToken: string, csrf: string): void {
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = this.serviceCtx.setInterval(() => {
			const csrf2 = this.getCSRF() ?? csrf;
			this.triggerRefreshCheck(refreshToken, csrf2);
		}, 3_600_000);
	}

	// ---- Cookie refresh ----

	async checkIfTokenNeedRefresh(
		refreshToken: string,
		csrf: string,
		gen = this.refreshGeneration,
	): Promise<void> {
		// 入口 + 每次跨 await 后比对 gen:loadCookies/clearCookies/-101 任一发生
		// 都会 bump,本轮(及其重试链)随即作废,绝不把过期结果写回。
		if (gen !== this.refreshGeneration) {
			this.logger.debug("[cookie] 刷新已被更新的 cookie 状态取代,跳过本轮");
			return;
		}
		try {
			// 传真实 bili_jct(优先 live jar,回退调用方传入值),不是 refreshToken。
			const info = await this.fetchCookieInfo(this.getCSRF() ?? csrf);
			// 跨 await 后必须重校 gen(②修不全:此前缺这一处,旧 refreshToken
			// 在重登/登出后仍用新 jar 继续刷新)。
			if (gen !== this.refreshGeneration) {
				this.logger.debug("[cookie] 刷新已被更新的 cookie 状态取代(fetchCookieInfo 后),跳过本轮");
				return;
			}
			const probeCode = typeof info?.code === "number" ? info.code : 0;
			if (probeCode === -101) {
				// 探测即 -101:会话已死,直接终态,不再跑 RSA 链。
				await this.terminateSession("[cookie] fetchCookieInfo 返回 -101(账号未登录),终止会话");
				return;
			}
			if (classifyRefreshCode(probeCode) === "risk-control") {
				// 风控/限流:非终态。跳过本轮,等下个 interval 自愈(可 bili cap)。
				this.logger.warn(
					`[cookie] fetchCookieInfo 风控/限流 code=${probeCode},跳过本轮(不触发 auth-lost,可 bili cap 后等下轮自愈)`,
				);
				return;
			}
			if (!info?.data?.refresh) return;
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
		const correspondPath = encrypted.reduce((str, c) => str + c.toString(16).padStart(2, "0"), "");
		// 加密那两步也跨了 await。罐子只有一个、换号原地换(⑭a 起),换号之后这条旧链再发请求,带的就是新号的 cookie,
		// 回来的 Set-Cookie 会被当成新会话的收进去 —— 每跨一次 await 都比对,换了就不再发。
		if (gen !== this.refreshGeneration) {
			this.logger.debug("[cookie] 刷新在算 correspond 期间被取代,丢弃");
			return;
		}

		const html = await this.client.get(`${EP.COOKIE_REFRESH_CORRESPOND_PATH}/${correspondPath}`);
		if (gen !== this.refreshGeneration) {
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
			// triggerRefreshCheck 记 warn,下个 interval 再探(gen/timer 不动)。
			throw new Error("correspond 页面未解析到 refresh_csrf,跳过本轮刷新");
		}

		const refreshData = (await this.client.postForm(EP.COOKIE_REFRESH_URL, {
			csrf,
			refresh_csrf: refreshCsrf,
			source: "main_web",
			refresh_token: refreshToken,
		})) as { code: number; message: string; data: { refresh_token: string } };

		// RSA/correspond/refresh 这串网络往返期间若 cookie 状态已被替换,
		// 后面的 jar 重置 / 持久化都基于过期前提,丢弃本轮。
		if (gen !== this.refreshGeneration) {
			this.logger.debug("[cookie] 刷新结果在网络往返期间被取代,丢弃");
			return;
		}

		if (refreshData.code !== 0) {
			const outcome = classifyRefreshCode(refreshData.code);
			if (outcome === "risk-control") {
				// ②4 判别式:-352/-403 是风控/限流,**非会话终态**。不 auth-lost、
				// 不拆 timer —— 抛可重试错(triggerRefreshCheck 记 warn),下个
				// interval 自愈;误升级为终态登出正是 ②4 反质疑的过度修复。
				this.logger.warn(
					`[cookie] 刷新遇风控/限流 code=${refreshData.code} msg=${refreshData.message},跳过本轮(不触发 auth-lost,可 bili cap 后等下轮)`,
				);
				throw new Error(`Cookie 刷新被风控: code=${refreshData.code}`);
			}
			// 终态(-101 / 其它非0):②3 —— B2 此前只 emit 不清理,死会话每小时
			// 继续 RSA 轮换、isLoginInfoLoaded 误报。统一走 terminateSession 清净。
			await this.terminateSession(
				`[cookie] 刷新失败(会话终态)code=${refreshData.code} msg=${refreshData.message},触发 auth-lost`,
			);
			throw new Error(`Cookie 刷新失败: code=${refreshData.code}, message=${refreshData.message}`);
		}

		const newCsrf = this.getCSRF();
		if (!newCsrf) throw new Error("未找到 bili_jct cookie");

		const acceptData = (await this.client.postForm(EP.COOKIE_REFRESH_CONFIRM_URL, {
			csrf: newCsrf,
			refresh_token: refreshToken,
		})) as { code: number };

		if (acceptData.code !== 0) {
			if (classifyRefreshCode(acceptData.code) === "risk-control") {
				// confirm 步遇风控:同 B2,非终态,退避等下轮(不 auth-lost/不拆 timer)。
				this.logger.warn(
					`[cookie] 刷新确认遇风控/限流 code=${acceptData.code},跳过本轮(可 bili cap 后等下轮)`,
				);
				throw new Error(`Cookie 刷新确认被风控: code=${acceptData.code}`);
			}
			// confirm 终态:新旧 cookie 状态不可信,清净 + auth-lost(②3 同款)。
			await this.terminateSession(
				`[cookie] 刷新确认失败(会话终态)code=${acceptData.code},触发 auth-lost`,
			);
			throw new Error(`Cookie 刷新确认失败: code=${acceptData.code}`);
		}

		// confirm POST 之后再校一次:此刻才会写盘,绝不能用过期 gen 的结果
		// 覆盖一个更新的登录态。
		if (gen !== this.refreshGeneration) {
			this.logger.debug("[cookie] 刷新完成但已被取代,不回写持久化");
			return;
		}

		// 通知 core 持久化新 cookie。await + try/catch:持久化失败时内存 jar
		// 已是新 cookie、盘上仍旧值 —— 响亮记 error,不再 reject 逃逸成功判定。
		try {
			await this.callbacks.onCookiesRefreshed?.({
				cookiesJson: this.getCookiesJson() ?? "[]",
				refreshToken: refreshData.data.refresh_token,
			});
		} catch (e) {
			this.logger.error(
				`[cookie] onCookiesRefreshed 持久化失败(内存 cookie 已更新,盘上为旧值,下次启动将回退): ${(e as Error).message}`,
			);
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
			throw new Error(`获取 TicketResponse 失败: ${ticket.message}`);
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
	 */
	private async wbiGet(endpoint: string, params: Record<string, string | number | object>) {
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
				throw new RiskControlError("[wbi] 刷新 wbiKeys 后仍 -352(WBI 签名持续被拒/风控)");
			}
			return retried;
		}
		return data;
	}

	// ---- Request helpers ----

	private retry<T>(
		fn: () => Promise<T>,
		label: string,
		opts?: { shouldRetry?: (err: unknown) => boolean },
	): Promise<T> {
		return retryUtil(() => fn(), {
			attempts: 4, // 1 initial + 3 retries
			baseDelayMs: 200,
			shouldRetry: opts?.shouldRetry ? (err) => opts.shouldRetry?.(err) ?? true : undefined,
			onRetry: (err, attempt) => {
				const message = err instanceof Error ? err.message : String(err);
				this.logger.warn(`[retry] ${label}() 第 ${attempt} 次失败: ${message}`);
			},
		});
	}

	/**
	 * wbi 签名请求的外层 retry 判定:持续风控({@link RiskControlError})fail-fast,
	 * 瞬时网络错误仍退避重试。所有经 wbiGet 的公有方法共用。
	 */
	private static readonly retryUnlessRiskControl = {
		shouldRetry: (err: unknown) => !(err instanceof RiskControlError),
	};

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
	 * 表单 POST + retry(bilibili 写接口一律 x-www-form-urlencoded)。body 是
	 * 惰性闭包:csrf(bili_jct)必须在**每次尝试时**现取 —— 与旧实现把
	 * `getCSRF()` 写在 retry 闭包内的语义一致(刷新轮换后重试用新值)。
	 */
	// biome-ignore lint/suspicious/noExplicitAny: 见 getJson
	private postFormJson<T = any>(
		url: string,
		body: () => Record<string, string | number | boolean | undefined>,
		label: string,
	): Promise<T> {
		return this.retry(async () => (await this.client.postForm(url, body())) as T, label);
	}

	// ---- Public API methods ----

	async fetchAllDynamic() {
		return this.getJson(EP.ALL_DYNAMIC_URL, "fetchAllDynamic");
	}

	async fetchUserSpaceDynamic(uid: string) {
		return this.getJson(
			`${EP.USER_SPACE_DYNAMIC_URL}&host_mid=${encodeURIComponent(uid)}`,
			"fetchUserSpaceDynamic",
		);
	}

	async fetchLoginQrCode() {
		return this.getJson(EP.LOGIN_QR_CODE_URL, "fetchLoginQrCode");
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

	async fetchUserCard(uid: string, withPhoto = false): Promise<UserCardResponse> {
		return this.getJson(
			`${EP.USER_CARD_URL}?mid=${encodeURIComponent(uid)}${withPhoto ? "&photo=true" : ""}`,
			"fetchUserCard",
		);
	}

	/**
	 * 关系状态数(粉丝/关注)。粉丝计数轮询稳态用这个替代 `fetchUserCard` ——
	 * 载荷远小于整张主页卡,更贴近 B 站对「实时粉丝计数」的预期用法。
	 */
	async fetchRelationStat(uid: string): Promise<RelationStatResponse> {
		return this.getJson(
			`${EP.RELATION_STAT_URL}?vmid=${encodeURIComponent(uid)}`,
			"fetchRelationStat",
		);
	}

	/**
	 * 批量拉多用户 name/face(冷刷 cachedProfile 用)。**单次最多 50 个** uid ——
	 * 调用方负责分片;此处只发一个请求。空列表直接短路,不发请求。
	 */
	async fetchUserCards(uids: string[]): Promise<UserCardsResponse> {
		if (!uids.length) return { code: 0, data: {} };
		const list = uids.map((u) => encodeURIComponent(u)).join(",");
		return this.getJson(`${EP.USER_CARDS_URL}?uids=${list}`, "fetchUserCards");
	}

	async fetchUserInfo(uid: string, griskId?: string) {
		return this.retry(
			async () => {
				if (uid === BANGUMI_TRIP_UID) {
					return {
						code: 0,
						data: { live_room: { roomid: BANGUMI_TRIP_ROOM_ID } },
					};
				}
				const params: Record<string, string> = { mid: uid };
				if (griskId) params.grisk_id = griskId;
				return this.wbiGet(EP.USER_INFO_URL, params);
			},
			"fetchUserInfo",
			Api.retryUnlessRiskControl,
		);
	}

	async fetchLiveRoomInfo(roomId: string): Promise<LiveRoomResponse> {
		return this.getJson(
			`${EP.LIVE_ROOM_INFO_URL}?room_id=${encodeURIComponent(roomId)}`,
			"fetchLiveRoomInfo",
		);
	}

	/**
	 * 真 buvid3(设备指纹,与登录态无关)。弹幕连接认证包要用它 —— cookie 罐里那条
	 * 是 loadCookies 填的占位假值,不能进认证包。成功后进程内缓存;失败返回空串
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

	async getMasterInfo(uid: string): Promise<MasterInfoData> {
		return this.getJson(`${EP.MASTER_INFO_URL}?uid=${encodeURIComponent(uid)}`, "getMasterInfo");
	}

	async fetchLiveRoomInfoStreamKey(roomId: string): Promise<LiveRoomDanmakuResponse> {
		// getDanmuInfo 现已强制 wbi 签名，裸 GET 一律被风控拦成 -352。必须走
		// wbiGet（自动加 wts + w_rid，并自带 -352 → 刷新 wbiKeys 重试一次的自愈）。
		return this.retry(
			async () => this.wbiGet(EP.LIVE_ROOM_INFO_STREAM_KEY_URL, { id: roomId }),
			"fetchLiveRoomInfoStreamKey",
			Api.retryUnlessRiskControl,
		);
	}

	async fetchLiveRoomInfoByUids(uids: string[]) {
		if (!uids.length) return { code: 0, data: {} };
		const params = uids.map((uid) => `uids[]=${encodeURIComponent(uid)}`).join("&");
		return this.getJson(`${EP.LIVE_ROOMS_INFO_URL}?${params}`, "fetchLiveRoomInfoByUids");
	}

	async fetchUserInfoInLive(uid: string, upUid: string) {
		return this.getJson(
			`${EP.USER_INFO_IN_LIVE_URL}?uid=${encodeURIComponent(uid)}&ruid=${encodeURIComponent(upUid)}`,
			"fetchUserInfoInLive",
		);
	}

	async fetchUserUpstat(uid: string) {
		return this.getJson(`${EP.USER_UPSTAT_URL}?mid=${encodeURIComponent(uid)}`, "fetchUserUpstat");
	}

	async fetchUserNavnum(uid: string) {
		return this.getJson(`${EP.USER_NAVNUM_URL}?mid=${encodeURIComponent(uid)}`, "fetchUserNavnum");
	}

	async fetchUserVideos(uid: string, ps = 5) {
		return this.retry(
			async () => this.wbiGet(EP.USER_VIDEOS_URL, { mid: uid, order: "pubdate", ps }),
			"fetchUserVideos",
			Api.retryUnlessRiskControl,
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
			throw new Error(`获取视频信息失败(${result.code}): ${result.message ?? "unknown"}`);
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
	) {
		return this.retry(
			async () => {
				const params: Record<string, string> = { search_type: searchType, keyword };
				if (opts?.page) params.page = String(opts.page);
				if (opts?.pageSize) params.page_size = String(opts.pageSize);
				return this.wbiGet(EP.SEARCH_BY_TYPE_URL, params);
			},
			"searchByType",
			Api.retryUnlessRiskControl,
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

	async follow(uid: string) {
		return this.postFormJson(
			EP.RELATION_MODIFY_URL,
			() => ({ fid: uid, act: 1, re_src: 11, csrf: this.getCSRF() }),
			"follow",
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
	async fetchRelations(uids: string[]): Promise<RelationsResponse> {
		if (!uids.length) return { code: 0, data: {} };
		const list = uids.map((f) => encodeURIComponent(f)).join(",");
		return this.getJson(`${EP.RELATIONS_URL}?fids=${list}`, "fetchRelations");
	}
}
