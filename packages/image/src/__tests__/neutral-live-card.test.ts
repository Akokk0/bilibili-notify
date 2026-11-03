/**
 * **直播卡的入口**(ADR-0019 决策 68 / 76):`generateLiveCard(input)` 吃一份中立的直播卡输入,不收任何
 * 平台的原始结构,状态明写。B 站那头的翻译(`liveCardInputFromRoomInfo`)在 `apps/server/src/bilibili/live`、拓展那头的在服务端,
 * 各自的测试钉着;㉒c 之前这里还有一个吃 B 站原始数据的 `generateLiveCard`(适配层),随翻译搬走、入口收成一个。
 * 这里钉的是:
 *
 * 1. 默认块在每种状态下画出的文字 —— 下播卡是「点赞 + 累计观看人数」,粉丝数变化不上默认卡
 *    (决策 76);没有的格子那一行不画(只收精确数,缺了就缺键);
 * 2. 卡上那句时间由 ISO 开播时刻算(北京时间),读不懂当没有;数字排成「1.2万」,粉丝数变化带正负号;
 * 3. 皮肤契约的直播取值(下播时 `stats.likes` = 点赞、`stats.totalViewers` = 累计观看,
 *    `stats.followersDelta` 有就给);
 * 4. 封面:引用解析到画解析结果,解析不到、只有 `url`、两样都没有都画占位;自定义直播封面盖在
 *    输入的封面上;契约的 `live.cover` 永远画得出来、`live.hasCover` 如实说;
 * 5. 头像:`creator.avatar` 是引用,解析到了画,没有或解析不到整块收起(B 站那条到 3a 之前不给,㉒b),
 *    契约的 `creator.avatar` 随之是地址 / 空串。
 */

import type { CardSkinManifest, ImageRef, ServiceContext } from "@bilibili-notify/internal";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ImageRenderer } from "../image-renderer";
import { liveCoverPlaceholder } from "../live-view";
import type { PuppeteerLike } from "../puppeteer";
import type { LiveCardInput } from "../templates/live-card";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
	signal: new AbortController().signal,
	track: () => {},
};

/** 两个图库引用与它们解析出的地址(宿主注入的解析口换的是 data URL)。 */
const FACE_REF: ImageRef = `${"a".repeat(64)}.png`;
const COVER_REF: ImageRef = `${"b".repeat(64)}.png`;
const FACE = "data:image/png;base64,FACE";
const COVER_FROM_REF = "data:image/png;base64,COVER-FROM-REF";
const RESOLVED: Record<string, string> = { [FACE_REF]: FACE, [COVER_REF]: COVER_FROM_REF };

function makeRenderer(
	opts: {
		resolveAsset?: (id: string) => Promise<string>;
		resolveCardSkin?: (id: string) => CardSkinManifest | undefined;
		/** 不给 = 默认那张表;`null` = 宿主没注入解析口。 */
		resolveImageRef?: ((ref: ImageRef) => Promise<string | undefined>) | null;
		/** 全局时区(现取);不给 = 出厂值。 */
		timezone?: () => string;
	} = {},
) {
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
		resolveAsset: opts.resolveAsset ?? (async () => ""),
		resolveFontFace: async () => "",
		timezone: opts.timezone ?? (() => "Asia/Shanghai"),
		resolveCardSkin: opts.resolveCardSkin,
		resolveImageRef:
			opts.resolveImageRef === null
				? undefined
				: (opts.resolveImageRef ?? (async (ref) => RESOLVED[ref])),
	});
	return { renderer, captured };
}

const COVER = "data:image/png;base64,COVER";

/** 北京时间 2026-09-13 20:00:00。 */
const STARTED_AT = "2026-09-13T12:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);

function input(over: Partial<LiveCardInput> = {}): LiveCardInput {
	return {
		status: "streaming",
		creator: { name: "示例主播", avatar: FACE_REF },
		title: "一场直播",
		category: "虚拟主播",
		description: "纯文本简介",
		cover: { ref: COVER_REF },
		startedAt: STARTED_AT,
		currentViewers: 12_345,
		likes: 20_133,
		totalViewers: 31_200,
		followers: 88_800,
		followersDelta: 1_234,
		...over,
	};
}

