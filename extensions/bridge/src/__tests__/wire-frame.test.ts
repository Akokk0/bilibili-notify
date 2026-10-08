/**
 * 刻画测试 — 桥适配器发给对端的**线上帧内容**(`NotificationPayload` → `message`)。
 *
 * 桥的 `message` 判别键(`kind` / 段的 `type`)与内部载荷的名字当初是同一套,`toBridgeMessage` 逐格抄过去;
 * 3a-16 起内部改叫 `image-group` / `mergeForward`、段的判别键 `kind`,适配器在映射回帧里的名字。
 * 下面的输入写内部的名字,期望值是线上的名字 —— 内部改名时期望值**一个字都不许动**:
 * 线上协议(`PROTOCOL.md` §6)是对着 koishi / AstrBot 两端写好的插件的,它们不会跟着改。
 *
 * 断言对象是 `JSON.parse(JSON.stringify(request))`:适配器会留下值为 `undefined` 的格
 * (如没有 caption),JSON 上它们不存在,toEqual 直接比内存对象分不出「缺格」与「undefined」。
 *
 * 帧里的 `type: "send"` 与 `id` 是传输层(`server.ts`)补的,不在适配器的产出里,这里钉的是
 * 适配器交给传输层的那份请求(botId / platform / target / message)。
 */

import type {
	Connection,
	ExtensionConnectionView,
	NotificationPayload,
	PushTarget,
} from "@bilibili-notify/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { createBridgeAdapter } from "../adapter.js";
import type { BridgeConnectionConfig } from "../config.js";
import type { BridgeSendRequest, BridgeServer, BridgeSession } from "../server.js";
import type { BridgeLink } from "../settings.js";

const LINK_ID = "link-home";
const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORIGIN = "http://192.168.1.5:8787";

const link: BridgeLink = {
	id: LINK_ID,
	name: "家里那台 koishi",
	enabled: true,
	token: "t0ken",
	bridgeKind: "koishi",
};

const view: ExtensionConnectionView<BridgeConnectionConfig> = {
	id: CONNECTION_ID,
	name: "电报那个 bot",
	enabled: true,
	config: { link: LINK_ID, botId: "b1" },
};

const connection = {
	id: CONNECTION_ID,
	name: "电报那个 bot",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	platform: "telegram",
	config: { link: LINK_ID, botId: "b1" },
} as Connection;

const target = {
	id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	name: "电报群",
	connectionId: CONNECTION_ID,
	kind: "session",
	platform: "telegram",
	scope: "group",
	enabled: true,
	address: "-100",
	parentAddress: "-1",
} as PushTarget;

/** markdown 档位:`supported` 文字原样出去,别的档位会被剥成纯文本。 */
function harness(markdown: "supported" | "unknown" = "supported") {
	const live: BridgeSession = {
		linkId: LINK_ID,
		kind: "koishi",
		bots: [
			{
				botId: "b1",
				platform: "telegram",
				capabilities: {
					atAll: "unsupported",
					inbound: "supported",
					forward: "unknown",
					miniAppCard: "unknown",
					shareCardLinks: "unknown",
					markdown,
				},
			},
		],
		connectedAt: 0,
		origin: ORIGIN,
	};
	const send = vi.fn(async (_id: string, _request: BridgeSendRequest) => ({
		ok: true,
		err: undefined as string | undefined,
	}));
	const stored: string[] = [];
	const server = {
		getSession: (id: string) => (id === LINK_ID ? live : undefined),
		listSessions: () => [live],
		send,
		sessionCount: 1,
		dispose() {},
	} as unknown as BridgeServer;
	const adapter = createBridgeAdapter({
		server,
		connections: () => [view],
		links: () => [link],
		mountPath: "/ext/bridge",
		blobs: {
			// 取图 id 按存入顺序固定编号,URL 才能进字面期望值。
			put() {
				stored.push("blob");
				return `blob${stored.length}`;
			},
		},
	});
	return {
		/** 发一条,返回线上会看到的那份请求(JSON 往返过一遍)。 */
		async sent(payload: NotificationPayload, pushOpts?: { private?: boolean }) {
			const r = await adapter.send(connection, target, payload, pushOpts);
			expect(r.ok).toBe(true);
			expect(send.mock.calls.at(-1)?.[0]).toBe(LINK_ID);
			return JSON.parse(JSON.stringify(send.mock.calls.at(-1)?.[1])) as unknown;
		},
	};
}

const HEAD = {
	botId: "b1",
	platform: "telegram",
	target: { scope: "group", address: "-100", parentAddress: "-1" },
};

