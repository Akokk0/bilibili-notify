/**
 * **动态卡的中立入口**(ADR-0019 决策 68):`generateNeutralDynamicCard(node)` 只收一棵造好的
 * node,不收任何平台的原始数据。B 站那条(`generateDynamicCard(raw)`)是它前面的适配层,
 * 画出来一个字节不变由 23 份基准快照(`card-baseline.test.ts`)钉着;这里钉的是中立那一侧:
 *
 * 1. 皮肤契约要的那几格(动态类型、图廊张数 / 首图)从 node 取得到 —— 转发内层取它自己的;
 * 2. 视频那一行没有弹幕数就不画弹幕图标与数字(决策 55:拓展作品不收弹幕数)。
 */

import type { CardSkinManifest, ServiceContext } from "@bilibili-notify/internal";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { ImageRenderer } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";
import type { DynamicNode } from "../templates/dynamic-content";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
};

/** 截图那一步的替身:把灌进去的 HTML 留下来。 */
function makeRenderer(resolveCardSkin?: (id: string) => CardSkinManifest | undefined) {
	const captured: string[] = [];
	const page = {
		setContent: async (html: string) => {
			captured.push(html);
		},
		waitForFunction: async () => undefined,
		$: async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		}),
		screenshot: async () => Buffer.from("fake-jpeg"),
		close: async () => {},
	};
	const renderer = new ImageRenderer({
		serviceCtx: SERVICE_CTX,
		puppeteer: { page: async () => page } as unknown as PuppeteerLike,
		config: { font: "sans-serif" },
		resolveAsset: async () => "",
		resolveFontFace: async () => "",
		resolveCardSkin,
	});
	return { renderer, captured };
}

/** 图一律 data URL —— 拓展交的就是字节转成的 data URL,而且测试不许联网。 */
const img = (name: string) => `data:image/png;base64,${name}`;

function node(over: Partial<DynamicNode> = {}): DynamicNode {
	return {
		avatarUrl: img("FACE"),
		upName: "示例作者",
		upIsVip: false,
		pubTime: "2026-09-24 12:00:00",
		stats: { forward: "1", comment: "2", like: "3" },
		...over,
	};
}

/** 一套探针皮肤:一个自定义块把几个契约字段原样印出来,外加转发框(内层卡画在它里头)。 */
const PROBE: CardSkinManifest = {
	...DEFAULT_CARD_SKIN,
	cards: {
		...DEFAULT_CARD_SKIN.cards,
		dynamic: {
			width: 600,
			blocks: [
				{
					id: "probe",
					kind: "custom",
					html: "<div>探针[{dynamic.type}|{pics.count}|{pics.first}|{video.danmaku}]</div>",
					grid: { row: 1, column: 1, span: 12 },
				},
				{
					id: "forward",
					kind: "builtin",
					builtin: "forward",
					grid: { row: 2, column: 1, span: 12 },
				},
			],
		},
	},
} as never;

async function probe(n: DynamicNode): Promise<string[]> {
	const { renderer, captured } = makeRenderer((id) => (id === "probe" ? PROBE : undefined));
	await renderer.generateNeutralDynamicCard(n, { cardSkin: "probe" });
	return [...(captured[0] ?? "").matchAll(/探针\[([^\]]*)\]/g)].map((m) => m[1]);
}

describe("generateNeutralDynamicCard — 皮肤契约从 node 取", () => {
	/**
	 * 验红:把 `skin/card-data.ts` 里 `dynamic.type` 或 `pics.*` 改成读别处(比如写死空值),
	 * 这条红。
	 */
	it("动态类型、图廊张数与首图都从 node 上那几格取", async () => {
		const out = await probe(
			node({
				type: "DYNAMIC_TYPE_DRAW",
				images: [{ url: img("P1") }, { url: img("P2") }, { url: img("P3") }],
			}),
		);
		expect(out).toEqual([`DYNAMIC_TYPE_DRAW|3|${img("P1")}|`]);
	});

	/**
	 * 转发内层取**它自己**的那几格 —— 不是外层的,也不是空的。
	 * 验红:把 `render-skin.tsx` 的 `renderForward` 改成拿外层的 props 装内层,这条红。
	 */
	it("转发框里那张卡取内层 node 的类型与图", async () => {
		const out = await probe(
			node({
				type: "DYNAMIC_TYPE_FORWARD",
				forward: node({
					upName: "原作者",
					type: "DYNAMIC_TYPE_AV",
					images: [{ url: img("INNER") }],
				}),
			}),
		);
		expect(out).toEqual(["DYNAMIC_TYPE_FORWARD|0||", `DYNAMIC_TYPE_AV|1|${img("INNER")}|`]);
	});
});