/** 默认皮肤画出的整张卡里,每一块的文字(封面取 src)。块没画就不在表里。 */
async function drawn(i: LiveCardInput, colorOptions = {}): Promise<Record<string, string>> {
	const { renderer, captured } = makeRenderer({
		resolveAsset: async (id) => `data:image/png;base64,ASSET-${id}`,
	});
	await renderer.generateLiveCard(i, colorOptions);
	const doc = new JSDOM(captured[0] ?? "").window.document;
	const out: Record<string, string> = {};
	for (const el of doc.querySelectorAll("[data-block]")) {
		const block = el.getAttribute("data-block") ?? "";
		const img = el.querySelector("img");
		out[block] =
			block === "cover" ? (img?.getAttribute("src") ?? "") : (el.textContent ?? "").trim();
	}
	return out;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("generateLiveCard — 默认块在各状态画出的文字", () => {
	it("开播:「直播中」角标、开播时间(北京时间)、人气 + 当前粉丝数", async () => {
		const d = await drawn(input({ status: "start" }));
		expect(d.status).toBe("直播中");
		expect(d.time).toBe("开播时间：2026-09-13 20:00:00");
		expect(d.currentViewers).toBe("人气：1.2万");
		expect(d.followers).toBe("当前粉丝数：8.9万");
		expect(d.cover).toBe(COVER_FROM_REF);
	});

	it("直播中:直播时长由开播时刻算", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(STARTED_AT_MS + (2 * 3600 + 13 * 60 + 5) * 1000);
		const d = await drawn(input({ status: "streaming" }));
		expect(d.status).toBe("直播中");
		expect(d.time).toBe("直播时长：2小时13分5秒");
		expect(d.currentViewers).toBe("人气：1.2万");
		expect(d.followers).toBe("当前粉丝数：8.9万");
	});

	/** 出卡那一刻现取全局时区:设置改了,下一张直播卡跟着变。 */
	it("卡上时间按出卡那一刻现取的时区排", async () => {
		let timezone = "Asia/Shanghai";
		const { renderer, captured } = makeRenderer({ timezone: () => timezone });
		await renderer.generateLiveCard(input({ status: "start" }));
		expect(captured[0] ?? "").toContain("开播时间：2026-09-13 20:00:00");
		timezone = "America/New_York";
		await renderer.generateLiveCard(input({ status: "start" }));
		expect(captured[1] ?? "").toContain("开播时间：2026-09-13 08:00:00");
	});

	/**
	 * 决策 76:下播卡的数据区是「点赞 + 累计观看人数」—— 下播那一刻的人气是散场时的在线
	 * 人数,概括不了这一场。粉丝数变化不上默认卡(它进下播文案)。
	 */
	it("下播:「已下播」角标、点赞 + 累计观看人数;粉丝数变化不画", async () => {
		const d = await drawn(input({ status: "end" }));
		expect(d.status).toBe("已下播");
		expect(d.time).toBe("开播时间：2026-09-13 20:00:00");
		expect(d.likes).toBe("点赞：2.0万");
		expect(d.totalViewers).toBe("累计观看人数：3.1万");
		expect(d.currentViewers).toBeUndefined();
		expect(d.followers).toBeUndefined();
		expect(Object.values(d).join("|")).not.toContain("粉丝数变化");
		expect(Object.values(d).join("|")).not.toContain("人气");
	});

	it("没在播:「未开播」角标与那句、人气,没有粉丝行", async () => {
		const d = await drawn(input({ status: "offline" }));
		expect(d.status).toBe("未开播");
		expect(d.time).toBe("未开播");
		expect(d.currentViewers).toBe("人气：1.2万");
		expect(d.followers).toBeUndefined();
	});

	/** 拓展没报的格子:那一行整行不画,不留一个「点赞：」后面什么都没有。 */
	it("没有的格子那一行不画:下播没报点赞 / 累计观看,开播没报人气", async () => {
		const ended = await drawn(input({ status: "end", likes: undefined, totalViewers: undefined }));
		expect(ended.likes).toBeUndefined();
		expect(ended.totalViewers).toBeUndefined();

		const started = await drawn(
			input({ status: "start", currentViewers: undefined, followers: undefined }),
		);
		expect(started.currentViewers).toBeUndefined();
		expect(started.followers).toBeUndefined();
	});

	/** 拓展可以不报分区:不留一个「分区：」后面什么都没有。B 站恒有分区。 */
	it("没有分区(没给或空串)→ 分区那一行不画", async () => {
		expect((await drawn(input({ category: undefined }))).category).toBeUndefined();
		expect((await drawn(input({ category: "" }))).category).toBeUndefined();
		expect((await drawn(input())).category).toBe("分区：虚拟主播");
	});

	it("没有开播时刻 → 不写那句时间", async () => {
		expect((await drawn(input({ status: "start", startedAt: undefined }))).time).toBe("");
		expect((await drawn(input({ status: "streaming", startedAt: undefined }))).time).toBe("");
	});

	/** 读不懂的 ISO 当没有开播时刻,不印「Invalid DateTime」,也不把整张卡弄抛。 */
	it("开播时刻读不懂 → 同样不写那句时间", async () => {
		for (const status of ["start", "streaming", "end"] as const) {
			const d = await drawn(input({ status, startedAt: "昨晚八点" }));
			expect(d.time, status).toBe("");
		}
	});

	/**
	 * 人数只收精确数、缺了就缺键;**精确的 0 是真数**:画出来,不当作没有。(B 站从前缺了也补 0、卡上印「人气：0」,
	 * 这一片起不补了 —— 缺的是上面「没有的格子那一行不画」那条;真报了 0 才是这条。)
	 */
	it("精确的 0 照画:人气 0、累计观看 0", async () => {
		expect((await drawn(input({ status: "start", currentViewers: 0 }))).currentViewers).toBe(
			"人气：0",
		);
		expect((await drawn(input({ status: "end", totalViewers: 0 }))).totalViewers).toBe(
			"累计观看人数：0",
		);
	});

	it("简介空着走兜底文案", async () => {
		expect((await drawn(input({ description: undefined }))).description).toBe(
			"这个主播很懒，什么简介都没写",
		);
	});

	it("自定义直播封面盖在输入的封面上", async () => {
		const d = await drawn(input(), { liveCoverImage: "my-cover" });
		expect(d.cover).toBe("data:image/png;base64,ASSET-my-cover");
	});

	/**
	 * 拓展直播没报封面、B 站两张都没有时走到这里:从前 `<img src="">` 画成一张只剩 alt 文字的
	 * 裂图。验红:把 `buildLiveCardView` 的封面兜底去掉(没有就直接画空串),这条红。
	 */
	it("没有封面(没给、url 是空串)→ 画 BN 自带的占位图", async () => {
		expect((await drawn(input({ cover: undefined }))).cover).toBe(liveCoverPlaceholder());
		expect((await drawn(input({ cover: { url: "" } }))).cover).toBe(liveCoverPlaceholder());
		expect((await drawn(input({ cover: {} }))).cover).toBe(liveCoverPlaceholder());
	});

	it("没有封面但设了自定义封面 → 画自定义封面,不画占位", async () => {
		const d = await drawn(input({ cover: undefined }), { liveCoverImage: "my-cover" });
		expect(d.cover).toBe("data:image/png;base64,ASSET-my-cover");
	});
});

