/**
 * **`ImageRenderer` 一律按皮肤出图**(ADR-0014 决策 15 / 18 / 19)。
 *
 * 这份守的是「渲染器与皮肤之间那条线」,不是皮肤渲染器本身(那归
 * `skin/__tests__/render-skin.test.ts`),也不是「皮肤画的块与模板逐字节相同」(那归
 * `skin/__tests__/skin-gate.test.ts` 的验收门 A)。这里问的是四件别处问不到的事:
 *
 * 1. `generate*` 真的走皮肤那条路了吗(网格 wrapper + 挂点在,画的是出厂默认皮肤那一份);
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
import { CSS_CUSTOM_PROPERTY_MAX_CHARS } from "../skin/knob-assets";

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
};

const BASE_CONFIG: ImageRendererConfig = {
	font: "PingFang SC, sans-serif",
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

/**
 * 根块(外框)那条 inline style 的**解码后**值。
 *
 * 直接在生 HTML 上 `toContain` 会栽:变量值里的引号在属性里是 `&quot;`
 * (`url("data:…")`、`"bn-user-font"` 都带引号),读 DOM 拿到的才是浏览器真看见的那串。
 */
function frameStyle(html: string): string {
	const doc = new JSDOM(html).window.document;
	return doc.querySelector('[data-bn~="frame"]')?.getAttribute("style") ?? "";
}

/** 一份 HTML 里 `[data-block]` 按文档序的块名。 */
function blockLabels(html: string): string[] {
	const doc = new JSDOM(html).window.document;
	return [...doc.querySelectorAll("[data-block]")].map((el) => el.getAttribute("data-block") ?? "");
}

// ── ① 走的是皮肤那条路 ────────────────────────────────────────────────────────

