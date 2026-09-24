import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardLevel } from "@bilibili-notify/blive";
import {
	CARD_SKIN_LIMITS,
	type CardSkinCard,
	type CardSkinKind,
	type CardSkinKnobOverrides,
	type CardSkinManifest,
	createSerialGate,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	type Disposable,
	effectiveCardSkinKnobs,
	type Logger,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { DateTime } from "luxon";
import { biliLiveCardInput } from "./bili-live-input";
import type { CardPropsByKind } from "./blocks/frames";
import { formatCardTime, numberToStr } from "./format";
import { buildLiveCardView, durationSince, LIVE_TIME_FORMAT, LIVE_TIME_ZONE } from "./live-view";
import type { PuppeteerLike, RenderPriority } from "./puppeteer";
import { USER_FONT_FAMILY } from "./render";
import { type ResolvedKnobAssets, resolveKnobAssets } from "./skin/knob-assets";
import {
	BLOCKED_IMG_PLACEHOLDER as BLOCKED_IMG_GIF,
	cardOfManifest,
	renderCardWithSkin,
	skinAssetRefs,
} from "./skin/render-skin";
import { shrinkImageForCssVar } from "./skin/shrink-image";
import { BG_COLORS, getSCLevel, SC_COLORS, SC_LEVELS } from "./styles";
import { buildDynamicNode, type DynamicNode } from "./templates/dynamic-content";
import type { LiveCardInput } from "./templates/live-card";
import type { RoastBoardCardProps, RoastSoloCardProps } from "./templates/roast-card";
import { injectWordCloudScript, wordCloudInitScript } from "./templates/wordcloud";
import type { CardColorOptions, CardSkinChoice, Dynamic, LiveData } from "./types";

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
 * 两种消费形态都验过:`lib/index.mjs`(独立端裸跑 / dev)与内联进 server 单文件 bundle
 * (打包器把本模块并进 dist/index.mjs,`static/` 由装配脚本搬到 dist/ 旁)。
 */
export const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

/** 图旋钮的解析结果最多留几份。见 `ImageRenderer#rememberKnobImage`。 */
const KNOB_IMAGE_CACHE_MAX = 4;

/**
 * 图旋钮轮换游标的键。**全局那串**记在 `<皮肤 id>:<旋钮 key>`(与 per-UP 出现之前一字不差);
 * 这枚旋钮的值来自 **per-UP 那层**时另记一格,键里带上那串 id 本身。
 *
 * 分开记是 ADR-0014 决策 17 的 🔗 要的:共用一格的话,这位 UP 每推一张就替全局那串往前拨
 * 一格(反过来也一样),两边都跳着出图。键用「那串 id」而不用订阅 id:渲染器不认得订阅,
 * 而这串就是 per-UP 那层自己的身份 —— 代价是两位 UP 单独选了**一模一样**的一串时共用一格,
 * 与全局那串跨订阅共用同一个道理(只让它转起来,不承诺公平)。那串一改就是新的一格、从头转。
 */
function knobCursorKey(
	skinId: string,
	key: string,
	perUp: Readonly<CardSkinKnobOverrides> | undefined,
): string {
	if (perUp === undefined || !(key in perUp)) return `${skinId}:${key}`;
	return `${skinId}:${key}@up:${JSON.stringify(perUp[key])}`;
}

/**
 * 锐评卡的**业务**入参。渐变 / 玻璃那几项 2026-09-20 从 props 上整批删掉(外观归皮肤的
 * 外框 CSS 与旋钮),所以这两个别名今天与 props 一字不差 —— 留着名字是因为它们是对外
 * 导出的入参契约,调用方(`apps/server` 的周报投递)写的是这个名。
 */
export type RoastBoardData = RoastBoardCardProps;
export type RoastSoloData = RoastSoloCardProps;

const GUARD_LEVEL_IMG: Record<GuardLevel, string> = {
	[GuardLevel.None]: "",
	[GuardLevel.Captain]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
	[GuardLevel.Admiral]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	[GuardLevel.Governor]:
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

/**
 * Runtime configuration for {@link ImageRenderer}. The standalone runtime fills it
 * from its own config store. The `logLevel` field is intentionally dropped — the
 * host is responsible for setting the logger level externally.
 */
export interface ImageRendererConfig {
	// 🪦 `backgroundImage` 2026-09-20 删掉(整条 `cardStyle.backgroundImages` 链):背景图
	// 归皮肤自己的 `image` 旋钮,值经 `cardSkinKnobs` → `resolveKnobAssets` 进来。
	/**
	 * 主人自带的字体文件资产 id(独立端专属);渲染期经 `resolveFontFace` 解析成一条
	 * 现成的 `@font-face` 规则。设了就**优先于 `font`**;宿主没注入 resolver、或资产
	 * 悬空时静静回落 `font`。
	 */
	fontAsset?: string;
	/**
	 * CSS font-family。**退役中**(2026-09-14):字体归皮肤自己的旋钮,独立端不再喂这一项;
	 * 不给就只剩 `renderCard` 那条兜底链 —— 与从前那句「默认(交给渲染那台机器)」同义。
	 */
	font?: string;
	/**
	 * 用户拧过的皮肤旋钮(**全局**那份),**按皮肤 id** 分开(ADR-0014 决策 16 的 🔗)。回落到
	 * 默认皮肤时自动取默认皮肤那份 —— 一套坏皮肤的配色不该跟着回落画到默认皮肤上。
	 * per-UP 那层随每张卡的选项进来(`CardColorOptions.cardSkinKnobs`),在出图那一刻逐枚叠上。
	 */
	cardSkinKnobs?: Readonly<Record<string, CardSkinKnobOverrides>>;
}

export interface ImageRendererOptions {
	serviceCtx: ServiceContext;
	puppeteer: PuppeteerLike;
	config: ImageRendererConfig;
	/**
	 * 把卡片背景图资产 id 解析成可渲染的 data URL(宿主注入,读 `<dataDir>/assets/card-bg`)。
	 * 解析不出来返回空串。已是 data:/http URL 的值直接透传、不经此回调。
	 */
	resolveAsset: (id: string) => Promise<string>;
	/**
	 * 把字体资产 id 解析成**一整条 `@font-face` 规则**(宿主注入,读
	 * `<dataDir>/assets/font` 后用 {@link buildFontFace} 拼好)。解析不出来返回空串,
	 * 渲染器回落家族名。
	 *
	 * 契约是整条规则而不是 data URL,为的是**省一整份内存**:一款中文字库 base64 之后
	 * 二三十兆,渲染器若再自己拼一遍,同一串东西在堆里就有两份 —— 而镜像里 V8 的
	 * old-space 上限只有 512MB。宿主那边本来就按资产 id 缓存着解析结果,顺手拼好即可。
	 */
	resolveFontFace: (id: string) => Promise<string>;
	/**
	 * 热更日志降级到 debug。**预览渲染器**(dashboard 每来一次预览请求就
	 * updateConfig 一遍)必须开:主人在 Cards 页拖一格滑块就是一条 INFO「配置已
	 * 更新」,既刷屏,又和真正落盘生效的那条(推送渲染器热重载)长得一模一样,读起来
	 * 像"已经保存了"。降到 debug 后排障仍拿得到,平时不冒充保存。
	 */
	quietConfigUpdates?: boolean;
	/**
	 * 皮肤 id → 那份清单(宿主注入,读 `<dataDir>/card-skins/`)。**同步**:出图是逐张卡
	 * 的热路径,而宿主那头本来就把索引攥在内存里。取不到 → 回落默认皮肤并报
	 * {@link ImageRendererOptions.onCardSkinFallback}。不注入 = 只有内置默认皮肤。
	 */
	resolveCardSkin?: (id: string) => CardSkinManifest | undefined;
	/**
	 * 皮肤包内资产名(`assets/<名>`)→ data URL(宿主注入,读盘)。取不到回 undefined,
	 * 渲染器用透明占位。与 {@link resolveAsset} 不同的是它按**皮肤**分格 —— 两套皮肤各带
	 * 一张 `assets/bg.png` 是完全正常的事。
	 */
	resolveCardSkinAsset?: (skinId: string, name: string) => Promise<string | undefined>;
	/**
	 * 出图回落了(ADR-0014 决策 19「回落必须可见」)。宿主拿它亮面板告警 —— 用户换了皮肤
	 * 却看不出没生效,只会以为是自己没保存。
	 *
	 * **去重归宿主**:同一套皮肤每张卡都会回落一次,渲染器这一层不认识「同一个原因」。
	 */
	onCardSkinFallback?: (info: { skinId: string; kind: CardSkinKind; reason: string }) => void;
}

export class ImageRenderer {
	readonly logger: Logger;
	private readonly serviceCtx: ServiceContext;
	private readonly puppeteer: PuppeteerLike;
	private config: ImageRendererConfig;
	/**
	 * 图片旋钮的轮换游标 → 已经出过几张。全局那串记在 `<皮肤 id>:<旋钮 key>`;per-UP 那串
	 * 另记一格(见 {@link knobCursorKey}),两边不互相拨动。
	 */
	private readonly knobImageCursor = new Map<string, number>();
	/**
	 * 资产 id → **最终注进 CSS 的那串**(空串 = 这张注不出去,别再白读白压)。
	 * 见 {@link knobImage} / {@link rememberKnobImage}。
	 */
	private readonly knobImageCache = new Map<string, string>();
	private readonly resolveAsset: (id: string) => Promise<string>;
	private readonly resolveFontFace: (id: string) => Promise<string>;
	private readonly quietConfigUpdates: boolean;
	private readonly resolveCardSkin?: (id: string) => CardSkinManifest | undefined;
	private readonly resolveCardSkinAsset?: (
		skinId: string,
		name: string,
	) => Promise<string | undefined>;
	private readonly onCardSkinFallback?: (info: {
		skinId: string;
		kind: CardSkinKind;
		reason: string;
	}) => void;

	/**
	 * 自带字体的解析结果缓存 —— **只留一款,且留的是拼好的那条规则**。
	 *
	 * 一款完整中文字库十几到几十兆,base64 之后还要再涨三分之一。每张卡重读一遍盘既慢
	 * 又在 Docker 那点堆上限里反复搓大字符串;而同一时刻真正在用的通常就一款,留一份
	 * 足够(per-UP 换了一款就换掉这一份,不攒)。
	 *
	 * 存 `@font-face` 规则而不是 data URL:规则本身就把 data URL 包在里头,只留它就等于
	 * 少留一整份几十兆的串。
	 */
	private fontCache: { id: string; fontFace: string } | null = null;

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
	/**
	 * 1x1 透明 GIF —— 被拦截的远端图替换成它,保证最终 HTML 无任何外部引用可被 puppeteer 再抓。
	 * 与皮肤渲染器「取不到包内资产」时用的是**同一串**(那边是 `skin/render-skin.tsx` 的
	 * `BLOCKED_IMG_PLACEHOLDER`),各写一份迟早漂移。
	 */
	private static readonly BLOCKED_IMG_PLACEHOLDER = BLOCKED_IMG_GIF;
	/** IM2:单张远端图字节上限,防超大图全量入内存 + base64 膨胀驻留 cache → OOM。 */
	private readonly MAX_REMOTE_IMG_BYTES = 8 * 1024 * 1024;

	/**
	 * 串行渲染队列,避免 puppeteer 并发问题。带两条车道:链接卡这类低优先级的渲染在
	 * 正常车道排空之前不动 —— 优先级得在这一级就生效,只在浏览器闸那级让路的话,
	 * 低优先级的渲染在这里就已经排到推送卡前面了。
	 */
	private readonly renderGate = createSerialGate();

	constructor(opts: ImageRendererOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.puppeteer = opts.puppeteer;
		this.config = opts.config;
		this.resolveAsset = opts.resolveAsset;
		this.resolveFontFace = opts.resolveFontFace;
		this.quietConfigUpdates = opts.quietConfigUpdates ?? false;
		this.resolveCardSkin = opts.resolveCardSkin;
		this.resolveCardSkinAsset = opts.resolveCardSkinAsset;
		this.onCardSkinFallback = opts.onCardSkinFallback;
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
		// 日志内容只列**真正变化**的字段(此前无脑打印一整份配置,改玻璃片透明度这类字段时
		// 看起来像"别的项又被打印了一遍",容易被误读成没热更新到实际改的项)。
		const diffs: string[] = [];
		if (prev.font !== config.font) diffs.push(`font=${config.font}`);
		if (prev.fontAsset !== config.fontAsset) {
			diffs.push(`fontAsset=${config.fontAsset ? "(自带字体)" : "(无)"}`);
			// 换了一款就把缓存里那份几十兆的 base64 放掉,别攥着已经不用的字体。
			this.fontCache = null;
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

	unixTimestampToString(timestamp: number): string {
		return formatCardTime(timestamp);
	}

	/**
	 * 解析一个图片资产字段为可渲染 URL:空 → "";已是 data:/http URL → 透传(预览路由已解析);
	 * 否则当资产 id,经注入的 resolveAsset 读盘解析成 data URL(解析不出来即 "")。
	 *
	 * 今天只剩**直播封面**(`liveCoverImage`)走它 —— 卡片背景图那条链 2026-09-20 整个删掉
	 * (背景图归皮肤的 `image` 旋钮,走 `resolveKnobAssets`)。
	 */
	private async resolveBg(v?: string): Promise<string> {
		if (!v) return "";
		if (v.startsWith("data:") || v.startsWith("http")) return v;
		return await this.resolveAsset(v);
	}

	/**
	 * 这张卡用哪款字体 —— 每个 generate* 都经它,per-call 覆盖优先于全局 config。
	 *
	 * `colorOptions.font` 曾经**根本没被读过**:设置页允许给单个 UP / 单类卡另设字体,
	 * 存得下也解析得出,就是没人交给渲染器,于是选了等于没选。这一族 bug 长得都一样 ——
	 * 界面上改得动、保存得下、行为不变。
	 *
	 * 自带的字体文件优先:宿主把它解析成一条现成的 `@font-face`,家族名换成内部那个。
	 * 解析不出来(资产被删了、卷丢了)就静静回落家族名 —— 出图不该因为
	 * 少一个文件而崩,也不该塞一条空 src 的规则进 CSS。
	 */
	private async resolveFont(
		colorOptions: CardColorOptions = {},
	): Promise<{ font: string; fontFace?: string }> {
		const font = colorOptions.font ?? this.config.font ?? "";
		const assetId = colorOptions.fontAsset ?? this.config.fontAsset;
		if (!assetId) return { font };

		if (this.fontCache?.id !== assetId) {
			const fontFace = await this.resolveFontFace(assetId);
			this.fontCache = fontFace ? { id: assetId, fontFace } : null;
		}
		if (!this.fontCache) return { font };
		// 原样透传,**不再自己拼** —— 拼一遍就是在堆里多一份几十兆的串。
		return { font: USER_FONT_FAMILY, fontFace: this.fontCache.fontFace };
	}

	/**
	 * 字体 / 图两档旋钮 → 额外的 `@font-face` 与根块变量(见 `skin/knob-assets.ts`)。
	 *
	 * `overrides` 是**合好的**那份(per-UP → 全局);`perUp` 单给是为了认出哪一枚来自
	 * per-UP 那层 —— 轮换游标要按层分开记(见 {@link knobCursorKey})。
	 *
	 * 多张图**每次推送轮换**:游标记在渲染器上。从前那份轮换记在推送侧(每个房间自己一份),
	 * 而旋钮值住配置、推送侧根本不认得它 —— 记在这里是唯一摸得着那个「第几次」的地方。
	 * 跨订阅共用一个游标只是让它转起来,不承诺公平。
	 */
	private async resolveKnobAssets(
		skinId: string,
		knobs: CardSkinManifest["knobs"],
		overrides: Readonly<CardSkinKnobOverrides> | undefined,
		perUp: Readonly<CardSkinKnobOverrides> | undefined,
	): Promise<ResolvedKnobAssets> {
		const out = await resolveKnobAssets(knobs, overrides, {
			image: (assetId) => this.knobImage(assetId),
			fontFace: (assetId) => this.resolveFontFace(assetId),
			shrinkImage: (url, budget) => shrinkImageForCssVar(this.puppeteer, url, budget),
			onImageResolved: (assetId, url) => this.rememberKnobImage(assetId, url),
			pick: (count, key) => {
				const cursor = knobCursorKey(skinId, key, perUp);
				const at = this.knobImageCursor.get(cursor) ?? 0;
				this.knobImageCursor.set(cursor, at + 1);
				return at % count;
			},
		});
		// **这一层的失败全是静默的**(图不出、字体回落),不说出来主人只能对着一张
		// 少了背景的卡片猜。
		for (const w of out.warnings) this.logger.warn(`[card-skin] ${w}`);
		return out;
	}

	/**
	 * 图旋钮指着的那个资产 → data URL,**命中缓存就不读盘**。
	 *
	 * 缓存里存的是「最终要注进 CSS 的那串」(见 {@link rememberKnobImage}),所以命中时
	 * 连 `fitUrl` 那趟按预算压的判断都一并省了 —— 它对已经合规的串是空操作。
	 *
	 * **不需要作废**:id 是上传时摇的随机名,`saveCardBg` 只新建不覆盖,同一个 id 永远是
	 * 同一份字节(图廊那条 `GET /asset/:id` 也照这条发 `Cache-Control: immutable`);换一张图
	 * 就是换一个 id,自然不命中。而删图那头有引用闸 —— 还被旋钮指着的图删不掉(409),所以
	 * 「id 还在、字节没了」只可能是有人手动动了数据目录。
	 */
	private async knobImage(assetId: string): Promise<string> {
		const hit = this.knobImageCache.get(assetId);
		return hit !== undefined ? hit : await this.resolveAsset(assetId);
	}

	/**
	 * 记住这个资产最终注出去的那串。**空串也记** —— 注不出去(悬空 / 压不进 2 MiB 上限)
	 * 同样是个不会变的答案,不记的话每张卡都要为同一张废图再读一遍盘、再白压一次。
	 *
	 * 留几份就照 {@link fontCache} 的先例卡住:每份最多 `IMAGE_URL_BUDGET` 个字符
	 * (约 2 MiB),而镜像里 V8 的 old-space 只有 512MB。多图轮换时留一份会次次落空,所以
	 * 留一小撮、按插入顺序淘汰最旧的。
	 */
	private rememberKnobImage(assetId: string, url: string): void {
		this.knobImageCache.delete(assetId);
		this.knobImageCache.set(assetId, url);
		for (const oldest of this.knobImageCache.keys()) {
			if (this.knobImageCache.size <= KNOB_IMAGE_CACHE_MAX) break;
			this.knobImageCache.delete(oldest);
		}
	}

	/**
	 * B 站 `live_time`(北京时间「yyyy-MM-dd HH:mm:ss」)到此刻过了多久,写成「2小时13分」。
	 * 直播引擎拿它拼文案里的直播时长;卡上那句走的是同一个 {@link durationSince}。
	 */
	async getTimeDifference(dateString: string): Promise<string> {
		return durationSince(
			DateTime.fromFormat(dateString, LIVE_TIME_FORMAT, { zone: LIVE_TIME_ZONE }),
		);
	}

	// ── 皮肤(ADR-0014) ─────────────────────────────────────────────────────────

	/** 这张卡用哪套皮肤;缺省 / 空串 = 内置默认。 */
	private skinIdOf(opts?: { cardSkin?: string }): string {
		return opts?.cardSkin || DEFAULT_CARD_SKIN_ID;
	}

	/**
	 * 这张卡要用的**包内资产**预取成表。
	 *
	 * 渲染器里的资产查表是**同步**的(替换发生在一次字符串替换的回调里),而宿主读盘是
	 * 异步的 —— 所以先按 `skinAssetRefs` 列出名单一次性取完,再把表交给渲染器。取不到的
	 * 不进表(渲染器那头用透明占位),一张取不到不该拖垮整张卡。
	 */
	private async prefetchSkinAssets(
		skinId: string,
		card: CardSkinCard,
		fonts?: CardSkinManifest["fonts"],
	): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const resolve = this.resolveCardSkinAsset;
		if (!resolve) return out;
		const refs = skinAssetRefs(card, fonts);
		if (refs.length === 0) return out;
		await Promise.all(
			refs.map(async (name) => {
				try {
					const url = await resolve(skinId, name);
					if (url) out.set(name, url);
				} catch (e) {
					this.logger.warn(`[card-skin] 皮肤「${skinId}」的资产 ${name} 取不到:${e}`);
				}
			}),
		);
		return out;
	}

	/**
	 * **一切出图的唯一入口**(ADR-0014 决策 18 / 19)。皮肤 JSON + 这张卡的 props →
	 * HTML → 截图。
	 *
	 * 三道回落,顺序是刻意的:
	 *
	 * 1. **皮肤不在 / 没有这种卡** → 默认皮肤(渲染都还没开始,最便宜的一道);
	 * 2. **渲染抛错** → 默认皮肤重画一次。推送不能因为换皮肤而丢,所以这里吞掉的是
	 *    皮肤的错,不是渲染管线的错 —— 默认皮肤也抛就照抛出去,由推送那侧降级成文字;
	 * 3. **卡片太高**(`CARD_SKIN_LIMITS.maxHeight`)→ 默认皮肤重画。默认皮肤也超
	 *    **照发**:那时长的是内容,不是皮肤。
	 *
	 * 三道都经 {@link ImageRendererOptions.onCardSkinFallback} 报给宿主;**id 本来就是
	 * 默认皮肤时不算回落**,不报(没换过皮肤的人不该收到「皮肤回落」的告警)。
	 */
	private async renderWithSkin<K extends CardSkinKind>(args: {
		kind: K;
		props: CardPropsByKind[K];
		/** `<title>`;截图里看不见,排障时看得见。 */
		title: string;
		skinId: string;
		/**
		 * 这位 UP 那层旋钮覆盖(按皮肤 id 分,原样的 per-UP 层)。与 config 里全局那份在
		 * 下面的 `once` 里逐枚合并 —— 回落到默认皮肤时取的也是默认皮肤那一格。
		 */
		skinKnobs?: CardSkinChoice["cardSkinKnobs"];
		font: { font: string; fontFace?: string };
		priority?: RenderPriority;
		/** 截图前要等的页内条件(词云等画完)。 */
		waitFor?: string;
		/** HTML 出来之后再动一刀(词云往 `</body>` 前塞画词脚本)。 */
		postProcess?: (html: string) => string;
	}): Promise<Buffer> {
		const { kind, props, title, font } = args;
		const max = CARD_SKIN_LIMITS.maxHeight;

		const once = async (
			id: string,
			manifest: CardSkinManifest,
		): Promise<{ buffer: Buffer; height: number }> => {
			// 逐枚合并:per-UP 拧过的 → 全局拧过的 → 不注(ADR-0014 决策 17 的 🔗)。字体 / 图两档
			// 也吃这份合好的 —— 它们要读盘,只把 per-UP 喂给 `knobValues` 的话那两档会静静不动。
			const knobValues = effectiveCardSkinKnobs(this.config.cardSkinKnobs, args.skinKnobs, id);
			// 包内资产与旋钮资产之间零依赖 —— 并发发起,省掉一次串行 I/O 往返。
			const [assets, knobAssets] = await Promise.all([
				this.prefetchSkinAssets(id, cardOfManifest(manifest, kind), manifest.fonts),
				this.resolveKnobAssets(id, manifest.knobs, knobValues, args.skinKnobs?.[id]),
			]);
			let html = await renderCardWithSkin(kind, props, manifest, {
				title,
				font: font.font,
				fontFace: font.fontFace,
				resolveAsset: (name) => assets.get(name),
				knobValues,
				knobAssets,
			});
			if (args.postProcess) html = args.postProcess(html);
			return await withRetry(() => this.renderHtml(html, args.waitFor, args.priority));
		};

		const fallback = async (from: string, reason: string): Promise<Buffer> => {
			// 只报事实,去重与「怎么让主人看见」归宿主 —— 同一套坏皮肤每张卡都会走到这儿。
			this.onCardSkinFallback?.({ skinId: from, kind, reason });
			this.logger.debug(`[card-skin] 皮肤「${from}」的 ${kind} 卡${reason},回落默认皮肤`);
			return (await once(DEFAULT_CARD_SKIN_ID, DEFAULT_CARD_SKIN)).buffer;
		};

		const id = args.skinId;
		const isDefault = id === DEFAULT_CARD_SKIN_ID;
		// 默认皮肤是代码里的常量,宿主没注入解析口时它仍然在。
		const manifest = this.resolveCardSkin?.(id) ?? (isDefault ? DEFAULT_CARD_SKIN : undefined);
		if (!manifest) return await fallback(id, "皮肤不存在");
		if (!manifest.cards[kind] && !isDefault) return await fallback(id, "皮肤没有这种卡");

		try {
			const { buffer, height } = await once(id, manifest);
			// 量出来的是**整张图**的高,而图 = 卡 + 上下两道出血。闸拦的是「内容太长」,
			// 出血是皮肤自己选的常数,不该从这张卡的额度里扣 —— 报出来的那个数同理,
			// 说「卡片高度」就得是卡的高度。
			const bleed = cardOfManifest(manifest, kind).bleed?.size ?? 0;
			const cardHeight = height - bleed * 2;
			if (isDefault || cardHeight <= max) return buffer;
			return await fallback(id, `卡片高度 ${Math.round(cardHeight)} 超过上限 ${max}`);
		} catch (e) {
			// 默认皮肤自己画不出来 = 渲染管线的问题,往外抛(推送那侧本来就有降级兜底)。
			if (isDefault) throw e;
			return await fallback(id, `渲染失败(${e instanceof Error ? e.message : String(e)})`);
		}
	}

	// ── 图片生成公共方法 ──────────────────────────────────────────────────────────

	/**
	 * **B 站直播卡的适配层**:接口数据 → {@link biliLiveCardInput} → {@link generateNeutralLiveCard}。
	 * 签名不动,直播引擎与预览路由照旧调它。
	 *
	 * `liveStatus` 两种来源:直播引擎传 `LiveType`(1 开播 / 2 直播中 / 3 下播 / 4 首次),
	 * 私聊指令传接口原值(0 没在播 / 1 在播)。
	 */
	async generateLiveCard(
		// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
		data: any,
		username: string,
		userface: string,
		liveData: LiveData,
		liveStatus: number,
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		return this.generateNeutralLiveCard(
			biliLiveCardInput(data, username, userface, liveData, liveStatus),
			colorOptions,
		);
	}

	/**
	 * **直播卡的中立入口**(ADR-0019 决策 68):吃一份 {@link LiveCardInput},不收任何平台的
	 * 原始数据。状态明写(开播 / 直播中 / 下播 / 没在播),卡上那句时间由开播时刻算。
	 *
	 * 主人给这条订阅设的自定义直播封面(`colorOptions.liveCoverImage`,独立端专属)在这里
	 * 解析、盖在输入的封面上 —— 它是 BN 的卡片样式,不分平台。
	 *
	 * 卡里的图只认字符串地址(远端网址或 data URL):远端的走白名单预取,data URL 原样进卡。
	 */
	async generateNeutralLiveCard(
		input: LiveCardInput,
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		const username = input.author.name;
		this.logger.debug(`[live] 开始渲染直播卡片：${username}`);
		// 自定义封面解析成 data URL;解析为 "" 时用输入里那张,特性自动无感。
		const coverOverride = await this.resolveBg(colorOptions.liveCoverImage);

		return this.renderWithSkin({
			kind: "live",
			title: "直播通知",
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(colorOptions),
			props: buildLiveCardView(input, coverOverride || undefined),
		})
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
		 * per-call 样式覆盖;上舰卡只取字体与皮肤(bgColor 由舰长等级决定,渐变色不适用)。
		 * 缺省 = 走渲染器全局 config(复刻现状)。
		 */
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		const guardName = ["", "总督", "提督", "舰长"][guardLevel] ?? "上舰";
		this.logger.debug(`[guard] 开始渲染上舰卡片：${uname} → ${masterName}（${guardName}）`);
		const captainImgUrl = GUARD_LEVEL_IMG[guardLevel] ?? "";

		return this.renderWithSkin({
			kind: "guard",
			title: "上舰通知",
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(colorOptions),
			props: {
				captainImgUrl,
				guardLevel,
				uname,
				face,
				isAdmin,
				masterAvatarUrl,
				masterName,
				bgColor: BG_COLORS[guardLevel],
			},
		})
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
		 * per-call 样式覆盖;SC 卡只取字体与皮肤(bgColor 由价格档位决定,渐变色不适用)。
		 * 缺省 = 走渲染器全局 config(复刻现状)。
		 */
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[sc] 开始渲染 SC 卡片：${senderName} → ${masterName}（¥${price}）`);
		const battery = price * 10;
		const levelIndex = getSCLevel(battery);
		const bgColor = SC_COLORS[levelIndex];
		const levelInfo = Object.values(SC_LEVELS)[levelIndex];

		return this.renderWithSkin({
			kind: "sc",
			title: "醒目留言通知",
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(colorOptions),
			props: {
				senderFace,
				senderName,
				masterName,
				masterAvatarUrl,
				text,
				price,
				duration: levelInfo.duration,
				bgColor,
			},
		})
			.then((buf) => {
				this.logger.debug(`[sc] SC 卡片渲染完成：${senderName}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成 SC 卡片失败！错误: ${e}`);
			});
	}

	/**
	 * **B 站动态的适配层**:原始动态 → {@link buildDynamicNode} 造 node(皮肤要的类型与图也
	 * 一并记在 node 上)→ {@link generateNeutralDynamicCard}。签名不动,推送与链接解析照旧调它。
	 *
	 * 开播伪动态(`DYNAMIC_TYPE_LIVE_RCMD`)在**顶层**造不出 node,在那一步抛「直播开播动态，不做
	 * 处理」。动态引擎在过滤与出卡之前就按类型把顶层的它跳过了(ADR-0019 决策 66),不再靠认这句
	 * 原文;顶层还撞得上它的只剩卡片页的真实预览(按序号取某位 UP 的一条动态,可能正好是它)。
	 * **转发**的原动态是它时不抛 —— 引擎跳不掉转发,那一格画成「无法渲染」那一类提示,转发照常
	 * 出卡。造 node 放在包错之外,那里报出来的就是这句原文,比套一层「生成动态卡片失败」说得清。
	 */
	async generateDynamicCard(
		data: Dynamic,
		colorOptions: CardColorOptions = {},
		/** 渲染优先级;链接解析出的卡传 `low`,推送卡不传。 */
		options?: { priority?: RenderPriority },
	): Promise<Buffer> {
		const node = await buildDynamicNode(data, false, {
			time: (ts) => this.unixTimestampToString(ts),
			num: (n) => numberToStr(n),
		});
		return this.generateNeutralDynamicCard(node, colorOptions, options);
	}

	/**
	 * **动态卡的中立入口**(ADR-0019 决策 68):吃一棵造好的 {@link DynamicNode},不收任何平台的
	 * 原始数据 —— 皮肤契约要的那几格(动态类型、图廊张数 / 首图、转发内层那一份)都在 node 上,
	 * 转发内层是 `node.forward`,自己带着自己的那几格。
	 *
	 * 卡里的图只认字符串地址(远端网址或 data URL):远端的走白名单预取,data URL 原样进卡。
	 */
	async generateNeutralDynamicCard(
		node: DynamicNode,
		colorOptions: CardColorOptions = {},
		/** 渲染优先级;链接解析出的卡传 `low`,推送卡不传。 */
		options?: { priority?: RenderPriority },
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[dynamic] 开始渲染动态卡片：${node.upName}`);
		return this.renderWithSkin({
			kind: "dynamic",
			title: "动态通知",
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(colorOptions),
			priority: options?.priority,
			props: { node },
		})
			.then((buf) => {
				this.logger.debug(`[dynamic] 动态卡片渲染完成：${node.upName}（${Date.now() - t0}ms）`);
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
		/**
		 * 用哪套皮肤、这位 UP 怎么拧它;词云卡整张是一个内置块,皮肤只管外框(ADR-0014 决策 3)。
		 */
		opts: CardSkinChoice = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[wordcloud] 开始渲染词云卡片：${masterName}（${words.length} 词）`);
		// 画布(`#wordCloudCanvas`)在内置块里,皮肤路径出的 HTML 照样有它 —— 画词的脚本
		// 原样注进 `</body>` 之前(`wordCloudInitScript`,读盘拼脚本那一半单独住在那儿)。
		const script = wordCloudInitScript(words, ASSET_DIR);
		return this.renderWithSkin({
			kind: "wordcloud",
			title: "弹幕词云",
			skinId: this.skinIdOf(opts),
			skinKnobs: opts.cardSkinKnobs,
			font: await this.resolveFont(),
			waitFor: "window.wordcloudDone === true",
			postProcess: (html) => injectWordCloudScript(html, script),
			props: { masterName, masterAvatarUrl },
		})
			.then((buf) => {
				this.logger.debug(`[wordcloud] 词云卡片渲染完成：${masterName}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成词云图片失败！错误: ${e}`);
			});
	}

	async generateRoastBoardCard(
		data: RoastBoardData,
		/** 用哪套皮肤;榜单整张是一个内置块,皮肤只管外框(ADR-0014 决策 3)。 */
		opts: { cardSkin?: string } = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[roast] 开始渲染周报卡片：近 ${data.days} 天`);
		return this.renderWithSkin({
			kind: "roastBoard",
			title: "UP 主周报",
			skinId: this.skinIdOf(opts),
			font: await this.resolveFont(),
			props: { ...data },
		})
			.then((buf) => {
				this.logger.debug(`[roast] 周报卡片渲染完成（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(`生成周报卡片失败！错误: ${e}`);
			});
	}

	async generateRoastSoloCard(
		data: RoastSoloData,
		/** 用哪套皮肤;单人锐评整张是一个内置块,皮肤只管外框(ADR-0014 决策 3)。 */
		opts: { cardSkin?: string } = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[roast] 开始渲染单人锐评卡片：${data.up.name}`);
		return this.renderWithSkin({
			kind: "roastSolo",
			title: "UP 主锐评",
			skinId: this.skinIdOf(opts),
			font: await this.resolveFont(),
			props: { ...data },
		})
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
	 * 被丢成透明占位 → 图渲染不出来。给 i*.hdslb.com 的 /bfs/ 资源加 `@<w>w_<q>q_1s.webp`
	 * 后缀,让 CDN 直接返回缩放压缩版,既不触发上限,内联体积也小一个数量级。 */
	private static readonly BILI_IMG_MAX_W = 1280;
	private static readonly BILI_IMG_QUALITY = 80;
	/**
	 * 「只要第一帧」。**没有它 GIF 会被转成动画 webp** —— 实测一张 6.7MB 的 GIF:
	 * 带 `_1s` 是 37KB / 0.17s 的静态图,不带是 2.33MB / 6.9s、含 74 个动画帧块。
	 * 出图走截图,动画本来就只截得到一帧,那点体积和秒数纯属白烧,还正好撞上 10s
	 * 抓取超时 —— 一超时就被静默换成 1x1 透明占位,于是卡片上凭空缺几张图。
	 *
	 * 对静图无副作用(实测两张 face 图带不带 `_1s` 返回字节分毫不差),所以不按源
	 * 格式分流,一律带上 —— 少一条「靠扩展名猜是不是动图」的分支,也就少一处会错。
	 */
	private static readonly BILI_IMG_FIRST_FRAME = "_1s";

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
		const suffix = `@${ImageRenderer.BILI_IMG_MAX_W}w_${ImageRenderer.BILI_IMG_QUALITY}q${ImageRenderer.BILI_IMG_FIRST_FRAME}.webp`;
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

		let dataUrl: string;
		try {
			dataUrl = await this.fetchOnce(url);
		} catch (err) {
			// 加处理后缀是**为了**避开 8MB 上限,但它自己也是一条会断的路:CDN 得现场
			// 转码,可能超时,也可能对某个源根本不吃这套参数。而预取失败在上游是被吞掉
			// 的(换 1x1 透明占位、整张卡照样「渲染成功」),主人只能靠肉眼发现某几格
			// 是空的 —— 所以这条路断了必须退回原图再试一次。原图不需要转码,通常直接
			// 命中 CDN 存储;只有它也拿不到才算真没辙。
			if (url === rawUrl) throw err;
			this.logger.warn(`[prefetch] 处理版取图失败,回退原图重试:${url} (${err})`);
			dataUrl = await this.fetchOnce(rawUrl);
		}
		// 缓存键恒用处理后 URL(回退拿到的也记在这个键上)—— 同一张图在一张卡里常出现
		// 多次,让后面几次直接命中,而不是每次都先把那条死路重撞一遍。
		this.imageCache.set(url, { dataUrl, updatedAt: Date.now() });
		this.pruneImageCache();
		return dataUrl;
	}

	/** 真正发起一次抓取并转成 data URL。失败一律抛,由调用方决定要不要换条路再来。 */
	private async fetchOnce(url: string): Promise<string> {
		// IM1:SSRF 闸门(防御纵深 —— 调用方也已 gate,但这里才是真正发起 fetch
		// 的点,独立守一道)。回退路径同样经过这里,不存在绕过。
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
			// 写缓存由调用方统一做 —— 这里若自己写一笔,回退路径就会在 rawUrl 上多留
			// 一个键,跟处理后 URL 那个键各存一份同一张图,白占额度还搅乱逐出顺序。
			return `data:${contentType};base64,${buf.toString("base64")}`;
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

	/**
	 * 回的是 `{ buffer, height }` 而不是光一个 buffer:**卡片最大高度那道闸要的正是这个数**
	 * (ADR-0014 决策 19),而它只有在这儿(截图前量 `html` 的 boundingBox)拿得到 ——
	 * 出了这个函数就只剩一团 JPEG 字节,再想知道多高就得把图解码回来。
	 */
	private async doRender(
		html: string,
		waitForCondition?: string,
		priority: RenderPriority = "normal",
	): Promise<{ buffer: Buffer; height: number }> {
		// 先 inline 远程图片（耗时操作），再获取 page，避免 page 在空闲期间被回收
		const inlinedHtml = await this.inlineRemoteImages(html);
		const page = await this.puppeteer.page({ priority });
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
				return {
					buffer: Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
					height: boundingBox.height,
				};
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			}
		} finally {
			await page.close().catch(() => {}); // Chrome 已崩溃时 close() 也会抛错，忽略之
		}
	}

	/**
	 * 把一份**现成的 HTML** 截成图 —— 编辑器的「最终效果」走这条(ADR-0014 决策 22)。
	 *
	 * 走的是与出图同一个实例:串行闸是**实例私有**的,另起一个渲染器等于放两条并发的
	 * Chrome 渲染出去。这条不碰 `config` —— HTML 已经画好了,配置对它没有任何影响。
	 *
	 * 回 `height` 是为了让编辑器能提前说「这张超过最大高度」:出图那头超了会**静默**回落
	 * 默认皮肤(决策 19),而编辑器是作者唯一能在发出去之前知道的地方。
	 */
	async screenshotHtml(
		html: string,
		opts: { priority?: RenderPriority } = {},
	): Promise<{ buffer: Buffer; height: number }> {
		return await this.renderHtml(html, undefined, opts.priority ?? "normal");
	}

	/** 将渲染任务加入串行队列;一个任务抛错不影响后面的(release 在 finally 里)。 */
	private async renderHtml(
		html: string,
		waitForCondition?: string,
		priority: RenderPriority = "normal",
	): Promise<{ buffer: Buffer; height: number }> {
		const release = await this.renderGate.acquire({ priority });
		try {
			return await this.doRender(html, waitForCondition, priority);
		} finally {
			release();
		}
	}
}