/** 占位图本身:内嵌的 data URL(出卡不许联网),而且真是一张 SVG。 */
describe("直播封面的占位图", () => {
	it("是内嵌的 SVG,带「暂无封面」那行字", () => {
		const prefix = "data:image/svg+xml;base64,";
		expect(liveCoverPlaceholder().startsWith(prefix)).toBe(true);
		const svg = Buffer.from(liveCoverPlaceholder().slice(prefix.length), "base64").toString("utf8");
		expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		expect(svg).toContain("暂无封面");
		// 16:9 —— 与 B 站封面同比例,没声明高度的皮肤里它按自己的比例撑开,不会压扁。
		expect(svg).toContain('width="640" height="360"');
	});
});

/** 一套探针皮肤:一个自定义块把直播契约的几格原样印出来。 */
const PROBE: CardSkinManifest = {
	...DEFAULT_CARD_SKIN,
	cards: {
		...DEFAULT_CARD_SKIN.cards,
		live: {
			width: 600,
			blocks: [
				{
					id: "probe",
					kind: "custom",
					html: "<div>探针[{stats.currentViewers}|{stats.likes}|{stats.followers}|{stats.totalViewers}|{stats.followersDelta}|{live.isStreaming}|{live.isEnded}]</div>",
					grid: { row: 1, column: 1, span: 12 },
				},
			],
		},
	},
} as never;

