/**
 * **直播卡的中立入口**(ADR-0019 决策 68 / 76):`generateNeutralLiveCard(input)` 吃一份中立的
 * 直播卡输入,不收任何平台的原始结构,状态明写。B 站那条(`generateLiveCard`)是它前面的
 * 适配层,另由 `live-card-bili.test.ts` 钉着。这里钉的是:
 *
 * 1. 默认块在每种状态下画出的文字 —— 下播卡是「点赞 + 累计观看人数」,粉丝数变化不上默认卡
 *    (决策 76);没有的格子那一行不画;
 * 2. 卡上那句时间由开播时刻算(北京时间);数字排成「1.2万」,粉丝数变化带正负号;
 * 3. 皮肤契约的直播取值(下播时 `stats.popularity` = 点赞、`stats.fans` = 累计观看,
 *    `stats.fansChanged` 有就给);
 * 4. 自定义直播封面盖在输入的封面上;
 * 5. 没有真封面时封面格画 BN 自带的占位图,契约的 `live.cover` 同样给它、`live.hasCover` 为假。
 */

import type { CardSkinManifest, ServiceContext } from "@bilibili-notify/internal";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ImageRenderer } from "../image-renderer";
import { LIVE_COVER_PLACEHOLDER } from "../live-view";
import type { PuppeteerLike } from "../puppeteer";
import type { LiveCardInput } from "../templates/live-card";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
};

function makeRenderer(
	opts: {
		resolveAsset?: (id: string) => Promise<string>;
		resolveCardSkin?: (id: string) => CardSkinManifest | undefined;
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
		resolveCardSkin: opts.resolveCardSkin,
	});
	return { renderer, captured };
}

const COVER = "data:image/png;base64,COVER";

/** 北京时间 2026-09-13 20:00:00。 */
const STARTED_AT = Date.parse("2026-09-13T12:00:00Z");

function input(over: Partial<LiveCardInput> = {}): LiveCardInput {
	return {
		status: "streaming",
		author: { name: "示例主播", face: "data:image/png;base64,FACE" },
		title: "一场直播",
		area: "虚拟主播",
		description: "纯文本简介",
		cover: COVER,
		startedAt: STARTED_AT,
		online: 12_345,
		likes: 20_133,
		totalViewers: 31_200,
		fans: 88_800,
		fansChanged: 1_234,
		...over,
	};
}

