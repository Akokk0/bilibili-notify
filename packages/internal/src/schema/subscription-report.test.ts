/**
 * 订阅源拓展的五种上报(ADR-0019 决策 55 / 56 / 57 / 62)—— 三种**事件**(作品 / 开播 / 下播)与两种
 * **不触发推送**的上报(资料更新 / 直播状态)。宿主收下之前先过 `checkSubscriptionReport`,规矩全在它
 * 身上(决策 59):
 *
 * - **不认识的字段整条拒**(只可能是拓展照更新的契约写的);
 * - **必填坏了整条拒**;
 * - **认识的选填格值坏了只丢那一格**(一张图解不开、互动数为负 —— 平台那边真会发生,主人宁可收一张
 *   少一张图的卡),并说清丢了什么、为什么;
 * - **作品正文与视频标题太长不算坏**:截到上限收下,同样说一句「已截断」(决策 59 的 09-24 🔗)。
 *
 * 另外两条宿主在收下之前也要问的:报的种类清单里声明了没有、报的外部 id 像不像样。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	checkReportedExternalId,
	checkSubscriptionReport,
	readImageSize,
	SUBSCRIPTION_AVATAR_MAX_BYTES,
	SUBSCRIPTION_POST_IMAGES_MAX,
	SUBSCRIPTION_POST_TOPIC_MAX,
	SUBSCRIPTION_POST_TOPICS_MAX,
	SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES,
	SUBSCRIPTION_REPORT_IMAGES_TOTAL_MAX_BYTES,
	SUBSCRIPTION_REPORT_TEXT_MAX,
	SUBSCRIPTION_REPORT_TITLE_MAX,
	sniffImageFormat,
	undeclaredReportReason,
} from "./subscription-report";

// ---- 几种图的字节:只有文件头是真的,后面随便填 ----------------------------------------

const MAGIC = {
	png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	jpeg: [0xff, 0xd8, 0xff, 0xe0],
	webp: [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")],
	gif: [...Buffer.from("GIF89a")],
	svg: [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
} as const;

/** 一张 `format` 格式的「图」,总长 `size` 字节(至少是文件头那么长)。 */
function image(format: keyof typeof MAGIC, size = 32): Uint8Array {
	const head = MAGIC[format];
	const bytes = new Uint8Array(Math.max(size, head.length));
	bytes.set(head);
	return bytes;
}

const MiB = 1024 * 1024;
const T = Date.UTC(2026, 8, 23, 12, 0, 0);

const POST = {
	id: "7400000000000000001",
	url: "https://www.douyin.com/video/7400000000000000001",
	publishedAt: T,
};

function dropped(kind: Parameters<typeof checkSubscriptionReport>[0], raw: unknown): string[] {
	const r = checkSubscriptionReport(kind, raw);
	if (!r.ok) throw new Error(`应该收下(丢格),却整条拒了:${r.reason}`);
	return r.dropped;
}

function rejected(kind: Parameters<typeof checkSubscriptionReport>[0], raw: unknown): string {
	const r = checkSubscriptionReport(kind, raw);
	if (r.ok) throw new Error(`应该整条拒,却收下了(丢了:${r.dropped.join(";") || "无"})`);
	return r.reason;
}

