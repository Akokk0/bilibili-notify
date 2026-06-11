import {
	type Disposable,
	type Logger,
	retry as retryUtil,
	type ServiceContext,
} from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import axios, { type AxiosInstance } from "axios";
import { CronJob } from "cron";
import { JSDOM } from "jsdom";
import { DateTime } from "luxon";
import { Cookie, CookieJar } from "tough-cookie";
import * as EP from "./endpoints";
import type {
	BACookie,
	BiliTicket,
	LiveRoomDanmuInfo,
	LiveRoomInfo,
	MasterInfoData,
	MySelfInfoData,
	UserCardInfoData,
	V_VoucherCaptchaData,
	ValidateCaptchaData,
} from "./types";
import { buildTicketParams, encWbi, type WbiKeys } from "./wbi";

export interface CookiesRefreshedPayload {
	cookiesJson: string;
	refreshToken: string;
}

export interface BilibiliAPICallbacks {
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

export interface BilibiliAPIConfig {
	userAgent?: string;
}

export interface BilibiliAPIOptions {
	serviceCtx: ServiceContext;
	config: BilibiliAPIConfig;
	callbacks?: BilibiliAPICallbacks;
}

export class BilibiliAPI {
	readonly logger: Logger;
	private readonly serviceCtx: ServiceContext;
	private config: BilibiliAPIConfig;
	private readonly callbacks: BilibiliAPICallbacks;

	private jar: CookieJar;
	private client!: AxiosInstance;
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
	 * BiliTicket 在途去重。并发签名(或 wbiGet -352 清空 wbiKeys 后多个并行
	 * 重试)会各自触发一次 ticket POST 风暴;共享同一在途 Promise 收敛为一次。
	 */
	private biliTicketInFlight?: Promise<void>;

	constructor(opts: BilibiliAPIOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.config = opts.config;
		this.callbacks = opts.callbacks ?? {};
		this.logger = opts.serviceCtx.logger;
		this.jar = new CookieJar();
	}

	async start(): Promise<void> {
		await this.initClient();
		this.logger.debug("[init] HTTP 客户端初始化完成");

		// Daily ticket refresh at midnight (Beijing time, where bilibili.com lives).
		this.ticketJob = new CronJob(
			"0 0 * * *",
			() => {
				this.updateBiliTicket().catch((e: Error) =>
					this.logger.error(`[init] 更新 BiliTicket 失败: ${e.message}`),
				);
			},
			null,
			false,
			"Asia/Shanghai",
		);
		this.ticketJob.start();
		await this.updateBiliTicket();
		this.logger.info("[init] BiliTicket 已更新，API 初始化完成");
	}

	stop(): void {
		this.ticketJob?.stop();
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
	}

	/**
	 * 热替换 User-Agent。adapter 在 dashboard 编辑 `app.userAgent` 后调用,
	 * 直接改 axios 实例的 default headers,后续请求生效;已 in-flight 的请求
	 * 仍走旧 UA。`undefined` / 空串 → 回退到内置默认 Firefox UA。
	 */
	setUserAgent(userAgent: string | undefined): void {
		const ua = userAgent?.trim()
			? userAgent
			: "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0";
		this.config = { ...this.config, userAgent };
		if (this.client) {
			this.client.defaults.headers["User-Agent"] = ua;
			this.logger.info(`[init] User-Agent 已更新: ${ua}`);
		}
	}

	// ---- Initialization ----

	private async initClient(): Promise<void> {
		const { wrapper } = await import("axios-cookiejar-support");
		this.client = wrapper(
			axios.create({
				jar: this.jar,
				// 有限超时:无 timeout 时一个挂起连接(对端不回 / 半开 TCP)会让
				// 该请求永不结束 —— 卡死整条刷新链 / API 调用且不进 retry。20s 覆盖
				// 连接 + 响应,超时抛 ECONNABORTED 由 this.retry 正常退避重试。
				timeout: 20_000,
				headers: {
					"Content-Type": "application/json",
					"User-Agent":
						(this.config as BilibiliAPIConfig).userAgent ||
						"Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
					Origin: "https://www.bilibili.com",
					Referer: "https://www.bilibili.com/",
					priority: "u=1, i",
					"sec-ch-ua": '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
					"sec-ch-ua-mobile": "?0",
					"sec-ch-ua-platform": '"Linux"',
					"sec-fetch-dest": "empty",
					"sec-fetch-mode": "cors",
					"sec-fetch-site": "same-site",
				},
			}),
		);
		this.client.interceptors.response.use((response) => {
			const data = response.data as { code?: unknown } | undefined;
			if (data && typeof data.code === "number") this.maybeFireAuthLost(data.code);
			return response;
		});
	}

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
		this.fireAuthLost();
		this.jar = new CookieJar();
		await this.initClient();
	}

