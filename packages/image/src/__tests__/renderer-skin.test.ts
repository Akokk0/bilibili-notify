/**
 * **`ImageRenderer` 一律按皮肤出图**(ADR-0014 决策 15 / 18 / 19)。
 *
 * 这份守的是「渲染器与皮肤之间那条线」,不是皮肤渲染器本身(那归
 * `skin/__tests__/render-skin.test.ts`),也不是「皮肤画的块与模板逐字节相同」(那归
 * `skin/__tests__/skin-gate.test.ts` 的验收门 A)。这里问的是四件别处问不到的事:
 *
 * 1. `generate*` 真的走皮肤那条路了吗(网格 wrapper + 挂点在,块序列与旧模板一致);
 * 2. 皮肤取不到 / 画不出来 / 画得太高时,回落**发生了**而且**报出来了**;
 * 3. 皮肤里的自定义块与包内资产真的进了图;
 * 4. 用的本来就是默认皮肤时**不报**回落(没换过皮肤的人不该收到「皮肤回落」的告警)。
 *
 * 每条的验红方式都写在用例里 —— 「守卫只钉形状不钉性质」那一族的防身符。
 */

import type { CardSkinKind, CardSkinManifest, ServiceContext } from "@bilibili-notify/internal";
import {
	CARD_SKIN_LIMITS,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
} from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import {
	ImageRenderer,
	type ImageRendererConfig,
	type ImageRendererOptions,
} from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";
import { renderCard } from "../render";
import { LiveCard } from "../templates/live-card";

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
};

const BASE_CONFIG: ImageRendererConfig = {
	cardColorStart: "#e0c3fc",
	cardColorEnd: "#8ec5fc",
	font: "PingFang SC, sans-serif",
	showPopularity: true,
	showArea: true,
	showFans: true,
};

/** B 站直播接口那一小撮渲染真会读的字段。 */
const LIVE_ROOM = {
	title: "标题",
	area_name: "分区",
	user_cover: "http://i0.hdslb.com/bfs/album/cover.png",
	keyframe: "http://i0.hdslb.com/bfs/album/keyframe.png",
	description: "简介",
	online: 1234,
	live_time: "2026-09-13 20:00:00",
};

const LIVE_DATA = { likedNum: 0, watchedNum: "1", fansNum: 1, fansChanged: "" } as never;

/**
 * 截图那一步的替身:把灌进去的 HTML 留下来,并让每张卡的**高度**可控
 * (最大高度那道闸只认 boundingBox 的 height,别处造不出来)。
 */
function makePuppeteer(height = 400) {
	const captured: string[] = [];
	const page = {
		setContent: async (html: string) => {
			captured.push(html);
		},
		waitForFunction: async () => undefined,
		$: async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height }),
			dispose: async () => {},
		}),
		screenshot: async () => Buffer.from("fake-jpeg"),
		close: async () => {},
	};
	return { captured, puppeteer: { page: async () => page } as unknown as PuppeteerLike };
}

interface Harness {
	renderer: ImageRenderer;
	captured: string[];
	fallbacks: Array<{ skinId: string; kind: CardSkinKind; reason: string }>;
}

function makeHarness(extra: Partial<ImageRendererOptions> = {}, height = 400): Harness {
	const { captured, puppeteer } = makePuppeteer(height);
	const fallbacks: Harness["fallbacks"] = [];
	const renderer = new ImageRenderer({
		serviceCtx: SERVICE_CTX,
		puppeteer,
		config: BASE_CONFIG,
		resolveAsset: async () => "",
		resolveFontFace: async () => "",
		onCardSkinFallback: (info) => fallbacks.push(info),
		...extra,
	});
	return { renderer, captured, fallbacks };
}

function liveCard(renderer: ImageRenderer, cardSkin?: string): Promise<Buffer> {
	return renderer.generateLiveCard(
		LIVE_ROOM,
		"示例UP",
		"http://i0.hdslb.com/bfs/face/f.jpg",
		LIVE_DATA,
		1,
		{
			...(cardSkin !== undefined ? { cardSkin } : {}),
		},
	);
}

/** 一份 HTML 里 `[data-block]` 按文档序的块名。 */
function blockLabels(html: string): string[] {
	const doc = new JSDOM(html).window.document;
	return [...doc.querySelectorAll("[data-block]")].map((el) => el.getAttribute("data-block") ?? "");
}

// ── ① 走的是皮肤那条路 ────────────────────────────────────────────────────────