describe("作品(post):字段表照决策 55", () => {
	it("只有必填三格:原样收下,什么都没丢", () => {
		const r = checkSubscriptionReport("post", POST);
		expect(r).toEqual({ ok: true, value: POST, dropped: [] });
	});

	it("每一格都给齐:全收下,图还是图(Uint8Array)", () => {
		const cover = image("jpeg");
		const avatar = image("webp");
		const full = {
			...POST,
			text: "第一行\n#话题 照字面",
			images: [image("png"), image("jpeg"), image("webp"), image("gif")],
			video: { cover, title: "标题", duration: 61.5, description: "简介", plays: 12 },
			stats: { likes: 3, comments: 0, shares: 1 },
			author: { name: "作者", avatar },
		};
		const r = checkSubscriptionReport("post", full);
		expect(r.ok && r.dropped).toEqual([]);
		if (!r.ok) return;
		expect(r.value).toEqual(full);
		expect(r.value.images?.[0]).toBeInstanceOf(Uint8Array);
		expect(r.value.video?.cover).toBeInstanceOf(Uint8Array);
	});

	it("收下的图是 BN 自己的一份:拓展之后再改它那几块字节,BN 手里的不跟着变", () => {
		const picture = image("png");
		const r = checkSubscriptionReport("post", { ...POST, images: [picture] });
		if (!r.ok) throw new Error(r.reason);
		picture[0] = 0;
		expect(r.value.images?.[0]?.[0]).toBe(0x89);
	});

	it("Buffer 也是 Uint8Array,照收", () => {
		const r = checkSubscriptionReport("post", { ...POST, images: [Buffer.from(image("png"))] });
		expect(r.ok && r.dropped).toEqual([]);
	});
});

describe("不认识的字段:整条拒,点名是哪一格", () => {
	it("顶层多一格", () => {
		expect(rejected("post", { ...POST, repost: { id: "1" } })).toContain("repost");
	});

	it("嵌在选填格里的也算 —— 不是只丢那一格", () => {
		expect(rejected("post", { ...POST, video: { title: "t", danmaku: 3 } })).toContain(
			"video.danmaku",
		);
		expect(rejected("post", { ...POST, stats: { likes: 1, collects: 2 } })).toContain(
			"stats.collects",
		);
	});
});

describe("必填:缺了 / 坏了都整条拒,原因点名", () => {
	it("缺 url", () => {
		const { url: _url, ...rest } = POST;
		expect(rejected("post", rest)).toMatch(/缺.*url/);
	});

	it("url 不是 http(s) 地址", () => {
		expect(rejected("post", { ...POST, url: "javascript:alert(1)" })).toMatch(/url.*http/);
	});

	it("作品 id 是空串", () => {
		expect(rejected("post", { ...POST, id: "" })).toMatch(/id.*空/);
	});

	it("时间交成了秒(平台接口常见的那种)", () => {
		expect(rejected("post", { ...POST, publishedAt: Math.floor(T / 1000) })).toMatch(
			/publishedAt.*秒/,
		);
	});

	it("时间不是整数毫秒", () => {
		expect(rejected("post", { ...POST, publishedAt: new Date(T).toISOString() })).toContain(
			"publishedAt",
		);
	});

	it("整条不是对象", () => {
		expect(rejected("post", "hello")).toMatch(/对象/);
		expect(rejected("post", null)).toMatch(/对象/);
		expect(rejected("post", [POST])).toMatch(/对象/);
	});
});

