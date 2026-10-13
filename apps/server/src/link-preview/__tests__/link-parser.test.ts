/**
 * 链接解析的门 —— 群里有人贴链接,门问在册的解析器认不认,认了就查、出卡、回。
 *
 * 缝在 `handleMessage(msg)`:喂一条 adapter 归一化好的群消息,看它对外做了什么
 * (问了哪个解析器、喂给渲染器的作品长什么样、往哪个群发了什么),不看内部。用例里仍以
 * OneBot 帧起手,经真实的 `extractGroupMessage` 归一化 —— 那正是接线层在 index.ts 里做的事。
 * 协作者全是假的:配置(现读)、解析器(登记表里的假解析器,只认 `acme.invalid`)、渲染器、发送。
 * B 站自己的链接怎么认、怎么查由 `bilibili/__tests__/link-resolver.test.ts` 钉。
 */

import type { CardColorOptions, RenderPriority } from "@bilibili-notify/image";
import type {
	ConnectionCapabilities,
	DeliveryResult,
	LinkParsingConfig,
	LinkParsingPolicy,
	LinkPreview,
	LinkResolver,
	NotificationPayload,
	Post,
} from "@bilibili-notify/internal";
import { fail, LINK_LIMITS, type LinkLimits, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { extractGroupMessage } from "../../platforms/onebot-inbound.js";
import { createLinkParser, type LinkParser, type LinkReplyDestination } from "../link-parser.js";
import { createLinkResolverRegistry } from "../registry.js";

const ADAPTER = "11111111-1111-4111-8111-111111111111";
const GROUP = 123456;
const BOT = 10000;
const SOMEONE = 20002;
const RESOLVER_KEY = "acme.inprocess";

/** 假解析器认的链接:`https://acme.invalid/link/<id>`。 */
const link = (id: string) => `https://acme.invalid/link/${id}`;
const LINK = link("a1");

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

/** 接线层在 index.ts 里做的事:OneBot 帧经 adapter 归一化,再补上平台与连接进 handleMessage。 */
async function feed(parser: LinkParser, frame: Record<string, unknown>): Promise<void> {
	const msg = extractGroupMessage(frame);
	if (!msg) return;
	await parser.handleMessage({ connectionId: ADAPTER, ...msg });
}

/** 主人在卡片页选的那套皮肤 —— 推送的动态卡吃它,链接解析出的卡也得吃它。 */
const SKIN = "skin-from-panel";
/** 卡片页里给「动态」这一类调的配色 —— 同样两种卡都得吃。 */
const COLORS: CardColorOptions = { font: "Comic Sans MS" };

/** 假解析器交的预览:作品正文带 id,原生分享描述五格都能一一认出。 */
function previewOf(id: string, withNativeShare = true): LinkPreview {
	return {
		post: {
			creator: { name: "链接作者" },
			publishedAt: "2026-10-01T08:00:00.000Z",
			text: `正文-${id}`,
		},
		canonicalId: id,
		...(withNativeShare
			? {
					nativeShare: {
						appId: "acme-app",
						title: `标题-${id}`,
						description: `描述-${id}`,
						imageUrl: `https://acme.invalid/${id}.png`,
						pagePath: `pages/link?id=${id}`,
						webUrl: link(id),
					},
				}
			: {}),
	};
}

function makeParser(
	over: Partial<LinkParsingConfig> = {},
	limits?: Partial<LinkLimits>,
	extra: {
		policyFor?: (key: string) => LinkParsingPolicy;
		capabilities?: (dest: LinkReplyDestination) => ConnectionCapabilities | undefined;
		probeCapabilities?: (dest: LinkReplyDestination) => Promise<ConnectionCapabilities | undefined>;
		/** 每条 payload 的投递结果;缺省全部成功。 */
		sendResult?: (payload: NotificationPayload) => DeliveryResult;
		/** 假解析器怎么回(缺省按链接尾巴的 id 交预览)。 */
		resolve?: LinkResolver["resolve"];
	} = {},
) {
	const config: LinkParsingConfig = {
		enabled: true,
		cooldownSeconds: 60,
		defaults: { parse: true, form: "image" },
		groups: {},
		...over,
	};
	const resolve = vi.fn<LinkResolver["resolve"]>(
		extra.resolve ??
			(async (url) => {
				const id = /\/link\/([A-Za-z0-9]+)/.exec(url)?.[1] ?? "x";
				return ok(previewOf(id));
			}),
	);
	const matches = vi.fn((url: string) => url.includes("acme.invalid/link/"));
	const resolver: LinkResolver = { label: "对拍源", matches, resolve };
	const linkResolvers = createLinkResolverRegistry();
	linkResolvers.register(RESOLVER_KEY, resolver);
	const warn = vi.fn();
	const generatePostCard = vi.fn(
		async (_post: Post, _colors?: CardColorOptions, _options?: { priority?: RenderPriority }) =>
			Buffer.from("png-bytes"),
	);
	const sent: { dest: LinkReplyDestination; payload: NotificationPayload }[] = [];
	const send = vi.fn(
		async (dest: LinkReplyDestination, payload: NotificationPayload): Promise<DeliveryResult> => {
			sent.push({ dest, payload });
			return extra.sendResult?.(payload) ?? { ok: true, latencyMs: 1 };
		},
	);
	const probeCapabilities = vi.fn(
		extra.probeCapabilities ?? (async (_dest: LinkReplyDestination) => undefined),
	);
	let now = 1_000_000;
	const logger = { info() {}, warn, error() {}, debug() {} };
	const readConfig = vi.fn(() => config);
	const renderer = vi.fn((): { generatePostCard: typeof generatePostCard } | null => ({
		generatePostCard,
	}));
	const signal = new AbortController().signal;
	const build = (rendererOverride?: () => ReturnType<typeof renderer>) =>
		createLinkParser({
			logger,
			config: readConfig,
			linkResolvers,
			signal,
			renderer: rendererOverride ?? renderer,
			presentation: () => ({ colors: COLORS, cardSkin: SKIN }),
			send,
			now: () => now,
			policyFor: extra.policyFor ?? (() => ({ parse: true, form: "image" })),
			capabilities: extra.capabilities ?? (() => undefined),
			probeCapabilities,
			...(limits ? { limits } : {}),
		});
	return {
		parser: build(),
		build,
		config,
		readConfig,
		renderer,
		resolve,
		matches,
		resolver,
		linkResolvers,
		signal,
		warn,
		generatePostCard,
		send,
		sent,
		probeCapabilities,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("createLinkParser", () => {
	it("群里一条被认领的链接:问解析器,把它交的作品渲染成图片卡,发回来源群", async () => {
		const h = makeParser();
		await feed(h.parser, groupFrame(`看这个 ${LINK} 好看`));

		// 问的是解析器认的那条链接原文,带着关停信号。
		expect(h.resolve).toHaveBeenCalledWith(LINK, h.signal);

		expect(h.generatePostCard).toHaveBeenCalledTimes(1);
		// 交给出图器的就是解析器交的作品,原样。
		expect(firstArg(h.generatePostCard.mock.calls)).toEqual(previewOf("a1").post);
		// 呈现与推送的动态卡同一份:配色不传的话主人在卡片页给「动态」调的样式只有推送卡认,
		// 皮肤不传的话渲染器退回内置默认皮肤、主人选的那套排版就丢了。
		expect(h.generatePostCard.mock.calls[0]?.[1]).toEqual({ ...COLORS, cardSkin: SKIN });
		// 低优先级:群里谁都能触发的卡,不能排在开播 / 动态卡前面 —— 让路这件事由渲染
		// 队列按车道做,不靠这里数自己发了几张。
		expect(h.generatePostCard.mock.calls[0]?.[2]).toEqual({ priority: "low" });

		expect(h.sent).toEqual([
			{
				dest: { connectionId: ADAPTER, groupId: String(GROUP) },
				payload: {
					kind: "image",
					image: { buffer: Buffer.from("png-bytes"), mime: "image/jpeg" },
				},
			},
		]);
	});

	describe("什么都不做的几种情况", () => {
		it("功能关着:不问解析器、不发", async () => {
			const h = makeParser({ enabled: false });
			await feed(h.parser, groupFrame(LINK));
			expect(h.resolve).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("私聊里贴链接不算(这版只做群)", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame(LINK, { message_type: "private", group_id: undefined }));
			expect(h.resolve).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("机器人自己发的消息不解析", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame(LINK, { user_id: BOT }));
			expect(h.resolve).not.toHaveBeenCalled();
		});

		it("正文里没有链接就不问解析器 —— 连配置都不读:群里每句话都进这儿,读配置要整份深拷贝", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame("今天天气不错"));
			expect(h.resolve).not.toHaveBeenCalled();
			expect(h.readConfig).not.toHaveBeenCalled();
		});

		it("有网址但没有解析器认领:同样连配置都不读、不发", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame("看 https://example.com/page 和 foo.bar/baz"));
			expect(h.matches).toHaveBeenCalled();
			expect(h.resolve).not.toHaveBeenCalled();
			expect(h.readConfig).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("登记表是空的(没有集成登记解析器):什么都不做", async () => {
			const h = makeParser();
			const parser = createLinkParser({
				logger: { info() {}, warn() {}, error() {}, debug() {} },
				config: h.readConfig,
				linkResolvers: createLinkResolverRegistry(),
				signal: h.signal,
				renderer: h.renderer,
				presentation: () => ({}),
				send: h.send,
				policyFor: () => ({ parse: true, form: "image" }),
				capabilities: () => undefined,
			});
			await feed(parser, groupFrame(LINK));
			expect(h.readConfig).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("来源停下后(解析器被撤)同一条链接没人认", async () => {
			const h = makeParser();
			// 门每条消息现读登记表:解析器的把手一撤(来源停下时宿主就是这么撤的),下一条就没人认。
			const other = createLinkResolverRegistry();
			const handle = other.register(RESOLVER_KEY, h.resolver);
			const parser = createLinkParser({
				logger: { info() {}, warn() {}, error() {}, debug() {} },
				config: h.readConfig,
				linkResolvers: other,
				signal: h.signal,
				renderer: h.renderer,
				presentation: () => ({}),
				send: h.send,
				policyFor: () => ({ parse: true, form: "image" }),
				capabilities: () => undefined,
			});
			await feed(parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(1);
			handle.dispose();
			h.advance(61_000);
			await feed(parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(1);
		});

		it("没有 Chrome(渲染器为空)连解析器都不问", async () => {
			const h = makeParser();
			const parser = h.build(vi.fn(() => null));
			await feed(parser, groupFrame(LINK));
			expect(h.resolve).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});
	});

	describe("冷却", () => {
		it("同一个群同一条链接 60 秒内只出一次图,过了冷却再出;别的群不受影响", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame(LINK));
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(1);
			// 被冷却挡下的那一条连解析器都不问。
			expect(h.resolve).toHaveBeenCalledTimes(1);

			await feed(h.parser, groupFrame(LINK, { group_id: 999 }));
			expect(h.sent).toHaveLength(2);
			expect(h.sent[1]?.dest.groupId).toBe("999");

			h.advance(61_000);
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(3);
		});

		it("冷却设 0 = 不节流", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			await feed(h.parser, groupFrame(LINK));
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(2);
		});

		it("链接坏了也吃冷却:同一条坏链接反复贴,解析器只被问一次", async () => {
			const h = makeParser({}, undefined, {
				resolve: async () => fail("unavailable", "获取视频信息失败(-404): 啥都木有"),
			});
			await feed(h.parser, groupFrame(LINK));
			await feed(h.parser, groupFrame(LINK));
			expect(h.resolve).toHaveBeenCalledTimes(1);
			expect(h.sent).toHaveLength(0);
		});

		it("同一个东西换了写法重贴:每种写法各问一次解析器,但只出一张", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame(link("a1")));
			await feed(h.parser, groupFrame(`${link("a1")}?from=share`));
			expect(h.resolve).toHaveBeenCalledTimes(2);
			expect(h.sent).toHaveLength(1);
		});

		it("同一条消息里先后贴同一个东西的两种写法,也只出一张", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame(`${link("a1")} ${link("a1")}?from=share`));
			expect(h.resolve).toHaveBeenCalledTimes(2);
			expect(h.sent).toHaveLength(1);
		});

		it("冷却设 0 时,同一条消息里指着同一个东西的两种写法也只出一张;不同的东西各出一张", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			await feed(h.parser, groupFrame(`${link("a1")} ${link("a1")}?from=share`));
			expect(h.sent).toHaveLength(1);
			await feed(h.parser, groupFrame(`${link("a2")} ${link("a3")}`));
			expect(h.sent).toHaveLength(3);
		});

		it("冷却键里有解析器:不同集成的两个解析器碰巧交出同一个规范 id,互不冷却", async () => {
			const h = makeParser();
			const second: LinkResolver = {
				label: "第二家",
				matches: (url) => url.includes("other.invalid/"),
				resolve: async () => ok(previewOf("a1")),
			};
			h.linkResolvers.register("other.inprocess", second);
			await feed(h.parser, groupFrame(`${link("a1")} https://other.invalid/x`));
			expect(h.sent).toHaveLength(2);
		});
	});

	describe("限流 —— 冷却只防同一条反复贴,这几条防换着链接刷", () => {
		/** 互不相同的 id,数量随要。 */
		const ids = (n: number) =>
			Array.from({ length: n }, (_, i) => `x${String(i).padStart(4, "0")}`);

		it("同一个群一分钟内换着链接刷,最多出 groupPerMinute 张;别的群不受影响;过一分钟再放行", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			for (const id of ids(LINK_LIMITS.groupPerMinute + 2)) {
				await feed(h.parser, groupFrame(link(id)));
			}
			expect(h.sent).toHaveLength(LINK_LIMITS.groupPerMinute);

			await feed(h.parser, groupFrame(link("zzzz"), { group_id: 999 }));
			expect(h.sent).toHaveLength(LINK_LIMITS.groupPerMinute + 1);

			h.advance(61_000);
			await feed(h.parser, groupFrame(link("yyyy")));
			expect(h.sent).toHaveLength(LINK_LIMITS.groupPerMinute + 2);
		});

		it("全局同时在处理的链接卡有上限:渲染卡着时,再来的链接不排队 —— 渲染队列是串行的,推送卡排在后面", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			const release: (() => void)[] = [];
			h.generatePostCard.mockImplementation(
				() =>
					new Promise<Buffer<ArrayBuffer>>((resolve) =>
						release.push(() => resolve(Buffer.from("x"))),
					),
			);
			const runs = ids(LINK_LIMITS.maxInflight + 1).map((id) =>
				feed(h.parser, groupFrame(link(id))),
			);
			for (let i = 0; i < 50 && release.length < LINK_LIMITS.maxInflight; i++) {
				await new Promise((r) => setTimeout(r, 1));
			}
			// 第 maxInflight+1 条连解析器都没问 —— 不是排队,是直接放弃。
			expect(h.resolve).toHaveBeenCalledTimes(LINK_LIMITS.maxInflight);
			for (const r of release) r();
			await Promise.all(runs);
			expect(h.sent).toHaveLength(LINK_LIMITS.maxInflight);

			// 卡着的放行之后,新来的照常。
			h.generatePostCard.mockResolvedValue(Buffer.from("png-bytes"));
			await feed(h.parser, groupFrame(link("yyyy")));
			expect(h.sent).toHaveLength(LINK_LIMITS.maxInflight + 1);
		});

		it("冷却表有容量上限:满了先忘最久没碰的 —— 表不会越涨越慢", async () => {
			// 每条链接在表里占两格(链接原文一把、规范 id 一把),所以容量 4 = 最近两条链接。
			const h = makeParser({}, { tableCap: 4 });
			const [a, b, c] = ids(3) as [string, string, string];
			for (const id of [a, b, c]) {
				await feed(h.parser, groupFrame(link(id)));
			}
			expect(h.sent).toHaveLength(3);
			// a 最久没碰,已被挤掉:再贴照样出图;c 还在表里:不出。
			await feed(h.parser, groupFrame(link(a)));
			expect(h.sent).toHaveLength(4);
			await feed(h.parser, groupFrame(link(c)));
			expect(h.sent).toHaveLength(4);
		});
	});

	describe("失败不回话、不抛", () => {
		it("解析器回失败:不发任何东西,handle 正常返回,失败原话进日志", async () => {
			const h = makeParser({}, undefined, {
				resolve: async () => fail("unavailable", "boom"),
			});
			await expect(feed(h.parser, groupFrame(LINK))).resolves.toBeUndefined();
			expect(h.generatePostCard).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
			expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
		});

		it("解析器自己抛了(它的 bug):同样不发、不抛,并且不影响同一条消息里的下一个", async () => {
			const h = makeParser({ cooldownSeconds: 0 }, undefined, {
				resolve: async (url) => {
					if (url.endsWith("bad")) throw new Error("解析器炸了");
					return ok(previewOf("good"));
				},
			});
			await expect(
				feed(h.parser, groupFrame(`${link("bad")} ${link("good")}`)),
			).resolves.toBeUndefined();
			expect(h.sent).toHaveLength(1);
			expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("解析器炸了"));
		});

		it("渲染失败:不发任何东西", async () => {
			const h = makeParser();
			h.generatePostCard.mockRejectedValue(new Error("截图超时(20s)"));
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(0);
		});

		it("发送返回失败:不抛", async () => {
			const h = makeParser();
			h.send.mockResolvedValue(fail("invalid", "group: groupId missing"));
			await expect(feed(h.parser, groupFrame(LINK))).resolves.toBeUndefined();
			// 失败的原话得进日志:群里没回话时,这一行是唯一说得清原因的地方。
			expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("group: groupId missing"));
		});
	});

	describe("官机(qq-official)入口", () => {
		it("已解析好的群消息:同一套流程,回复目的地标明连接与群 openid", async () => {
			const h = makeParser();
			await h.parser.handleMessage({
				connectionId: ADAPTER,
				groupId: "G_OPENID",
				userId: "M_OPENID",
				text: ` ${LINK}/`,
				cardLinks: [],
				miniAppCardLinks: [],
			});
			expect(h.resolve).toHaveBeenCalledTimes(1);
			expect(h.sent).toHaveLength(1);
			expect(h.sent[0]?.dest).toEqual({
				connectionId: ADAPTER,
				groupId: "G_OPENID",
			});
		});

		it("冷却按 连接 + 群 + 链接算:官机群与 OneBot 群互不影响", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame(LINK));
			await h.parser.handleMessage({
				connectionId: "22222222-2222-4222-8222-222222222222",
				groupId: "G_OPENID",
				userId: "M",
				text: LINK,
				cardLinks: [],
				miniAppCardLinks: [],
			});
			expect(h.sent).toHaveLength(2);
		});
	});

	describe("进来的本身就是原生分享卡", () => {
		/** 进来的是一张小程序卡:它的链接在 `miniAppCardLinks` 里,正文与普通卡链接两格都空。 */
		const feedNativeCard = (h: ReturnType<typeof makeParser>) =>
			h.parser.handleMessage({
				connectionId: ADAPTER,
				groupId: String(GROUP),
				userId: String(SOMEONE),
				text: "",
				cardLinks: [],
				miniAppCardLinks: [LINK],
			});

		it("群里已经有那张卡了 → 一律不回,不管这个群选的是哪种形式;也不问解析器", async () => {
			for (const form of ["image", "miniapp"] as const) {
				const h = makeParser({}, undefined, {
					policyFor: () => ({ parse: true, form }),
					capabilities: () => ({
						atAll: { state: "unknown" },
						inbound: { state: "unknown" },
						miniAppCard: { state: "supported", checkedAt: 1 },
					}),
				});
				await feedNativeCard(h);
				expect(h.sent).toHaveLength(0);
				expect(h.resolve).not.toHaveBeenCalled();
			}
		});

		it("跳过不留痕:随后有人把同一条链接以文字贴出来,照常出卡", async () => {
			const h = makeParser();
			await feedNativeCard(h);
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(1);
		});

		it("普通分享卡(灰色链接卡之类)里的链接算,照常出卡", async () => {
			const h = makeParser();
			await h.parser.handleMessage({
				connectionId: ADAPTER,
				groupId: String(GROUP),
				userId: String(SOMEONE),
				text: "",
				cardLinks: [LINK],
				miniAppCardLinks: [],
			});
			expect(h.sent).toHaveLength(1);
		});
	});

	describe("多链接", () => {
		it("一条消息里最多解析三个被认领的链接", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			const text = ["a1", "a2", "a3", "a4"].map(link).join(" ");
			await feed(h.parser, groupFrame(text));
			expect(h.resolve).toHaveBeenCalledTimes(3);
			expect(h.resolve.mock.calls.map(([url]) => url)).toEqual([
				link("a1"),
				link("a2"),
				link("a3"),
			]);
		});

		it("没人认的链接不占那三个名额", async () => {
			const h = makeParser({ cooldownSeconds: 0 });
			const text = [
				"https://example.com/1",
				"https://example.com/2",
				"https://example.com/3",
				link("a1"),
			].join(" ");
			await feed(h.parser, groupFrame(text));
			expect(h.resolve.mock.calls.map(([url]) => url)).toEqual([link("a1")]);
		});

		it("两个解析器都认同一条链接时先登记的答", async () => {
			const h = makeParser();
			const late = vi.fn<LinkResolver["resolve"]>(async () => ok(previewOf("late")));
			h.linkResolvers.register("later.inprocess", {
				label: "后来的",
				matches: () => true,
				resolve: late,
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.resolve).toHaveBeenCalledTimes(1);
			expect(late).not.toHaveBeenCalled();
		});

		it("没有 https:// 的裸写法照样挑得出来、交给解析器时是原文", async () => {
			const h = makeParser();
			await feed(h.parser, groupFrame("acme.invalid/link/a1 看看"));
			expect(h.resolve).toHaveBeenCalledWith("acme.invalid/link/a1", h.signal);
			expect(h.sent).toHaveLength(1);
		});
	});

	// 逐群答案本身(哪些目标算、停用算不算、陌生群跟谁)由 link-scope 算成表,这里只看解析器
	// 拿着答案做没做对:说解析才出卡,说不解析什么都不碰。
	describe("逐群答案(解不解析)", () => {
		const THIS_GROUP = `${ADAPTER}:${GROUP}`;
		const only = (key: string) => (k: string) => ({ parse: k === key, form: "image" as const });

		it("这个群的答案是解析 → 照常出卡", async () => {
			const h = makeParser({}, undefined, { policyFor: only(THIS_GROUP) });
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(1);
		});

		it("这个群的答案是不解析 → 不问解析器、不碰渲染器、不发", async () => {
			const h = makeParser({}, undefined, { policyFor: only(`${ADAPTER}:999999`) });
			await feed(h.parser, groupFrame(LINK));
			expect(h.resolve).not.toHaveBeenCalled();
			expect(h.renderer).not.toHaveBeenCalled();
			expect(h.sent).toHaveLength(0);
		});

		it("被拦下的链接不记冷却:主人随后把群打开,同一条链接立刻能出卡", async () => {
			let parse = false;
			const h = makeParser({}, undefined, { policyFor: () => ({ parse, form: "image" }) });
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(0);

			parse = true;
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(1);
		});

		it("官机群按 连接:群 openid 查答案", async () => {
			const h = makeParser({}, undefined, {
				policyFor: only(`${ADAPTER}:G_OPENID`),
			});
			await h.parser.handleMessage({
				connectionId: ADAPTER,
				groupId: "G_OPENID",
				userId: "M_OPENID",
				text: LINK,
				cardLinks: [],
				miniAppCardLinks: [],
			});
			expect(h.sent).toHaveLength(1);
			await h.parser.handleMessage({
				connectionId: ADAPTER,
				groupId: "G_OTHER",
				userId: "M_OPENID",
				text: LINK,
				cardLinks: [],
				miniAppCardLinks: [],
			});
			expect(h.sent).toHaveLength(1);
		});
	});

	// 形式(图片卡 / 小程序卡)× 连接能力 → 发什么、失败怎么回落。能力本身怎么探在
	// onebot 适配器那边守,这里只看解析器拿着答案做没做对。
	describe("回复形式(图片卡 / 原生分享)", () => {
		const miniapp = () => ({ parse: true, form: "miniapp" as const });
		const caps = (state: "supported" | "unsupported" | "unknown"): ConnectionCapabilities => ({
			atAll: { state: "unknown" },
			inbound: { state: "unknown" },
			miniAppCard:
				state === "supported"
					? { state, checkedAt: 1 }
					: state === "unsupported"
						? { state, reason: "没有接口", checkedAt: 1 }
						: { state },
		});
		/** 今天的小程序卡载荷:解析器交的中立描述五格一一对应。 */
		const MINIAPP_CARD: NotificationPayload = {
			kind: "miniapp-card",
			title: "标题-a1",
			desc: "描述-a1",
			picUrl: "https://acme.invalid/a1.png",
			path: "pages/link?id=a1",
			jumpUrl: "https://acme.invalid/link/a1",
		};

		it("形式=小程序卡、连接支持 → 发小程序卡,字段来自解析器交的描述;不碰渲染器", async () => {
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("supported"),
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent.map((s) => s.payload)).toEqual([MINIAPP_CARD]);
			expect(h.generatePostCard).not.toHaveBeenCalled();
			expect(h.probeCapabilities).not.toHaveBeenCalled();
		});

		it("连接不支持 → 回落图片卡,和形式=图片卡一样", async () => {
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("unsupported"),
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["image"]);
			expect(h.generatePostCard).toHaveBeenCalledTimes(1);
		});

		it("解析器没交原生分享描述 → 形式选了小程序卡、连接也支持,仍回图片卡", async () => {
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("supported"),
				resolve: async () => ok(previewOf("a1", false)),
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["image"]);
		});

		it("还没探出来 → 先探一次再决定:探出支持就发小程序卡", async () => {
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("unknown"),
				probeCapabilities: async () => caps("supported"),
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.probeCapabilities).toHaveBeenCalledTimes(1);
			expect(h.probeCapabilities).toHaveBeenCalledWith({
				connectionId: ADAPTER,
				groupId: String(GROUP),
			});
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["miniapp-card"]);
		});

		it("探完仍未知 → 图片卡,不拿一张注定发不出去的卡去试", async () => {
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("unknown"),
				probeCapabilities: async () => caps("unknown"),
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["image"]);
		});

		it("小程序卡发送失败 → 同一条链接回落图片卡,群里不会空着", async () => {
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("supported"),
				sendResult: (p) =>
					p.kind === "miniapp-card"
						? fail("unavailable", "签小程序卡失败: packet 后端未就绪")
						: { ok: true, latencyMs: 1 },
			});
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["miniapp-card", "image"]);
			expect(h.warn).toHaveBeenCalledWith(
				expect.stringContaining("签小程序卡失败: packet 后端未就绪,回落图片卡"),
			);
		});

		it("平台没有能力概念(官机)→ 形式选了小程序卡也回图片卡", async () => {
			const h = makeParser({}, undefined, { policyFor: miniapp, capabilities: () => undefined });
			await h.parser.handleMessage({
				connectionId: ADAPTER,
				groupId: "G_OPENID",
				userId: "M_OPENID",
				text: LINK,
				cardLinks: [],
				miniAppCardLinks: [],
			});
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["image"]);
		});

		it("没有渲染器:支持小程序卡照发;要回落图片卡时才无事可做", async () => {
			const ok = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("supported"),
			});
			ok.renderer.mockReturnValue(null);
			await feed(ok.parser, groupFrame(LINK));
			expect(ok.sent.map((s) => s.payload.kind)).toEqual(["miniapp-card"]);

			const none = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps("unsupported"),
			});
			none.renderer.mockReturnValue(null);
			await feed(none.parser, groupFrame(LINK));
			expect(none.sent).toHaveLength(0);
			expect(none.resolve).not.toHaveBeenCalled();
		});

		it("一张也发不出来时不吃冷却:连接一恢复,同一条链接立刻出卡", async () => {
			// 形式=小程序卡、连接签不了、又没有渲染器 —— 回落无门。这一趟要是把冷却记上,
			// 主人把 Chrome 装好 / 连接连上之后,还得干等一整个冷却才看得到卡。
			let state: "unsupported" | "supported" = "unsupported";
			const h = makeParser({}, undefined, {
				policyFor: miniapp,
				capabilities: () => caps(state),
			});
			h.renderer.mockReturnValue(null);
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent).toHaveLength(0);

			state = "supported";
			await feed(h.parser, groupFrame(LINK));
			expect(h.sent.map((s) => s.payload.kind)).toEqual(["miniapp-card"]);
		});
	});
});
