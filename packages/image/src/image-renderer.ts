import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CARD_SKIN_LIMITS,
	type CardKind,
	type CardSkinCard,
	type CardSkinKnobOverrides,
	type CardSkinManifest,
	createSerialGate,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	effectiveCardSkinKnobs,
	formatAmount,
	type ImageRef,
	type Logger,
	type Post,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { packageText } from "@bilibili-notify/internal/texts";
import type { CardPropsByKind } from "./blocks/frames";
import { formatCardTime } from "./format";
import { buildLiveCardView } from "./live-view";
import { buildMembershipCardView } from "./membership-view";
import type { PuppeteerLike, RenderPriority } from "./puppeteer";
import { USER_FONT_FAMILY } from "./render";
import { type ResolvedKnobAssets, resolveKnobAssets } from "./skin/knob-assets";
import { cardOfManifest, renderCardWithSkin, skinAssetRefs } from "./skin/render-skin";
import { shrinkImageForCssVar } from "./skin/shrink-image";
import { buildSuperchatCardView } from "./superchat-view";
import type { LiveCardInput } from "./templates/live-card";
import type { MembershipCardInput } from "./templates/membership-card";
import { nodeFromPost } from "./templates/post-node";
import { collectImageRefs } from "./templates/post-refs";
import type { RoastBoardCardInput, RoastSoloCardInput } from "./templates/roast-card";
import type { SuperchatCardInput } from "./templates/superchat-card";
import { injectWordCloudScript, wordCloudInitScript } from "./templates/wordcloud";
import type { CardColorOptions, CardSkinChoice } from "./types";

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

/**
 * 被拦下的请求要去哪:有主机报主机,没有主机的(`file:` 之类)报协议。路径与参数不进日志
 * —— 里头可能有签名、令牌,而排障只要知道是哪一处还在把远端地址交进来。
 */
function blockedTargetOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.host || parsed.protocol;
	} catch {
		return "(解析不了的地址)";
	}
}

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
export interface ImageRendererSettings {
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
	config: ImageRendererSettings;
	/**
	 * 把卡片背景图资产 id 解析成可渲染的 data URL(宿主注入,读 `<dataDir>/assets/card-bg`)。
	 * 解析不出来返回空串。
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
	 * 全局时区(ADR-0021 决策 43)的现取口:卡上的时间按它排。**出卡那一刻取**,不在构造时存,
	 * 主人改了设置,后续每一张卡立刻跟上。必填 —— 推送与预览两个宿主漏接一个就是「预览与
	 * 推送分家」,让类型检查替两处把关。
	 */
	timezone: () => string;
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
	 * 图库引用 → 可画的地址(宿主注入,读图库,**读字节转成 data URL**)。作品卡里的配图、封面、头像、正文小图标
	 * 与表情图都是 `ImageRef`(`Post` 只收引用),出图前由 {@link ImageRenderer.generatePostCard} 逐个问它。
	 *
	 * 契约是 data URL 而不是本机地址:渲染页只许 `data:`(别的请求被浏览器适配层的闸掐断),不该为了一张作品图去访问本机 HTTP
	 * (还得带上面板的鉴权),而内容相同的字节转出来的 data URL 逐字相同。解析不到(图已被清扫)回 `undefined`,
	 * 渲染器画占位;抛错同样当解析不到。不注入 = 所有引用都画占位。
	 */
	resolveImageRef?: (ref: ImageRef) => Promise<string | undefined>;
	/**
	 * 出图回落了(ADR-0014 决策 19「回落必须可见」)。宿主拿它亮面板告警 —— 用户换了皮肤
	 * 却看不出没生效,只会以为是自己没保存。
	 *
	 * **去重归宿主**:同一套皮肤每张卡都会回落一次,渲染器这一层不认识「同一个原因」。
	 */
	onCardSkinFallback?: (info: { skinId: string; kind: CardKind; reason: string }) => void;
}

