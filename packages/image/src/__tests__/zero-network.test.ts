/**
 * **出图器零联网**(3a-37):交给渲染页的那份 HTML 里,除了内嵌内容(`data:`)没有任何会发请求的地址。
 *
 * 渲染页的请求闸在宿主的浏览器适配层(只放行 `data:`,别的掐断),这里钉的是上游那一半:卡里的图在出卡前都已是
 * 图库引用、经宿主的解析口转成 data URL,出图器自己拼出来的 HTML 不该再带任何远端地址 —— 带了就是哪条路还在把
 * 地址原样交给页面,真机上那张图会被闸掐成空白。
 *
 * 做法:七种卡各从公开入口出一张(输入里的图一律是引用或 data URL),截图那一步换成替身、把灌进 `setContent` 的
 * HTML 留下来扫。不开浏览器、不联网。
 *
 * 验红:往任一模板里塞一个 `<img src="http://…">`(如 `blocks/live.tsx` 的头像),对应那一种卡红。
 */

import type { ImageRef, Post, ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { ImageRenderer } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
	signal: new AbortController().signal,
	track: () => {},
};

const img = (name: string) => `data:image/png;base64,${name}`;
const ref = (n: number): ImageRef => `${n.toString(16).padStart(64, "0")}.png`;

/** 截图那一步的替身:把灌进去的 HTML 留下来。图库里每个引用都认得出(转成 data URL)。 */
function makeHarness() {
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
		resolveAsset: async (id) => img(`ASSET-${id}`),
		resolveFontFace: async () => "",
		resolveImageRef: async (r) => img(`REF-${r.slice(60, 64)}`),
	});
	return { renderer, captured };
}

/**
 * HTML 里会让页面发请求、又不是内嵌内容的地址:`src=` / `href=` 属性与 CSS `url(` 里以
 * `http:` / `https:` / `//` / `file:` / `blob:` 开头的。只看开头 —— data URL 的正文里出现这些字样不算
 * (内联 SVG 的 `xmlns='http://www.w3.org/2000/svg'` 就是)。
 */
function networkAddresses(html: string): string[] {
	const scheme = String.raw`(?:https?:|file:|blob:|\/\/)`;
	const patterns = [
		new RegExp(String.raw`\b(?:src|href)\s*=\s*["']?\s*${scheme}[^"'\s>]*`, "gi"),
		new RegExp(String.raw`\burl\(\s*(?:["']|&quot;|&#39;)?\s*${scheme}[^"')\s]*`, "gi"),
	];
	return patterns.flatMap((pattern) => html.match(pattern) ?? []);
}

describe("networkAddresses(扫描本身)", () => {
	it("认得出属性与 CSS 里的远端地址,不把 data URL 的正文当地址", () => {
		expect(networkAddresses('<img src="https://example.invalid/a.png">')).toHaveLength(1);
		expect(networkAddresses("<img src=//example.invalid/a.png>")).toHaveLength(1);
		expect(networkAddresses('<link href="file:///tmp/a.css">')).toHaveLength(1);
		expect(networkAddresses('<img src="blob:null/0000">')).toHaveLength(1);
		expect(
			networkAddresses("<style>.a{background:url(http://example.invalid/a.png)}</style>"),
		).toHaveLength(1);
		expect(
			networkAddresses(
				'<div style="background:url(&quot;https://example.invalid/a.png&quot;)"></div>',
			),
		).toHaveLength(1);
		expect(
			networkAddresses(
				`<img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`,
			),
		).toEqual([]);
		expect(networkAddresses(`<style>.a{background:url("${img("A")}")}</style>`)).toEqual([]);
	});
});

const creator = { name: "示例主播", avatar: ref(1) };

/** 字段尽量铺满的一条作品:头像、正文里的小图标与表情、配图、视频封面、附加块图标,外加一层转发。 */
const POST: Post = {
	creator,
	publishedAt: "2023-11-14T22:13:20.000Z",
	text: "正文",
	richText: [
		{ kind: "text", text: "正文" },
		{ kind: "link", text: "链接", url: "https://example.invalid/page", icon: ref(2) },
		{ kind: "emoji", text: "[doge]", image: ref(3) },
	],
	images: [{ ref: ref(4) }, { ref: ref(5) }],
	attachment: { kind: "card", title: "预约", lines: [{ text: "一行字", icon: ref(2) }] },
	stats: { shares: 1, comments: 2, likes: 3 },
	repost: {
		creator: { name: "原作者", avatar: ref(6) },
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "",
		video: { cover: { ref: ref(7) }, title: "一期视频", description: "简介" },
		images: [{ ref: ref(8) }],
		stats: {},
	},
};

const roastCreator = { name: "示例作者", color: "#fb7299", avatar: img("ROAST") };

