/**
 * 链接解析处理器 —— 群里有人贴 B 站视频链接,机器人回一张视频卡片。
 *
 * 缝在 `handle(frame, {adapterId})`:喂一帧 OneBot 事件,看它对外做了什么
 * (取了哪个视频、喂给渲染器的动态长什么样、往哪个群发了什么),不看内部。
 * 四个协作者全是假的:配置(现读)、B 站接口、渲染器、发送。
 */

import type { VideoInfo, VideoRef } from "@bilibili-notify/api";
import type { CardColorOptions, Dynamic, RenderPriority } from "@bilibili-notify/image";
import type {
	CardBlock,
	DeliveryResult,
	LinkParsingConfig,
	NotificationPayload,
} from "@bilibili-notify/internal";
import { LINK_LIMITS, type LinkLimits } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createLinkParser, type LinkReplyDestination } from "../link-parser.js";

const ADAPTER = "11111111-1111-4111-8111-111111111111";
const GROUP = 123456;
const BOT = 10000;
const SOMEONE = 20002;

const VIDEO: VideoInfo = {
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

/** 第一次调用的第一个参数;没被调过就让测试在这里死,别在后面报一串 undefined。 */
function firstArg<A extends unknown[]>(calls: A[]): A[0] {
	const call = calls[0];
	if (!call) throw new Error("expected at least one call");
	return call[0];
}

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

/** 主人在版式编辑器里改过的动态卡版式 —— 推送的动态卡吃它,链接解析出的卡也得吃它。 */
const LAYOUT: CardBlock[] = [
	{ id: "content", type: "content", visible: true },
	{ id: "header", type: "header", visible: true, marginTop: 12 },
];

function makeParser(over: Partial<LinkParsingConfig> = {}, limits?: Partial<LinkLimits>) {
	const config: LinkParsingConfig = { enabled: true, cooldownSeconds: 60, ...over };
	const getVideoInfo = vi.fn(async (_ref: VideoRef) => VIDEO);
	const resolveShortLink = vi.fn(async (_url: string): Promise<string | null> => null);
	const generateDynamicCard = vi.fn(
		async (
			_data: Dynamic,
			_colors?: CardColorOptions,
			_layout?: CardBlock[],
			_options?: { priority?: RenderPriority },
		) => Buffer.from("png-bytes"),
	);
	const sent: { dest: LinkReplyDestination; payload: NotificationPayload }[] = [];
	const send = vi.fn(
		async (dest: LinkReplyDestination, payload: NotificationPayload): Promise<DeliveryResult> => {
			sent.push({ dest, payload });
			return { ok: true, latencyMs: 1 };
		},
	);
	let now = 1_000_000;
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const readConfig = vi.fn(() => config);
	const parser = createLinkParser({
		logger,
		config: readConfig,
		api: { getVideoInfo, resolveShortLink },
		renderer: () => ({ generateDynamicCard }),
		layout: () => LAYOUT,
		send,
		now: () => now,
		...(limits ? { limits } : {}),
	});
	return {
		parser,
		config,
		readConfig,
		getVideoInfo,
		resolveShortLink,
		generateDynamicCard,
		send,
		sent,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("createLinkParser", () => {
	it("群里一条 BV 链接:取那个视频,渲染成「投稿了视频」形态的动态卡,发回来源群", async () => {
		const h = makeParser();
		await h.parser.handle(groupFrame("看这个 https://www.bilibili.com/video/BV1zMtU6uEEb/ 好看"), {
			adapterId: ADAPTER,
		});

		expect(h.getVideoInfo).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });

		expect(h.generateDynamicCard).toHaveBeenCalledTimes(1);
		const dyn = firstArg(h.generateDynamicCard.mock.calls);
		expect(dyn.type).toBe("DYNAMIC_TYPE_AV");
		expect(dyn.modules.module_author).toMatchObject({
			name: "示例UP",
			face: "http://i0.hdslb.com/bfs/face/face.jpg",
			mid: 12345,
			pub_ts: 1756800000,
		});
		expect(dyn.modules.module_dynamic.major?.archive).toEqual({
			badge: { text: "投稿视频" },
			cover: "http://i0.hdslb.com/bfs/archive/cover.jpg",
			duration_text: "12:34",
			title: "示例标题",
			desc: "示例简介",
			stat: { play: "6.5万", danmaku: "120" },
			bvid: "BV1zMtU6uEEb",
			jump_url: "//www.bilibili.com/video/BV1zMtU6uEEb",
		});
		expect(dyn.modules.module_stat).toEqual({
			comment: { count: 30 },
			forward: { count: 15 },
			like: { count: 3000 },
		});
		// 版式与推送的动态卡同一份:不传的话渲染器会退回出厂版式,主人在编辑器里排的顺序就丢了。
		expect(h.generateDynamicCard.mock.calls[0]?.[2]).toBe(LAYOUT);
		// 低优先级:群里谁都能触发的卡,不能排在开播 / 动态卡前面 —— 让路这件事由渲染
		// 队列按车道做,不靠这里数自己发了几张。
		expect(h.generateDynamicCard.mock.calls[0]?.[3]).toEqual({ priority: "low" });

		expect(h.sent).toEqual([
			{
				dest: { platform: "onebot", adapterId: ADAPTER, groupId: String(GROUP) },
				payload: {
					kind: "image",
					image: { buffer: Buffer.from("png-bytes"), mime: "image/jpeg" },
				},
			},
		]);
		expect(h.sent[0]?.payload).toEqual({
			kind: "image",
			image: { buffer: Buffer.from("png-bytes"), mime: "image/jpeg" },
		});
	});

	describe("什么都不做的几种情况", () => {
		const LINK = "https://www.bilibili.com/video/BV1zMtU6uEEb";

		it("功能关着:不打接口、不发", async () => {
			const h = makeParser({ enabled: false });
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.getVideoInfo).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("私聊里贴链接不算(这版只做群)", async () => {
			const h = makeParser();
			await h.parser.handle(groupFrame(LINK, { message_type: "private", group_id: undefined }), {
				adapterId: ADAPTER,
			});
			expect(h.getVideoInfo).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("机器人自己发的消息不解析", async () => {
			const h = makeParser();
			await h.parser.handle(groupFrame(LINK, { user_id: BOT }), { adapterId: ADAPTER });
			expect(h.getVideoInfo).not.toHaveBeenCalled();
		});

		it("正文里没有链接就不打接口 —— 连配置都不读:群里每句话都进这儿,读配置要整份深拷贝", async () => {
			const h = makeParser();
			await h.parser.handle(groupFrame("今天天气不错"), { adapterId: ADAPTER });
			expect(h.getVideoInfo).not.toHaveBeenCalled();
			expect(h.readConfig).not.toHaveBeenCalled();
		});

		it("没有 Chrome:短链也不跟那一跳 —— 连接口都不打的承诺对短链同样成立", async () => {
			const h = makeParser();
			const parser = createLinkParser({
				logger: { info() {}, warn() {}, error() {}, debug() {} },
				config: () => h.config,
				api: { getVideoInfo: h.getVideoInfo, resolveShortLink: h.resolveShortLink },
				renderer: () => null,
				layout: () => undefined,
				send: h.send,
			});
			await parser.handle(groupFrame("https://b23.tv/abc123"), { adapterId: ADAPTER });
			expect(h.resolveShortLink).not.toHaveBeenCalled();
		});

		it("帧本身坏掉(段里的 data 一碰就炸)也不抛 —— 这是被 void 掉的回调,抛出去就是进程退出", async () => {
			const h = makeParser();
			const frame = groupFrame("x", {
				message: [
					{
						type: "text",
						get data(): { text: string } {
							throw new Error("坏段");
						},
					},
				],
			});
			await expect(h.parser.handle(frame, { adapterId: ADAPTER })).resolves.toBeUndefined();
		});

		it("没有 Chrome(渲染器为空)连接口都不打", async () => {
			const h = makeParser();
			const parser = createLinkParser({
				logger: { info() {}, warn() {}, error() {}, debug() {} },
				config: () => h.config,
				api: { getVideoInfo: h.getVideoInfo, resolveShortLink: h.resolveShortLink },
				renderer: () => null,
				layout: () => undefined,
				send: h.send,
			});
			await parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.getVideoInfo).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});
	});

	describe("冷却", () => {
		const LINK = "https://www.bilibili.com/video/BV1zMtU6uEEb";

		it("同一个群同一个视频 60 秒内只出一次图,过了冷却再出;别的群不受影响", async () => {
			const h = makeParser();
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(1);

			await h.parser.handle(groupFrame(LINK, { group_id: 999 }), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(2);
			expect(h.sent[1]?.dest.groupId).toBe("999");

			h.advance(61_000);
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(3);
		});

		it("冷却设 0 = 不节流", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(2);
		});

		it("链接坏了也吃冷却:同一条坏链接反复贴,接口只被打一次", async () => {
			const h = makeParser();
			h.getVideoInfo.mockRejectedValue(new Error("获取视频信息失败(-404): 啥都木有"));
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.getVideoInfo).toHaveBeenCalledTimes(1);
			expect(h.sent).toHaveLength(0);
		});
	});

	describe("限流 —— 冷却只防同一个视频反复贴,这几条防换着视频刷", () => {
		const link = (id: string) => `https://www.bilibili.com/video/${id}`;
		/** 互不相同的 BV 号,数量随要。 */
		const ids = (n: number) =>
			Array.from({ length: n }, (_, i) => `BV1${String(i).padStart(9, "x")}`);

		it("同一个群一分钟内换着视频刷,最多出 groupPerMinute 张;别的群不受影响;过一分钟再放行", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			for (const id of ids(LINK_LIMITS.groupPerMinute + 2)) {
				await h.parser.handle(groupFrame(link(id)), { adapterId: ADAPTER });
			}
			expect(h.sent).toHaveLength(LINK_LIMITS.groupPerMinute);

			await h.parser.handle(groupFrame(link("BV1zzzzzzzzz"), { group_id: 999 }), {
				adapterId: ADAPTER,
			});
			expect(h.sent).toHaveLength(LINK_LIMITS.groupPerMinute + 1);

			h.advance(61_000);
			await h.parser.handle(groupFrame(link("BV1yyyyyyyyy")), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(LINK_LIMITS.groupPerMinute + 2);
		});

		it("全局同时在处理的链接卡有上限:渲染卡着时,再来的链接不排队 —— 渲染队列是串行的,推送卡排在后面", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			const release: (() => void)[] = [];
			h.generateDynamicCard.mockImplementation(
				() =>
					new Promise<Buffer<ArrayBuffer>>((resolve) =>
						release.push(() => resolve(Buffer.from("x"))),
					),
			);
			const runs = ids(LINK_LIMITS.maxInflight + 1).map((id) =>
				h.parser.handle(groupFrame(link(id)), { adapterId: ADAPTER }),
			);
			for (let i = 0; i < 50 && release.length < LINK_LIMITS.maxInflight; i++) {
				await new Promise((r) => setTimeout(r, 1));
			}
			// 第 maxInflight+1 条连接口都没打 —— 不是排队,是直接放弃。
			expect(h.getVideoInfo).toHaveBeenCalledTimes(LINK_LIMITS.maxInflight);
			for (const r of release) r();
			await Promise.all(runs);
			expect(h.sent).toHaveLength(LINK_LIMITS.maxInflight);

			// 卡着的放行之后,新来的照常。
			h.generateDynamicCard.mockResolvedValue(Buffer.from("png-bytes"));
			await h.parser.handle(groupFrame(link("BV1yyyyyyyyy")), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(LINK_LIMITS.maxInflight + 1);
		});

		it("冷却表有容量上限:满了先忘最久没碰的 —— 表不会越涨越慢", async () => {
			const h = makeParser({}, { tableCap: 2 });
			const [a, b, c] = ids(3) as [string, string, string];
			for (const id of [a, b, c]) {
				await h.parser.handle(groupFrame(link(id)), { adapterId: ADAPTER });
			}
			expect(h.sent).toHaveLength(3);
			// a 最久没碰,已被挤掉:再贴照样出图;c 还在表里:不出。
			await h.parser.handle(groupFrame(link(a)), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(4);
			await h.parser.handle(groupFrame(link(c)), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(4);
		});
	});

	describe("失败不回话、不抛", () => {
		const LINK = "https://www.bilibili.com/video/BV1zMtU6uEEb";

		it("接口失败:不发任何东西,handle 正常返回", async () => {
			const h = makeParser();
			h.getVideoInfo.mockRejectedValue(new Error("boom"));
			await expect(
				h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER }),
			).resolves.toBeUndefined();
			expect(h.generateDynamicCard).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("渲染失败:不发任何东西", async () => {
			const h = makeParser();
			h.generateDynamicCard.mockRejectedValue(new Error("截图超时(20s)"));
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			expect(h.sent).toHaveLength(0);
		});

		it("发送返回失败:不抛", async () => {
			const h = makeParser();
			h.send.mockResolvedValue({ ok: false, latencyMs: 3, err: "group: groupId missing" });
			await expect(
				h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER }),
			).resolves.toBeUndefined();
		});
	});

	describe("官机(qq-official)入口", () => {
		it("已解析好的群消息:同一套流程,回复目的地标明平台与群 openid", async () => {
			const h = makeParser();
			await h.parser.handleMessage({
				platform: "qq-official",
				adapterId: ADAPTER,
				groupId: "G_OPENID",
				userId: "M_OPENID",
				text: " https://www.bilibili.com/video/BV1zMtU6uEEb/",
			});
			expect(h.getVideoInfo).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });
			expect(h.sent).toHaveLength(1);
			expect(h.sent[0]?.dest).toEqual({
				platform: "qq-official",
				adapterId: ADAPTER,
				groupId: "G_OPENID",
			});
		});

		it("冷却按平台 + adapter + 群 + 视频算:官机群与 OneBot 群互不影响", async () => {
			const h = makeParser();
			const LINK = "https://www.bilibili.com/video/BV1zMtU6uEEb";
			await h.parser.handle(groupFrame(LINK), { adapterId: ADAPTER });
			await h.parser.handleMessage({
				platform: "qq-official",
				adapterId: "22222222-2222-4222-8222-222222222222",
				groupId: "G_OPENID",
				userId: "M",
				text: LINK,
			});
			expect(h.sent).toHaveLength(2);
		});
	});

	describe("短链与多链接", () => {
		it("b23.tv 短链先解成落地地址再取视频", async () => {
			const h = makeParser();
			h.resolveShortLink.mockResolvedValue(
				"https://www.bilibili.com/video/BV1zMtU6uEEb?share_source=copy_web",
			);
			await h.parser.handle(groupFrame("分享 https://b23.tv/abc123"), { adapterId: ADAPTER });
			expect(h.resolveShortLink).toHaveBeenCalledWith("https://b23.tv/abc123");
			expect(h.getVideoInfo).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });
			expect(h.sent).toHaveLength(1);
		});

		it("短链解不出来(不是视频 / 落到别处)就当没看见", async () => {
			const h = makeParser();
			h.resolveShortLink.mockResolvedValue(null);
			await h.parser.handle(groupFrame("https://b23.tv/notvideo"), { adapterId: ADAPTER });
			expect(h.getVideoInfo).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("短链本身也吃冷却:同一条短链反复贴,那一跳只跟一次 —— 哪怕它解不出视频", async () => {
			const h = makeParser();
			h.resolveShortLink.mockResolvedValue(null);
			await h.parser.handle(groupFrame("https://b23.tv/notvideo"), { adapterId: ADAPTER });
			await h.parser.handle(groupFrame("https://b23.tv/notvideo"), { adapterId: ADAPTER });
			expect(h.resolveShortLink).toHaveBeenCalledTimes(1);
		});

		it("短链解出来的视频与直链共用冷却:先贴短链再贴直链,只出一张", async () => {
			const h = makeParser();
			h.resolveShortLink.mockResolvedValue("https://www.bilibili.com/video/BV1zMtU6uEEb");
			await h.parser.handle(groupFrame("https://b23.tv/abc123"), { adapterId: ADAPTER });
			await h.parser.handle(groupFrame("https://www.bilibili.com/video/BV1zMtU6uEEb"), {
				adapterId: ADAPTER,
			});
			expect(h.sent).toHaveLength(1);
		});

		it("一条消息里最多解析三个链接", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			const text = ["BV1aaaaaaaaa", "BV1bbbbbbbbb", "BV1ccccccccc", "BV1dddddddddd".slice(0, 12)]
				.map((id) => `https://www.bilibili.com/video/${id}`)
				.join(" ");
			await h.parser.handle(groupFrame(text), { adapterId: ADAPTER });
			expect(h.getVideoInfo).toHaveBeenCalledTimes(3);
			expect(h.getVideoInfo.mock.calls.map(([ref]) => ref)).toEqual([
				{ bvid: "BV1aaaaaaaaa" },
				{ bvid: "BV1bbbbbbbbb" },
				{ bvid: "BV1ccccccccc" },
			]);
		});
	});
});