export class ImageRenderer {
	readonly logger: Logger;
	private readonly puppeteer: PuppeteerLike;
	private config: ImageRendererSettings;
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
	private readonly timezone: () => string;
	private readonly quietConfigUpdates: boolean;
	private readonly resolveCardSkin?: (id: string) => CardSkinManifest | undefined;
	private readonly resolveImageRef?: (ref: ImageRef) => Promise<string | undefined>;
	private readonly resolveCardSkinAsset?: (
		skinId: string,
		name: string,
	) => Promise<string | undefined>;
	private readonly onCardSkinFallback?: (info: {
		skinId: string;
		kind: CardKind;
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

	/**
	 * 渲染页一共有多少个请求被适配层的闸掐断(只增)。正常是 0:卡里的图在出卡前都已
	 * 转成 data URL。不是 0 就是哪条路还在把远端地址交进来。只给测试断言用,没有公开的读口。
	 */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: 只增不读是故意的 —— 读它的是测试(白盒)
	private blockedRequestCount = 0;

	/**
	 * 串行渲染队列,避免 puppeteer 并发问题。带两条车道:链接卡这类低优先级的渲染在
	 * 正常车道排空之前不动 —— 优先级得在这一级就生效,只在浏览器闸那级让路的话,
	 * 低优先级的渲染在这里就已经排到推送卡前面了。
	 */
	private readonly renderGate = createSerialGate();

	constructor(opts: ImageRendererOptions) {
		this.puppeteer = opts.puppeteer;
		this.config = opts.config;
		this.resolveAsset = opts.resolveAsset;
		this.resolveFontFace = opts.resolveFontFace;
		this.timezone = opts.timezone;
		this.quietConfigUpdates = opts.quietConfigUpdates ?? false;
		this.resolveCardSkin = opts.resolveCardSkin;
		this.resolveCardSkinAsset = opts.resolveCardSkinAsset;
		this.resolveImageRef = opts.resolveImageRef;
		this.onCardSkinFallback = opts.onCardSkinFallback;
		this.logger = opts.serviceCtx.logger;
	}

	/**
	 * 热更运行时配置(卡片配色 / 字体 / 显示选项)。adapter 在 dashboard 编辑后调用,
	 * 后续渲染的卡片立刻用新配色,无需重启 server。
	 */
	updateConfig(config: ImageRendererSettings): void {
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

	// ── 公共工具方法 ─────────────────────────────────────────────────────────────

	unixTimestampToString(timestamp: number): string {
		return formatCardTime(timestamp, this.timezone());
	}

	/**
	 * 解析一个图片资产字段为可渲染 URL:空 → "";否则当资产 id,经注入的 resolveAsset 读盘解析成
	 * data URL(解析不出来即 "")。只认资产 id —— 现成的地址不透传,渲染页只画内嵌内容。
	 *
	 * 今天只剩**直播封面**(`liveCoverImage`)走它 —— 卡片背景图那条链 2026-09-20 整个删掉
	 * (背景图归皮肤的 `image` 旋钮,走 `resolveKnobAssets`)。
	 */
	private async resolveBg(v?: string): Promise<string> {
		if (!v) return "";
		return await this.resolveAsset(v);
	}

	/**
	 * 这张卡用哪款字体 —— 每个 generate* 都经它,一律读渲染器全局 config。
	 *
	 * 自带的字体文件优先:宿主把它解析成一条现成的 `@font-face`,家族名换成内部那个。
	 * 解析不出来(资产被删了、卷丢了)就静静回落家族名 —— 出图不该因为
	 * 少一个文件而崩,也不该塞一条空 src 的规则进 CSS。
	 */
	private async resolveFont(): Promise<{ font: string; fontFace?: string }> {
		const font = this.config.font ?? "";
		const assetId = this.config.fontAsset;
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
	private async renderWithSkin<K extends CardKind>(args: {
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
	 * **直播卡的入口**(ADR-0019 决策 68):吃一份 {@link LiveCardInput},不收任何平台的原始数据 ——
	 * B 站那头由 `apps/server/src/bilibili/live` 的 `liveCardInputFromRoomInfo` 翻、拓展订阅那头由服务端的
	 * `liveCardInputFromReport` 翻,都来这一个口。状态明写(开播 / 直播中 / 下播 / 没在播),卡上那句时间由开播时刻算。
	 *
	 * 主人给这条订阅设的自定义直播封面(`colorOptions.liveCoverImage`,独立端专属)在这里
	 * 解析、盖在输入的封面上 —— 它是 BN 的卡片样式,不分平台。
	 *
	 * **图库引用在这里事先解析**(同 {@link generatePostCard}):输入里的封面与主播头像若是引用,交给宿主注入的
	 * {@link ImageRendererOptions.resolveImageRef},拿到可画的地址再同步排视图。解析不到的引用,头像块收起、
	 * 封面画「暂无封面」占位,不抛。出图器自己不读盘、不联网。
	 *
	 * 卡里的图最终只认 data URL:渲染页不联网,远端网址进了卡也会被浏览器适配层的闸掐断、画不出来。
	 */
	async generateLiveCard(
		input: LiveCardInput,
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		const username = input.creator.name;
		this.logger.debug(`[live] 开始渲染直播卡片：${username}`);
		// 自定义封面解析成 data URL;解析为 "" 时用输入里那张,特性自动无感。
		const coverOverride = await this.resolveBg(colorOptions.liveCoverImage);
		// 自定义封面盖住输入的封面时,输入里那张引用不必白读一遍。
		const refs = new Set<ImageRef>();
		if (input.creator.avatar !== undefined) refs.add(input.creator.avatar);
		if (!coverOverride && input.cover?.ref !== undefined) refs.add(input.cover.ref);
		const resolved = await this.resolveImageRefs(refs);

		return this.renderWithSkin({
			kind: "live",
			title: packageText("image.image-renderer.1"),
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(),
			props: buildLiveCardView(input, {
				coverOverride: coverOverride || undefined,
				imageUrl: (ref) => resolved.get(ref),
				timezone: this.timezone(),
			}),
		})
			.then((buf) => {
				this.logger.debug(`[live] 直播卡片渲染完成：${username}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.2", { value0: e }));
			});
	}

	/**
	 * **会员卡的入口**(ADR-0021 决策 26):吃一份 {@link MembershipCardInput},不收任何平台的原始数据 —— 各平台的会员体系
	 * (B 站的大航海是其中一套)都由来源先翻成中立的会员事件、再由宿主连同档位表里那一档组成这份输入。出图器不认识任何平台的
	 * 档位怎么叫、怎么排:档色、徽章、宣告语都是输入里带的。
	 *
	 * **图库引用在这里事先解析**(同 {@link generateLiveCard}):观众与主播的头像、档位的徽章若是引用,交给宿主注入的
	 * {@link ImageRendererOptions.resolveImageRef},拿到可画的地址再同步排视图。解析不到的引用,头像块 / 徽章块收起,不抛。
	 * 出图器自己不读盘、不联网。per-call 样式覆盖只取字体与皮肤(档色由档位定,渐变色不适用)。
	 */
	async generateMembershipCard(
		input: MembershipCardInput,
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		const { viewer, creator, tier } = input;
		this.logger.debug(
			`[membership] 开始渲染会员卡片：${viewer.name} → ${creator.name}（${tier.name}）`,
		);
		const refs = new Set<ImageRef>();
		if (viewer.avatar !== undefined) refs.add(viewer.avatar);
		if (creator.avatar !== undefined) refs.add(creator.avatar);
		if (tier.icon?.ref !== undefined) refs.add(tier.icon.ref);
		const resolved = await this.resolveImageRefs(refs);

		return this.renderWithSkin({
			kind: "membership",
			title: packageText("image.image-renderer.3"),
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(),
			props: buildMembershipCardView(input, { imageUrl: (ref) => resolved.get(ref) }),
		})
			.then((buf) => {
				this.logger.debug(`[membership] 会员卡片渲染完成：${viewer.name}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.4", { value0: e }));
			});
	}

	/**
	 * **醒目留言卡的入口**(ADR-0021 决策 26):吃一份 {@link SuperchatCardInput}。「按价格算档」不在这里了 —— 来源按平台规矩
	 * 算好档({@link SuperchatCardInput.tier},B 站那头在 `superchatEventFromLiveEvent`),出图器只按 `rank` 取默认配色表里的颜色。
	 * 金额经 `formatAmount`、留言时长经 `formatDuration` 排成字(没给时长就不画时长块)。
	 *
	 * **图库引用在这里事先解析**,规矩同 {@link generateMembershipCard}。per-call 样式覆盖只取字体与皮肤(档色由档位定,
	 * 渐变色不适用)。
	 */
	async generateSuperchatCard(
		input: SuperchatCardInput,
		colorOptions: CardColorOptions = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		const { viewer, creator } = input;
		this.logger.debug(
			`[superchat] 开始渲染醒目留言卡片：${viewer.name} → ${creator.name}（${formatAmount(input.amount, input.currency)}）`,
		);
		const refs = new Set<ImageRef>();
		if (viewer.avatar !== undefined) refs.add(viewer.avatar);
		if (creator.avatar !== undefined) refs.add(creator.avatar);
		const resolved = await this.resolveImageRefs(refs);

		return this.renderWithSkin({
			kind: "superchat",
			title: packageText("image.image-renderer.5"),
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(),
			props: buildSuperchatCardView(input, { imageUrl: (ref) => resolved.get(ref) }),
		})
			.then((buf) => {
				this.logger.debug(
					`[superchat] 醒目留言卡片渲染完成：${viewer.name}（${Date.now() - t0}ms）`,
				);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.6", { value0: e }));
			});
	}

	/**
	 * **作品卡的入口**:吃一份平台中立的 {@link Post},不收任何平台的原始数据。`Post` → 卡片节点
	 * ({@link nodeFromPost})→ 皮肤出卡。发布时间由本渲染器按全局时区排({@link unixTimestampToString},
	 * 时区在出卡那一刻现取)。
	 *
	 * B 站动态由 `apps/server/src/bilibili/dynamic` 的 `postFromDynamic` 先翻成 `Post` 再来;来源上下文交来的作品
	 * 已经是 `Post`(图已存进图库,`PostImage` 只放 `ref`);链接预览手里有现成的数据,直接造 `Post`。
	 *
	 * **图库引用在这里事先解析**:作品里用到的每个引用(配图、封面、头像、正文里的小图标与表情图、附加块文字行的
	 * 图标)交给宿主注入的 {@link ImageRendererOptions.resolveImageRef},拿到可画的地址再同步造节点。出图器自己不读盘、
	 * 不联网。解析不到(图已被清扫、宿主没注入)的引用画占位,不抛。
	 *
	 * 卡里的图最终只认 data URL:渲染页不联网,远端网址进了卡也会被浏览器适配层的闸掐断、画不出来。
	 */
	async generatePostCard(
		post: Post,
		colorOptions: CardColorOptions = {},
		/** 渲染优先级;链接解析出的卡传 `low`,推送卡不传。 */
		options?: { priority?: RenderPriority },
	): Promise<Buffer> {
		const t0 = Date.now();
		const resolved = await this.resolveImageRefs(collectImageRefs(post));
		const node = nodeFromPost(post, {
			time: (seconds) => this.unixTimestampToString(seconds),
			imageUrl: (ref) => resolved.get(ref),
		});
		this.logger.debug(`[post] 开始渲染作品卡片：${node.creatorName}`);
		return this.renderWithSkin({
			kind: "post",
			title: packageText("image.image-renderer.7"),
			skinId: this.skinIdOf(colorOptions),
			skinKnobs: colorOptions.cardSkinKnobs,
			font: await this.resolveFont(),
			priority: options?.priority,
			props: { node },
		})
			.then((buf) => {
				this.logger.debug(`[post] 作品卡片渲染完成：${node.creatorName}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.8", { value0: e }));
			});
	}

	/** 引用 → 可画的地址。解析口抛错或解析不到的引用不进表(画占位),一个坏引用不拖累整张卡。 */
	private async resolveImageRefs(refs: ReadonlySet<ImageRef>): Promise<Map<ImageRef, string>> {
		const resolved = new Map<ImageRef, string>();
		const resolve = this.resolveImageRef;
		if (!resolve || refs.size === 0) return resolved;
		await Promise.all(
			[...refs].map(async (ref) => {
				try {
					const url = await resolve(ref);
					if (url) resolved.set(ref, url);
				} catch (e) {
					this.logger.debug(`[image] 图库引用 ${ref} 解析失败,画占位:${String(e)}`);
				}
			}),
		);
		return resolved;
	}

	async generateWordCloudImg(
		words: Array<[string, number]>,
		creatorName: string,
		/**
		 * 主播头像的图库引用(选填;没有、或引用解析不到就不画头像块)。和别的卡一样,出图器在这里经宿主注入的
		 * {@link ImageRendererOptions.resolveImageRef} 事先认成可画的地址。
		 */
		creatorAvatar?: ImageRef,
		/**
		 * 用哪套皮肤、这位 UP 怎么拧它;词云卡整张是一个内置块,皮肤只管外框(ADR-0014 决策 3)。
		 */
		opts: CardSkinChoice = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[wordcloud] 开始渲染词云卡片：${creatorName}（${words.length} 词）`);
		// 画布(`#wordCloudCanvas`)在内置块里,皮肤路径出的 HTML 照样有它 —— 画词的脚本
		// 原样注进 `</body>` 之前(`wordCloudInitScript`,读盘拼脚本那一半单独住在那儿)。
		const script = wordCloudInitScript(words, ASSET_DIR);
		const resolved = await this.resolveImageRefs(
			creatorAvatar === undefined ? new Set<ImageRef>() : new Set([creatorAvatar]),
		);
		const creatorAvatarUrl = creatorAvatar === undefined ? undefined : resolved.get(creatorAvatar);
		return this.renderWithSkin({
			kind: "wordcloud",
			title: packageText("image.image-renderer.9"),
			skinId: this.skinIdOf(opts),
			skinKnobs: opts.cardSkinKnobs,
			font: await this.resolveFont(),
			waitFor: "window.wordcloudDone === true",
			postProcess: (html) => injectWordCloudScript(html, script),
			props: { creatorName, creatorAvatarUrl },
		})
			.then((buf) => {
				this.logger.debug(`[wordcloud] 词云卡片渲染完成：${creatorName}（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.10", { value0: e }));
			});
	}

	async generateRoastBoardCard(
		data: RoastBoardCardInput,
		/** 用哪套皮肤;榜单整张是一个内置块,皮肤只管外框(ADR-0014 决策 3)。 */
		opts: { cardSkin?: string } = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[roast] 开始渲染周报卡片：近 ${data.days} 天`);
		return this.renderWithSkin({
			kind: "roastBoard",
			title: packageText("image.image-renderer.11"),
			skinId: this.skinIdOf(opts),
			font: await this.resolveFont(),
			props: { ...data },
		})
			.then((buf) => {
				this.logger.debug(`[roast] 周报卡片渲染完成（${Date.now() - t0}ms）`);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.12", { value0: e }));
			});
	}

	async generateRoastSoloCard(
		data: RoastSoloCardInput,
		/** 用哪套皮肤;单人锐评整张是一个内置块,皮肤只管外框(ADR-0014 决策 3)。 */
		opts: { cardSkin?: string } = {},
	): Promise<Buffer> {
		const t0 = Date.now();
		this.logger.debug(`[roast] 开始渲染单人锐评卡片：${data.creator.name}`);
		return this.renderWithSkin({
			kind: "roastSolo",
			title: packageText("image.image-renderer.13"),
			skinId: this.skinIdOf(opts),
			font: await this.resolveFont(),
			props: { ...data },
		})
			.then((buf) => {
				this.logger.debug(
					`[roast] 单人锐评卡片渲染完成：${data.creator.name}（${Date.now() - t0}ms）`,
				);
				return buf;
			})
			.catch((e) => {
				throw new Error(packageText("image.image-renderer.14", { value0: e }));
			});
	}

	// ── 渲染管线（内部） ──────────────────────────────────────────────────────────

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
		// 这一张卡被闸拦下的请求,出完卡汇总记一条。
		const blocked: string[] = [];
		const page = await this.puppeteer.page({
			priority,
			onBlockedRequest: (url) => {
				this.blockedRequestCount += 1;
				blocked.push(url);
			},
		});
		try {
			await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
			if (waitForCondition) {
				await page.waitForFunction(waitForCondition, { timeout: 30_000 });
			}
			const elementHandle = await page.$("html");
			if (!elementHandle) throw new Error(packageText("image.image-renderer.15"));
			const boundingBox = await elementHandle.boundingBox();
			if (!boundingBox) throw new Error(packageText("image.image-renderer.16"));
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
				timeoutId = setTimeout(
					() => reject(new Error(packageText("image.image-renderer.17"))),
					20_000,
				);
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
			if (blocked.length > 0) {
				const targets = [...new Set(blocked.map(blockedTargetOf))].join("、");
				this.logger.warn(`[image] 渲染页拦下 ${blocked.length} 个请求(这些图画不出来)· ${targets}`);
			}
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