const CARDS: Record<string, (renderer: ImageRenderer) => Promise<unknown>> = {
	post: (r) => r.generatePostCard(POST),
	live: (r) =>
		r.generateLiveCard({
			status: "start",
			creator,
			title: "标题",
			category: "分区",
			description: "简介",
			cover: { ref: ref(9) },
			startedAt: "2025-12-31T16:00:00.000Z",
			currentViewers: 1,
		}),
	"live(自定义封面)": (r) =>
		r.generateLiveCard(
			{ status: "streaming", creator, title: "标题", cover: { ref: ref(9) } },
			{ liveCoverImage: "cover-asset-1" },
		),
	membership: (r) =>
		r.generateMembershipCard({
			viewer: { name: "示例观众", avatar: ref(10) },
			creator,
			tier: {
				name: "示例档",
				rank: 1,
				color: "#a8e6cf",
				colorEnd: "#88d8b0",
				announcement: "{viewer} 加入了 {creator} 的会员",
				icon: { ref: ref(11) },
			},
		}),
	superchat: (r) =>
		r.generateSuperchatCard({
			viewer: { name: "示例观众", avatar: ref(10) },
			creator,
			text: "加油",
			amount: 30,
			currency: "CNY",
			tier: { rank: 1, durationSec: 60 },
		}),
	wordcloud: (r) =>
		r.generateWordCloudImg(
			[
				["弹幕", 10],
				["示例", 5],
			],
			creator.name,
			creator.avatar,
		),
	roastBoard: (r) =>
		r.generateRoastBoardCard({
			days: 30,
			pigeon: { ...roastCreator, reason: "理由" },
			diligent: { name: "另一位", color: "#2ac864", reason: "理由" },
			roast: [{ ...roastCreator, comment: "锐评" }],
			scores: [{ ...roastCreator, score: 41 }],
		}),
	roastSolo: (r) =>
		r.generateRoastSoloCard({
			days: 7,
			creator: roastCreator,
			verdict: "锐评",
			score: 32,
			highlights: [{ label: "涨粉", comment: "示例" }],
		}),
};

describe("出图器零联网:交给渲染页的 HTML 里只有内嵌内容", () => {
	it.each(Object.keys(CARDS))("%s 卡", async (name) => {
		const { renderer, captured } = makeHarness();
		await CARDS[name]?.(renderer);
		expect(captured).toHaveLength(1);
		// 确实画了图(否则「没有远端地址」是空话):图库引用或资产解析出来的 data URL 在里面。
		expect(captured[0]).toMatch(/data:image\/png;base64,(?:REF-|ASSET-|ROAST)/);
		expect(networkAddresses(captured[0] ?? "")).toEqual([]);
	});
});

/**
 * 反过来:输入里**故意**带只有地址(`url`)、没有图库引用的图 —— 出图只认引用,这些地址到不了 HTML,那一格画占位
 * 或收起。任何路径交来的远端地址都到不了渲染页。
 *
 * 验红:把 `templates/picture-url.ts` 的 `pictureUrl` 或 `live-view.ts` 的 `coverUrlOf` 改回「只有 url 原样用」,对应的卡红。
 */
describe("出图器零联网:只有地址、没有引用的图到不了 HTML", () => {
	const remote = (name: string) => ({ url: `https://example.invalid/${name}.png` });

	const URL_ONLY_CARDS: Record<string, (renderer: ImageRenderer) => Promise<unknown>> = {
		post: (r) =>
			r.generatePostCard({
				creator: { name: "示例作者" },
				publishedAt: "2023-11-14T22:13:20.000Z",
				text: "正文",
				images: [remote("p1"), remote("p2")],
				attachment: { kind: "card", title: "预约", cover: remote("card") },
				locked: { icon: remote("lock"), title: "充电专属", hint: "说明" },
				repost: {
					creator: { name: "原作者" },
					publishedAt: "2023-11-14T22:13:20.000Z",
					text: "",
					video: { cover: remote("cover"), title: "一期视频", description: "简介" },
					attachment: {
						kind: "goods",
						eyebrow: "商品",
						items: [{ cover: remote("goods"), name: "一件", price: "1" }],
					},
				},
			}),
		"post(附加视频卡 + 专栏图)": (r) =>
			r.generatePostCard({
				creator: { name: "示例作者" },
				publishedAt: "2023-11-14T22:13:20.000Z",
				text: "正文",
				article: { title: "专栏", images: [remote("article")] },
				attachment: { kind: "video", cover: remote("attached"), title: "关联视频" },
			}),
		live: (r) =>
			r.generateLiveCard({
				status: "start",
				creator: { name: "示例主播" },
				title: "标题",
				cover: remote("live"),
			}),
		membership: (r) =>
			r.generateMembershipCard({
				viewer: { name: "示例观众" },
				creator: { name: "示例主播" },
				tier: { name: "示例档", icon: remote("badge") },
			}),
	};

	it.each(Object.keys(URL_ONLY_CARDS))("%s 卡", async (name) => {
		const { renderer, captured } = makeHarness();
		await URL_ONLY_CARDS[name]?.(renderer);
		expect(captured).toHaveLength(1);
		expect(captured[0]).not.toContain("example.invalid");
		expect(networkAddresses(captured[0] ?? "")).toEqual([]);
	});
});