async function contract(i: LiveCardInput): Promise<string> {
	const { renderer, captured } = makeRenderer({
		resolveCardSkin: (id) => (id === "probe" ? PROBE : undefined),
	});
	await renderer.generateLiveCard(i, { cardSkin: "probe" });
	return /探针\[([^\]]*)\]/.exec(captured[0] ?? "")?.[1] ?? "(没找到探针)";
}

/**
 * 封面探针:一个没写 `showIf` 的自定义块直接 `<img src="{live.cover}">`,再印出 `live.hasCover`
 * —— 契约说的是「`live.cover` 永远画得出来(没有真封面时是占位图),`live.hasCover` 如实说
 * 有没有真封面」。
 */
const COVER_PROBE: CardSkinManifest = {
	...DEFAULT_CARD_SKIN,
	cards: {
		...DEFAULT_CARD_SKIN.cards,
		live: {
			width: 600,
			blocks: [
				{
					id: "probe",
					kind: "custom",
					html: '<div><img src="{live.cover}"><span>有封面[{live.hasCover}]</span></div>',
					grid: { row: 1, column: 1, span: 12 },
				},
			],
		},
	},
} as never;

async function coverContract(
	i: LiveCardInput,
	colorOptions: Record<string, string> = {},
): Promise<{ src: string; hasCover: string }> {
	const { renderer, captured } = makeRenderer({
		resolveAsset: async (id) => `data:image/png;base64,ASSET-${id}`,
		resolveCardSkin: (id) => (id === "cover-probe" ? COVER_PROBE : undefined),
	});
	await renderer.generateLiveCard(i, { ...colorOptions, cardSkin: "cover-probe" });
	const doc = new JSDOM(captured[0] ?? "").window.document;
	// 自定义块的 wrapper 一律挂 `data-block="custom"`(块 id 不上 DOM)。
	const probe = doc.querySelector('[data-block="custom"]');
	return {
		src: probe?.querySelector("img")?.getAttribute("src") ?? "(没找到探针)",
		hasCover: /有封面\[([^\]]*)\]/.exec(probe?.textContent ?? "")?.[1] ?? "(没找到探针)",
	};
}

