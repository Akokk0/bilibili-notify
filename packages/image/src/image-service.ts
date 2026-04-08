import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GuardLevel } from "blive-message-listener";
import { JSDOM } from "jsdom";
import { type Context, Logger, Service } from "koishi";
// biome-ignore lint/correctness/noUnusedImports: <import type>
import {} from "koishi-plugin-puppeteer";
import { DateTime } from "luxon";
import type { BilibiliNotifyImageConfig } from "./config";
import { BG_COLORS, generateDynamicCardStyle, getSCLevel, SC_COLORS, SC_LEVELS } from "./styles";
import { buildDynamicCardHtml, buildDynamicContent } from "./templates/dynamic-card";
import { buildGuardCardHtml } from "./templates/guard-card";
import { buildLiveCardHtml } from "./templates/live-card";
import { buildSCCardHtml } from "./templates/sc-card";
import { buildWordCloudHtml } from "./templates/wordcloud";
import type { CardColorOptions, Dynamic, LiveData } from "./types";

declare module "koishi" {
	interface Context {
		"bilibili-notify-image": BilibiliNotifyImage;
	}
}

const SERVICE_NAME = "bilibili-notify-image";

async function withRetry<T>(fn: () => T | Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt < maxAttempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
			}
		}
	}
	throw lastError;
}

class BilibiliNotifyImage extends Service<BilibiliNotifyImageConfig> {
	static inject = ["puppeteer"];

	private readonly imageLogger: Logger;

	// 图片 base64 缓存
	private readonly imageCache = new Map<string, { dataUrl: string; updatedAt: number }>();
	private clearCacheTimer?: () => void;
	private readonly CACHE_TTL_MS = 30 * 60 * 1000;
	private readonly CACHE_MAX_SIZE = 300;

	// 串行渲染队列，避免 puppeteer 并发问题
	private renderQueue: Promise<void> = Promise.resolve();

	constructor(ctx: Context, config: BilibiliNotifyImageConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		this.imageLogger = new Logger(SERVICE_NAME);
		this.imageLogger.level = this.config.logLevel;
	}

	protected start() {
		this.clearCacheTimer = this.ctx.setInterval(() => this.pruneImageCache(), 5 * 60 * 1000);
	}

	protected stop() {
		this.clearCacheTimer?.();
		this.clearCacheTimer = undefined;
		this.imageCache.clear();
	}

	// ── 公共工具方法 ─────────────────────────────────────────────────────────────

