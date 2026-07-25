import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CardBlock,
	Disposable,
	GuardLayout,
	Logger,
	ServiceContext,
} from "@bilibili-notify/internal";
import { GuardLevel } from "blive-message-listener";
import { JSDOM } from "jsdom";
import { DateTime } from "luxon";
import type { PuppeteerLike } from "./puppeteer";
import { renderCard } from "./render";
import { BG_COLORS, getSCLevel, SC_COLORS, SC_LEVELS } from "./styles";
import { DynamicCard } from "./templates/dynamic-card";
import { buildDynamicNode } from "./templates/dynamic-content";
import { GuardCard } from "./templates/guard-card";
import { LiveCard } from "./templates/live-card";
import {
	RoastBoardCard,
	type RoastBoardCardProps,
	RoastSoloCard,
	type RoastSoloCardProps,
} from "./templates/roast-card";
import { SCCard } from "./templates/sc-card";
import { buildWordCloudHtml } from "./templates/wordcloud";
import type { CardColorOptions, Dynamic, LiveData } from "./types";

/**
 * 本模块能读到自带静态资源的目录 —— 词云要的那两个脚本就在 `static/` 下。
 *
 * **不能写 `__dirname`。**这个包是 ESM(`"type": "module"`),源码里根本没有
 * 这个变量;以前不炸只是因为打包时开了 `shims: true`,给产物注入了一个。而 dev
 * 服务器不走产物 —— `apps/server/tsconfig.dev.json` 的 paths 把工作区包直接映到各包
 * 的 `src/index.ts`,tsx 加载的是源码,shim 无从注入,生成词云当场
 * `__dirname is not defined`。构建全绿,只有开发时炸。
 *
 * 相对路径两种形态下都对得上:源码里 `static/` 挨着本文件(`src/static/`),
 * 打包后 pack 的 copy 规则把它搬到 `lib/static/`,而那时本文件已被并进
 * `lib/index.*` —— 都是「同级的 static」。
 *
 * 三种消费形态都验过:`lib/index.mjs`(独立端)、`lib/index.cjs` 与 koishi 的
 * CJS bundle(打包器会把 `import.meta.url` 改写成 CJS 能跑的形式)。
 */
export const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

/** 锐评卡的**业务**入参 —— 配色部分由渲染器从全局 `cardStyle` 填,调用方不用管。 */
type RoastStyleKeys =
	| "cardColorStart"
	| "cardColorEnd"
	| "glassOpacity"
	| "glassClear"
	| "backgroundImage";
export type RoastBoardData = Omit<RoastBoardCardProps, RoastStyleKeys>;
export type RoastSoloData = Omit<RoastSoloCardProps, RoastStyleKeys>;

const GUARD_LEVEL_IMG: Record<GuardLevel, string> = {
	[GuardLevel.None]: "",
	[GuardLevel.Jianzhang]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
	[GuardLevel.Tidu]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	[GuardLevel.Zongdu]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
};

async function withRetry<T>(fn: () => T | Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt < maxAttempts - 1) {
				// Chrome 进程崩溃时需等待 puppeteer 重启浏览器，延迟更长
				const isBrowserCrash =
					error instanceof Error && error.message.includes("Connection closed");
				const delay = isBrowserCrash ? 6000 : delayMs * (attempt + 1);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}
	throw lastError;
}

/** 可选配置项的日志值:未设置 = 回到各卡内置基线,打成「(默认)」而非裸 `undefined`。 */
function fmtOptional(v: number | boolean | undefined): string {
	return v === undefined ? "(默认)" : String(v);
}

/**
 * Runtime configuration for {@link ImageRenderer}. Mirrors the platform-neutral
 * subset of the original koishi `BilibiliNotifyImageConfig` schema; the koishi
 * shell maps its schema fields onto this struct, and the standalone runtime
 * fills it from its own config store. The `logLevel` field is intentionally
 * dropped — the adapter is responsible for setting the logger level externally.
 */