	// ---- Cookie management ----

	addCookie(cookieStr: string): void {
		this.jar.setCookieSync(
			`${cookieStr}; path=/; domain=.bilibili.com`,
			"https://www.bilibili.com",
		);
	}

	getCookiesJson(): string | undefined {
		try {
			return JSON.stringify(this.jar.serializeSync()?.cookies ?? []);
		} catch (e) {
			this.logger.warn(`[cookie] 获取 cookies 失败: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	getCookiesHeader(): string {
		try {
			return (this.jar.serializeSync()?.cookies ?? []).map((c) => `${c.key}=${c.value}`).join("; ");
		} catch {
			return "";
		}
	}

	private getCSRF(): string | undefined {
		return this.jar.serializeSync()?.cookies.find((c) => c.key === "bili_jct")?.value;
	}

	/** Load cookies from CookieData (decrypted by StorageManager) */
	async loadCookies(data: CookieData): Promise<void> {
		let cookies: BACookie[];
		try {
			const parsed = JSON.parse(data.cookiesJson);
			if (!Array.isArray(parsed)) throw new Error("cookiesJson 不是数组");
			cookies = parsed as BACookie[];
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

		// 重载 / 换号:先重建 jar + 重绑 client,旧 SESSDATA/bili_jct 绝不残留
		// 参与后续请求(否则换号后旧会话 cookie 仍被发出,与 clearCookies 同源)。
		this.jar = new CookieJar();
		await this.initClient();

		const biliJctCookie = cookies.find((c) => c.key === "bili_jct");

		for (const cd of cookies) {
			const cookie = new Cookie({
				key: cd.key,
				value: cd.value,
				expires: this.parseExpires(cd.expires),
				domain: cd.domain,
				path: cd.path,
				secure: cd.secure,
				httpOnly: cd.httpOnly,
				sameSite: cd.sameSite,
			});
			this.jar.setCookieSync(
				cookie,
				`http${cookie.secure ? "s" : ""}://${cookie.domain}${cookie.path}`,
			);
		}

		// Add a dummy buvid3 cookie if bili_jct is present (required by some APIs)
		if (biliJctCookie) {
			const buvid3 = new Cookie({
				key: "buvid3",
				value: "some_non_empty_value",
				expires: this.parseExpires(biliJctCookie.expires),
				domain: biliJctCookie.domain,
				path: biliJctCookie.path,
				secure: biliJctCookie.secure,
			});
			this.jar.setCookieSync(
				buvid3,
				`http${buvid3.secure ? "s" : ""}://${buvid3.domain}${buvid3.path}`,
			);
		}

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
		this.checkIfTokenNeedRefresh(refreshToken, csrf)
			.catch((e: Error) => this.logger.warn(`[cookie] Cookie 刷新检查失败: ${e.message}`))
			.finally(() => {
				this.refreshInFlight = false;
			});
	}

	markLoginInfoLoaded(): void {
		this.loginInfoLoaded = true;
	}

	isLoginInfoLoaded(): boolean {
		return this.loginInfoLoaded;
	}

	/**
	 * 清空内存 cookie jar(登出 / 密钥重置)。调用方此前只删盘 cookie 而不清
	 * 这里,导致 api 仍以 stale SESSDATA/bili_jct 发已认证请求,直到进程重启
	 * (安全缺陷,P0-2)。重建 jar + 重绑 client(沿用 -101 路径同款做法,
	 * 旧 client 仍持旧 jar 引用,必须 initClient 重绑),停掉刷新定时器
	 * (登出后已无 refreshToken 可刷),标记未登录。
	 */
	async clearCookies(): Promise<void> {
		// 作废任何 in-flight refresh —— 登出后它不得再 onCookiesRefreshed 回写。
		this.refreshGeneration++;
		this.refreshCookieTimer?.dispose();
		this.refreshCookieTimer = undefined;
		this.jar = new CookieJar();
		await this.initClient();
		this.loginInfoLoaded = false;
		this.logger.info("[cookie] 内存 cookie jar 已清空");
	}