describe("ImageRenderer 一律按皮肤出图", () => {
	it("默认皮肤:出的 HTML 带网格 wrapper 与根块挂点,块序列就是出厂默认皮肤那一份", async () => {
		const h = makeHarness();
		await liveCard(h.renderer);
		const html = h.captured[0] ?? "";

		// 网格 wrapper 是皮肤路径**独有**的标记:模板路径的块 wrapper 没有 class。
		// 验红:把 generateLiveCard 改回 renderCard(LiveCard, …),这两条立刻红。
		expect(html).toContain("bn-blk-cover");
		expect(html).toContain('data-bn="glass"');
		expect(html).toContain("display:grid");

		// 画的是**出厂默认皮肤**这一份(2026-09-18 起用原子块拼),不是冻住的旧默认 ——
		// 与旧模板逐块相同那件事只对旧默认成立,归 skin-gate 的验收门 A。
		// 验红:把渲染器的默认回落换成任何一套别的皮肤(块序不同即可),这条红。
		const expected = (DEFAULT_CARD_SKIN.cards.live?.blocks ?? []).map((b) =>
			b.kind === "builtin" ? b.builtin : "custom",
		);
		expect(expected).toContain("avatar");
		expect(blockLabels(html)).toEqual(expected);
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
		expect(h.captured[0]).toMatch(/\[data-bn~="glass"\]\{[^}]*height:190px/);
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

/**
 * **旋钮那条线**(ADR-0014 决策 16 的 🔗,2026-09-14)。皮肤的声明住 manifest 里、用户的
 * 值住渲染器 config 里,两头在 `renderWithSkin` 那一处碰面 —— 零件各自的单元测试全绿
 * 也证明不了它们真接上了(「接线要有自己的守卫」)。验红:把 `renderCardWithSkin` 里
 * 那句 `knobs: manifest.knobs` 或 `knobValues: this.config.cardSkinKnobs?.[id]` 任意
 * 一句掐掉,这一组红。
 */
describe("ImageRenderer 皮肤旋钮", () => {
	const KNOB_SKIN: CardSkinManifest = {
		...DEFAULT_CARD_SKIN,
		name: "带旋钮的皮肤",
		knobs: [{ key: "accent", label: "主色", type: "color", default: "#fb7299" }],
	};
	const withSkin = (knobs?: ImageRendererConfig["cardSkinKnobs"]): Harness =>
		makeHarness({
			config: { ...BASE_CONFIG, ...(knobs ? { cardSkinKnobs: knobs } : {}) },
			resolveCardSkin: (id) => (id === "knobby" ? KNOB_SKIN : undefined),
		});

	it("用户拧过的值从 config 一路到出图的 HTML", async () => {
		const h = withSkin({ knobby: { accent: "#00f0ff" } });
		await liveCard(h.renderer, "knobby");
		expect(h.captured[0] ?? "").toContain("--bn-knob-accent:#00f0ff");
		expect(h.fallbacks).toEqual([]);
	});

	/**
	 * 字体 / 图两档(2026-09-14 主人拍板)。它们与别的旋钮不同:值是主人资产库里的一个
	 * id,**得读盘**才能用 —— 解析器住 `skin/knob-assets.ts`(自己有单元测试),这里钉的
	 * 是渲染器有没有真把它接上。验红:把 `renderWithSkin` 里那句
	 * `knobAssets: await this.resolveKnobAssets(...)` 掐掉,这两条红。
	 */
	describe("字体 / 图两档要读盘", () => {
		const ASSET_SKIN: CardSkinManifest = {
			...DEFAULT_CARD_SKIN,
			name: "带字体与壁纸的皮肤",
			knobs: [
				{ key: "font", label: "字体", type: "font", default: "" },
				{ key: "wallpaper", label: "壁纸", type: "image" },
			],
		};
		const withAssets = (knobs: ImageRendererConfig["cardSkinKnobs"]): Harness =>
			makeHarness({
				config: { ...BASE_CONFIG, cardSkinKnobs: knobs },
				resolveCardSkin: (id) => (id === "assetty" ? ASSET_SKIN : undefined),
				resolveAsset: async (id) => `data:image/png;base64,${id}`,
				resolveFontFace: async (id) => `@font-face{font-family:"bn-user-font";src:url("${id}")}`,
			});

		it("主人传的字体文件 → `@font-face` 与变量都进了 HTML", async () => {
			const h = withAssets({ assetty: { font: "upload:f1" } });
			await liveCard(h.renderer, "assetty");
			const html = h.captured[0] ?? "";
			expect(html).toContain("@font-face");
			expect(frameStyle(html)).toContain('--bn-knob-font:"bn-user-font"');
			expect(h.fallbacks).toEqual([]);
		});

		it("壁纸 → 解析成 data URL 注进变量(自带 center / cover)", async () => {
			const h = withAssets({ assetty: { wallpaper: ["bg1"] } });
			await liveCard(h.renderer, "assetty");
			expect(frameStyle(h.captured[0] ?? "")).toContain(
				'--bn-knob-wallpaper:url("data:image/png;base64,bg1") center / cover',
			);
		});
	});

	it("没拧过 → HTML 里没有旋钮变量(皮肤 CSS 的兜底管事)", async () => {
		const h = withSkin();
		await liveCard(h.renderer, "knobby");
		expect(h.captured[0] ?? "").not.toContain("--bn-knob-accent");
	});

	/** 覆盖按皮肤 id 分开存,所以另一套皮肤的配色不该画到这套上。 */
	it("取的是这套皮肤自己那份覆盖,别的皮肤那份不串门", async () => {
		const h = withSkin({ other: { accent: "#00f0ff" } });
		await liveCard(h.renderer, "knobby");
		expect(h.captured[0] ?? "").not.toContain("--bn-knob-accent");
	});

	/**
	 * 回落到默认皮肤时取的是**默认皮肤**那份覆盖 —— 一套坏皮肤的配色跟着回落画到默认
	 * 皮肤上,用户看到的是一张既不是 A 也不是 B 的卡。
	 */
	it("回落到默认皮肤时,用的是默认皮肤自己那份覆盖", async () => {
		const h = makeHarness({
			config: {
				...BASE_CONFIG,
				cardSkinKnobs: {
					knobby: { accent: "#00f0ff" },
					[DEFAULT_CARD_SKIN_ID]: { "gradient-start": "#123456" },
				},
			},
			resolveCardSkin: () => undefined,
		});
		await liveCard(h.renderer, "knobby");
		const html = h.captured[0] ?? "";
		expect(html).toContain("--bn-knob-gradient-start:#123456");
		expect(html).not.toContain("--bn-knob-accent");
		expect(h.fallbacks.map((f) => f.reason)).toEqual(["皮肤不存在"]);
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

	it("出血不占高度额度 —— 闸拦的是内容太长,不是皮肤自己选的那圈余量", async () => {
		const BLEED = 28;
		const skin = {
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				live: { ...DEFAULT_CARD_SKIN.cards.live, bleed: { size: BLEED, color: "#07091a" } },
			},
		} as typeof DEFAULT_CARD_SKIN;
		// 图高 = 卡高 + 上下两道出血。卡刚好卡在上限上,不该被拦。
		const h = makeHarness(
			{ resolveCardSkin: (id) => (id === "glow" ? skin : undefined) },
			CARD_SKIN_LIMITS.maxHeight + BLEED * 2,
		);
		await liveCard(h.renderer, "glow");

		// 验红:把减出血那一步去掉,这两条立刻红(图高比上限大 56)。
		expect(h.fallbacks).toEqual([]);
		expect(h.captured).toHaveLength(1);
	});

	it("超高的判定与报出来的数都按**卡**算,出血不算在里面", async () => {
		const BLEED = 28;
		const over = 200;
		const skin = {
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				live: { ...DEFAULT_CARD_SKIN.cards.live, bleed: { size: BLEED, color: "#07091a" } },
			},
		} as typeof DEFAULT_CARD_SKIN;
		const h = makeHarness(
			{ resolveCardSkin: (id) => (id === "glow" ? skin : undefined) },
			CARD_SKIN_LIMITS.maxHeight + over + BLEED * 2,
		);
		await liveCard(h.renderer, "glow");

		expect(h.fallbacks).toEqual([
			{
				skinId: "glow",
				kind: "live",
				reason: `卡片高度 ${CARD_SKIN_LIMITS.maxHeight + over} 超过上限 ${CARD_SKIN_LIMITS.maxHeight}`,
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

/**
 * **推送那条路也得把大图压进 2 MiB 预算。**
 *
 * Blink 对一条自定义属性的值封顶 `2,097,152` 字符,超了**整条声明在解析期就被丢掉**,
 * 于是皮肤 CSS 里的 `var(--bn-knob-wallpaper, 渐变)` 判定「没设」、安安静静画兜底
 * (2026-09-20 真机量的:主人那张 1.7MB 的背景图 base64 之后 2,265,368 字符)。
 *
 * 预览那条有自己的守卫(`routes/__tests__/cards-route.test.ts`),**这一条守的是推送** ——
 * 两根线各接各的,剪一根另一根不会红。判据:把 `ImageRenderer#resolveKnobAssets` 里那句
 * `shrinkImage: … => this.fitKnobImage(…)` 拆掉,这两条必须红。
 */
describe("旋钮里的大图:推送出图这条路", () => {
	/** base64 之后必定越过 2 MiB 的一张「图」。 */
	const OVERSIZED = `data:image/png;base64,${"A".repeat(CSS_CUSTOM_PROPERTY_MAX_CHARS)}`;

	function bigWallpaperHarness(resolveAsset: () => Promise<string>): Harness {
		return makeHarness({
			resolveAsset,
			config: {
				...BASE_CONFIG,
				cardSkinKnobs: { [DEFAULT_CARD_SKIN_ID]: { wallpaper: ["big.png"] } },
			},
		});
	}

	/**
	 * ⚠️ 压图**也走同一个假浏览器**,所以 `captured` 里混着压图那几页(一个 `<img>` 的
	 * 空壳)。要的是卡片那几页 —— 按有没有外框挂点挑。
	 */
	const cards = (h: Harness): string[] => h.captured.filter((x) => x.includes('data-bn="frame"'));

	it("压过之后才注,而且整条值落在上限之内", async () => {
		const h = bigWallpaperHarness(async () => OVERSIZED);
		await liveCard(h.renderer);
		const style = frameStyle(cards(h)[0] ?? "");
		expect(style).toContain('--bn-knob-wallpaper:url("data:image/webp;base64,');
		const value = /--bn-knob-wallpaper:([^;]*)/.exec(style)?.[1] ?? "";
		expect(value.length).toBeGreaterThan(0);
		expect(value.length).toBeLessThanOrEqual(CSS_CUSTOM_PROPERTY_MAX_CHARS);
		// 原样那份绝不该出现 —— 出现了就等于交给 Chrome 再丢一次。
		expect(style).not.toContain("data:image/png");
	});

	it("同一张图只压一次 —— 每推一张卡重压一遍太贵(按资产 id 缓存)", async () => {
		let reads = 0;
		const h = bigWallpaperHarness(async () => {
			reads += 1;
			return OVERSIZED;
		});
		await liveCard(h.renderer);
		const first = frameStyle(cards(h)[0] ?? "");
		const pagesAfterFirst = h.captured.length;
		await liveCard(h.renderer);
		const second = frameStyle(cards(h)[1] ?? "");
		expect(second).toBe(first);
		// 读盘每次都会发生(资产可能换了),但压只该发生一次 —— 缓存命中时压的那几个
		// 浏览器页压根不开。验红:把 `knobImageFit` 那层缓存拆掉,这条红。
		expect(reads).toBe(2);
		expect(second).toContain("data:image/webp;base64,");
		// 第二次只该多开**一个**页(画卡片那一个);多出压图的那几页就是缓存没生效。
		expect(h.captured.length - pagesAfterFirst).toBe(1);
	});
});