describe("ImageRenderer 一律按皮肤出图", () => {
	it("默认皮肤:出的 HTML 带网格 wrapper 与根块挂点,块序列与旧模板路径一致", async () => {
		const h = makeHarness();
		await liveCard(h.renderer);
		const html = h.captured[0] ?? "";

		// 网格 wrapper 是皮肤路径**独有**的标记:模板路径的块 wrapper 没有 class。
		// 验红:把 generateLiveCard 改回 renderCard(LiveCard, …),这两条立刻红。
		expect(html).toContain("bn-blk-cover");
		expect(html).toContain('data-bn="glass"');
		expect(html).toContain("display:grid");

		// 块序列必须与旧模板一字不差 —— 「升级后卡片不能变样」的那一半
		// (另一半是块内层逐字节,归 skin-gate 的验收门 A)。
		const viaTemplate = await renderCard(
			LiveCard,
			{
				showPopularity: true,
				showArea: true,
				showFans: true,
				cardColorStart: BASE_CONFIG.cardColorStart,
				cardColorEnd: BASE_CONFIG.cardColorEnd,
				data: LIVE_ROOM,
				username: "示例UP",
				userface: "http://i0.hdslb.com/bfs/face/f.jpg",
				titleStatus: "开播啦",
				liveTime: "开播时间：2026-09-13 20:00:00",
				liveStatus: 1,
				cover: true,
				onlineNum: "1234",
				likedNum: "0",
				watchedNum: "1",
				fansNum: "1",
				fansChanged: "",
			},
			{ title: "直播通知", font: BASE_CONFIG.font, htmlWidth: 600 },
		);
		expect(blockLabels(html)).toEqual(blockLabels(viaTemplate));
	});

	it("上舰卡:皮肤的根块 CSS 被翻成挂点选择器拼进样式表", async () => {
		const h = makeHarness();
		await h.renderer.generateGuardCard(
			{ guardLevel: 3, uname: "新舰长", face: "http://i0.hdslb.com/bfs/face/g.jpg", isAdmin: 0 },
			{ masterAvatarUrl: "http://i0.hdslb.com/bfs/face/m.jpg", masterName: "示例UP" },
		);
		// 出厂默认皮肤的 guard 卡带一句 `[data-bn="glass"]{height:190px;…}`;渲染器把它
		// 翻成 `~=` 形式(单图图廊那种双挂点容器要靠它才选得中)。
		// 验红:把 renderCardWithSkin 的 extraCss 那一路掐掉,这条红。
		expect(h.captured[0]).toContain('[data-bn~="glass"]{height:190px');
	});

	it("宽度取皮肤定的 card.width,不是写死的 600", async () => {
		const wide: CardSkinManifest = {
			...DEFAULT_CARD_SKIN,
			// biome-ignore lint/style/noNonNullAssertion: 出厂默认皮肤七种卡齐全
			cards: { ...DEFAULT_CARD_SKIN.cards, live: { ...DEFAULT_CARD_SKIN.cards.live!, width: 880 } },
		};
		const h = makeHarness({ resolveCardSkin: (id) => (id === "wide" ? wide : undefined) });
		await liveCard(h.renderer, "wide");
		// 验红:把 renderCardWithSkin 里的 `htmlWidth: card.width` 换回 600,这条红。
		expect(h.captured[0]).toContain("width: 880px");
	});
});

// ── ② 回落 ───────────────────────────────────────────────────────────────────

describe("ImageRenderer 皮肤回落", () => {
	it("resolveCardSkin 回 undefined → 用默认皮肤画出来,并且只报一次", async () => {
		const h = makeHarness({ resolveCardSkin: () => undefined });
		const buf = await liveCard(h.renderer, "ghost-skin");

		expect(buf).toBeInstanceOf(Buffer);
		// 图照出(推送不能因为换皮肤而丢),而且出的是默认皮肤那一副。
		expect(h.captured).toHaveLength(1);
		expect(h.captured[0]).toContain("bn-blk-cover");
		// 验红:把 fallback() 里那句 onCardSkinFallback?.(…) 删掉,这条红。
		expect(h.fallbacks).toEqual([{ skinId: "ghost-skin", kind: "live", reason: "皮肤不存在" }]);
	});

	it("皮肤里没有这种卡 → 回落,原因说得出是哪一种缺", async () => {
		const noLive: CardSkinManifest = {
			...DEFAULT_CARD_SKIN,
			cards: { dynamic: DEFAULT_CARD_SKIN.cards.dynamic },
		};
		const h = makeHarness({ resolveCardSkin: () => noLive });
		await liveCard(h.renderer, "only-dynamic");
		expect(h.fallbacks).toEqual([
			{ skinId: "only-dynamic", kind: "live", reason: "皮肤没有这种卡" },
		]);
	});

	it("卡片比上限还高 → 回落默认皮肤重画一次,原因带上那个高度", async () => {
		const tall = CARD_SKIN_LIMITS.maxHeight + 200;
		const h = makeHarness(
			{ resolveCardSkin: (id) => (id === "tall" ? DEFAULT_CARD_SKIN : undefined) },
			tall,
		);
		await liveCard(h.renderer, "tall");

		// 画了两遍:一遍是那套皮肤,一遍是回落后的默认皮肤。
		// 验红:把高度闸那句 `height <= max` 改成恒真,这两条都红。
		expect(h.captured).toHaveLength(2);
		expect(h.fallbacks).toEqual([
			{
				skinId: "tall",
				kind: "live",
				reason: `卡片高度 ${tall} 超过上限 ${CARD_SKIN_LIMITS.maxHeight}`,
			},
		]);
	});

	it("默认皮肤自己就超高 → 照发,不报回落(那是内容长,不是皮肤的错)", async () => {
		const h = makeHarness({}, CARD_SKIN_LIMITS.maxHeight + 1000);
		await liveCard(h.renderer);
		expect(h.captured).toHaveLength(1);
		expect(h.fallbacks).toEqual([]);
	});

	it("id 本来就是默认皮肤 → 一次都不报", async () => {
		const h = makeHarness({ resolveCardSkin: () => undefined });
		await liveCard(h.renderer, DEFAULT_CARD_SKIN_ID);
		// resolveCardSkin 对 `default` 也回 undefined,但代码里的常量兜住了它 ——
		// 验红:把 `?? (isDefault ? DEFAULT_CARD_SKIN : undefined)` 那半删掉,这条红。
		expect(h.fallbacks).toEqual([]);
		expect(h.captured).toHaveLength(1);
	});

	it("缺省(压根没传 cardSkin)同样算默认皮肤,不报", async () => {
		const h = makeHarness({ resolveCardSkin: () => undefined });
		await liveCard(h.renderer);
		expect(h.fallbacks).toEqual([]);
	});
});