/** 默认皮肤画出的整张卡里,每一块的文字(封面取 src)。块没画就不在表里。 */
async function drawn(i: LiveCardInput, colorOptions = {}): Promise<Record<string, string>> {
	const { renderer, captured } = makeRenderer({
		resolveAsset: async (id) => `data:image/png;base64,ASSET-${id}`,
	});
	await renderer.generateNeutralLiveCard(i, colorOptions);
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

describe("generateNeutralLiveCard — 默认块在各状态画出的文字", () => {
	it("开播:「直播中」角标、开播时间(北京时间)、人气 + 当前粉丝数", async () => {
		const d = await drawn(input({ status: "start" }));
		expect(d.status).toBe("直播中");
		expect(d.time).toBe("开播时间：2026-09-13 20:00:00");
		expect(d.popularity).toBe("人气：1.2万");
		expect(d.fans).toBe("当前粉丝数：8.9万");
		expect(d.cover).toBe(COVER);
	});

	it("直播中:直播时长由开播时刻算", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(STARTED_AT + (2 * 3600 + 13 * 60 + 5) * 1000);
		const d = await drawn(input({ status: "streaming" }));
		expect(d.status).toBe("直播中");
		expect(d.time).toBe("直播时长：2小时13分5秒");
		expect(d.popularity).toBe("人气：1.2万");
		expect(d.fans).toBe("当前粉丝数：8.9万");
	});

	/**
	 * 决策 76:下播卡的数据区是「点赞 + 累计观看人数」—— 下播那一刻的人气是散场时的在线
	 * 人数,概括不了这一场。粉丝数变化不上默认卡(它进下播文案)。
	 */
	it("下播:「已下播」角标、点赞 + 累计观看人数;粉丝数变化不画", async () => {
		const d = await drawn(input({ status: "end" }));
		expect(d.status).toBe("已下播");
		expect(d.time).toBe("开播时间：2026-09-13 20:00:00");
		expect(d.popularity).toBe("点赞：2.0万");
		expect(d.fans).toBe("累计观看人数：3.1万");
		expect(Object.values(d).join("|")).not.toContain("粉丝数变化");
		expect(Object.values(d).join("|")).not.toContain("人气");
	});

	it("没在播:「未开播」角标与那句、人气,没有粉丝行", async () => {
		const d = await drawn(input({ status: "offline" }));
		expect(d.status).toBe("未开播");
		expect(d.time).toBe("未开播");
		expect(d.popularity).toBe("人气：1.2万");
		expect(d.fans).toBeUndefined();
	});

	/** 拓展没报的格子:那一行整行不画,不留一个「点赞：」后面什么都没有。 */
	it("没有的格子那一行不画:下播没报点赞 / 累计观看,开播没报人气", async () => {
		const ended = await drawn(input({ status: "end", likes: undefined, totalViewers: undefined }));
		expect(ended.popularity).toBeUndefined();
		expect(ended.fans).toBeUndefined();

		const started = await drawn(input({ status: "start", online: undefined, fans: undefined }));
		expect(started.popularity).toBeUndefined();
		expect(started.fans).toBeUndefined();
	});

	/** 拓展可以不报分区:不留一个「分区：」后面什么都没有。B 站恒有分区。 */
	it("没有分区(没给或空串)→ 分区那一行不画", async () => {
		expect((await drawn(input({ area: undefined }))).area).toBeUndefined();
		expect((await drawn(input({ area: "" }))).area).toBeUndefined();
		expect((await drawn(input())).area).toBe("分区：虚拟主播");
	});

	it("没有开播时刻 → 不写那句时间", async () => {
		expect((await drawn(input({ status: "start", startedAt: undefined }))).time).toBe("");
		expect((await drawn(input({ status: "streaming", startedAt: undefined }))).time).toBe("");
	});

	it("平台排好的文字原样上卡(B 站的累计观看就是接口给的成品字符串)", async () => {
		const d = await drawn(input({ status: "end", totalViewers: "3.1万+" }));
		expect(d.fans).toBe("累计观看人数：3.1万+");
	});

	it("简介空着走兜底文案", async () => {
		expect((await drawn(input({ description: undefined }))).desc).toBe(
			"这个主播很懒，什么简介都没写",
		);
	});

	it("自定义直播封面盖在输入的封面上", async () => {
		const d = await drawn(input(), { liveCoverImage: "my-cover" });
		expect(d.cover).toBe("data:image/png;base64,ASSET-my-cover");
	});

	/**
	 * 拓展直播没报封面、B 站两张都没有时走到这里:从前 `<img src="">` 画成一张只剩 alt 文字的
	 * 裂图。验红:把 `buildLiveCardView` 的封面改回 `input.cover ?? ""`,这条红。
	 */
	it("没有封面(没给或空串)→ 画 BN 自带的占位图", async () => {
		expect((await drawn(input({ cover: undefined }))).cover).toBe(LIVE_COVER_PLACEHOLDER);
		expect((await drawn(input({ cover: "" }))).cover).toBe(LIVE_COVER_PLACEHOLDER);
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
		expect(LIVE_COVER_PLACEHOLDER.startsWith(prefix)).toBe(true);
		const svg = Buffer.from(LIVE_COVER_PLACEHOLDER.slice(prefix.length), "base64").toString("utf8");
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
					html: "<div>探针[{stats.popularity}|{stats.fans}|{stats.fansChanged}|{live.isStreaming}|{live.isEnded}]</div>",
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
	await renderer.generateNeutralLiveCard(i, { cardSkin: "probe" });
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
	await renderer.generateNeutralLiveCard(i, { ...colorOptions, cardSkin: "cover-probe" });
	const doc = new JSDOM(captured[0] ?? "").window.document;
	// 自定义块的 wrapper 一律挂 `data-block="custom"`(块 id 不上 DOM)。
	const probe = doc.querySelector('[data-block="custom"]');
	return {
		src: probe?.querySelector("img")?.getAttribute("src") ?? "(没找到探针)",
		hasCover: /有封面\[([^\]]*)\]/.exec(probe?.textContent ?? "")?.[1] ?? "(没找到探针)",
	};
}

describe("generateNeutralLiveCard — 皮肤契约的封面", () => {
	it("有封面:live.cover 就是它,live.hasCover 为真", async () => {
		expect(await coverContract(input())).toEqual({ src: COVER, hasCover: "true" });
	});

	it("没有真封面:live.cover 给占位图(没写 showIf 的皮肤也不裂图),live.hasCover 为假", async () => {
		expect(await coverContract(input({ cover: undefined }))).toEqual({
			src: LIVE_COVER_PLACEHOLDER,
			hasCover: "false",
		});
	});

	it("自定义封面算真封面", async () => {
		expect(
			await coverContract(input({ cover: undefined }), { liveCoverImage: "my-cover" }),
		).toEqual({ src: "data:image/png;base64,ASSET-my-cover", hasCover: "true" });
	});
});

describe("generateNeutralLiveCard — 皮肤契约的直播取值", () => {
	it("下播:popularity = 点赞、fans = 累计观看,粉丝数变化照给", async () => {
		expect(await contract(input({ status: "end" }))).toBe("2.0万|3.1万|+1234|false|true");
	});

	it("开播 / 直播中:popularity = 人气、fans = 当前粉丝数", async () => {
		expect(await contract(input({ status: "start" }))).toBe("1.2万|8.9万|+1234|true|false");
		expect(await contract(input({ status: "streaming" }))).toBe("1.2万|8.9万|+1234|true|false");
	});

	it("粉丝数变化带正负号,过万写成「万」", async () => {
		expect(await contract(input({ status: "end", fansChanged: 12_345 }))).toContain("|+1.2万|");
		expect(await contract(input({ status: "end", fansChanged: -35 }))).toContain("|-35|");
		expect(await contract(input({ status: "end", fansChanged: -12_345 }))).toContain("|-1.2万|");
	});
});