describe("选填:值坏了只丢那一格,其余照收,原因写清", () => {
	it("互动数为负:只丢那一个数", () => {
		const r = checkSubscriptionReport("post", { ...POST, stats: { likes: -1, comments: 2 } });
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.stats).toEqual({ comments: 2 });
		expect(r.dropped).toEqual([expect.stringMatching(/stats\.likes.*负/)]);
	});

	it("互动数不是整数 / 不是数", () => {
		expect(dropped("post", { ...POST, stats: { shares: 1.5 } })).toEqual([
			expect.stringMatching(/stats\.shares.*整数/),
		]);
		expect(dropped("post", { ...POST, stats: { shares: "12" } })).toEqual([
			expect.stringContaining("stats.shares"),
		]);
	});

	// 决策 59 的 09-24 🔗:作品正文与视频标题**太长不算坏** —— 截到上限收下,问题框里记一条「截断」。整格丢掉
	// 的话关键词屏蔽看到的是空串,含屏蔽词的长文照推,卡上也没了正文。
	it("正文超长:截到上限收下,记一条「已截断」", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			text: "字".repeat(SUBSCRIPTION_REPORT_TEXT_MAX + 1),
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.text).toBe("字".repeat(SUBSCRIPTION_REPORT_TEXT_MAX));
		expect(r.dropped).toEqual([`text:超过 ${SUBSCRIPTION_REPORT_TEXT_MAX} 字,已截断`]);
	});

	it("视频标题超长:截到上限收下,记一条「已截断」", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			video: { title: "题".repeat(SUBSCRIPTION_REPORT_TITLE_MAX + 5), plays: 3 },
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.video).toEqual({ title: "题".repeat(SUBSCRIPTION_REPORT_TITLE_MAX), plays: 3 });
		expect(r.dropped).toEqual([`video.title:超过 ${SUBSCRIPTION_REPORT_TITLE_MAX} 字,已截断`]);
	});

	it("截口正落在一个 emoji 中间:少截一个字,不把它劈成两半", () => {
		const MAX = SUBSCRIPTION_REPORT_TEXT_MAX;
		// 😀 占两个 UTF-16 单元(上限也按这个单位数):第 MAX 个单元是它的前一半。
		const straddling = checkSubscriptionReport("post", {
			...POST,
			text: `${"字".repeat(MAX - 1)}😀尾`,
		});
		if (!straddling.ok) throw new Error(straddling.reason);
		expect(straddling.value.text).toBe("字".repeat(MAX - 1));
		// 正好装得下它:照留。
		const fits = checkSubscriptionReport("post", { ...POST, text: `${"字".repeat(MAX - 2)}😀尾` });
		if (!fits.ok) throw new Error(fits.reason);
		expect(fits.value.text).toBe(`${"字".repeat(MAX - 2)}😀`);
	});

	it("正好在上限上:不截、不记", () => {
		const text = "字".repeat(SUBSCRIPTION_REPORT_TEXT_MAX);
		expect(checkSubscriptionReport("post", { ...POST, text })).toEqual({
			ok: true,
			value: { ...POST, text },
			dropped: [],
		});
	});

	it("只有正文与视频标题截断:别的长文本超长照旧丢那一格,正文不是字符串照旧丢", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			video: { description: "简".repeat(SUBSCRIPTION_REPORT_TEXT_MAX + 1) },
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.video).toEqual({});
		expect(r.dropped).toEqual([
			expect.stringMatching(
				new RegExp(`^video\\.description:超过 ${SUBSCRIPTION_REPORT_TEXT_MAX} 字$`),
			),
		]);
		const live = checkSubscriptionReport("liveStart", {
			url: "https://live.douyin.com/1",
			startedAt: T,
			title: "题".repeat(SUBSCRIPTION_REPORT_TITLE_MAX + 1),
		});
		if (!live.ok) throw new Error(live.reason);
		expect(live.value.title).toBeUndefined();
		expect(dropped("post", { ...POST, text: 42 })).toEqual([expect.stringMatching(/^text:/)]);
	});

	it("一组选填格整个不是对象:丢那一组", () => {
		const r = checkSubscriptionReport("post", { ...POST, video: "不是对象" });
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.video).toBeUndefined();
		expect(r.dropped).toEqual([expect.stringMatching(/video.*对象/)]);
	});

	it("组里坏一格只丢那一格:视频时长为负,标题照收", () => {
		const r = checkSubscriptionReport("post", { ...POST, video: { title: "t", duration: -3 } });
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.video).toEqual({ title: "t" });
		expect(r.dropped).toEqual([expect.stringContaining("video.duration")]);
	});

	it("值是 undefined 的选填格当没给", () => {
		expect(checkSubscriptionReport("post", { ...POST, text: undefined })).toEqual({
			ok: true,
			value: POST,
			dropped: [],
		});
	});

	it("丢了几格就记几条", () => {
		expect(
			dropped("post", {
				...POST,
				text: 3,
				stats: { likes: -1, comments: -1 },
				author: { name: "" },
			}),
		).toHaveLength(4);
	});
});