	numberToStr(num: number): string {
		if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`;
		if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
		return num.toString();
	}

	unixTimestampToString(timestamp: number): string {
		const d = new Date(timestamp * 1000);
		const pad = (n: number) => `0${n}`.slice(-2);
		return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	}

	async getTimeDifference(dateString: string): Promise<string> {
		const apiDateTime = DateTime.fromFormat(dateString, "yyyy-MM-dd HH:mm:ss", {
			zone: "UTC+8",
		});
		const diff = DateTime.now().diff(apiDateTime, [
			"years",
			"months",
			"days",
			"hours",
			"minutes",
			"seconds",
		]);
		const { years, months, days, hours, minutes, seconds } = diff.toObject();
		const parts: string[] = [];
		if (years) parts.push(`${Math.abs(years)}年`);
		if (months) parts.push(`${Math.abs(months)}个月`);
		if (days) parts.push(`${Math.abs(days)}天`);
		if (hours) parts.push(`${Math.abs(hours)}小时`);
		if (minutes) parts.push(`${Math.abs(minutes)}分`);
		if (seconds) parts.push(`${Math.round(Math.abs(seconds))}秒`);
		const sign = diff.as("seconds") < 0 ? "-" : "";
		return parts.length > 0 ? `${sign}${parts.join("")}` : "0秒";
	}

	async getLiveStatus(time: string, liveStatus: number): Promise<[string, string, boolean]> {
		switch (liveStatus) {
			case 0:
				return ["未直播", "未开播", true];
			case 1:
				return ["开播啦", `开播时间：${time}`, true];
			case 2:
				return ["正在直播", `直播时长：${await this.getTimeDifference(time)}`, false];
			case 3:
				return ["下播啦", `开播时间：${time}`, true];
			default:
				return ["", "", true];
		}
	}

	// ── 图片生成公共方法 ──────────────────────────────────────────────────────────

	async generateLiveCard(
		// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
		data: any,
		username: string,
		userface: string,
		liveData: LiveData,
		liveStatus: number,
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const { cardColorStart = this.config.cardColorStart, cardColorEnd = this.config.cardColorEnd } =
			colorOptions;

		const [titleStatus, liveTime, cover] = await this.getLiveStatus(data.live_time, liveStatus);

		const html = buildLiveCardHtml({
			font: this.config.font,
			hideDesc: this.config.hideDesc,
			followerDisplay: this.config.followerDisplay,
			cardColorStart,
			cardColorEnd,
			data,
			username,
			userface,
			titleStatus,
			liveTime,
			liveStatus,
			cover,
			onlineNum: this.numberToStr(+(data.online ?? 0)),
			likedNum: this.numberToStr(+(liveData.likedNum ?? "0")),
			watchedNum: liveData.watchedNum ?? "",
			fansNum: liveData.fansNum ?? "",
			fansChanged: liveData.fansChanged ?? "",
		});

		return withRetry(() => this.renderHtml(html)).catch((e) => {
			throw new Error(`生成直播卡片失败！错误: ${e}`);
		});
	}

	async generateGuardCard(
		captainImgUrl: string,
		{
			guardLevel,
			uname,
			face,
			isAdmin,
		}: { guardLevel: GuardLevel; uname: string; face: string; isAdmin: number },
		{ masterAvatarUrl, masterName }: { masterAvatarUrl: string; masterName: string },
	): Promise<Buffer> {
		const html = buildGuardCardHtml({
			font: this.config.font,
			captainImgUrl,
			guardLevel,
			uname,
			face,
			isAdmin,
			masterAvatarUrl,
			masterName,
			bgColor: BG_COLORS[guardLevel],
		});

		return withRetry(() => this.renderHtml(html)).catch((e) => {
			throw new Error(`生成上舰卡片失败！错误: ${e}`);
		});
	}

	async generateSCCard({
		senderFace,
		senderName,
		masterName,
		text,
		price,
		masterAvatarUrl,
	}: {
		senderFace: string;
		senderName: string;
		masterName: string;
		text: string;
		price: number;
		masterAvatarUrl?: string;
	}): Promise<Buffer> {
		const battery = price * 10;
		const levelIndex = getSCLevel(battery);
		const bgColor = SC_COLORS[levelIndex];
		const levelInfo = Object.values(SC_LEVELS)[levelIndex];

		const html = buildSCCardHtml({
			font: this.config.font,
			senderFace,
			senderName,
			masterName,
			masterAvatarUrl,
			text,
			price,
			duration: levelInfo.duration,
			bgColor,
		});

		return withRetry(() => this.renderHtml(html)).catch((e) => {
			throw new Error(`生成 SC 卡片失败！错误: ${e}`);
		});
	}

	async generateDynamicCard(data: Dynamic, colorOptions: CardColorOptions = {}): Promise<Buffer> {
		const { cardColorStart = this.config.cardColorStart, cardColorEnd = this.config.cardColorEnd } =
			colorOptions;

		const moduleAuthor = data.modules.module_author;
		const moduleStat = data.modules.module_stat;
		const topic = data.modules.module_dynamic.topic?.name ?? "";

		let pubTime = this.unixTimestampToString(moduleAuthor.pub_ts);
		const { decorateCardUrl, decorateCardId, decorateCardColor } = moduleAuthor.decorate
			? {
					decorateCardUrl: moduleAuthor.decorate.card_url,
					decorateCardId: moduleAuthor.decorate.fan.num_str,
					decorateCardColor: moduleAuthor.decorate.fan.color,
				}
			: { decorateCardUrl: undefined, decorateCardId: undefined, decorateCardColor: "#FFFFFF" };

		const content = await buildDynamicContent(data, false, __dirname);
		if (content.pubTimeSuffix) {
			pubTime += content.pubTimeSuffix;
		}

		const cardStyle = generateDynamicCardStyle(
			this.config.font,
			cardColorStart,
			cardColorEnd,
			decorateCardColor ?? "#FFFFFF",
		);

		const html = buildDynamicCardHtml({
			font: this.config.font,
			cardStyle,
			avatarUrl: moduleAuthor.face,
			upName: moduleAuthor.name,
			upIsVip: moduleAuthor.vip.type !== 0,
			pubTime,
			decorateCardUrl,
			decorateCardId,
			topic,
			mainContent: content.html,
			forwardCount: this.numberToStr(moduleStat.forward.count),
			commentCount: this.numberToStr(moduleStat.comment.count),
			likeCount: this.numberToStr(moduleStat.like.count),
		});

		return withRetry(() => this.renderHtml(html)).catch((e) => {
			throw new Error(`生成动态卡片失败！错误: ${e}`);
		});
	}

	async generateWordCloudImg(words: Array<[string, number]>, masterName: string): Promise<Buffer> {
		const html = buildWordCloudHtml(masterName, words, __dirname);
		return withRetry(() => this.renderHtml(html, "window.wordcloudDone === true")).catch((e) => {
			throw new Error(`生成词云图片失败！错误: ${e}`);
		});
	}

	// ── 渲染管线（内部） ──────────────────────────────────────────────────────────

	private isRemoteUrl(url?: string | null): url is string {
		return Boolean(url && /^https?:\/\//i.test(url));
	}

	private getMimeType(url: string): string {
		const lower = url.toLowerCase();
		if (lower.endsWith(".png")) return "image/png";
		if (lower.endsWith(".webp")) return "image/webp";
		if (lower.endsWith(".gif")) return "image/gif";
		if (lower.endsWith(".bmp")) return "image/bmp";
		if (lower.endsWith(".svg")) return "image/svg+xml";
		return "image/jpeg";
	}

	private pruneImageCache(): void {
		const now = Date.now();
		for (const [url, entry] of this.imageCache.entries()) {
			if (now - entry.updatedAt > this.CACHE_TTL_MS) {
				this.imageCache.delete(url);
			}
		}
		if (this.imageCache.size <= this.CACHE_MAX_SIZE) return;
		const sorted = [...this.imageCache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		const overflow = this.imageCache.size - this.CACHE_MAX_SIZE;
		for (let i = 0; i < overflow; i++) {
			this.imageCache.delete(sorted[i][0]);
		}
	}

	private async fetchImageAsDataUrl(url: string): Promise<string> {
		const cached = this.imageCache.get(url);
		if (cached) {
			cached.updatedAt = Date.now();
			return cached.dataUrl;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					Referer: "https://www.bilibili.com/",
				},
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}
			const contentType =
				response.headers.get("content-type")?.split(";")[0]?.trim() || this.getMimeType(url);
			const dataUrl = `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
			this.imageCache.set(url, { dataUrl, updatedAt: Date.now() });
			this.pruneImageCache();
			return dataUrl;
		} finally {
			clearTimeout(timeout);
		}
	}

	/** 将 HTML 中所有远程图片和 CSS 背景替换为 base64 data URL，避免渲染时跨域 */
	/** 按批次限制并发数量，避免同时发起过多请求 */
	private async fetchWithConcurrencyLimit<T>(
		tasks: (() => Promise<T>)[],
		concurrency = 3,
	): Promise<T[]> {
		const results: T[] = [];
		for (let i = 0; i < tasks.length; i += concurrency) {
			const batch = tasks.slice(i, i + concurrency).map((task) => task());
			results.push(...(await Promise.all(batch)));
		}
		return results;
	}

	private async inlineRemoteImages(html: string): Promise<string> {
		const dom = new JSDOM(html);
		const { document } = dom.window;

		// 内联 <img src="https://...">
		const imgElements = Array.from(document.querySelectorAll("img"));
		await this.fetchWithConcurrencyLimit(
			imgElements.map((img) => async () => {
				const src = img.getAttribute("src");
				if (!this.isRemoteUrl(src)) return;
				try {
					img.setAttribute("src", await this.fetchImageAsDataUrl(src));
				} catch (err) {
					this.imageLogger.warn(`图片预取失败，保留原 URL: ${src} (${err})`);
				}
			}),
		);

		// 内联 CSS 中的 url("https://...")
		const cssUrlRegex = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi;
		const cssUrlSet = new Set<string>();

		const collectCssUrls = (cssText: string) => {
			for (const m of cssText.matchAll(cssUrlRegex)) {
				if (this.isRemoteUrl(m[2])) cssUrlSet.add(m[2]);
			}
		};

		for (const el of document.querySelectorAll("style")) {
			collectCssUrls(el.textContent ?? "");
		}
		for (const el of document.querySelectorAll("[style]")) {
			collectCssUrls(el.getAttribute("style") ?? "");
		}

		const cssUrlMap = new Map<string, string>();
		await Promise.all(
			[...cssUrlSet].map(async (url) => {
				try {
					cssUrlMap.set(url, await this.fetchImageAsDataUrl(url));
				} catch (err) {
					this.imageLogger.warn(`CSS 图片预取失败，保留原 URL: ${url} (${err})`);
				}
			}),
		);

		if (cssUrlMap.size > 0) {
			const replaceCssUrls = (css: string) => {
				let result = css;
				for (const [url, dataUrl] of cssUrlMap.entries()) {
					result = result.replaceAll(url, dataUrl);
				}
				return result;
			};
			for (const el of document.querySelectorAll("style")) {
				el.textContent = replaceCssUrls(el.textContent ?? "");
			}
			for (const el of document.querySelectorAll("[style]")) {
				el.setAttribute("style", replaceCssUrls(el.getAttribute("style") ?? ""));
			}
		}

		return dom.serialize();
	}

	private async doRender(html: string, waitForCondition?: string): Promise<Buffer> {
		const htmlPath = pathToFileURL(resolve(__dirname, "page/0.html"));
		const page = await this.ctx.puppeteer.page();
		try {
			const inlinedHtml = await this.inlineRemoteImages(html);
			await page.goto(htmlPath.toString());
			await page.setContent(inlinedHtml, { waitUntil: "load", timeout: 15_000 });
			if (waitForCondition) {
				await page.waitForFunction(waitForCondition, { timeout: 30_000 });
			}
			const elementHandle = await page.$("html");
			if (!elementHandle) throw new Error("无法获取 html 元素");
			const boundingBox = await elementHandle.boundingBox();
			if (!boundingBox) throw new Error("无法获取 boundingBox");
			const screenshotPromise = page.screenshot({
				type: "jpeg",
				clip: {
					x: boundingBox.x,
					y: boundingBox.y,
					width: boundingBox.width,
					height: boundingBox.height,
				},
			});
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("截图超时（20s）")), 20_000),
			);
			const buffer = await Promise.race([screenshotPromise, timeoutPromise]);
			await elementHandle.dispose();
			return buffer;
		} finally {
			await page.close();
		}
	}

	/** 将渲染任务加入串行队列 */
	private renderHtml(html: string, waitForCondition?: string): Promise<Buffer> {
		return new Promise<Buffer>((resolve, reject) => {
			this.renderQueue = this.renderQueue
				.catch(() => {}) // 隔离前一任务的错误，防止阻断后续任务
				.then(async () => {
					try {
						resolve(await this.doRender(html, waitForCondition));
					} catch (err) {
						reject(err);
					}
				});
		});
	}
}

export default BilibiliNotifyImage;
