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
		this.logger.debug("[init] BiliTicket 已更新，API 初始化完成");
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

	/** Fire onAuthLost only when code === -101, with a 60s debounce to avoid burst calls. */
	private maybeFireAuthLost(code: number): void {
		if (code !== -101) return;
		const now = Date.now();
		if (now - this.authLostFiredAt < AUTH_LOST_DEBOUNCE_MS) return;
		this.authLostFiredAt = now;
		try {
			this.callbacks.onAuthLost?.();
		} catch (e) {
			this.logger.warn(`[auth] onAuthLost 回调抛错: ${e}`);
		}
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
			this.logger.error(`[cookie] 获取 cookies 失败: ${e}`);
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
		const cookies = JSON.parse(data.cookiesJson) as BACookie[];
		this.logger.debug(
			`[cookie] 正在写入 ${cookies.length} 条 Cookie，refreshToken=${data.refreshToken ? "存在" : "缺失"}`,
		);

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
		attempts = 3,
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
			if (!info?.data?.refresh) return;
		} catch (e) {
			if (attempts > 1) {
				// serviceCtx.setTimeout 让 plugin/runtime dispose 能立即 clear,
				// 否则裸 setTimeout 让 3s 重试链在 stop() 后还会触发一次 fetch。
				await new Promise<void>((resolveSleep) => {
					this.serviceCtx.setTimeout(resolveSleep, 3000);
				});
				return this.checkIfTokenNeedRefresh(refreshToken, csrf, attempts - 1, gen);
			}
			// 重试耗尽:**不能** fall through 去强制 refresh —— 我们此刻并不知道
			// cookie 是否真需要刷新,一次瞬时网络抖动就触发整条 RSA/correspond/
			// refresh/confirm 轮换(每小时一次不必要的 cookie 旋转,放大风控)。
			// 放弃本轮,等下个 interval 再探测。
			this.logger.warn(`[cookie] 刷新探测连续失败,跳过本轮(不强制刷新): ${(e as Error).message}`);
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
		const refreshCsrf = document.getElementById("1-name")?.textContent ?? null;

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

		if (refreshData.code === -101) {
			this.logger.warn(
				"[cookie] 刷新接口返回 -101（账号未登录），已重置 HTTP 客户端，需重新扫码登录",
			);
			// session 失效 ⇒ 作废所有 in-flight refresh。
			this.refreshGeneration++;
			this.maybeFireAuthLost(-101);
			this.jar = new CookieJar();
			await this.initClient();
			return;
		}
		if (refreshData.code !== 0) {
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

	private async updateBiliTicket(): Promise<void> {
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
			async () => (await this.client.get(`${EP.GET_USER_SPACE_DYNAMIC_LIST}&host_mid=${mid}`)).data,
			"getUserSpaceDynamic",
		);
	}

	async hasNewDynamic(updateBaseline: string) {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.HAS_NEW_DYNAMIC}?update_baseline=${updateBaseline}`)).data,
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
			async () => (await this.client.get(`${EP.GET_LOGIN_STATUS}?qrcode_key=${qrcodeKey}`)).data,
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
			const url = `${EP.GET_USER_CARD_INFO}?mid=${mid}${withPhoto ? "&photo=true" : ""}`;
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
			const wbi = await this.getWbi(params);
			return (await this.client.get(`${EP.GET_USER_INFO}?${wbi}`)).data;
		}, "getUserInfo");
	}

	async getLiveRoomInfo(roomId: string): Promise<LiveRoomInfo> {
		return this.retry(
			async () => (await this.client.get(`${EP.GET_LIVE_ROOM_INFO}?room_id=${roomId}`)).data,
			"getLiveRoomInfo",
		);
	}

	async getMasterInfo(uid: string): Promise<MasterInfoData> {
		return this.retry(
			async () => (await this.client.get(`${EP.GET_MASTER_INFO}?uid=${uid}`)).data,
			"getMasterInfo",
		);
	}

	async getLiveRoomInfoStreamKey(roomId: string) {
		return this.retry(
			async () => (await this.client.get(`${EP.GET_LIVE_ROOM_INFO_STREAM_KEY}?id=${roomId}`)).data,
			"getLiveRoomInfoStreamKey",
		);
	}

	async getLiveRoomInfoByUids(uids: string[]) {
		if (!uids.length) return { code: 0, data: {} };
		return this.retry(async () => {
			const params = uids.map((uid) => `uids[]=${uid}`).join("&");
			return (await this.client.get(`${EP.GET_LIVE_ROOMS_INFO}?${params}`)).data;
		}, "getLiveRoomInfoByUids");
	}

	async getOnlineGoldRank(roomId: string, ruid: string, page = 1, pageSize = 20) {
		return this.retry(
			async () =>
				(
					await this.client.get(
						`${EP.GET_ONLINE_GOLD_RANK}?room_id=${roomId}&ruid=${ruid}&page=${page}&page_size=${pageSize}`,
					)
				).data,
			"getOnlineGoldRank",
		);
	}

	async getUserInfoInLive(uid: string, ruid: string) {
		return this.retry(
			async () =>
				(await this.client.get(`${EP.GET_USER_INFO_IN_LIVE}?uid=${uid}&ruid=${ruid}`)).data,
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
			async () => (await this.client.get(`${EP.GET_USER_UPSTAT}?mid=${mid}`)).data,
			"getUserUpstat",
		);
	}

	async getUserNavnum(mid: string) {
		return this.retry(
			async () => (await this.client.get(`${EP.GET_USER_NAVNUM}?mid=${mid}`)).data,
			"getUserNavnum",
		);
	}

	async getUserVideos(mid: string, ps = 5) {
		return this.retry(async () => {
			const wbi = await this.getWbi({ mid, order: "pubdate", ps });
			return (await this.client.get(`${EP.GET_USER_VIDEOS}?${wbi}`)).data;
		}, "getUserVideos");
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
			const wbi = await this.getWbi(params);
			return (await this.client.get(`${EP.SEARCH_BY_TYPE}?${wbi}`)).data;
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
			async () => (await this.client.get(`${EP.GET_COOKIES_INFO}?csrf=${csrf}`)).data,
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
		const { data } = await this.client.post(
			EP.V_VOUCHER_CAPTCHA_URL,
			{ csrf, v_voucher },
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
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
		const { data } = await this.client.post(
			EP.VALIDATE_CAPTCHA_URL,
			{ csrf, challenge, token, validate, seccode },
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
		);
		const result = data as ValidateCaptchaData;
		if (result.code !== 0) {
			this.logger.warn(`[captcha] 验证失败: code=${result.code}`);
			return null;
		}
		// Persist grisk_id as a cookie
		this.addCookie(`x-bili-gaia-vtoken=${result.data?.grisk_id}`);
		return result.data;
	}
}
