/**
 * **动态卡的中立入口**(ADR-0019 决策 68):`generateNeutralDynamicCard(node)` 只收一棵造好的
 * node,不收任何平台的原始数据。`Post` 那条(`generatePostCard(post)`)是它前面的一层,画出来一个字节不变
 * 由基准快照(`card-baseline.test.ts`)钉着;这里钉的是中立入口自己:
 *
 * 1. 皮肤契约要的那几格(动态类型、图廊张数 / 首图)从 node 取得到 —— 转发内层取它自己的;
 * 2. 视频那一行没有弹幕数就不画弹幕图标与数字(决策 55:拓展作品不收弹幕数);
 * 3. 头像:node 带了地址就画(拓展作品那条路),没有就整格不画(`Post` 那条到 ㉑d / 3a 之前不给);
 * 4. `generatePostCard`:`Post` → 节点 → 皮肤出卡的接线(时间格式化器、数字排版、label、配色 / 皮肤选项)。
 */

import type { CardSkinManifest, Post, ServiceContext } from "@bilibili-notify/internal";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { formatCardTime } from "../format";
import { ImageRenderer } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";
import type { DynamicNode } from "../templates/dynamic-content";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
	signal: new AbortController().signal,
	track: () => {},
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

describe("generateNeutralDynamicCard — 头像", () => {
	/**
	 * 拓展作品那条路(`apps/server/src/runtime/extension-post-work.ts`)自己造 node、带着头像地址:
	 * 卡上照画。B 站那条路到 3a 之前不给头像(`DynamicNode.avatarUrl`),头像格整个不画。
	 * 验红:把头像块改回无条件画,第二条红;让它不再读 `node.avatarUrl`,第一条红。
	 */
	it("node 带了头像地址:头像格与那张 <img> 都画,契约里 up.face 是这个地址", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(node());
		const html = captured[0] ?? "";
		expect(html).toContain('data-cell="avatar"');
		expect(html).toContain(`src="${img("FACE")}" alt="头像"`);
	});

	it("node 没有头像地址:头像格整个不画,契约里 up.face 是空串;名字照画", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(node({ avatarUrl: undefined }));
		const html = captured[0] ?? "";
		expect(html).not.toContain('data-cell="avatar"');
		expect(html).not.toContain('alt="头像"');
		expect(html).toContain("示例作者");
	});

	it("转发框里的内层卡同理:内层没有头像地址,框里就没有头像格", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generateNeutralDynamicCard(
			node({
				type: "DYNAMIC_TYPE_FORWARD",
				forward: node({ upName: "原作者", avatarUrl: undefined }),
			}),
		);
		const html = captured[0] ?? "";
		// 外层有、内层没有:整张卡上只剩一个头像格。
		expect(html.match(/data-cell="avatar"/g)).toHaveLength(1);
		expect(html).toContain("原作者");
	});
});

describe("generatePostCard — 作品卡的入口(吃中立的 Post)", () => {
	const POST: Post = {
		creator: { name: "示例作者", isPremium: true },
		publishedAt: "2023-11-14T22:13:20.000Z",
		label: "投稿了视频",
		text: "你好世界",
		richText: [{ kind: "text", text: "你好世界" }],
		video: {
			cover: { url: img("COVER") },
			title: "一期视频",
			description: "",
			durationSec: 967,
			views: 12_345,
			danmaku: 129,
		},
		stats: { shares: 12_345, comments: 9999, likes: 128 },
	};

	/**
	 * 接线:`generatePostCard` → `nodeFromPost` → 皮肤出卡。零件各自绿(nodeFromPost 有自己的测试、皮肤路径有基准快照)
	 * 证明不了入口真的把它们接上了。验红:把 `generatePostCard` 里的 `nodeFromPost(...)` 换成别的、或不再把时间格式化器
	 * 递给它,这条红。
	 */
	it("作者、正文、发布时间(渲染器按本地时区排)+ label、视频数字、互动数都画出来", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generatePostCard(POST);
		const html = captured[0] ?? "";
		expect(html).toContain("示例作者");
		expect(html).toContain("你好世界");
		expect(html).toContain(`${formatCardTime(1_700_000_000)} · 投稿了视频`);
		// 数字统一经 formatCount / formatClock。
		expect(html).toContain("16:07");
		expect(html).toMatch(/aria-label="播放量"[\s\S]*?1\.2万/);
		expect(html).toMatch(/aria-label="点赞"[\s\S]*?<span>128<\/span>/);
		expect(html).toMatch(/aria-label="转发"[\s\S]*?<span>1\.2万<\/span>/);
		// 头像不画。
		expect(html).not.toContain('alt="头像"');
	});

	it("配色 / 皮肤选项一路递到出卡(换皮肤 id 用的是同一条路)", async () => {
		const { renderer, captured } = makeRenderer((id) => (id === "probe" ? PROBE : undefined));
		await renderer.generatePostCard(POST, { cardSkin: "probe" });
		expect(captured[0] ?? "").toContain("探针[DYNAMIC_TYPE_AV|0||129]");
	});

	it("被转发的原作品是内层卡:label 接在作者名后", async () => {
		const { renderer, captured } = makeRenderer();
		await renderer.generatePostCard({
			creator: { name: "转发者" },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "转发语",
			repost: { ...POST, creator: { name: "原作者" }, stats: undefined },
		});
		expect(captured[0] ?? "").toContain("原作者 投稿了视频");
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
