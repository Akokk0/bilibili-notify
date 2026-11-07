import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
/**
 * B 站的链接解析器:认哪些链接、怎么查、交什么。
 *
 * 前半直接对着解析器的公开口(`matches` / `resolve`),协作者(B 站接口、抓图服务)是假的;
 * 后半把真解析器登进登记表、挂在真的门上,钉「B 站视频链接贴进群里」从入站帧到发出去的整条路
 * (短链、冷却、小程序卡里的链接不回……这些行为拆分之前住在门的测试里)。
 */

import type { CardColorOptions, RenderPriority } from "@bilibili-notify/image";
import type {
	ConnectionCapabilities,
	DeliveryResult,
	LinkPreviewSettings,
	NotificationPayload,
	Post,
} from "@bilibili-notify/internal";
import { fail, type ImageRef, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	createLinkPreviewer,
	type LinkPreviewer,
	type LinkReplyDestination,
} from "../../link-preview/link-previewer.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { extractGroupMessage } from "../../platforms/onebot-inbound.js";
import type { VideoRef, VideoResponse } from "../api/index.js";
import type { ImagesDeps } from "../images.js";
import { createBiliLinkResolver, QQ_MINI_APP_ID } from "../link-resolver.js";

const ADAPTER = "11111111-1111-4111-8111-111111111111";
const GROUP = 123456;
const BOT = 10000;
const SOMEONE = 20002;

const VIDEO: VideoResponse = {
	bvid: "BV1zMtU6uEEb",
	aid: 114514,
	title: "示例标题",
	pic: "http://i0.hdslb.com/bfs/archive/cover.jpg",
	desc: "示例简介",
	duration: 754,
	pubdate: 1756800000,
	tname: "日常",
	owner: { mid: 12345, name: "示例UP", face: "http://i0.hdslb.com/bfs/face/face.jpg" },
	stat: { view: 65000, danmaku: 120, reply: 30, favorite: 400, coin: 200, share: 15, like: 3000 },
};
const VIDEO_URL = "https://www.bilibili.com/video/BV1zMtU6uEEb";

/** 假抓图服务存进「图库」后回的那个引用。 */
const COVER_REF: ImageRef = `${"c".repeat(64)}.webp`;

/** 第一次调用的第一个参数;没被调过就让测试在这里死,别在后面报一串 undefined。 */
function firstArg<A extends unknown[]>(calls: A[]): A[0] {
	const call = calls[0];
	if (!call) throw new Error("expected at least one call");
	return call[0];
}

function makeResolver(video: VideoResponse = VIDEO, label: () => string = () => "B 站") {
	const fetchVideoInfo = vi.fn(async (_ref: VideoRef) => video);
	const resolveShortLink = vi.fn(async (_url: string): Promise<string | null> => null);
	/** 抓图服务的内存替身:缺省每张都抓得到;`h.fetchImage.mockResolvedValue(fail(…))` 演抓不到。 */
	const fetchImage = vi.fn<ImagesDeps["images"]["fetchImage"]>(async () => ok({ ref: COVER_REF }));
	const warn = vi.fn();
	const resolver = createBiliLinkResolver({
		get label() {
			return label();
		},
		api: { fetchVideoInfo, resolveShortLink },
		fetchImage,
		logger: { info() {}, warn, error() {}, debug() {} },
	});
	const signal = new AbortController().signal;
	return { resolver, fetchVideoInfo, resolveShortLink, fetchImage, warn, signal };
}

describe("createBiliLinkResolver · 认哪些链接", () => {
	it("认 BV、av、b23.tv 短链(带不带 https:// 都行);别的域名、长得像的域名不认", () => {
		const { resolver } = makeResolver();
		expect(resolver.matches(VIDEO_URL)).toBe(true);
		expect(resolver.matches("bilibili.com/video/BV1zMtU6uEEb")).toBe(true);
		expect(resolver.matches("https://www.bilibili.com/video/av114514")).toBe(true);
		expect(resolver.matches("https://b23.tv/abc123")).toBe(true);
		expect(resolver.matches("https://example.com/video/BV1zMtU6uEEb")).toBe(false);
		expect(resolver.matches("https://notbilibili.com/video/BV1zMtU6uEEb")).toBe(false);
		expect(resolver.matches("https://www.bilibili.com/read/cv123")).toBe(false);
	});
});

