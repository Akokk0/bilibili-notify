import http from "node:http";
import https from "node:https";
import type { CookieData } from "@bilibili-notify/storage";
import axios, { type AxiosInstance } from "axios";
import { CronJob } from "cron";
import { JSDOM } from "jsdom";
import type { Context, Logger } from "koishi";
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

// Special UID: Bangumi Trip account has no live room; return a static room id
const BANGUMI_TRIP_UID = "11783021";
const BANGUMI_TRIP_ROOM_ID = 931774;

export interface BilibiliAPIConfig {
	logLevel: number;
	userAgent?: string;
}

export class BilibiliAPI {
	readonly logger: Logger;
	private readonly config: BilibiliAPIConfig;
	private readonly onCookiesRefreshed?: (payload: CookiesRefreshedPayload) => void;

	private jar: CookieJar;
	private client!: AxiosInstance;
	// biome-ignore lint/suspicious/noExplicitAny: ESM-only module loaded dynamically
	private cacheable: any;
	// biome-ignore lint/suspicious/noExplicitAny: ESM-only module loaded dynamically
	private pRetry!: any;
	// biome-ignore lint/suspicious/noExplicitAny: ESM-only module loaded dynamically
	private AbortError!: any;
	private wbiKeys: WbiKeys = { imgKey: "", subKey: "" };
	private ticketJob!: CronJob;
	private refreshCookieIntervalId?: ReturnType<typeof setInterval>;
	private loginInfoLoaded = false;

	constructor(
		ctx: Context,
		config: BilibiliAPIConfig,
		onCookiesRefreshed?: (payload: CookiesRefreshedPayload) => void,
	) {
		this.config = config;
		this.onCookiesRefreshed = onCookiesRefreshed;
		this.logger = ctx.logger("bilibili-notify-api");
		this.logger.level = config.logLevel;
		this.jar = new CookieJar();
	}

	async start(): Promise<void> {
		// Load ESM-only dependencies dynamically (works in both ESM and CJS output)
		const [{ default: CacheableLookup }, pRetryMod] = await Promise.all([
			import("cacheable-lookup"),
			import("p-retry"),
		]);
		this.pRetry = pRetryMod.default;
		this.AbortError = pRetryMod.AbortError;

		this.cacheable = new CacheableLookup();
		this.cacheable.install(http.globalAgent);
		this.cacheable.install(https.globalAgent);

		await this.initClient();
		this.logger.debug("HTTP 客户端初始化完成");

		// Daily ticket refresh at midnight
		this.ticketJob = new CronJob("0 0 * * *", () => {
			this.updateBiliTicket().catch((e: Error) =>
				this.logger.error(`更新 BiliTicket 失败: ${e.message}`),
			);
		});
		this.ticketJob.start();
		await this.updateBiliTicket();
		this.logger.debug("BiliTicket 已更新，API 初始化完成");
	}

	stop(): void {
		if (this.cacheable) {
			this.cacheable.uninstall(http.globalAgent);
			this.cacheable.uninstall(https.globalAgent);
		}
		this.ticketJob?.stop();
		if (this.refreshCookieIntervalId !== undefined) {
			clearInterval(this.refreshCookieIntervalId);
			this.refreshCookieIntervalId = undefined;
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
			this.logger.error(`获取 cookies 失败: ${e}`);
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
			`正在写入 ${cookies.length} 条 Cookie，refreshToken=${data.refreshToken ? "有" : "无"}`,
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
		this.logger.debug(`Cookie 写入完成，bili_jct=${biliJctCookie ? "存在" : "缺失"}`);

		if (data.refreshToken) {
			const csrf = biliJctCookie?.value ?? "";
			this.checkIfTokenNeedRefresh(data.refreshToken, csrf).catch((e: Error) =>
				this.logger.warn(`Cookie 刷新检查失败: ${e.message}`),
			);
			this.enableRefreshCookiesInterval(data.refreshToken, csrf);
		}
	}

	markLoginInfoLoaded(): void {
		this.loginInfoLoaded = true;
	}

	isLoginInfoLoaded(): boolean {
		return this.loginInfoLoaded;
	}

	private parseExpires(expires?: string): Date | "Infinity" {
		if (!expires || expires === "Infinity") return "Infinity";
		return DateTime.fromISO(expires).toJSDate();
	}

	private enableRefreshCookiesInterval(refreshToken: string, csrf: string): void {
		if (this.refreshCookieIntervalId !== undefined) {
			clearInterval(this.refreshCookieIntervalId);
		}
		this.refreshCookieIntervalId = setInterval(async () => {
			const csrf2 = this.getCSRF() ?? csrf;
			await this.checkIfTokenNeedRefresh(refreshToken, csrf2).catch((e: Error) =>
				this.logger.warn(`定时 Cookie 刷新失败: ${e.message}`),
			);
		}, 3_600_000);
	}

	// ---- Cookie refresh ----

	async checkIfTokenNeedRefresh(refreshToken: string, csrf: string, attempts = 3): Promise<void> {
		try {
			const info = await this.getCookieInfo(refreshToken);
			if (!info?.data?.refresh) return;
		} catch {
			if (attempts > 1) {
				await new Promise((r) => setTimeout(r, 3000));
				return this.checkIfTokenNeedRefresh(refreshToken, csrf, attempts - 1);
			}
			// Fall through and attempt refresh anyway
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

		if (refreshData.code === -101) {
			await this.initClient();
			return;
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

		// 通知 core 持久化新 cookie
		this.onCookiesRefreshed?.({
			cookiesJson: this.getCookiesJson() ?? "[]",
			refreshToken: refreshData.data.refresh_token as string,
		});
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
		return this.pRetry(fn, {
			retries: 3,
			onFailedAttempt: (err: Error & { attemptNumber: number }) => {
				this.logger.warn(`${label}() 第 ${err.attemptNumber} 次失败: ${err.message ?? err}`);
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

	async searchByType(searchType: string, keyword: string) {
		return this.retry(async () => {
			const wbi = await this.getWbi({ search_type: searchType, keyword });
			return (await this.client.get(`${EP.SEARCH_BY_TYPE}?${wbi}`)).data;
		}, "searchByType");
	}

	async getCookieInfo(refreshToken: string) {
		return this.retry(
			async () => (await this.client.get(`${EP.GET_COOKIES_INFO}?csrf=${refreshToken}`)).data,
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

	async getCORSContent(url: string) {
		return this.retry(async () => (await this.client.get(url)).data, "getCORSContent");
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
	): Promise<ValidateCaptchaData["data"]> {
		const csrf = this.getCSRF();
		const { data } = await this.client.post(
			EP.VALIDATE_CAPTCHA_URL,
			{ csrf, challenge, token, validate, seccode },
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
		);
		const result = data as ValidateCaptchaData;
		if (result.code !== 0) {
			this.logger.warn(`验证失败: code=${result.code}`);
			return null;
		}
		// Persist grisk_id as a cookie
		this.addCookie(`x-bili-gaia-vtoken=${result.data?.grisk_id}`);
		return result.data;
	}
}
