/**
 * **B 站直播卡的适配层**(`generateLiveCard`,ADR-0019 决策 68):签名不动,把接口数据翻成
 * 中立的直播卡输入再交给中立入口。这里钉的是「翻过去之后卡上画出来的」—— 每种状态码画成
 * 哪个角标、哪句时间、哪张封面、数据区哪几行,以及简介剥成纯文本、数字排成「1.2万」。
 *
 * 走出厂默认皮肤出整张卡,按块的 wrapper(`data-block`)取每一块的文字 —— 块怎么排是皮肤的
 * 事,这里只问每块画了什么。图一律 data URL:测试不许联网。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ImageRenderer } from "../image-renderer";
import { LIVE_COVER_PLACEHOLDER } from "../live-view";
import type { PuppeteerLike } from "../puppeteer";
import type { LiveData } from "../types";

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
};

function makeRenderer(resolveAsset: (id: string) => Promise<string> = async () => "") {
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
		resolveAsset,
		resolveFontFace: async () => "",
	});
	return { renderer, captured };
}

const USER_COVER = "data:image/png;base64,USER-COVER";
const KEYFRAME = "data:image/png;base64,KEYFRAME";
const FACE = "data:image/png;base64,FACE";

/** B 站直播间接口里卡片会读的那几格。 */
const ROOM = {
	title: "周年庆典特别直播",
	area_name: "虚拟主播",
	user_cover: USER_COVER,
	keyframe: KEYFRAME,
	description: "<p>每晚八点开播&nbsp;&amp;&nbsp;周末加场</p><br>&lt;b&gt;见动态&lt;/b&gt;",
	online: 12_345,
	live_time: "2026-09-13 20:00:00",
};

/** 直播引擎攒下的那几个数:点赞与粉丝是数字,累计观看是接口给的成品字符串。 */
const LIVE_DATA: LiveData = {
	likedNum: 20_133,
	watchedNum: "3.1万",
	fansNum: 88_800,
	fansChanged: 1_234,
};

/** 一张卡上每一块画出的文字(封面取 src)。块没画就不在表里。 */
interface Drawn {
	status?: string;
	time?: string;
	cover?: string;
	desc?: string;
	popularity?: string;
	area?: string;
	fans?: string;
}

function drawn(html: string): Drawn {
	const doc = new JSDOM(html).window.document;
	const text = (block: string) =>
		doc.querySelector(`[data-block="${block}"]`)?.textContent?.trim() ?? undefined;
	const out: Drawn = {
		status: text("status"),
		time: text("time"),
		cover: doc.querySelector('[data-block="cover"] img')?.getAttribute("src") ?? undefined,
		desc: text("desc"),
		popularity: text("popularity"),
		area: text("area"),
		fans: text("fans"),
	};
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Drawn;
}

async function bili(
	liveStatus: number,
	room: Record<string, unknown> = ROOM,
	liveData: LiveData = LIVE_DATA,
): Promise<Drawn> {
	const { renderer, captured } = makeRenderer();
	await renderer.generateLiveCard(room, "示例主播", FACE, liveData, liveStatus);
	return drawn(captured[0] ?? "");
}

afterEach(() => {
	vi.useRealTimers();
});

describe("generateLiveCard — B 站的状态码翻成卡上的样子", () => {
	it("1 开播:「直播中」角标、开播时间、房间封面、人气 + 当前粉丝数", async () => {
		expect(await bili(1)).toEqual({
			status: "直播中",
			time: "开播时间：2026-09-13 20:00:00",
			cover: USER_COVER,
			// 富文本剥成纯文本:标签与 entity 都去掉(entity 解出来的 `<b>` 也当标签剥)。
			desc: "每晚八点开播 & 周末加场 见动态",
			popularity: "人气：1.2万",
			area: "分区：虚拟主播",
			fans: "当前粉丝数：8.9万",
		});
	});

	it("2 直播中:「直播中」角标、直播时长(按北京时间算)、关键帧", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// 北京时间 2026-09-13 22:13:05 —— 开播两小时十三分五秒。
		vi.setSystemTime(new Date("2026-09-13T14:13:05Z"));
		const d = await bili(2);
		expect(d.status).toBe("直播中");
		expect(d.time).toBe("直播时长：2小时13分5秒");
		expect(d.cover).toBe(KEYFRAME);
		expect(d.popularity).toBe("人气：1.2万");
		expect(d.fans).toBe("当前粉丝数：8.9万");
	});

	/**
	 * 决策 76:下播卡的数据区从「人气 + 累计观看人数」换成「点赞 + 累计观看人数」;粉丝数变化
	 * 不上默认卡(它进下播文案)。从前的「点赞 + 粉丝数变化」那一支判的是 3,可 3 在出卡入口
	 * 早被压成了「已下播」角标用的 2,那一支从来没画出来过。
	 */
	it("3 下播:「已下播」角标、开播时间、房间封面、点赞 + 累计观看人数,粉丝数变化不画", async () => {
		const d = await bili(3);
		expect(d.status).toBe("已下播");
		expect(d.time).toBe("开播时间：2026-09-13 20:00:00");
		expect(d.cover).toBe(USER_COVER);
		expect(d.popularity).toBe("点赞：2.0万");
		expect(d.fans).toBe("累计观看人数：3.1万");
		expect(Object.values(d).join("|")).not.toContain("粉丝数变化");
	});

	it("0 没在播(私聊指令查一个没开播的房间):「未开播」角标与那句、人气,没有粉丝行", async () => {
		const d = await bili(0);
		expect(d.status).toBe("未开播");
		expect(d.time).toBe("未开播");
		expect(d.cover).toBe(USER_COVER);
		expect(d.popularity).toBe("人气：1.2万");
		expect(d.fans).toBeUndefined();
	});

	it("其余状态码(今天没有调用方传,比如 4):「直播中」角标、不写那句时间、房间封面", async () => {
		const d = await bili(4);
		expect(d.status).toBe("直播中");
		expect(d.time).toBe("");
		expect(d.cover).toBe(USER_COVER);
	});

	/**
	 * 两张互相兜底:没开播时 B 站给的关键帧是空串(卡片页「按 UP 预览」拿没在播的房间选直播中
	 * 就是这样),刚开播时关键帧也还没生成 —— 从前那一格画成一张只剩 alt 文字的裂图。
	 * 验红:把 `biliLiveCardInput` 的封面改回只取一张,这几条红。
	 */
	it("直播中却没有关键帧(空串或缺)→ 退到房间封面", async () => {
		expect((await bili(2, { ...ROOM, keyframe: "" })).cover).toBe(USER_COVER);
		expect((await bili(2, { ...ROOM, keyframe: undefined })).cover).toBe(USER_COVER);
	});

	it("开播 / 下播 / 没在播却没有房间封面 → 退到关键帧", async () => {
		for (const status of [1, 3, 0, 4]) {
			expect((await bili(status, { ...ROOM, user_cover: "" })).cover, `状态 ${status}`).toBe(
				KEYFRAME,
			);
		}
	});

	it("两张都没有 → 画 BN 自带的占位图,不是空的 src", async () => {
		for (const status of [2, 1]) {
			const d = await bili(status, { ...ROOM, keyframe: "", user_cover: "" });
			expect(d.cover, `状态 ${status}`).toBe(LIVE_COVER_PLACEHOLDER);
		}
	});

	it("没有粉丝数:开播卡不画粉丝行", async () => {
		const d = await bili(1, ROOM, { ...LIVE_DATA, fansNum: undefined });
		expect(d.fans).toBeUndefined();
	});
});