describe("createBiliLinkResolver · resolve", () => {
	it("BV 链接:取那个视频,交「投稿了视频」形态的作品、BV 号当规范 id", async () => {
		const h = makeResolver();
		const result = await h.resolver.resolve(`${VIDEO_URL}/`, h.signal);
		expect(h.fetchVideoInfo).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });
		if (!result.ok) throw new Error("应当成功");
		expect(result.canonicalId).toBe("BV1zMtU6uEEb");
		// 直接造的作品,不是伪造的 B 站原始动态:「投稿了视频」是明说的 label,不靠 archive.badge 的隐含耦合。
		expect(result.post).toEqual({
			creator: { name: "示例UP" },
			publishedAt: "2025-09-02T08:00:00.000Z",
			label: "投稿了视频",
			text: "",
			video: {
				// 封面在交出前抓进图库:渲染页不联网,只有地址的图画不出来。
				cover: { url: "http://i0.hdslb.com/bfs/archive/cover.jpg", ref: COVER_REF },
				title: "示例标题",
				description: "示例简介",
				durationSec: 754,
				views: 65000,
				danmaku: 120,
			},
			stats: { shares: 15, comments: 30, likes: 3000 },
		});
		// 抓的是图床的缩放版,带站内引用头 —— 与推送的动态卡同一条抓图路(`bilibili/images.ts`)。
		expect(h.fetchImage.mock.calls).toEqual([
			[
				"http://i0.hdslb.com/bfs/archive/cover.jpg@1280w_80q_1s.webp",
				{ headers: { Referer: "https://www.bilibili.com/" } },
			],
		]);
	});

	it("av 链接按 aid 取;规范 id 仍是接口回的 BV 号(av 与 BV 写法落到同一个视频)", async () => {
		const h = makeResolver();
		const result = await h.resolver.resolve("https://www.bilibili.com/video/av114514", h.signal);
		expect(h.fetchVideoInfo).toHaveBeenCalledWith({ aid: "114514" });
		expect(result.ok && result.canonicalId).toBe("BV1zMtU6uEEb");
	});

	it("原生分享描述:五格来自视频信息,appId 是 B 站 QQ 小程序的 appid", async () => {
		const h = makeResolver();
		const result = await h.resolver.resolve(VIDEO_URL, h.signal);
		if (!result.ok) throw new Error("应当成功");
		expect(result.nativeShare).toEqual({
			appId: QQ_MINI_APP_ID,
			title: "示例标题",
			description: "示例简介",
			imageUrl: "http://i0.hdslb.com/bfs/archive/cover.jpg",
			// B 站小程序的视频页;真卡的路径是 GetAppInfoByLink 解出来的,只带 bvid 就能开。
			pagePath: "pages/video/video?bvid=BV1zMtU6uEEb",
			webUrl: "https://www.bilibili.com/video/BV1zMtU6uEEb",
		});
	});

	it("简介太长截前 80 字(腾讯那边显示不下);空简介用 UP 名顶上", async () => {
		const long = makeResolver({ ...VIDEO, desc: `  ${"长".repeat(100)}  ` });
		const longResult = await long.resolver.resolve(VIDEO_URL, long.signal);
		expect(longResult.ok && longResult.nativeShare?.description).toBe("长".repeat(80));

		const empty = makeResolver({ ...VIDEO, desc: "   " });
		const emptyResult = await empty.resolver.resolve(VIDEO_URL, empty.signal);
		expect(emptyResult.ok && emptyResult.nativeShare?.description).toBe("示例UP");
	});

	it("b23.tv 短链先解成落地地址再取视频", async () => {
		const h = makeResolver();
		h.resolveShortLink.mockResolvedValue(`${VIDEO_URL}?share_source=copy_web`);
		const result = await h.resolver.resolve("https://b23.tv/abc123", h.signal);
		expect(h.resolveShortLink).toHaveBeenCalledWith("https://b23.tv/abc123");
		expect(h.fetchVideoInfo).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });
		expect(result.ok).toBe(true);
	});

	it("短链解不出来(不是视频 / 落到别处)回失败结果,不取视频", async () => {
		const h = makeResolver();
		h.resolveShortLink.mockResolvedValue(null);
		const result = await h.resolver.resolve("https://b23.tv/notvideo", h.signal);
		expect(result).toMatchObject({ ok: false, code: "not_found" });
		expect(h.fetchVideoInfo).not.toHaveBeenCalled();

		h.resolveShortLink.mockResolvedValue("https://www.bilibili.com/read/cv123");
		expect(await h.resolver.resolve("https://b23.tv/article", h.signal)).toMatchObject({
			ok: false,
			code: "not_found",
		});
		expect(h.fetchVideoInfo).not.toHaveBeenCalled();
	});

	it("接口失败(坏链接、风控、网络):收成失败结果、带上原话,不抛", async () => {
		const h = makeResolver();
		h.fetchVideoInfo.mockRejectedValue(new Error("获取视频信息失败(-404): 啥都木有"));
		const result = await h.resolver.resolve(VIDEO_URL, h.signal);
		expect(result).toMatchObject({
			ok: false,
			code: "unavailable",
			message: "获取视频信息失败(-404): 啥都木有",
		});

		h.resolveShortLink.mockRejectedValue(new Error("socket hang up"));
		expect(await h.resolver.resolve("https://b23.tv/abc123", h.signal)).toMatchObject({
			ok: false,
			message: "socket hang up",
		});
	});

	it("不是 B 站视频链接:回 not_found", async () => {
		const h = makeResolver();
		expect(await h.resolver.resolve("https://example.com/x", h.signal)).toMatchObject({
			ok: false,
			code: "not_found",
		});
	});

	it("封面抓不到:作品照交、封面那一格没有引用,记一条 warn", async () => {
		const h = makeResolver();
		h.fetchImage.mockResolvedValue(fail("unavailable", "连不上"));
		const result = await h.resolver.resolve(VIDEO_URL, h.signal);
		expect(result.ok && result.post.video?.cover).toEqual({
			url: "http://i0.hdslb.com/bfs/archive/cover.jpg",
		});
		expect(h.warn).toHaveBeenCalledTimes(1);
		// 地址不带参数、不带缩放后缀:报的是那张图本身。
		expect(h.warn).toHaveBeenCalledWith(
			"图片抓取失败，本张仅保留原地址",
			expect.objectContaining({
				url: "http://i0.hdslb.com/bfs/archive/cover.jpg",
				code: "unavailable",
			}),
		);
	});

	it("抓图服务自己抛了:和抓不到一样,作品照交", async () => {
		const h = makeResolver();
		h.fetchImage.mockRejectedValue(new Error("socket hang up"));
		const result = await h.resolver.resolve(VIDEO_URL, h.signal);
		expect(result.ok).toBe(true);
	});
});

