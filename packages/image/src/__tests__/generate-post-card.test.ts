/**
 * **作品卡的出卡入口**(`ImageRenderer.generatePostCard(post)`):吃中立的 `Post`,不收任何平台的原始数据。
 *
 * 钉的是入口自己 —— `Post` → 节点 → 皮肤出卡这一串的接线,与图库引用的解析:
 *
 * 1. 皮肤契约要的那几格(动态类型、图廊张数 / 首图、视频弹幕数)从作品取得到 —— 转发内层取它自己的;
 * 2. 视频那一行没有弹幕 / 播放数就不画对应的图标与数字(拓展作品不收弹幕数);
 * 3. 头像:有引用就画(解析不到画占位),没有引用头像格整个不画;
 * 4. 互动数哪一项没报就不画哪一项;
 * 5. 发布时间(渲染器按本地时区排)+ label、数字排版、配色 / 皮肤选项一路递到出卡;
 * 6. **图库引用由宿主注入的 `resolveImageRef` 事先解析**:配图 / 封面 / 头像 / 正文小图标与表情图 / 附加块文字行图标;
 *    `ref` 与 `url` 都有时认 `ref`,只有 `url` 的、解析不到(或解析口抛错)的都画占位、不抛。
 */

import type { CardSkinManifest, ImageRef, Post, ServiceContext } from "@bilibili-notify/internal";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { formatCardTime } from "../format";
import { ImageRenderer } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";
import { BLOCKED_IMG_PLACEHOLDER } from "../skin/render-skin";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
	signal: new AbortController().signal,
	track: () => {},
};

interface HarnessOptions {
	resolveCardSkin?: (id: string) => CardSkinManifest | undefined;
	resolveImageRef?: (ref: ImageRef) => Promise<string | undefined>;
}

/** 截图那一步的替身:把灌进去的 HTML 留下来。 */
function makeRenderer(options: HarnessOptions = {}) {
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
		...options,
	});
	return { renderer, captured };
}

/** 图一律 data URL —— 测试不许联网。 */
const img = (name: string) => `data:image/png;base64,${name}`;

const ref = (n: number): ImageRef => `${n.toString(16).padStart(64, "0")}.png`;

function post(over: Partial<Post> = {}): Post {
	return {
		creator: { name: "示例作者" },
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "",
		stats: { shares: 1, comments: 2, likes: 3 },
		...over,
	};
}

/** 一套探针皮肤:一个自定义块把几个契约字段原样印出来,外加转发框(内层卡画在它里头)。 */
const PROBE: CardSkinManifest = {
	...DEFAULT_CARD_SKIN,
	cards: {
		...DEFAULT_CARD_SKIN.cards,
		post: {
			width: 600,
			blocks: [
				{
					id: "probe",
					kind: "custom",
					html: "<div>探针[{post.hasVideo}|{post.hasRepost}|{images.count}|{images.first}|{video.danmaku}]</div>",
					grid: { row: 1, column: 1, span: 12 },
				},
				{
					id: "repost",
					kind: "builtin",
					builtin: "repost",
					grid: { row: 2, column: 1, span: 12 },
				},
			],
		},
	},
} as never;

/** 探针用例的图库:`ref(n)` → `img("R<n>")`。 */
const probeImage = async (r: ImageRef) => img(`R${Number.parseInt(r.slice(0, 64), 16)}`);

async function probe(p: Post): Promise<string[]> {
	const { renderer, captured } = makeRenderer({
		resolveCardSkin: (id) => (id === "probe" ? PROBE : undefined),
		resolveImageRef: probeImage,
	});
	await renderer.generatePostCard(p, { cardSkin: "probe" });
	return [...(captured[0] ?? "").matchAll(/探针\[([^\]]*)\]/g)].map((m) => m[1] as string);
}

async function htmlOf(p: Post, options: HarnessOptions = {}): Promise<string> {
	const { renderer, captured } = makeRenderer(options);
	await renderer.generatePostCard(p);
	return captured[0] ?? "";
}