describe("作品的图:png / jpeg / webp / gif,按文件头认", () => {
	it("认得的四种都收,SVG 与认不出的丢掉那一张,点名第几张", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			images: [image("png"), image("svg"), image("gif"), new Uint8Array([1, 2, 3]), image("webp")],
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.images).toHaveLength(3);
		expect(r.dropped).toEqual([
			expect.stringMatching(/images\[1\].*png \/ jpeg \/ webp \/ gif/),
			expect.stringContaining("images[3]"),
		]);
	});

	it("不是 Uint8Array(交了 data URL / 地址)的丢掉", () => {
		expect(dropped("post", { ...POST, images: ["https://p3.douyinpic.com/x.webp"] })).toEqual([
			expect.stringMatching(/images\[0\].*Uint8Array/),
		]);
	});

	it(`单张超过 ${SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES / MiB} MiB 的丢掉那一张`, () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			images: [image("png", SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES + 1), image("png")],
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.images).toHaveLength(1);
		expect(r.dropped).toEqual([expect.stringMatching(/images\[0\].*8 MiB/)]);
		// 正好卡在上限的照收。
		expect(
			dropped("post", { ...POST, images: [image("png", SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES)] }),
		).toEqual([]);
	});

	it(`超过 ${SUBSCRIPTION_POST_IMAGES_MAX} 张:前 ${SUBSCRIPTION_POST_IMAGES_MAX} 张照收,多出来的丢掉`, () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			images: Array.from({ length: SUBSCRIPTION_POST_IMAGES_MAX + 2 }, () => image("jpeg")),
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.images).toHaveLength(SUBSCRIPTION_POST_IMAGES_MAX);
		expect(r.dropped).toEqual([
			expect.stringMatching(new RegExp(`images.*${SUBSCRIPTION_POST_IMAGES_MAX}.*2 张`)),
		]);
	});

	it("整条上报的图加起来有上限:装不下的那几张丢掉", () => {
		const big = image("png", SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES);
		const fit = SUBSCRIPTION_REPORT_IMAGES_TOTAL_MAX_BYTES / SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES;
		const r = checkSubscriptionReport("post", {
			...POST,
			images: Array.from({ length: fit + 1 }, () => big),
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.images).toHaveLength(fit);
		expect(r.dropped).toEqual([
			expect.stringMatching(
				new RegExp(`images\\[${fit}\\].*${SUBSCRIPTION_REPORT_IMAGES_TOTAL_MAX_BYTES / MiB} MiB`),
			),
		]);
	});

	it("images 不是数组:丢这一格", () => {
		expect(dropped("post", { ...POST, images: image("png") })).toEqual([
			expect.stringMatching(/images.*数组/),
		]);
	});

	it("视频封面同一条:SVG 丢掉", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			video: { cover: image("svg"), title: "t" },
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.video).toEqual({ title: "t" });
		expect(r.dropped).toEqual([expect.stringContaining("video.cover")]);
	});
});