describe("generateLiveCard — 封面是 PostImage:引用 / url / 都没有", () => {
	/** 默认皮肤画出的封面格的 src(拿 `drawn` 的封面口径)。 */
	async function coverSrc(
		cover: LiveCardInput["cover"],
		opts: Parameters<typeof makeRenderer>[0] = {},
		colorOptions: object = {},
	): Promise<string> {
		const { renderer, captured } = makeRenderer(opts);
		await renderer.generateLiveCard(input({ cover }), colorOptions);
		const doc = new JSDOM(captured[0] ?? "").window.document;
		return doc.querySelector('[data-block="cover"] img')?.getAttribute("src") ?? "(没有封面格)";
	}

	/**
	 * 规则:只认 `ref` 的解析结果;解析不到当成没有封面(画「暂无封面」占位,不画透明块,也**不退回 `url`**);
	 * 只有 `url`、两样都没有同样是没有封面(地址不进卡,渲染页不联网)。
	 * 验红:`coverUrlOf` 里让解析不到时退回 `url`,第二条红;让 `ref` 不再解析,第一条红。
	 */
	it("引用解析到了:画解析出的地址", async () => {
		expect(await coverSrc({ ref: COVER_REF })).toBe(COVER_FROM_REF);
	});

	it("引用解析不到(回 undefined / 抛错 / 没注入解析口):画占位,哪怕同时带着 url", async () => {
		const gone = `${"c".repeat(64)}.png`;
		expect(await coverSrc({ ref: gone })).toBe(liveCoverPlaceholder());
		expect(await coverSrc({ ref: gone, url: "https://example.com/c.png" })).toBe(
			liveCoverPlaceholder(),
		);
		expect(
			await coverSrc(
				{ ref: COVER_REF },
				{
					resolveImageRef: async () => {
						throw new Error("读盘失败");
					},
				},
			),
		).toBe(liveCoverPlaceholder());
		expect(await coverSrc({ ref: COVER_REF }, { resolveImageRef: null })).toBe(
			liveCoverPlaceholder(),
		);
	});

	it("只有 url:占位(来源没把图存进图库就是没有封面;data URL 也一样,出图只认引用)", async () => {
		expect(await coverSrc({ url: "https://example.com/c.png" })).toBe(liveCoverPlaceholder());
		expect(await coverSrc({ url: COVER })).toBe(liveCoverPlaceholder());
	});

	it("引用与 url 都有且引用解析到了:认引用", async () => {
		expect(await coverSrc({ ref: COVER_REF, url: "https://example.com/c.png" })).toBe(
			COVER_FROM_REF,
		);
	});

	it("两样都没有(没给 cover / cover 是空对象):占位", async () => {
		expect(await coverSrc(undefined)).toBe(liveCoverPlaceholder());
		expect(await coverSrc({})).toBe(liveCoverPlaceholder());
	});

	/** 自定义直播封面(`colorOptions.liveCoverImage`)优先级最高,盖在引用与 url 之上,也盖在占位之上。 */
	it("自定义直播封面盖住引用,输入里那张引用连问都不问", async () => {
		const asked: string[] = [];
		const src = await coverSrc(
			{ ref: COVER_REF },
			{
				resolveAsset: async (id) => `data:image/png;base64,ASSET-${id}`,
				resolveImageRef: async (ref) => {
					asked.push(ref);
					return RESOLVED[ref];
				},
			},
			{ liveCoverImage: "my-cover" },
		);
		expect(src).toBe("data:image/png;base64,ASSET-my-cover");
		// 头像引用照问,封面引用没问。
		expect(asked).toEqual([FACE_REF]);
	});
});

describe("generateLiveCard — 皮肤契约的封面", () => {
	it("有封面:live.cover 就是它,live.hasCover 为真", async () => {
		expect(await coverContract(input())).toEqual({ src: COVER_FROM_REF, hasCover: "true" });
	});

	it("没有真封面:live.cover 给占位图(没写 showIf 的皮肤也不裂图),live.hasCover 为假", async () => {
		expect(await coverContract(input({ cover: undefined }))).toEqual({
			src: liveCoverPlaceholder(),
			hasCover: "false",
		});
		// 引用解析不到同样是没有真封面。
		expect(await coverContract(input({ cover: { ref: `${"c".repeat(64)}.png` } }))).toEqual({
			src: liveCoverPlaceholder(),
			hasCover: "false",
		});
	});

	it("自定义封面算真封面", async () => {
		expect(
			await coverContract(input({ cover: undefined }), { liveCoverImage: "my-cover" }),
		).toEqual({ src: "data:image/png;base64,ASSET-my-cover", hasCover: "true" });
	});
});

describe("generateLiveCard — 皮肤契约的直播取值", () => {
	it("下播:likes = 点赞、totalViewers = 累计观看(在看人数与粉丝数为空),粉丝数变化照给", async () => {
		expect(await contract(input({ status: "end" }))).toBe("|2.0万||3.1万|+1234|false|true");
	});

	it("开播 / 直播中:currentViewers = 在看人数、followers = 当前粉丝数(点赞与累计观看为空)", async () => {
		expect(await contract(input({ status: "start" }))).toBe("1.2万||8.9万||+1234|true|false");
		expect(await contract(input({ status: "streaming" }))).toBe("1.2万||8.9万||+1234|true|false");
	});

	it("粉丝数变化带正负号,过万写成「万」", async () => {
		expect(await contract(input({ status: "end", followersDelta: 12_345 }))).toContain("|+1.2万|");
		expect(await contract(input({ status: "end", followersDelta: -35 }))).toContain("|-35|");
		expect(await contract(input({ status: "end", followersDelta: -12_345 }))).toContain("|-1.2万|");
	});
});