export interface ImageRendererConfig {
	/** 卡片渐变背景起始颜色（十六进制）。 */
	cardColorStart: string;
	/** 卡片渐变背景结束颜色（十六进制）。 */
	cardColorEnd: string;
	/** 玻璃片(内容层)透明度 0..1 的全局默认;未设时各卡走自身基线(live/dyn 0.82、sc/guard 0.75)。 */
	glassOpacity?: number;
	/** 完全透明:内容层透明 + 无模糊的全局默认(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义卡片背景图资产 id(空 = 渐变);渲染期经 resolveAsset 解析成 data URL。 */
	backgroundImage?: string;
	/** CSS font-family，默认值由 adapter 提供(通常透传 `DEFAULT_CARD_STYLE.font`)。 */
	font: string;
	/** 直播卡数据区:显示人气 / 点赞(直播中=人气,下播=点赞)。 */
	showPopularity: boolean;
	/** 直播卡数据区:显示分区。 */
	showArea: boolean;
	/** 直播卡数据区:显示粉丝数据(当前粉丝数 / 累计观看 / 粉丝变化,按直播态)。 */
	showFans: boolean;
}

export interface ImageRendererOptions {
	serviceCtx: ServiceContext;
	puppeteer: PuppeteerLike;
	config: ImageRendererConfig;
	/**
	 * 把卡片背景图资产 id 解析成可渲染的 data URL(服务端注入,读 `<dataDir>/assets/card-bg`)。
	 * 未注入 = 背景图特性不可用(返回 "")。已是 data:/http URL 的值直接透传、不经此回调。
	 */
	resolveAsset?: (id: string) => Promise<string>;
	/**
	 * 热更日志降级到 debug。**预览渲染器**(dashboard 每来一次预览请求就
	 * updateConfig 一遍)必须开:主人在 Cards 页拖一格滑块就是一条 INFO「配置已
	 * 更新」,既刷屏,又和真正落盘生效的那条(推送渲染器热重载)长得一模一样,读起来
	 * 像"已经保存了"。降到 debug 后排障仍拿得到,平时不冒充保存。
	 */
	quietConfigUpdates?: boolean;
}

export class ImageRenderer {
	readonly logger: Logger;
	private readonly serviceCtx: ServiceContext;
	private readonly puppeteer: PuppeteerLike;
	private config: ImageRendererConfig;
	private readonly resolveAsset?: (id: string) => Promise<string>;
	private readonly quietConfigUpdates: boolean;

	// 图片 base64 缓存
	private readonly imageCache = new Map<string, { dataUrl: string; updatedAt: number }>();
	private clearCacheTimer?: Disposable;
	private readonly CACHE_TTL_MS = 30 * 60 * 1000;
	private readonly CACHE_MAX_SIZE = 300;

	/**
	 * IM1(SSRF):待内联的图片 URL 来自 B 站 API 的**不可信**字段(face /
	 * cover / pics / decorate)。仅放行 B 站自有资产域 —— 任何 IP 字面量
	 * (含 169.254.169.254 元数据 / 127.* / 10.* / 192.168.*)与外部域都不满足
	 * 后缀匹配,天然被拒(无需 DNS 解析、无重绑定旁路)。
	 */
	private static readonly IMG_HOST_ALLOWLIST = [
		"hdslb.com",
		"biliimg.com",
		"bilibili.com",
		"bilivideo.com",
		"bilivideo.cn",
	] as const;
	/** 1x1 透明 GIF —— 被拦截的远端图替换成它,保证最终 HTML 无任何外部引用可被 puppeteer 再抓。 */
	private static readonly BLOCKED_IMG_PLACEHOLDER =
		"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
	/** IM2:单张远端图字节上限,防超大图全量入内存 + base64 膨胀驻留 cache → OOM。 */
	private readonly MAX_REMOTE_IMG_BYTES = 8 * 1024 * 1024;

	// 串行渲染队列，避免 puppeteer 并发问题
	private renderQueue: Promise<void> = Promise.resolve();

	constructor(opts: ImageRendererOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.puppeteer = opts.puppeteer;
		this.config = opts.config;
		this.resolveAsset = opts.resolveAsset;
		this.quietConfigUpdates = opts.quietConfigUpdates ?? false;
		this.logger = opts.serviceCtx.logger;
	}