describe("作品的话题(topics):话题名的列表,第一个上卡当标签", () => {
	it("原样收下,次序不变", () => {
		const r = checkSubscriptionReport("post", { ...POST, topics: ["城市散步", "vlog"] });
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.topics).toEqual(["城市散步", "vlog"]);
		expect(r.dropped).toEqual([]);
	});

	/** 平台接口常把 `#` 连着名字一起给(`#旅行#`、`#旅行`),BN 收的是名字本身。 */
	it("名字两头的 # 与空白先剥掉,中间的原样", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			topics: ["#旅行#", " #城市 散步 ", "C#", "##我的#日记##"],
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.topics).toEqual(["旅行", "城市 散步", "C", "我的#日记"]);
		expect(r.dropped).toEqual([]);
	});

	it("剥完空了的、不是字符串的只丢那一项,点名第几项;其余照收", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			topics: ["旅行", "##", "  ", 42, "美食"],
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.topics).toEqual(["旅行", "美食"]);
		expect(r.dropped).toEqual([
			expect.stringMatching(/^topics\[1\]:.*空/),
			expect.stringMatching(/^topics\[2\]:.*空/),
			expect.stringMatching(/^topics\[3\]:.*字符串/),
		]);
	});

	it(`超过 ${SUBSCRIPTION_POST_TOPIC_MAX} 字的只丢那一项;字数按剥掉 # 之后数`, () => {
		const longest = "长".repeat(SUBSCRIPTION_POST_TOPIC_MAX);
		const r = checkSubscriptionReport("post", {
			...POST,
			topics: [`${longest}长`, `#${longest}#`],
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.topics).toEqual([longest]);
		expect(r.dropped).toEqual([
			expect.stringMatching(new RegExp(`^topics\\[0\\]:.*${SUBSCRIPTION_POST_TOPIC_MAX} 字`)),
		]);
	});

	/** 重复的不是坏值(卡上什么都不少),不进上报问题。按剥完的名字认:`#旅行#` 与 `旅行` 是同一个。 */
	it("去重:留第一次出现的那个,次序不变,不算丢格", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			topics: ["旅行", "美食", "#旅行#", "美食", "vlog"],
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.topics).toEqual(["旅行", "美食", "vlog"]);
		expect(r.dropped).toEqual([]);
	});

	it(`超过 ${SUBSCRIPTION_POST_TOPICS_MAX} 个:前 ${SUBSCRIPTION_POST_TOPICS_MAX} 个照收,多出来的丢掉、说是几个`, () => {
		const names = Array.from({ length: SUBSCRIPTION_POST_TOPICS_MAX + 3 }, (_, i) => `话题${i}`);
		const r = checkSubscriptionReport("post", { ...POST, topics: names });
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.topics).toEqual(names.slice(0, SUBSCRIPTION_POST_TOPICS_MAX));
		expect(r.dropped).toEqual([
			`topics[${SUBSCRIPTION_POST_TOPICS_MAX}] 起:最多 ${SUBSCRIPTION_POST_TOPICS_MAX} 个,多出来的 3 个丢了`,
		]);
	});

	it("topics 不是数组:丢这一格", () => {
		expect(dropped("post", { ...POST, topics: "旅行" })).toEqual([
			expect.stringMatching(/^topics:.*数组/),
		]);
	});
});