// ── ③ 自定义块与包内资产 ─────────────────────────────────────────────────────

describe("ImageRenderer 皮肤里的自定义块", () => {
	/** 一个自定义块(占位符 + 包内资产图)+ 原来的封面块。 */
	const CUSTOM_SKIN: CardSkinManifest = {
		...DEFAULT_CARD_SKIN,
		name: "自定义",
		cards: {
			...DEFAULT_CARD_SKIN.cards,
			live: {
				width: 600,
				blocks: [
					{
						id: "hello",
						kind: "custom",
						grid: { row: 1, column: 1, span: 12 },
						html: '<p>{up.name}</p><img src="asset:assets/logo.png">',
					},
				],
			},
		},
	};

	it("占位符换成契约字段、`asset:` 换成宿主给的 data URL", async () => {
		const asked: Array<[string, string]> = [];
		const h = makeHarness({
			resolveCardSkin: (id) => (id === "custom" ? CUSTOM_SKIN : undefined),
			resolveCardSkinAsset: async (skinId, name) => {
				asked.push([skinId, name]);
				return "data:image/png;base64,LOGO";
			},
		});
		await liveCard(h.renderer, "custom");
		const html = h.captured[0] ?? "";

		expect(h.fallbacks).toEqual([]);
		// 验红:把 renderCustomHtml 的占位符分支改成原样返回,第一条红。
		expect(html).toContain("<p>示例UP</p>");
		// 预取是**按皮肤分格**的:两套皮肤各带一张 assets/logo.png 是正常的事。
		expect(asked).toEqual([["custom", "assets/logo.png"]]);
		// 验红:把 prefetchSkinAssets 回空 Map,这条红(图变成 1x1 透明占位)。
		expect(html).toContain("data:image/png;base64,LOGO");
	});

	it("资产取不到 → 用透明占位,整张卡照出、不回落", async () => {
		const h = makeHarness({
			resolveCardSkin: (id) => (id === "custom" ? CUSTOM_SKIN : undefined),
			resolveCardSkinAsset: async () => undefined,
		});
		await liveCard(h.renderer, "custom");
		expect(h.fallbacks).toEqual([]);
		expect(h.captured[0]).toContain(
			"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
		);
	});
});

// ── ④ 词云:皮肤路径仍然把词画上去 ──────────────────────────────────────────

describe("ImageRenderer 词云卡", () => {
	it("皮肤路径出的 HTML 里仍有画布,画词脚本照旧注在 </body> 之前", async () => {
		const h = makeHarness();
		const words: Array<[string, number]> = Array.from({ length: 3 }, (_, i) => [`词${i}`, 10 - i]);
		await h.renderer.generateWordCloudImg(words, "示例UP");
		const html = h.captured[0] ?? "";

		// 画布归内置块,脚本归 `wordCloudInitScript` —— 两半都在,词云才画得出来。
		// 验红:把 postProcess 那一路掐掉,后两条红(画布还在,但永远没人往上画)。
		expect(html).toContain('id="wordCloudCanvas"');
		expect(html).toContain("renderAutoFitWordCloud");
		expect(html.indexOf("renderAutoFitWordCloud")).toBeLessThan(html.indexOf("</body>"));
		expect(h.fallbacks).toEqual([]);
	});
});