// —— 真解析器挂在真的门上 ——

function groupFrame(text: string, over: Record<string, unknown> = {}) {
	return {
		post_type: "message",
		message_type: "group",
		group_id: GROUP,
		user_id: SOMEONE,
		self_id: BOT,
		message: [{ type: "text", data: { text } }],
		raw_message: text,
		...over,
	};
}

/** 接线层在 index.ts 里做的事:OneBot 帧经 adapter 归一化,再补上连接进 handleMessage。 */
async function feed(parser: LinkPreviewer, frame: Record<string, unknown>): Promise<void> {
	const msg = extractGroupMessage(frame);
	if (!msg) return;
	await parser.handleMessage({ connectionId: ADAPTER, ...msg });
}

function makeGate(over: Partial<LinkPreviewSettings> = {}, capable = false) {
	const h = makeResolver();
	const linkResolvers = createLinkResolverRegistry();
	linkResolvers.register(BILIBILI_SOURCE_KEY, h.resolver);
	const settings: LinkPreviewSettings = {
		enabled: true,
		cooldownSec: 60,
		isOnByDefault: true,
		replyForm: "image",
		byTarget: {},
		...over,
	};
	const generatePostCard = vi.fn(
		async (_post: Post, _colors?: CardColorOptions, _options?: { priority?: RenderPriority }) =>
			Buffer.from("png-bytes"),
	);
	const sent: { dest: LinkReplyDestination; payload: NotificationPayload }[] = [];
	const caps: ConnectionCapabilities = {
		atAll: { state: "unknown" },
		inbound: { state: "unknown" },
		nativeShare: { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" },
	};
	const parser = createLinkPreviewer({
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		settings: () => settings,
		linkResolvers,
		signal: h.signal,
		renderer: () => ({ generatePostCard }),
		presentation: () => ({}),
		send: async (dest, payload): Promise<DeliveryResult> => {
			sent.push({ dest, payload });
			return { ok: true, latencyMs: 1 };
		},
		policyFor: () => ({ isOn: true, replyForm: capable ? "nativeShare" : "image" }),
		capabilities: () => (capable ? caps : undefined),
	});
	return { ...h, parser, generatePostCard, sent };
}

describe("B 站链接贴进群里(真解析器 + 真的门)", () => {
	it("群里一条 BV 链接:取视频、抓封面、出图片卡、发回来源群", async () => {
		const h = makeGate();
		await feed(h.parser, groupFrame(`看这个 ${VIDEO_URL}/ 好看`));
		expect(h.fetchVideoInfo).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });
		expect(firstArg(h.generatePostCard.mock.calls).video?.cover).toEqual({
			url: "http://i0.hdslb.com/bfs/archive/cover.jpg",
			ref: COVER_REF,
		});
		expect(h.sent.map((s) => s.payload.kind)).toEqual(["image"]);
	});

	it("形式=小程序卡且连接支持:发原生分享,载荷是解析器交的描述", async () => {
		const h = makeGate({}, true);
		await feed(h.parser, groupFrame(VIDEO_URL));
		expect(h.sent.map((s) => s.payload)).toEqual([
			{
				kind: "native-share",
				appId: QQ_MINI_APP_ID,
				title: "示例标题",
				description: "示例简介",
				imageUrl: "http://i0.hdslb.com/bfs/archive/cover.jpg",
				pagePath: "pages/video/video?bvid=BV1zMtU6uEEb",
				webUrl: "https://www.bilibili.com/video/BV1zMtU6uEEb",
			},
		]);
		expect(h.generatePostCard).not.toHaveBeenCalled();
	});

	it("短链本身也吃冷却:同一条短链反复贴,那一跳只跟一次 —— 哪怕它解不出视频", async () => {
		const h = makeGate();
		h.resolveShortLink.mockResolvedValue(null);
		await feed(h.parser, groupFrame("https://b23.tv/notvideo"));
		await feed(h.parser, groupFrame("https://b23.tv/notvideo"));
		expect(h.resolveShortLink).toHaveBeenCalledTimes(1);
		expect(h.sent).toHaveLength(0);
	});

	it("短链解出来的视频与直链共用冷却:先贴短链再贴直链,只出一张", async () => {
		const h = makeGate();
		h.resolveShortLink.mockResolvedValue(VIDEO_URL);
		await feed(h.parser, groupFrame("https://b23.tv/abc123"));
		await feed(h.parser, groupFrame(VIDEO_URL));
		expect(h.sent).toHaveLength(1);
	});

	it("同一个视频换了写法(av 号、带参数)重贴:只出一张", async () => {
		const h = makeGate();
		await feed(h.parser, groupFrame(VIDEO_URL));
		await feed(h.parser, groupFrame("https://www.bilibili.com/video/av114514"));
		await feed(h.parser, groupFrame(`${VIDEO_URL}?p=2`));
		expect(h.sent).toHaveLength(1);
	});

	it("链接坏了也吃冷却:同一条坏链接反复贴,接口只被打一次", async () => {
		const h = makeGate();
		h.fetchVideoInfo.mockRejectedValue(new Error("获取视频信息失败(-404): 啥都木有"));
		await feed(h.parser, groupFrame(VIDEO_URL));
		await feed(h.parser, groupFrame(VIDEO_URL));
		expect(h.fetchVideoInfo).toHaveBeenCalledTimes(1);
		expect(h.sent).toHaveLength(0);
	});

	it("一条消息里最多解析三个链接", async () => {
		const h = makeGate({ cooldownSec: 0 });
		const text = ["BV1aaaaaaaaa", "BV1bbbbbbbbb", "BV1ccccccccc", "BV1ddddddddd"]
			.map((id) => `https://www.bilibili.com/video/${id}`)
			.join(" ");
		await feed(h.parser, groupFrame(text));
		expect(h.fetchVideoInfo.mock.calls.map(([ref]) => ref)).toEqual([
			{ bvid: "BV1aaaaaaaaa" },
			{ bvid: "BV1bbbbbbbbb" },
			{ bvid: "BV1ccccccccc" },
		]);
	});

	describe("进来的本身就是 B 站小程序卡", () => {
		/** B 站 App「分享到 QQ」发出的那张卡,链接在 meta.detail_1.qqdocurl。 */
		const MINIAPP_CARD = JSON.stringify({
			app: "com.tencent.miniapp_01",
			prompt: "[QQ小程序]哔哩哔哩",
			meta: { detail_1: { appid: "1109937557", qqdocurl: "https://b23.tv/AbCdEf" } },
		});
		const cardFrame = () =>
			groupFrame("", {
				message: [{ type: "json", data: { data: MINIAPP_CARD } }],
				raw_message: "[CQ:json,data=…]",
			});

		it("群里已经有那张卡了 → 一律不回,也不打接口", async () => {
			for (const capable of [false, true]) {
				const h = makeGate({}, capable);
				await feed(h.parser, cardFrame());
				expect(h.sent).toHaveLength(0);
				expect(h.resolveShortLink).not.toHaveBeenCalled();
				expect(h.fetchVideoInfo).not.toHaveBeenCalled();
			}
		});

		it("跳过不留痕:随后有人把同一条链接以文字贴出来,照常出卡", async () => {
			const h = makeGate();
			h.resolveShortLink.mockResolvedValue(VIDEO_URL);
			await feed(h.parser, cardFrame());
			await feed(h.parser, groupFrame("https://b23.tv/AbCdEf"));
			expect(h.sent).toHaveLength(1);
		});

		it("其它分享卡(灰色链接卡之类)不算,照常出卡", async () => {
			const h = makeGate();
			h.resolveShortLink.mockResolvedValue(VIDEO_URL);
			const card =
				'{"app":"com.tencent.structmsg","meta":{"news":{"jumpUrl":"https://b23.tv/AbCdEf"}}}';
			await feed(
				h.parser,
				groupFrame("", {
					message: [{ type: "json", data: { data: card } }],
					raw_message: "[CQ:json]",
				}),
			);
			expect(h.sent).toHaveLength(1);
		});
	});
});

it("reads the resolver label from the current source descriptor rather than its creation value", () => {
	let label = "Before";
	const { resolver } = makeResolver(VIDEO, () => label);
	expect(resolver.label).toBe("Before");
	label = "After";
	expect(resolver.label).toBe("After");
});