describe("头像(作者 / 资料更新):只收 png / jpeg / webp,不收 gif 与 SVG", () => {
	it("作者头像是 gif:只丢头像,名字照收", () => {
		const r = checkSubscriptionReport("post", {
			...POST,
			author: { name: "作者", avatar: image("gif") },
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.value.author).toEqual({ name: "作者" });
		expect(r.dropped).toEqual([expect.stringMatching(/author\.avatar.*png \/ jpeg \/ webp/)]);
	});

	it("资料更新的头像:svg 丢掉,webp 照收", () => {
		expect(dropped("profile", { avatar: image("svg") })).toEqual([
			expect.stringContaining("avatar"),
		]);
		expect(dropped("profile", { avatar: image("webp") })).toEqual([]);
	});

	it("头像超过上限的丢掉 —— 与候选头像那把尺子同一口径", () => {
		expect(dropped("profile", { avatar: image("png", SUBSCRIPTION_AVATAR_MAX_BYTES + 1) })).toEqual(
			[expect.stringContaining("avatar")],
		);
		expect(dropped("profile", { avatar: image("png", SUBSCRIPTION_AVATAR_MAX_BYTES) })).toEqual([]);
		// 这么多字节编成 data URL,正好过得了候选头像那道字数上限(存头像文件走的是那一道)。
		const dataUrl = `data:image/jpeg;base64,${Buffer.alloc(SUBSCRIPTION_AVATAR_MAX_BYTES).toString("base64")}`;
		expect(dataUrl.length).toBeLessThanOrEqual(128 * 1024);
	});
});

describe("开播(liveStart)/ 下播(liveEnd):字段表照决策 56", () => {
	const LIVE = { url: "https://live.douyin.com/123", startedAt: T };

	it("开播:url 与开播时刻必填,别的都选填", () => {
		const full = {
			...LIVE,
			title: "标题",
			cover: image("jpeg"),
			category: "游戏",
			viewers: 100,
			totalViewers: 3_456,
			likes: 5,
			description: "简介",
			author: { name: "主播" },
		};
		expect(checkSubscriptionReport("liveStart", full)).toEqual({
			ok: true,
			value: full,
			dropped: [],
		});
		expect(rejected("liveStart", { url: LIVE.url })).toMatch(/缺.*startedAt/);
	});

	it("下播:只有 url 必填;开播时刻坏了只丢它", () => {
		expect(checkSubscriptionReport("liveEnd", { url: LIVE.url })).toEqual({
			ok: true,
			value: { url: LIVE.url },
			dropped: [],
		});
		expect(dropped("liveEnd", { url: LIVE.url, startedAt: 1 })).toEqual([
			expect.stringContaining("startedAt"),
		]);
		expect(rejected("liveEnd", { startedAt: T })).toMatch(/缺.*url/);
	});

	it("不收的那些(人气值 / 粉丝数 / 短号……)算不认识的字段", () => {
		expect(rejected("liveStart", { ...LIVE, fans: 3 })).toContain("fans");
		expect(rejected("liveEnd", { url: LIVE.url, online: 3 })).toContain("online");
	});

	it("人数为负只丢人数", () => {
		expect(dropped("liveStart", { ...LIVE, viewers: -1 })).toEqual([
			expect.stringMatching(/viewers.*负/),
		]);
	});
});

/**
 * 直播人数是两格(决策 75):`viewers` 此刻在线、`totalViewers` 本场累计观看,都选填、平台有哪个报哪个。
 * 两格各管各的:一格坏了只丢它,另一格照收。
 */
describe("直播人数:此刻在线与本场累计是两格(决策 75)", () => {
	const LIVE_KINDS = [
		["liveStart", { url: "https://live.douyin.com/123", startedAt: T }],
		["liveEnd", { url: "https://live.douyin.com/123" }],
		["liveStatus", { live: true }],
	] as const;

	it.each(LIVE_KINDS)("%s:两格都收", (kind, base) => {
		const value = { ...base, viewers: 12, totalViewers: 3_456 };
		expect(checkSubscriptionReport(kind, value)).toEqual({ ok: true, value, dropped: [] });
	});

	it.each(LIVE_KINDS)("%s:只报累计也收(平台只有这一个数)", (kind, base) => {
		const value = { ...base, totalViewers: 0 };
		expect(checkSubscriptionReport(kind, value)).toEqual({ ok: true, value, dropped: [] });
	});

	it.each([
		["为负", -1, /totalViewers.*负/],
		["是小数", 1.5, /totalViewers.*整数/],
		["不是数字", "1.2万", /totalViewers.*数字/],
	] as const)("累计观看%s:只丢这一格,在线人数照收", (_label, bad, reason) => {
		for (const [kind, base] of LIVE_KINDS) {
			const r = checkSubscriptionReport(kind, { ...base, viewers: 12, totalViewers: bad });
			if (!r.ok) throw new Error(`${kind} 应该收下(丢格),却整条拒了:${r.reason}`);
			expect(r.value).toEqual({ ...base, viewers: 12 });
			expect(r.dropped).toEqual([expect.stringMatching(reason)]);
		}
	});
});

describe("直播状态(liveStatus):在不在播必填,其余同直播那张表、全选填(决策 57)", () => {
	it("只报在不在播", () => {
		expect(checkSubscriptionReport("liveStatus", { live: false })).toEqual({
			ok: true,
			value: { live: false },
			dropped: [],
		});
	});

	it("在播时带上标题 / 封面 / 在线与累计人数 / 点赞 / 开播时刻", () => {
		const status = {
			live: true,
			url: "https://live.douyin.com/123",
			startedAt: T,
			title: "t",
			cover: image("webp"),
			viewers: 1,
			totalViewers: 30,
			likes: 2,
		};
		expect(checkSubscriptionReport("liveStatus", status)).toEqual({
			ok: true,
			value: status,
			dropped: [],
		});
	});

	it("缺 live / live 不是布尔:整条拒", () => {
		expect(rejected("liveStatus", { title: "t" })).toMatch(/缺.*live/);
		expect(rejected("liveStatus", { live: "yes" })).toContain("live");
	});
});

describe("资料更新(profile):名字 / 头像 / 粉丝数都选填(决策 62)", () => {
	it("一格都不给也收(什么都没变)", () => {
		expect(checkSubscriptionReport("profile", {})).toEqual({ ok: true, value: {}, dropped: [] });
	});

	it("名字空串 / 粉丝数为负:各丢各的", () => {
		const r = checkSubscriptionReport("profile", { name: "", fans: -2, avatar: image("png") });
		if (!r.ok) throw new Error(r.reason);
		expect(Object.keys(r.value)).toEqual(["avatar"]);
		expect(r.dropped).toEqual([expect.stringContaining("name"), expect.stringMatching(/fans.*负/)]);
	});

	it("多一格整条拒", () => {
		expect(rejected("profile", { name: "n", signature: "签名" })).toContain("signature");
	});
});

describe("报的种类:清单 contributes.subscription.events 就是能力声明(决策 5 / 62)", () => {
	it("事件只收声明过的", () => {
		expect(undeclaredReportReason("post", ["post"])).toBeUndefined();
		expect(undeclaredReportReason("liveEnd", ["post", "liveStart"])).toMatch(/liveEnd/);
	});

	it("直播状态:声明了开播或下播之一才收", () => {
		expect(undeclaredReportReason("liveStatus", ["liveStart"])).toBeUndefined();
		expect(undeclaredReportReason("liveStatus", ["liveEnd"])).toBeUndefined();
		expect(undeclaredReportReason("liveStatus", ["post"])).toMatch(/liveStart.*liveEnd/);
	});

	it("资料更新总是收", () => {
		expect(undeclaredReportReason("profile", ["post"])).toBeUndefined();
	});
});

describe("报的外部 id", () => {
	it("非空字符串、不超过订阅外部 id 那把尺子", () => {
		expect(checkReportedExternalId("MS4wLjABAAAA")).toEqual({
			ok: true,
			externalId: "MS4wLjABAAAA",
		});
		expect(checkReportedExternalId("")).toMatchObject({ ok: false });
		expect(checkReportedExternalId(123)).toMatchObject({ ok: false });
		expect(checkReportedExternalId("x".repeat(257))).toMatchObject({ ok: false });
	});
});

describe("按文件头认图的格式", () => {
	it("四种位图认得出,SVG / 空的 / 残缺的认不出", () => {
		expect(sniffImageFormat(image("png"))).toBe("png");
		expect(sniffImageFormat(image("jpeg"))).toBe("jpeg");
		expect(sniffImageFormat(image("webp"))).toBe("webp");
		expect(sniffImageFormat(image("gif"))).toBe("gif");
		expect(sniffImageFormat(image("svg"))).toBeUndefined();
		expect(sniffImageFormat(new Uint8Array())).toBeUndefined();
		// 只有 RIFF 没有 WEBP 的(wav 就是这样)。
		expect(
			sniffImageFormat(
				new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]),
			),
		).toBeUndefined();
	});
});