	private parseExpires(expires?: string): Date | "Infinity" {
		if (!expires || expires === "Infinity") return "Infinity";
		return DateTime.fromISO(expires).toJSDate();
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
			const info = await this.getCookieInfo(this.getCSRF() ?? csrf);
			// 跨 await 后必须重校 gen(②修不全:此前缺这一处,旧 refreshToken
			// 在重登/登出后仍用新 jar 继续刷新)。
			if (gen !== this.refreshGeneration) {
				this.logger.debug("[cookie] 刷新已被更新的 cookie 状态取代(getCookieInfo 后),跳过本轮");
				return;
			}
			const probeCode = typeof info?.code === "number" ? info.code : 0;
			if (probeCode === -101) {
				// 探测即 -101:会话已死,直接终态,不再跑 RSA 链。
				await this.terminateSession("[cookie] getCookieInfo 返回 -101(账号未登录),终止会话");
				return;
			}
			if (classifyRefreshCode(probeCode) === "risk-control") {
				// 风控/限流:非终态。跳过本轮,等下个 interval 自愈(可 bili cap)。
				this.logger.warn(
					`[cookie] getCookieInfo 风控/限流 code=${probeCode},跳过本轮(不触发 auth-lost,可 bili cap 后等下轮自愈)`,
				);
				return;
			}
			if (!info?.data?.refresh) return;
		} catch (e) {
			// P2:此前这里还有一层 3 次 ×3s 递归重试,而内层 getCookieInfo 已被
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

		const ts = DateTime.now().toMillis();
		const data = new TextEncoder().encode(`refresh_${ts}`);
		const encrypted = new Uint8Array(
			await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, data),
		);
		const correspondPath = encrypted.reduce((str, c) => str + c.toString(16).padStart(2, "0"), "");

		const { data: html } = await this.client.get(
			`${EP.COOKIE_REFRESH_CORRESPOND_PATH}/${correspondPath}`,
		);
		const { document } = new JSDOM(html).window;
		const refreshCsrf = document.getElementById("1-name")?.textContent?.trim() || null;
		if (!refreshCsrf) {
			// correspond 页面没解析出 refresh_csrf(B 站返回异常 / 结构变更):
			// 绝不 POST 一个 null refresh_csrf(必失败且语义不明)。抛可重试错,
			// triggerRefreshCheck 记 warn,下个 interval 再探(gen/timer 不动)。
			throw new Error("correspond 页面未解析到 refresh_csrf,跳过本轮刷新");
		}

		const { data: refreshData } = await this.client.post(
			EP.COOKIE_REFRESH_URL,
			{
				csrf,
				refresh_csrf: refreshCsrf,
				source: "main_web",
				refresh_token: refreshToken,
			},
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
		);

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