describe("generatePostCard — 皮肤契约从作品取", () => {
	/**
	 * 验红:把 `skin/card-data.ts` 里 `post.hasVideo` / `post.hasRepost` 或 `images.*` 改成读别处(比如写死空值),
	 * 这条红。
	 */
	it("有没有视频 / 转发、图廊张数与首图都从作品上取", async () => {
		const out = await probe(post({ images: [{ ref: ref(1) }, { ref: ref(2) }, { ref: ref(3) }] }));
		expect(out).toEqual([`false|false|3|${img("R1")}|`]);
	});

	/**
	 * 转发内层取**它自己**的那几格 —— 不是外层的,也不是空的。
	 * 验红:把 `render-skin.tsx` 的 `renderForward` 改成拿外层的 props 装内层,这条红。
	 */
	it("转发框里那张卡取内层作品的有无视频与图", async () => {
		const out = await probe(
			post({
				repost: post({
					creator: { name: "原作者" },
					video: { cover: { ref: ref(1) }, title: "t", description: "" },
					images: [{ ref: ref(2) }],
				}),
			}),
		);
		expect(out).toEqual(["false|true|0||", `true|false|1|${img("R2")}|`]);
	});
});

describe("generatePostCard — 视频那一行", () => {
	const video = (over: Partial<NonNullable<Post["video"]>> = {}): Post["video"] => ({
		cover: { url: img("COVER") },
		title: "一期视频",
		description: "",
		durationSec: 201,
		views: 12_345,
		...over,
	});

	/**
	 * 拓展作品不收弹幕数。缺了那一格就不画弹幕图标与数字 —— 从前只要有视频就无条件
	 * 画,画出一个空图标。播放数那一项照画。
	 */
	it("没有弹幕数:不画弹幕图标,播放数照画;契约里弹幕数是空串", async () => {
		const html = await htmlOf(post({ video: video() }));
		expect(html).toContain('aria-label="播放量"');
		expect(html).toContain("1.2万");
		expect(html).not.toContain('aria-label="弹幕"');
		expect(await probe(post({ video: video() }))).toEqual(["true|false|0||"]);
	});

	it("有弹幕数:图标与数字都画", async () => {
		const html = await htmlOf(post({ video: video({ danmaku: 34 }) }));
		expect(html).toMatch(/aria-label="弹幕"[\s\S]*?34/);
	});

	/** 播放数同样选填:没报就不画播放图标与数字。弹幕数有就照画。 */
	it("没有播放数:不画播放图标,弹幕数照画", async () => {
		const html = await htmlOf(post({ video: video({ views: undefined, danmaku: 34 }) }));
		expect(html).not.toContain('aria-label="播放量"');
		expect(html).toMatch(/aria-label="弹幕"[\s\S]*?34/);
	});

	it("播放数与弹幕数都没有:两个图标都不画(整行收起),视频的标题照画", async () => {
		const html = await htmlOf(post({ video: video({ views: undefined }) }));
		expect(html).not.toContain('aria-label="播放量"');
		expect(html).not.toContain('aria-label="弹幕"');
		expect(html).toContain("一期视频");
	});
});