describe("桥适配器 — 线上帧内容", () => {
	it("text", async () => {
		expect(await harness().sent({ kind: "text", text: "hello **粗**" })).toEqual({
			...HEAD,
			message: { kind: "text", text: "hello **粗**" },
		});
	});

	it("image:Buffer 换成桥自己取得到的一次性 URL;没有 caption 时该格缺席", async () => {
		const h = harness();
		expect(
			await h.sent({
				kind: "image",
				image: { buffer: Buffer.from("PNG"), mime: "image/png" },
				caption: "卡片标题",
			}),
		).toEqual({
			...HEAD,
			message: {
				kind: "image",
				url: `${ORIGIN}/ext/bridge/blob/blob1`,
				mime: "image/png",
				caption: "卡片标题",
			},
		});
		expect(
			await h.sent({ kind: "image", image: { buffer: Buffer.from("PNG"), mime: "image/png" } }),
		).toEqual({
			...HEAD,
			message: { kind: "image", url: `${ORIGIN}/ext/bridge/blob/blob2`, mime: "image/png" },
		});
	});

	it("composite:四种段的判别键都是 `type`;图段换 URL,链接标题缺席时该格缺席", async () => {
		expect(
			await harness().sent({
				kind: "composite",
				segments: [
					{ kind: "text", text: "正文" },
					{ kind: "image", buffer: Buffer.from("JPG"), mime: "image/jpeg" },
					{ kind: "link", href: "https://example.com/v", title: "视频" },
					{ kind: "link", href: "https://example.com/bare" },
					{ kind: "at-all" },
				],
			}),
		).toEqual({
			...HEAD,
			message: {
				kind: "composite",
				segments: [
					{ type: "text", text: "正文" },
					{ type: "image", url: `${ORIGIN}/ext/bridge/blob/blob1`, mime: "image/jpeg" },
					{ type: "link", href: "https://example.com/v", title: "视频" },
					{ type: "link", href: "https://example.com/bare" },
					{ type: "at-all" },
				],
			},
		});
	});

	it("forward-images:kind 叫 `forward-images`,开关叫 `forward`,URL 原样透传不进 blob", async () => {
		expect(
			// 输入是内部的名字(`image-group` / `mergeForward`,图是 `PostImage`);带着的图库引用与 `isAnimated` 不上线。
			await harness().sent({
				kind: "image-group",
				images: [
					{
						ref: `${"a".repeat(64)}.jpg`,
						url: "https://i0.hdslb.com/1.jpg",
						width: 1080,
						height: 1920,
						isAnimated: false,
					},
					{ url: "https://i0.hdslb.com/2.jpg" },
				],
				mergeForward: true,
			}),
		).toEqual({
			...HEAD,
			message: {
				kind: "forward-images",
				images: [
					{ url: "https://i0.hdslb.com/1.jpg", width: 1080, height: 1920 },
					{ url: "https://i0.hdslb.com/2.jpg" },
				],
				forward: true,
			},
		});
	});

	it("image-group 里没有 url 的图(只带图库引用)不进帧", async () => {
		expect(
			await harness().sent({
				kind: "image-group",
				images: [{ ref: `${"a".repeat(64)}.jpg` }, { url: "https://i0.hdslb.com/2.jpg" }],
				mergeForward: false,
			}),
		).toEqual({
			...HEAD,
			message: {
				kind: "forward-images",
				images: [{ url: "https://i0.hdslb.com/2.jpg" }],
				forward: false,
			},
		});
	});

	it("miniapp-card:五格原样,不过 markdown 剥离", async () => {
		expect(
			await harness("unknown").sent({
				kind: "miniapp-card",
				title: "**视频**标题",
				desc: "简介",
				picUrl: "https://i0.hdslb.com/cover.jpg",
				path: "pages/video/video?bvid=BV1xx",
				jumpUrl: "https://www.bilibili.com/video/BV1xx",
			}),
		).toEqual({
			...HEAD,
			message: {
				kind: "miniapp-card",
				title: "**视频**标题",
				desc: "简介",
				picUrl: "https://i0.hdslb.com/cover.jpg",
				path: "pages/video/video?bvid=BV1xx",
				jumpUrl: "https://www.bilibili.com/video/BV1xx",
			},
		});
	});

	it("target.scope:`private: true` 覆盖成 private,其余照目标自己的 scope", async () => {
		const h = harness();
		const text: NotificationPayload = { kind: "text", text: "x" };
		expect(await h.sent(text, { private: true })).toMatchObject({
			target: { scope: "private", address: "-100", parentAddress: "-1" },
		});
		expect(await h.sent(text, { private: false })).toMatchObject({
			target: { scope: "group" },
		});
	});

	it("markdown 不是 supported 时文字被剥成纯文本(text / caption / 段文字 / 链接标题)", async () => {
		const h = harness("unknown");
		const out = (await h.sent({
			kind: "composite",
			segments: [
				{ kind: "text", text: "**粗**" },
				{ kind: "link", href: "https://example.com", title: "**标**" },
			],
		})) as { message: { segments: { text?: string; title?: string }[] } };
		// 具体剥成什么由 markdown.ts 的单测管;这里钉的是「走了剥离、没有星号」。
		expect(out.message.segments[0]?.text).not.toContain("*");
		expect(out.message.segments[1]?.title).not.toContain("*");
	});
});