		const { data: acceptData } = await this.client.post(
			EP.COOKIE_REFRESH_CONFIRM_URL,
			{ csrf: newCsrf, refresh_token: refreshToken },
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
		);

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
				refreshToken: refreshData.data.refresh_token as string,
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
		const ticket = (await this.getBiliTicket(csrf)) as BiliTicket;
		if (ticket.code !== 0) {
			throw new Error(`获取 BiliTicket 失败: ${ticket.message}`);
		}
		const extract = (url: string) => url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("."));
		this.wbiKeys = {
			imgKey: extract(ticket.data.nav.img),
			subKey: extract(ticket.data.nav.sub),
		};
	}

	private async getBiliTicket(csrf?: string): Promise<BiliTicket> {
		const params = buildTicketParams(csrf);
		const resp = await this.client.post(
			`${EP.BILI_TICKET_URL}?${params.toString()}`,
			{},
			{
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
				},
			},
		);
		return resp.data as BiliTicket;
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
			return (await this.client.get(`${endpoint}?${wbi}`)).data;
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
				throw new Error("[wbi] 刷新 wbiKeys 后仍 -352(WBI 签名持续被拒/风控)");
			}
			return retried;
		}
		return data;
	}

	// ---- Retry helper ----

	private retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
		return retryUtil(() => fn(), {
			attempts: 4, // 1 initial + 3 retries
			baseDelayMs: 200,
			onRetry: (err, attempt) => {
				const message = err instanceof Error ? err.message : String(err);
				this.logger.warn(`[retry] ${label}() 第 ${attempt} 次失败: ${message}`);
			},
		});
	}

	// ---- Public API methods ----

	async getAllDynamic() {
		return this.retry(
			async () => (await this.client.get(EP.GET_ALL_DYNAMIC_LIST)).data,
			"getAllDynamic",
		);
	}

	async getUserSpaceDynamic(mid: string) {
		return this.retry(
			async () =>
				(
					await this.client.get(
						`${EP.GET_USER_SPACE_DYNAMIC_LIST}&host_mid=${encodeURIComponent(mid)}`,
					)
				).data,
			"getUserSpaceDynamic",
		);
	}

	async hasNewDynamic(updateBaseline: string) {
		return this.retry(
			async () =>
				(
					await this.client.get(
						`${EP.HAS_NEW_DYNAMIC}?update_baseline=${encodeURIComponent(updateBaseline)}`,
					)
				).data,
			"hasNewDynamic",
		);
	}

	async getLoginQRCode() {
		return this.retry(
			async () => (await this.client.get(EP.GET_LOGIN_QRCODE)).data,
			"getLoginQRCode",
		);
	}

	async getLoginStatus(qrcodeKey: string) {
		return this.retry(
			async () =>
				(
					await this.client.get(
						`${EP.GET_LOGIN_STATUS}?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
					)
				).data,
			"getLoginStatus",
		);
	}

	async getMyselfInfo(): Promise<MySelfInfoData> {
		return this.retry(
			async () => (await this.client.get(EP.GET_MYSELF_INFO)).data,
			"getMyselfInfo",
		);
	}

	async getUserCardInfo(mid: string, withPhoto = false): Promise<UserCardInfoData> {
		return this.retry(async () => {
			const url = `${EP.GET_USER_CARD_INFO}?mid=${encodeURIComponent(mid)}${withPhoto ? "&photo=true" : ""}`;
			return (await this.client.get(url)).data;
		}, "getUserCardInfo");
	}

	async getUserInfo(mid: string, griskId?: string) {
		return this.retry(async () => {
			if (mid === BANGUMI_TRIP_UID) {
				return {
					code: 0,
					data: { live_room: { roomid: BANGUMI_TRIP_ROOM_ID } },
				};
			}
			const params: Record<string, string> = { mid };
			if (griskId) params.grisk_id = griskId;
			return this.wbiGet(EP.GET_USER_INFO, params);
		}, "getUserInfo");
	}

	async getLiveRoomInfo(roomId: string): Promise<LiveRoomInfo> {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.GET_LIVE_ROOM_INFO}?room_id=${encodeURIComponent(roomId)}`))
					.data,
			"getLiveRoomInfo",
		);
	}

	async getMasterInfo(uid: string): Promise<MasterInfoData> {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.GET_MASTER_INFO}?uid=${encodeURIComponent(uid)}`)).data,
			"getMasterInfo",
		);
	}

	async getLiveRoomInfoStreamKey(roomId: string): Promise<LiveRoomDanmuInfo> {
		// getDanmuInfo 现已强制 wbi 签名，裸 client.get 一律被风控拦成 -352。必须走
		// wbiGet（自动加 wts + w_rid，并自带 -352 → 刷新 wbiKeys 重试一次的自愈）。
		return this.retry(
			async () => this.wbiGet(EP.GET_LIVE_ROOM_INFO_STREAM_KEY, { id: roomId }),
			"getLiveRoomInfoStreamKey",
		);
	}

	async getLiveRoomInfoByUids(uids: string[]) {
		if (!uids.length) return { code: 0, data: {} };
		return this.retry(async () => {
			const params = uids.map((uid) => `uids[]=${encodeURIComponent(uid)}`).join("&");
			return (await this.client.get(`${EP.GET_LIVE_ROOMS_INFO}?${params}`)).data;
		}, "getLiveRoomInfoByUids");
	}

	async getOnlineGoldRank(roomId: string, ruid: string, page = 1, pageSize = 20) {
		return this.retry(
			async () =>
				(
					await this.client.get(
						`${EP.GET_ONLINE_GOLD_RANK}?room_id=${encodeURIComponent(roomId)}&ruid=${encodeURIComponent(ruid)}&page=${page}&page_size=${pageSize}`,
					)
				).data,
			"getOnlineGoldRank",
		);
	}

	async getUserInfoInLive(uid: string, ruid: string) {
		return this.retry(
			async () =>
				(
					await this.client.get(
						`${EP.GET_USER_INFO_IN_LIVE}?uid=${encodeURIComponent(uid)}&ruid=${encodeURIComponent(ruid)}`,
					)
				).data,
			"getUserInfoInLive",
		);
	}

	async getTheUserWhoIsLiveStreaming() {
		return this.retry(
			async () => (await this.client.get(EP.GET_LATEST_UPDATED_UPS)).data,
			"getTheUserWhoIsLiveStreaming",
		);
	}

	async getUserUpstat(mid: string) {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.GET_USER_UPSTAT}?mid=${encodeURIComponent(mid)}`)).data,
			"getUserUpstat",
		);
	}

	async getUserNavnum(mid: string) {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.GET_USER_NAVNUM}?mid=${encodeURIComponent(mid)}`)).data,
			"getUserNavnum",
		);
	}

	async getUserVideos(mid: string, ps = 5) {
		return this.retry(
			async () => this.wbiGet(EP.GET_USER_VIDEOS, { mid, order: "pubdate", ps }),
			"getUserVideos",
		);
	}

	async searchByType(
		searchType: string,
		keyword: string,
		opts?: { page?: number; pageSize?: number },
	) {
		return this.retry(async () => {
			const params: Record<string, string> = { search_type: searchType, keyword };
			if (opts?.page) params.page = String(opts.page);
			if (opts?.pageSize) params.page_size = String(opts.pageSize);
			return this.wbiGet(EP.SEARCH_BY_TYPE, params);
		}, "searchByType");
	}

	/**
	 * 查询"cookie 是否需要刷新"。该端点的 `csrf` 参数语义是 **bili_jct**(非
	 * refresh_token);此前误传 refreshToken,虽然该读接口靠 SESSDATA 鉴权、
	 * csrf 可选,传错多被服务端忽略,但与官方契约不符且一旦服务端开始校验
	 * 该参数即会整条刷新探测失效。统一传真实 bili_jct csrf。
	 */
	async getCookieInfo(csrf: string) {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.GET_COOKIES_INFO}?csrf=${encodeURIComponent(csrf)}`)).data,
			"getCookieInfo",
		);
	}

	async follow(fid: string) {
		return this.retry(async () => {
			const csrf = this.getCSRF();
			return (
				await this.client.post(
					EP.MODIFY_RELATION,
					{ fid, act: 1, re_src: 11, csrf },
					{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
				)
			).data;
		}, "follow");
	}

	async createGroup(tag: string) {
		return this.retry(async () => {
			return (
				await this.client.post(
					EP.CREATE_GROUP,
					{ tag, csrf: this.getCSRF() },
					{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
				)
			).data;
		}, "createGroup");
	}

	async getAllGroup() {
		return this.retry(async () => (await this.client.get(EP.GET_ALL_GROUP)).data, "getAllGroup");
	}

	async copyUserToGroup(mid: string, groupId: string) {
		return this.retry(async () => {
			return (
				await this.client.post(
					EP.COPY_USER_TO_GROUP,
					{ fids: mid, tagids: groupId, csrf: this.getCSRF() },
					{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
				)
			).data;
		}, "copyUserToGroup");
	}

	async getRelationGroupDetail(tagid: string) {
		return this.retry(
			async () => (await this.client.get(`${EP.GET_RELATION_GROUP_DETAIL}?tagid=${tagid}`)).data,
			"getRelationGroupDetail",
		);
	}

	async v_voucherCaptcha(v_voucher: string): Promise<V_VoucherCaptchaData["data"]> {
		const csrf = this.getCSRF();
		// P2:与其余接口一致走 this.retry。**仅网络 POST 进 retry**,code≠0 是
		// 逻辑失败(非瞬时)放在 retry 外判,避免对逻辑错误盲重试 4 次。
		const data = await this.retry(
			async () =>
				(
					await this.client.post(
						EP.V_VOUCHER_CAPTCHA_URL,
						{ csrf, v_voucher },
						{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
					)
				).data,
			"v_voucherCaptcha",
		);
		const result = data as V_VoucherCaptchaData;
		if (result.code !== 0) throw new Error(`获取验证码失败: ${result.message}`);
		return result.data;
	}

	async validateCaptcha(
		challenge: string,
		token: string,
		validate: string,
		seccode: string,
	): Promise<ValidateCaptchaData["data"] | null> {
		const csrf = this.getCSRF();
		// P2:与其余接口一致走 this.retry(仅网络 POST 进 retry;code≠0 在外判)。
		const data = await this.retry(
			async () =>
				(
					await this.client.post(
						EP.VALIDATE_CAPTCHA_URL,
						{ csrf, challenge, token, validate, seccode },
						{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
					)
				).data,
			"validateCaptcha",
		);
		const result = data as ValidateCaptchaData;
		if (result.code !== 0) {
			this.logger.debug(`[captcha] 验证失败: code=${result.code}`);
			return null;
		}
		// code===0 但 data===null(B 站常见):此前仍 addCookie("...=undefined")
		// 污染 jar。强校验 grisk_id 存在才写 cookie。
		if (!result.data?.grisk_id) {
			this.logger.debug("[captcha] code=0 但缺 grisk_id,不写 x-bili-gaia-vtoken cookie");
			return null;
		}
		this.addCookie(`x-bili-gaia-vtoken=${result.data.grisk_id}`);
		return result.data;
	}
}