describe("generateNeutralDynamicCard — 视频那一行", () => {
	const video = {
		cover: img("COVER"),
		duration: "03:21",
		title: "一期视频",
		desc: "",
		views: "1.2万",
	};

	/**
	 * 决策 55:拓展作品不收弹幕数。缺了那一格就不画弹幕图标与数字 —— 从前只要有视频就无条件
	 * 画,画出一个空图标。播放数那一项照画。
	 */
	it("没有弹幕数:不画弹幕图标,播放数照画;契约里弹幕数是空串", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(node({ type: "DYNAMIC_TYPE_AV", video }));
		const html = captured[0] ?? "";
		expect(html).toContain('aria-label="播放量"');
		expect(html).toContain("1.2万");
		expect(html).not.toContain('aria-label="弹幕"');

		expect(await probe(node({ type: "DYNAMIC_TYPE_AV", video }))).toEqual(["DYNAMIC_TYPE_AV|0||"]);
	});

	it("有弹幕数:图标与数字都画(B 站那条照旧)", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(
			node({ type: "DYNAMIC_TYPE_AV", video: { ...video, danmaku: "34" } }),
		);
		const html = captured[0] ?? "";
		expect(html).toContain('aria-label="弹幕"');
		expect(html).toMatch(/aria-label="弹幕"[\s\S]*?34/);
	});

	/**
	 * 播放数同样选填(决策 55 的作品表里它是选填的):没报就不画播放图标与数字 —— 从前只要有视频就
	 * 无条件画,画出一个空着的播放图标。弹幕数有就照画。
	 */
	it("没有播放数:不画播放图标,弹幕数照画", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(
			node({ type: "DYNAMIC_TYPE_AV", video: { ...video, views: undefined, danmaku: "34" } }),
		);
		const html = captured[0] ?? "";
		expect(html).not.toContain('aria-label="播放量"');
		expect(html).toMatch(/aria-label="弹幕"[\s\S]*?34/);
	});

	it("播放数与弹幕数都没有:两个图标都不画(整行收起),视频的标题照画", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(
			node({ type: "DYNAMIC_TYPE_AV", video: { ...video, views: undefined } }),
		);
		const html = captured[0] ?? "";
		expect(html).not.toContain('aria-label="播放量"');
		expect(html).not.toContain('aria-label="弹幕"');
		expect(html).toContain("一期视频");
	});
});

describe("generateNeutralDynamicCard — 互动数", () => {
	/**
	 * 拓展的作品不一定三样都报(决策 55:赞 / 评论 / 转发各自选填)。没报的那一项不画 —— 画一个空着的
	 * 图标像是数字丢了,写 0 又是瞎说。B 站三样恒有,照旧。
	 */
	it("只报了点赞:只画点赞那一项,评论与转发连图标都不画", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(
			node({ stats: { forward: "", comment: "", like: "1.2万" } }),
		);
		const html = captured[0] ?? "";
		expect(html).toMatch(/aria-label="点赞"[\s\S]*?1\.2万/);
		expect(html).not.toContain('aria-label="评论"');
		expect(html).not.toContain('aria-label="转发"');
	});

	it("三样都有:三项都画(B 站那条照旧)", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(node());
		const html = captured[0] ?? "";
		for (const label of ["转发", "评论", "点赞"]) expect(html).toContain(`aria-label="${label}"`);
	});
});