/** 头像探针:一个自定义块把 `creator.avatar` 原样印出来。 */
const FACE_PROBE: CardSkinManifest = {
	...DEFAULT_CARD_SKIN,
	cards: {
		...DEFAULT_CARD_SKIN.cards,
		live: {
			width: 600,
			blocks: [
				{
					id: "probe",
					kind: "custom",
					html: "<div>头像[{creator.avatar}]</div>",
					grid: { row: 1, column: 1, span: 12 },
				},
			],
		},
	},
} as never;

describe("generateLiveCard — 头像", () => {
	/** 一张默认皮肤的卡出完,整份 HTML。 */
	async function html(
		i: LiveCardInput,
		resolveImageRef?: ((ref: ImageRef) => Promise<string | undefined>) | null,
	): Promise<string> {
		const { renderer, captured } = makeRenderer({ resolveImageRef });
		await renderer.generateLiveCard(i);
		return captured[0] ?? "";
	}

	/**
	 * 拓展直播自己带着头像引用(`liveCardInputFromReport`),卡上照画。B 站那条到 3a 之前不给(㉒b),头像块整块收起。
	 * 验红:把头像块改回无条件画,「没有头像」几条红;让 `buildLiveCardView` 不再解析 `creator.avatar`,这条红。
	 */
	it("主播头像是引用且解析到了:头像块与那张 <img> 都画,地址是解析结果", async () => {
		const out = await html(input());
		expect(out).toContain('data-block="creatorAvatar"');
		expect(out).toContain(`src="${FACE}" alt="主播头像"`);
	});

	it("输入没给头像:头像块整块不画(没有裂图),别的块照画", async () => {
		const noAvatar = input({ creator: { name: "示例主播" } });
		const out = await html(noAvatar);
		expect(out).not.toContain('data-block="creatorAvatar"');
		expect(out).not.toContain('data-cell="creatorAvatar"');
		expect(out).not.toContain('alt="主播头像"');
		const d = await drawn({ ...noAvatar, status: "end" });
		expect(d.creatorName).toBe("示例主播");
		expect(d.time).toBe("开播时间：2026-09-13 20:00:00");
		expect(d.title).toBe("一场直播");
		expect(d.creatorAvatar).toBeUndefined();
	});

	/** 头像的引用指着的图已经被清扫了:一张图坏了不拖累整张卡,头像块收起,不画裂图。 */
	it("头像引用解析不到(回 undefined / 抛错 / 没注入解析口):头像块收起,卡照出", async () => {
		for (const resolve of [
			async () => undefined,
			async () => {
				throw new Error("读盘失败");
			},
			null,
		]) {
			const out = await html(input(), resolve);
			expect(out).not.toContain('data-block="creatorAvatar"');
			expect(out).toContain("示例主播");
		}
	});

	/** 皮肤契约的 `creator.avatar` 字段留着(字段表只增不删):有头像是地址,没有是空串。 */
	it("皮肤契约:creator.avatar 有头像是地址、没有是空串", async () => {
		const upFace = async (i: LiveCardInput): Promise<string> => {
			const { renderer, captured } = makeRenderer({
				resolveCardSkin: (id) => (id === "face-probe" ? FACE_PROBE : undefined),
			});
			await renderer.generateLiveCard(i, { cardSkin: "face-probe" });
			return /头像\[([^\]]*)\]/.exec(captured[0] ?? "")?.[1] ?? "(没找到探针)";
		};
		expect(await upFace(input())).toBe(FACE);
		expect(await upFace(input({ creator: { name: "示例主播" } }))).toBe("");
	});
});