	start(): void {
		this.clearCacheTimer = this.serviceCtx.setInterval(() => this.pruneImageCache(), 5 * 60 * 1000);
	}

	/**
	 * 热更运行时配置(卡片配色 / 字体 / 显示选项)。adapter 在 dashboard 编辑后调用,
	 * 后续渲染的卡片立刻用新配色,无需重启 server。
	 * 注意:已缓存的 base64 图(头像 / 封面)与配色无关,无需 invalidate。
	 */
	updateConfig(config: ImageRendererConfig): void {
		const prev = this.config;
		this.config = config;
		// 仅在配置**实际变化**时记录 —— 预览每次渲染(尤其切卡片类型时样式没变)都会
		// updateConfig,无脑打 info 会刷屏并让人误以为「已保存」。重复传入相同配置则静默。
		// 日志内容只列**真正变化**的字段(此前无脑打印 cardColorStart/cardColorEnd,
		// 改玻璃片透明度这类字段时看起来像"渐变色又被打印了一遍",容易被误读成
		// 没热更新到实际改的项)。
		const diffs: string[] = [];
		if (prev.cardColorStart !== config.cardColorStart) {
			diffs.push(`cardColorStart=${config.cardColorStart}`);
		}
		if (prev.cardColorEnd !== config.cardColorEnd) {
			diffs.push(`cardColorEnd=${config.cardColorEnd}`);
		}
		if (prev.font !== config.font) diffs.push(`font=${config.font}`);
		if (prev.showPopularity !== config.showPopularity) {
			diffs.push(`showPopularity=${config.showPopularity}`);
		}
		if (prev.showArea !== config.showArea) diffs.push(`showArea=${config.showArea}`);
		if (prev.showFans !== config.showFans) diffs.push(`showFans=${config.showFans}`);
		// 可选字段被清空 = 回到「各卡内置基线」,打成 (默认);裸 `undefined` 读不出这层含义。
		if (prev.glassOpacity !== config.glassOpacity) {
			diffs.push(`glassOpacity=${fmtOptional(config.glassOpacity)}`);
		}
		if (prev.glassClear !== config.glassClear) {
			diffs.push(`glassClear=${fmtOptional(config.glassClear)}`);
		}
		if (prev.backgroundImage !== config.backgroundImage) {
			diffs.push(`backgroundImage=${config.backgroundImage ? "(set)" : "(none)"}`);
		}
		if (diffs.length === 0) return;
		const line = `[image] 配置已更新: ${diffs.join(", ")}`;
		if (this.quietConfigUpdates) this.logger.debug(line);
		else this.logger.info(line);
	}