describe("generatePostCard — 互动数", () => {
	/**
	 * 拓展的作品不一定三样都报(赞 / 评论 / 转发各自选填)。没报的那一项不画 —— 画一个空着的
	 * 图标像是数字丢了,写 0 又是瞎说。
	 */
	it("只报了点赞:只画点赞那一项,评论与转发连图标都不画", async () => {
		const html = await htmlOf(post({ stats: { likes: 12_345 } }));
		expect(html).toMatch(/aria-label="点赞"[\s\S]*?1\.2万/);
		expect(html).not.toContain('aria-label="评论"');
		expect(html).not.toContain('aria-label="转发"');
	});

	it("三样都有:三项都画", async () => {
		const html = await htmlOf(post());
		for (const label of ["转发", "评论", "点赞"]) expect(html).toContain(`aria-label="${label}"`);
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
		const html = await htmlOf(POST);
		expect(html).toContain("示例作者");
		expect(html).toContain("你好世界");
		expect(html).toContain(`${formatCardTime(1_700_000_000)} · 投稿了视频`);
		// 数字统一经 formatCount / formatClock。
		expect(html).toContain("16:07");
		expect(html).toMatch(/aria-label="播放量"[\s\S]*?1\.2万/);
		expect(html).toMatch(/aria-label="点赞"[\s\S]*?<span>128<\/span>/);
		expect(html).toMatch(/aria-label="转发"[\s\S]*?<span>1\.2万<\/span>/);
	});

	it("配色 / 皮肤选项一路递到出卡(换皮肤 id 用的是同一条路)", async () => {
		const { renderer, captured } = makeRenderer({
			resolveCardSkin: (id) => (id === "probe" ? PROBE : undefined),
		});
		await renderer.generatePostCard(POST, { cardSkin: "probe" });
		expect(captured[0] ?? "").toContain("探针[true|false|0||129]");
	});

	it("被转发的原作品是内层卡:label 接在作者名后", async () => {
		const html = await htmlOf({
			creator: { name: "转发者" },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "转发语",
			repost: { ...POST, creator: { name: "原作者" }, stats: undefined },
		});
		expect(html).toContain("原作者 投稿了视频");
	});
});

describe("generatePostCard — 头像", () => {
	const resolve = async (r: ImageRef) => (r === ref(1) ? img("FACE") : undefined);

	/**
	 * 头像是图库引用:有引用就画(地址由 `resolveImageRef` 解析),没有引用头像格整个不画(B 站到 3a 才有头像)。
	 * 验红:让 `nodeFromPost` 不再读 `creator.avatar`,第一条红;让头像块不判空,第二条红。
	 */
	it("有引用:头像格与那张 <img> 都画,地址是解析出来的 data URL", async () => {
		const html = await htmlOf(post({ creator: { name: "某人", avatar: ref(1) } }), {
			resolveImageRef: resolve,
		});
		expect(html).toContain('data-cell="creator-avatar"');
		expect(html).toContain(`src="${img("FACE")}" alt="头像"`);
	});

	it("没有引用:头像格整个不画;名字照画", async () => {
		const html = await htmlOf(post(), { resolveImageRef: resolve });
		expect(html).not.toContain('data-cell="creator-avatar"');
		expect(html).not.toContain('alt="头像"');
		expect(html).toContain("示例作者");
	});

	it("引用解析不到(图已被清扫):画占位,留一块空的头像位,不抛", async () => {
		const html = await htmlOf(post({ creator: { name: "某人", avatar: ref(9) } }), {
			resolveImageRef: resolve,
		});
		expect(html).toContain(`src="${BLOCKED_IMG_PLACEHOLDER}" alt="头像"`);
	});

	it("转发框里的内层卡同理:内层没有引用,框里就没有头像格", async () => {
		const html = await htmlOf(
			post({
				creator: { name: "外层", avatar: ref(1) },
				repost: post({ creator: { name: "原作者" } }),
			}),
			{ resolveImageRef: resolve },
		);
		// 外层有、内层没有:整张卡上只剩一个头像格。
		expect(html.match(/data-cell="creator-avatar"/g)).toHaveLength(1);
		expect(html).toContain("原作者");
	});
});