// ---- 读宽高:按规范手搓文件头,只有决定宽高的那几个字节是真的 --------------------------------

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

function pngOf(width: number, height: number): Uint8Array {
	// 签名 + IHDR(长 13):宽、高各 4 字节大端,后面是位深 / 颜色类型等。
	return new Uint8Array([
		...MAGIC.png,
		...u32be(13),
		...Buffer.from("IHDR"),
		...u32be(width),
		...u32be(height),
		8,
		6,
		0,
		0,
		0,
	]);
}

/** JPEG:SOI、一段 APP0、一段哈夫曼表(C4 不是帧头,别认错)、帧头 `sof`,再来一截熵编码数据。 */
function jpegOf(width: number, height: number, sof = 0xc0): Uint8Array {
	const app0 = [0xff, 0xe0, ...u16be(16), ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
	const dht = [0xff, 0xc4, ...u16be(5), 0, 1, 2];
	const frame = [0xff, sof, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3];
	return new Uint8Array([
		0xff,
		0xd8,
		...app0,
		// 段与段之间允许塞填充的 0xff。
		0xff,
		...dht,
		...frame,
		...new Array(15).fill(0),
	]);
}

function webpOf(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
	const riff = (body: number[]) =>
		new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...body]);
	switch (chunk) {
		case "VP8 ":
			// 有损:3 字节帧标记 + 起始码 9d 01 2a,再是宽、高(各 14 位,小端)。
			return riff([
				...Buffer.from("VP8 "),
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0x9d,
				0x01,
				0x2a,
				...u16le(width),
				...u16le(height),
			]);
		case "VP8L": {
			// 无损:签名 0x2f,之后 4 字节小端里前 14 位是宽 - 1、再 14 位是高 - 1。
			const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
			return riff([
				...Buffer.from("VP8L"),
				0,
				0,
				0,
				0,
				0x2f,
				bits & 0xff,
				(bits >> 8) & 0xff,
				(bits >> 16) & 0xff,
				(bits >>> 24) & 0xff,
			]);
		}
		case "VP8X":
			// 扩展格式(动图 / 带透明):画布宽 - 1、高 - 1 各 3 字节小端。
			return riff([
				...Buffer.from("VP8X"),
				10,
				0,
				0,
				0,
				0x10,
				0,
				0,
				0,
				...u24le(width - 1),
				...u24le(height - 1),
			]);
	}
}