	stop(): void {
		this.clearCacheTimer?.dispose();
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

	/**
	 * 解析卡片背景图字段为可渲染 URL:空 → "";已是 data:/http URL → 透传(预览路由已解析);
	 * 否则当资产 id,经注入的 resolveAsset 读盘解析成 data URL。无 resolver → ""(特性不可用)。
	 */
	private async resolveBg(v?: string): Promise<string> {
		if (!v) return "";
		if (v.startsWith("data:") || v.startsWith("http")) return v;
		return this.resolveAsset ? await this.resolveAsset(v) : "";
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
		/** live 版式描述符;缺省 = 默认版式(复刻现状)。 */
		layout?: CardBlock[],
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[live] 开始渲染直播卡片：${username}`);
		const { cardColorStart = this.config.cardColorStart, cardColorEnd = this.config.cardColorEnd } =
			colorOptions;
		const glassOpacity = colorOptions.glassOpacity ?? this.config.glassOpacity;
		const glassClear = colorOptions.glassClear ?? this.config.glassClear;
		// 背景图与直播封面(独立端专属)两次独立解析(各自 resolveAsset → 读盘),互不依赖 ——
		// 并发发起,省掉一次串行 I/O 往返。封面无 resolver(koishi)解析为 "" → 模板回退
		// API 封面/关键帧,特性自动无感。
		const [backgroundImage, coverOverride] = await Promise.all([
			this.resolveBg(colorOptions.backgroundImage ?? this.config.backgroundImage),
			this.resolveBg(colorOptions.liveCoverImage),
		]);

		const [titleStatus, liveTime, cover] = await this.getLiveStatus(data.live_time, liveStatus);

		// 规范化 liveStatus 用于 LiveCard 角标：
		// live-service 传入的是 LiveType 枚举（2=LiveBroadcast, 3=StopBroadcast, 4=FirstLiveBroadcast）
		// 指令传入的是原始 API live_status（1=正在播）
		// 统一映射：直播中=1，已下播=2，其他=0
		const cardBadgeStatus = liveStatus === 3 ? 2 : liveStatus >= 2 ? 1 : liveStatus;

		const html = await renderCard(
			LiveCard,
			{
				showPopularity: colorOptions.showPopularity ?? this.config.showPopularity,
				showArea: colorOptions.showArea ?? this.config.showArea,
				showFans: colorOptions.showFans ?? this.config.showFans,
				cardColorStart,
				cardColorEnd,
				glassOpacity,
				glassClear,
				backgroundImage,
				data,
				username,
				userface,
				titleStatus,
				liveTime,
				liveStatus: cardBadgeStatus,
				cover,
				coverOverride: coverOverride || undefined,
				onlineNum: this.numberToStr(+(data.online ?? 0)),
				likedNum:
					typeof liveData.likedNum === "number"
						? this.numberToStr(liveData.likedNum)
						: (liveData.likedNum ?? ""),
				watchedNum:
					typeof liveData.watchedNum === "number"
						? this.numberToStr(liveData.watchedNum)
						: (liveData.watchedNum ?? ""),
				fansNum:
					typeof liveData.fansNum === "number"
						? this.numberToStr(liveData.fansNum)
						: (liveData.fansNum ?? ""),
				fansChanged: (() => {
					if (typeof liveData.fansChanged !== "number") return liveData.fansChanged ?? "";
					const n = liveData.fansChanged;
					if (n > 0) return n >= 10_000 ? `+${(n / 10_000).toFixed(1)}万` : `+${n}`;
					return n <= -10_000 ? `${(n / 10_000).toFixed(1)}万` : n.toString();
				})(),
				layout,
			},
			{ title: "直播通知", font: this.config.font, htmlWidth: 600 },
		);

		return withRetry(() => this.renderHtml(html))
			.then((buf) => {
				this.logger.debug(`[live] 直播卡片渲染完成：${username}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成直播卡片失败！错误: ${e}`);
			});
	}

	async generateGuardCard(
		{
			guardLevel,
			uname,
			face,
			isAdmin,
		}: { guardLevel: GuardLevel; uname: string; face: string; isAdmin: number },
		{ masterAvatarUrl, masterName }: { masterAvatarUrl: string; masterName: string },
		/**
		 * per-call 样式覆盖;只取 glass / backgroundImage(上舰卡 bgColor 由舰长等级决定,
		 * 渐变色不适用)。缺省 = 走渲染器全局 config(复刻现状)。
		 */
		colorOptions: CardColorOptions = {},
		/** guard 受限 2D 版式;缺省 = 默认版式(复刻现状)。 */
		layout?: GuardLayout,
	): Promise<Buffer> {
		const t0 = Date.now();
		const guardName = ["", "总督", "提督", "舰长"][guardLevel] ?? "上舰";
		this.logger.debug(`[guard] 开始渲染上舰卡片：${uname} → ${masterName}（${guardName}）`);
		const captainImgUrl = GUARD_LEVEL_IMG[guardLevel] ?? "";
		const glassOpacity = colorOptions.glassOpacity ?? this.config.glassOpacity;
		const glassClear = colorOptions.glassClear ?? this.config.glassClear;
		const backgroundImage = await this.resolveBg(
			colorOptions.backgroundImage ?? this.config.backgroundImage,
		);
		const html = await renderCard(
			GuardCard,
			{
				captainImgUrl,
				guardLevel,
				uname,
				face,
				isAdmin,
				masterAvatarUrl,
				masterName,
				bgColor: BG_COLORS[guardLevel],
				layout,
				glassOpacity,
				glassClear,
				backgroundImage,
			},
			{ title: "上舰通知", font: this.config.font, htmlWidth: 430 },
		);

		return withRetry(() => this.renderHtml(html))
			.then((buf) => {
				this.logger.debug(`[guard] 上舰卡片渲染完成：${uname}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成上舰卡片失败！错误: ${e}`);
			});
	}

	async generateSCCard(
		{
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
		},
		/**
		 * per-call 样式覆盖;只取 glass / backgroundImage(SC 卡 bgColor 由价格档位决定,
		 * 渐变色不适用)。缺省 = 走渲染器全局 config(复刻现状)。
		 */
		colorOptions: CardColorOptions = {},
		/** sc 版式描述符;缺省 = 默认版式(复刻现状)。 */
		layout?: CardBlock[],
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[sc] 开始渲染 SC 卡片：${senderName} → ${masterName}（¥${price}）`);
		const battery = price * 10;
		const levelIndex = getSCLevel(battery);
		const bgColor = SC_COLORS[levelIndex];
		const levelInfo = Object.values(SC_LEVELS)[levelIndex];
		const glassOpacity = colorOptions.glassOpacity ?? this.config.glassOpacity;
		const glassClear = colorOptions.glassClear ?? this.config.glassClear;
		const backgroundImage = await this.resolveBg(
			colorOptions.backgroundImage ?? this.config.backgroundImage,
		);

		const html = await renderCard(
			SCCard,
			{
				senderFace,
				senderName,
				masterName,
				masterAvatarUrl,
				text,
				price,
				duration: levelInfo.duration,
				bgColor,
				layout,
				glassOpacity,
				glassClear,
				backgroundImage,
			},
			{ title: "醒目留言通知", font: this.config.font, htmlWidth: 290 },
		);

		return withRetry(() => this.renderHtml(html))
			.then((buf) => {
				this.logger.debug(`[sc] SC 卡片渲染完成：${senderName}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成 SC 卡片失败！错误: ${e}`);
			});
	}