describe("generatePostCard — 图库引用由注入的解析口事先解析", () => {
	/** 一张表当图库:引用 → data URL。 */
	const LIBRARY: Record<string, string> = {
		[ref(1)]: img("ONE"),
		[ref(2)]: img("TWO"),
		[ref(3)]: img("COVER"),
		[ref(4)]: img("ICON"),
		[ref(5)]: img("EMOJI"),
	};
	const resolveImageRef = async (r: ImageRef) => LIBRARY[r];

	it("配图、视频封面、正文小图标与表情图、附加块文字行图标都经解析口画出来", async () => {
		const html = await htmlOf(
			post({
				text: "链接[doge]",
				richText: [
					{ kind: "link", text: "链接", url: "u", icon: ref(4) },
					{ kind: "emoji", text: "[doge]", image: ref(5) },
				],
				images: [{ ref: ref(1) }, { ref: ref(2) }],
				attachment: {
					kind: "card",
					title: "预约",
					lines: [{ text: "一行字", icon: ref(4) }],
				},
			}),
			{ resolveImageRef },
		);
		expect(html).toContain(img("ONE"));
		expect(html).toContain(img("TWO"));
		// 小图标:链接前一个、文字行前一个;表情图画成图,不再是「[doge]」。
		expect(html.split(img("ICON")).length - 1).toBe(2);
		expect(html).toContain(img("EMOJI"));
		expect(html).not.toContain("[doge]");
		expect(html).toContain("一行字");

		const video = await htmlOf(
			post({ video: { cover: { ref: ref(3) }, title: "视频", description: "" } }),
			{ resolveImageRef },
		);
		expect(video).toContain(img("COVER"));
	});

	it("同一个引用在作品里出现几次,只问解析口一次", async () => {
		const asked: string[] = [];
		await htmlOf(
			post({
				images: [{ ref: ref(1) }, { ref: ref(1) }, { ref: ref(2) }],
				creator: { name: "某人", avatar: ref(1) },
			}),
			{
				resolveImageRef: async (r) => {
					asked.push(r);
					return LIBRARY[r];
				},
			},
		);
		expect(asked.sort()).toEqual([ref(1), ref(2)]);
	});

	it("被转发的原作品里的引用同样解析", async () => {
		const html = await htmlOf(
			post({ repost: post({ creator: { name: "原作者" }, images: [{ ref: ref(2) }] }) }),
			{ resolveImageRef },
		);
		expect(html).toContain(img("TWO"));
	});

	it("`ref` 与 `url` 都有时认 `ref`;只有 `url` 的画占位(地址不进卡)", async () => {
		const html = await htmlOf(
			post({ images: [{ ref: ref(1), url: img("OTHER") }, { url: img("PLAIN") }] }),
			{ resolveImageRef },
		);
		expect(html).toContain(img("ONE"));
		expect(html).not.toContain(img("OTHER"));
		expect(html).not.toContain(img("PLAIN"));
		expect(html).toContain(BLOCKED_IMG_PLACEHOLDER);
	});

	it("解析不到(图已被清扫)的引用画占位,不退回 `url`;两样都没有也画占位;解析口抛错同样画占位", async () => {
		const html = await htmlOf(
			post({
				images: [{ ref: ref(9), url: img("FALLBACK") }, {}, { ref: ref(1) }],
			}),
			{ resolveImageRef },
		);
		expect(html).not.toContain(img("FALLBACK"));
		expect(html.split(BLOCKED_IMG_PLACEHOLDER).length - 1).toBeGreaterThanOrEqual(2);

		const thrown = await htmlOf(post({ images: [{ ref: ref(1) }] }), {
			resolveImageRef: async () => {
				throw new Error("读盘失败");
			},
		});
		expect(thrown).toContain(BLOCKED_IMG_PLACEHOLDER);
	});

	it("没有注入解析口:所有引用都画占位,照样出卡", async () => {
		const html = await htmlOf(
			post({ images: [{ ref: ref(1) }], creator: { name: "某人", avatar: ref(1) } }),
		);
		expect(html).toContain(BLOCKED_IMG_PLACEHOLDER);
		expect(html).not.toContain("data:image/png;base64,ONE");
	});

	it("表情图解析不到:退回文字(「[doge]」),链接图标解析不到:只剩文字", async () => {
		const html = await htmlOf(
			post({
				text: "链接[doge]",
				richText: [
					{ kind: "link", text: "链接", url: "u", icon: ref(9) },
					{ kind: "emoji", text: "[doge]", image: ref(9) },
				],
			}),
			{ resolveImageRef },
		);
		expect(html).toContain("[doge]");
		expect(html).toContain('<span class="text-[#00AEEC]">链接</span>');
	});
});