function gifOf(width: number, height: number): Uint8Array {
	return new Uint8Array([...MAGIC.gif, ...u16le(width), ...u16le(height), 0xf7, 0, 0]);
}

describe("读图的宽高(卡片的图廊判长图要用,拓展只交字节)", () => {
	it("png:IHDR 里的宽高", () => {
		expect(readImageSize(pngOf(1080, 1920))).toEqual({ width: 1080, height: 1920 });
	});

	it("jpeg:跳过 APP0 与哈夫曼表,读帧头;基线与渐进式都认", () => {
		expect(readImageSize(jpegOf(640, 480))).toEqual({ width: 640, height: 480 });
		expect(readImageSize(jpegOf(1242, 2688, 0xc2))).toEqual({ width: 1242, height: 2688 });
	});

	it("webp:有损 / 无损 / 扩展三种块都认", () => {
		expect(readImageSize(webpOf("VP8 ", 800, 600))).toEqual({ width: 800, height: 600 });
		expect(readImageSize(webpOf("VP8L", 1024, 3000))).toEqual({ width: 1024, height: 3000 });
		expect(readImageSize(webpOf("VP8X", 720, 1280))).toEqual({ width: 720, height: 1280 });
	});

	it("gif:逻辑屏幕的宽高", () => {
		expect(readImageSize(gifOf(320, 240))).toEqual({ width: 320, height: 240 });
	});

	it("读不出来就是 undefined:SVG、空的、截断的、没有帧头的、不认识的 webp 块、宽高是 0 的", () => {
		expect(readImageSize(image("svg"))).toBeUndefined();
		expect(readImageSize(new Uint8Array())).toBeUndefined();
		expect(readImageSize(pngOf(10, 10).slice(0, 20))).toBeUndefined();
		expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
		expect(readImageSize(jpegOf(640, 480).slice(0, 30))).toBeUndefined();
		const unknownChunk = webpOf("VP8 ", 8, 8);
		unknownChunk.set(Buffer.from("VP8Q"), 12);
		expect(readImageSize(unknownChunk)).toBeUndefined();
		expect(readImageSize(gifOf(0, 240))).toBeUndefined();
	});
});

describe("拓展交来的对象读起来会抛(getter / Proxy)", () => {
	it("整条拒,原因带原话 —— 不许把异常漏出去", () => {
		const hostile = {
			...POST,
			get text(): string {
				throw new Error("boom");
			},
		};
		expect(rejected("post", hostile)).toContain("boom");
	});

	it("撤销了的 Proxy(连「是不是数组」都问不得):整条拒,不往外抛", () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		expect(rejected("post", proxy)).toMatch(/抛了/);
	});
});