	async generateDynamicCard(
		data: Dynamic,
		colorOptions: CardColorOptions = {},
		/** dynamic 版式描述符;缺省 = 默认版式(复刻现状)。 */
		layout?: CardBlock[],
	): Promise<Buffer> {
		const t0 = Date.now();
		const { cardColorStart = this.config.cardColorStart, cardColorEnd = this.config.cardColorEnd } =
			colorOptions;
		const glassOpacity = colorOptions.glassOpacity ?? this.config.glassOpacity;
		const glassClear = colorOptions.glassClear ?? this.config.glassClear;
		const backgroundImage = await this.resolveBg(
			colorOptions.backgroundImage ?? this.config.backgroundImage,
		);

		const moduleAuthor = data.modules.module_author;
		this.logger.debug(`[dynamic] 开始渲染动态卡片：${moduleAuthor.name}`);

		const node = await buildDynamicNode(data, false, {
			time: (ts) => this.unixTimestampToString(ts),
			num: (n) => this.numberToStr(n),
		});

		const html = await renderCard(
			DynamicCard,
			{
				cardColorStart,
				cardColorEnd,
				glassOpacity,
				glassClear,
				backgroundImage,
				node,
				layout,
			},
			{ title: "动态通知", font: this.config.font, htmlWidth: 600 },
		);

		return withRetry(() => this.renderHtml(html))
			.then((buf) => {
				this.logger.debug(
					`[dynamic] 动态卡片渲染完成：${moduleAuthor.name}（${Date.now() - t0}ms）`,
				);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成动态卡片失败！错误: ${e}`);
			});
	}

	async generateWordCloudImg(
		words: Array<[string, number]>,
		masterName: string,
		masterAvatarUrl?: string,
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[wordcloud] 开始渲染词云卡片：${masterName}（${words.length} 词）`);
		const html = await buildWordCloudHtml(
			masterName,
			words,
			ASSET_DIR,
			masterAvatarUrl,
			this.config.cardColorStart,
			this.config.cardColorEnd,
			this.config.font,
		);
		return withRetry(() => this.renderHtml(html, "window.wordcloudDone === true"))
			.then((buf) => {
				this.logger.debug(`[wordcloud] 词云卡片渲染完成：${masterName}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成词云图片失败！错误: ${e}`);
			});
	}

	/**
	 * 锐评卡的配色一律吃全局 `cardStyle`(与词云卡同源),**不接 per-kind 样式矩阵**:
	 * `cardStyleByKind` 是「每位 UP × 每种卡」的二维覆盖,而榜单周报压根不属于任何
	 * 单个 UP,那个维度对它没有意义。
	 */
	private roastStyle(): Promise<string> {
		return this.resolveBg(this.config.backgroundImage);
	}

	async generateRoastBoardCard(data: RoastBoardData): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[roast] 开始渲染周报卡片：近 ${data.days} 天`);
		const html = await renderCard(
			RoastBoardCard,
			{
				...data,
				cardColorStart: this.config.cardColorStart,
				cardColorEnd: this.config.cardColorEnd,
				glassOpacity: this.config.glassOpacity,
				glassClear: this.config.glassClear,
				backgroundImage: await this.roastStyle(),
			},
			{ title: "UP 主周报", font: this.config.font, htmlWidth: 600 },
		);
		return withRetry(() => this.renderHtml(html))
			.then((buf) => {
				this.logger.debug(`[roast] 周报卡片渲染完成（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成周报卡片失败！错误: ${e}`);
			});
	}

	async generateRoastSoloCard(data: RoastSoloData): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[roast] 开始渲染单人锐评卡片：${data.up.name}`);
		const html = await renderCard(
			RoastSoloCard,
			{
				...data,
				cardColorStart: this.config.cardColorStart,
				cardColorEnd: this.config.cardColorEnd,
				glassOpacity: this.config.glassOpacity,
				glassClear: this.config.glassClear,
				backgroundImage: await this.roastStyle(),
			},
			{ title: "UP 主锐评", font: this.config.font, htmlWidth: 430 },
		);
		return withRetry(() => this.renderHtml(html))
			.then((buf) => {
				this.logger.debug(`[roast] 单人锐评卡片渲染完成：${data.up.name}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成锐评卡片失败！错误: ${e}`);
			});
	}

	// ── 渲染管线（内部） ──────────────────────────────────────────────────────────

	private isRemoteUrl(url?: string | null): url is string {
		return Boolean(url && /^https?:\/\//i.test(url));
	}

	/**
	 * IM1:SSRF 白名单闸门。仅 http(s) + B 站自有资产域后缀。任何 IP 字面量 /
	 * 内网主机 / 外部域都不匹配 → 拒绝。被拒 URL 既不由本进程 fetch,也会在
	 * {@link inlineRemoteImages} 里被透明占位替换,使 puppeteer 同样无从抓取。
	 */
	private isFetchAllowed(rawUrl: string): boolean {
		let host: string;
		try {
			const u = new URL(rawUrl);
			if (u.protocol !== "http:" && u.protocol !== "https:") return false;
			host = u.hostname.toLowerCase();
		} catch {
			return false;
		}
		return ImageRenderer.IMG_HOST_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`));
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

	/** B 站图片处理服务的缩放目标宽 / 质量(webp)。动态原图常达十几 MB,超 8MB 上限会
	 * 被丢成透明占位 → 图渲染不出来。给 i*.hdslb.com 的 /bfs/ 资源加 `@<w>w_<q>q.webp`
	 * 后缀,让 CDN 直接返回缩放压缩版,既不触发上限,内联体积也小一个数量级。 */
	private static readonly BILI_IMG_MAX_W = 1280;
	private static readonly BILI_IMG_QUALITY = 80;

	/**
	 * 对 B 站图片处理服务器(i0/i1/i2…​.hdslb.com 的 /bfs/ 资源)的 URL 追加缩放 +
	 * webp 转码后缀;已有 `@…` 处理后缀会被替换。其它 host / 非 /bfs/ 路径原样返回
	 * (静态 s1 资源、第三方域不处理)。query 保留。
	 */
	private compressBiliImageUrl(url: string): string {
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return url;
		}
		if (!/^i\d+\.hdslb\.com$/.test(host)) return url;
		if (!url.includes("/bfs/")) return url;
		const [beforeQuery, query] = url.split("?", 2);
		// B 站图 URL 无 userinfo,`@` 只可能是已有的处理后缀 → 截到它之前。
		const cleanBase = beforeQuery.split("@")[0];
		const suffix = `@${ImageRenderer.BILI_IMG_MAX_W}w_${ImageRenderer.BILI_IMG_QUALITY}q.webp`;
		return query ? `${cleanBase}${suffix}?${query}` : `${cleanBase}${suffix}`;
	}

	private async fetchImageAsDataUrl(rawUrl: string): Promise<string> {
		// 大图先经 B 站处理服务缩放压缩,避免超 MAX_REMOTE_IMG_BYTES 被熔断成占位。
		const url = this.compressBiliImageUrl(rawUrl);
		const cached = this.imageCache.get(url);
		if (cached) {
			cached.updatedAt = Date.now();
			return cached.dataUrl;
		}

		// IM1:SSRF 闸门(防御纵深 —— 调用方也已 gate,但这里才是真正发起 fetch
		// 的点,独立守一道)。
		if (!this.isFetchAllowed(url)) {
			throw new Error(`SSRF blocked: non-allowlisted image host (${url})`);
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
			// IM2:先看 Content-Length 早拒;无该头则边读边累计字节,超限即 abort
			// 熔断 —— 不把超大图全量读进内存再判。
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > this.MAX_REMOTE_IMG_BYTES) {
				throw new Error(`image too large: declared ${declared} bytes`);
			}
			const buf = await this.readCapped(response, controller);
			const contentType =
				response.headers.get("content-type")?.split(";")[0]?.trim() || this.getMimeType(url);
			const dataUrl = `data:${contentType};base64,${buf.toString("base64")}`;
			this.imageCache.set(url, { dataUrl, updatedAt: Date.now() });
			this.pruneImageCache();
			return dataUrl;
		} finally {
			clearTimeout(timeout);
		}
	}

	/** IM2:流式读取并在累计字节超 {@link MAX_REMOTE_IMG_BYTES} 时 abort 熔断。 */
	private async readCapped(response: Response, controller: AbortController): Promise<Buffer> {
		const reader = response.body?.getReader();
		if (!reader) {
			// 极少数无 body stream 的实现:退化为缓冲后即时校验(仍兜住 cache 不驻留超大图)。
			const ab = await response.arrayBuffer();
			if (ab.byteLength > this.MAX_REMOTE_IMG_BYTES) {
				throw new Error(`image exceeds ${this.MAX_REMOTE_IMG_BYTES} bytes`);
			}
			return Buffer.from(ab);
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		let chunk = await reader.read();
		while (!chunk.done) {
			total += chunk.value.byteLength;
			if (total > this.MAX_REMOTE_IMG_BYTES) {
				controller.abort();
				throw new Error(`image exceeds ${this.MAX_REMOTE_IMG_BYTES} bytes`);
			}
			chunks.push(chunk.value);
			chunk = await reader.read();
		}
		return Buffer.concat(chunks);
	}

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

	/** 将 HTML 中所有远程图片和 CSS 背景替换为 base64 data URL，避免渲染时跨域 */
	private async inlineRemoteImages(html: string): Promise<string> {
		const dom = new JSDOM(html);
		const { document } = dom.window;

		// 内联 <img src="https://...">
		const imgElements = Array.from(document.querySelectorAll("img"));
		await this.fetchWithConcurrencyLimit(
			imgElements.map((img) => async () => {
				const src = img.getAttribute("src");
				if (!this.isRemoteUrl(src)) return;
				// IM1:非白名单(IP / 内网 / 外部域)→ 换透明占位,绝不保留原
				// URL(否则 puppeteer 渲染时会自行抓取,SSRF 仍成立)。
				if (!this.isFetchAllowed(src)) {
					this.logger.warn(`[prefetch] 拦截非白名单图片 URL(SSRF 防护): ${src}`);
					img.setAttribute("src", ImageRenderer.BLOCKED_IMG_PLACEHOLDER);
					return;
				}
				try {
					img.setAttribute("src", await this.fetchImageAsDataUrl(src));
				} catch (err) {
					// ②5:预取失败**不得保留原 URL** —— 否则 puppeteer 渲染时自行
					// 抓取,违背「零外部引用」承诺(白名单内域也是外部网络)。换占位。
					this.logger.warn(`[prefetch] 图片预取失败，替换为占位(不留外部引用): ${src} (${err})`);
					img.setAttribute("src", ImageRenderer.BLOCKED_IMG_PLACEHOLDER);
				}
			}),
		);

		// 内联 CSS 远程引用。②5:仅 url(...) 不够 —— `@import "https://…"` 与
		// `image-set("https://…" …)` 同样能让 puppeteer 解析样式时发起外部抓取
		// (SSRF 残口)。三类一并收集 → 占位/内联。
		const cssUrlRegex = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi;
		const cssImportRegex = /@import\s+(?:url\()?['"]?(https?:\/\/[^'")\s]+)/gi;
		const cssImageSetRegex = /image-set\(\s*['"](https?:\/\/[^'"]+)['"]/gi;
		const cssUrlSet = new Set<string>();

		const collectCssUrls = (cssText: string) => {
			for (const m of cssText.matchAll(cssUrlRegex)) {
				if (this.isRemoteUrl(m[2])) cssUrlSet.add(m[2]);
			}
			for (const m of cssText.matchAll(cssImportRegex)) {
				if (this.isRemoteUrl(m[1])) cssUrlSet.add(m[1]);
			}
			for (const m of cssText.matchAll(cssImageSetRegex)) {
				if (this.isRemoteUrl(m[1])) cssUrlSet.add(m[1]);
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
				// IM1:非白名单 CSS 背景图同样换透明占位(否则 puppeteer 解析
				// 样式时会去抓 url(...),SSRF 仍成立)。
				if (!this.isFetchAllowed(url)) {
					this.logger.warn(`[prefetch] 拦截非白名单 CSS 图片 URL(SSRF 防护): ${url}`);
					cssUrlMap.set(url, ImageRenderer.BLOCKED_IMG_PLACEHOLDER);
					return;
				}
				try {
					cssUrlMap.set(url, await this.fetchImageAsDataUrl(url));
				} catch (err) {
					// ②5:同 <img> —— 预取失败换占位,绝不留原 URL 给 puppeteer 抓。
					this.logger.warn(
						`[prefetch] CSS 图片预取失败，替换为占位(不留外部引用): ${url} (${err})`,
					);
					cssUrlMap.set(url, ImageRenderer.BLOCKED_IMG_PLACEHOLDER);
				}
			}),
		);

		if (cssUrlMap.size > 0) {
			// ②5:按 URL 长度降序替换。否则若一个 URL 是另一个的前缀
			// (`…/a` vs `…/a/b`),先替短的会把长的截断破坏。
			const orderedEntries = [...cssUrlMap.entries()].sort(([a], [b]) => b.length - a.length);
			const replaceCssUrls = (css: string) => {
				let result = css;
				for (const [url, dataUrl] of orderedEntries) {
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
		// 先 inline 远程图片（耗时操作），再获取 page，避免 page 在空闲期间被回收
		const inlinedHtml = await this.inlineRemoteImages(html);
		const page = await this.puppeteer.page();
		try {
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
			// 显式持有 timer 句柄,Promise.race 完成后必须 clear,否则截图先到时
			// 这个 20s timer 会挂着空跑(还绕开了 serviceCtx,plugin dispose 期间
			// 无法回收)。改用 setTimeout 句柄 + finally clear,直接搞定。
			let timeoutId: NodeJS.Timeout | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error("截图超时（20s）")), 20_000);
			});
			try {
				const raw = await Promise.race([screenshotPromise, timeoutPromise]);
				await elementHandle.dispose();
				return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			}
		} finally {
			await page.close().catch(() => {}); // Chrome 已崩溃时 close() 也会抛错，忽略之
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
