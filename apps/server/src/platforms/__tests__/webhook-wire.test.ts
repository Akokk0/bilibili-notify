/**
 * 刻画测试 — webhook 适配器**发到线上的报文**。
 *
 * 通用 webhook 把内部的 `NotificationPayload` 直接序列化出去(`kind: "forward-images"`、
 * `forward`、composite 段的 `type` 都是内部名),所以内部改名会静默改掉别人接收端看到的
 * JSON。这里把每种载荷的**完整请求体**钉成字面值:内部怎么改名,下面的期望值都不许动
 * (要改只能在适配器里映射回这些名字)。
 *
 * 钉的是今天的真实输出,看着别扭也照实钉 —— 例如 `private` 今天是 `!!pushOpts.private`
 * (「强制私聊标志」),不是写死的 false。
 *
 * 断言对象是 `JSON.parse(body)`:`undefined` 字段在线上不存在,用 toEqual 直接比内存对象
 * 会把「缺格」和「值是 undefined」混为一谈。fetch 用 stub,不打真实网络;`ts` 用假时钟。
 */

import type { Connection, NotificationPayload, PushTarget } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWebhookAdapter } from "../webhook.js";

const FIXED_NOW = new Date("2026-10-07T08:00:00.000Z");

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(FIXED_NOW);
	fetchMock = vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: "",
		text: async () => JSON.stringify({ errcode: 0, code: 0 }),
	}));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function connection(platform: string, secret?: string): Connection {
	return {
		id: "w1",
		name: "wh",
		platform,
		kind: "direct",
		connector: "webhook",
		enabled: true,
		config: { url: "http://hook.local/in", secret, headers: {} },
	} as unknown as Connection;
}

function target(over: Record<string, unknown> = {}): PushTarget {
	return {
		id: "wt1",
		name: "团队群",
		connectionId: "w1",
		kind: "endpoint",
		platform: "generic",
		scope: "group",
		enabled: true,
		...over,
	} as unknown as PushTarget;
}

/** 截住最近一次 POST 的请求体,按线上的样子(JSON 文本)解回来。 */
function sentBody(): unknown {
	const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
	return JSON.parse(init.body as string);
}

const PNG = Buffer.from("PNG-BYTES");
const JPG = Buffer.from("JPG-BYTES");

/** 五种载荷各一份有代表性的(composite 含 text / image / link / at-all 四种段)。 */
const PAYLOADS = {
	text: { kind: "text", text: "hello" },
	image: { kind: "image", image: { buffer: PNG, mime: "image/png" }, caption: "卡片标题" },
	composite: {
		kind: "composite",
		segments: [
			{ type: "text", text: "正文" },
			{ type: "image", buffer: JPG, mime: "image/jpeg" },
			{ type: "link", href: "https://example.com/v", title: "视频" },
			{ type: "link", href: "https://example.com/bare" },
			{ type: "at-all" },
		],
	},
	"forward-images": {
		kind: "forward-images",
		images: [
			{ url: "https://i0.hdslb.com/1.jpg", width: 1080, height: 1920 },
			{ url: "https://i0.hdslb.com/2.jpg" },
		],
		forward: true,
	},
	"miniapp-card": {
		kind: "miniapp-card",
		title: "视频标题",
		desc: "简介",
		picUrl: "https://i0.hdslb.com/cover.jpg",
		path: "pages/video/video?bvid=BV1xx",
		jumpUrl: "https://www.bilibili.com/video/BV1xx",
	},
} satisfies Record<NotificationPayload["kind"], NotificationPayload>;

const send = (
	platform: string,
	payload: NotificationPayload,
	pushOpts?: { private?: boolean },
	secret?: string,
) =>
	createWebhookAdapter({ logger }).send(connection(platform, secret), target(), payload, pushOpts);

describe("webhook 线上格式 — generic 通用 JSON", () => {
	const envelope = {
		targetId: "wt1",
		targetName: "团队群",
		scope: "group",
		private: false,
		ts: "2026-10-07T08:00:00.000Z",
	};

	it("text", async () => {
		await send("generic", PAYLOADS.text);
		expect(sentBody()).toEqual({ ...envelope, payload: { kind: "text", text: "hello" } });
	});

	it("image:Buffer 换成 base64,没有 caption 时该格缺席", async () => {
		await send("generic", PAYLOADS.image);
		expect(sentBody()).toEqual({
			...envelope,
			payload: {
				kind: "image",
				image: { mime: "image/png", data: PNG.toString("base64") },
				caption: "卡片标题",
			},
		});
		await send("generic", { kind: "image", image: { buffer: PNG, mime: "image/png" } });
		expect(sentBody()).toEqual({
			...envelope,
			payload: { kind: "image", image: { mime: "image/png", data: PNG.toString("base64") } },
		});
	});

	it("composite:段用判别键 `type`,图段 base64,其余段原样", async () => {
		await send("generic", PAYLOADS.composite);
		expect(sentBody()).toEqual({
			...envelope,
			payload: {
				kind: "composite",
				segments: [
					{ type: "text", text: "正文" },
					{ type: "image", mime: "image/jpeg", data: JPG.toString("base64") },
					{ type: "link", href: "https://example.com/v", title: "视频" },
					{ type: "link", href: "https://example.com/bare" },
					{ type: "at-all" },
				],
			},
		});
	});

	it("forward-images:kind 叫 `forward-images`,开关叫 `forward`", async () => {
		await send("generic", PAYLOADS["forward-images"]);
		expect(sentBody()).toEqual({
			...envelope,
			payload: {
				kind: "forward-images",
				images: [
					{ url: "https://i0.hdslb.com/1.jpg", width: 1080, height: 1920 },
					{ url: "https://i0.hdslb.com/2.jpg" },
				],
				forward: true,
			},
		});
	});

	it("miniapp-card:五格原样", async () => {
		await send("generic", PAYLOADS["miniapp-card"]);
		expect(sentBody()).toEqual({
			...envelope,
			payload: {
				kind: "miniapp-card",
				title: "视频标题",
				desc: "简介",
				picUrl: "https://i0.hdslb.com/cover.jpg",
				path: "pages/video/video?bvid=BV1xx",
				jumpUrl: "https://www.bilibili.com/video/BV1xx",
			},
		});
	});

	it("`private` 今天是「强制私聊标志」:传 true 才为 true,不传 / false 为 false", async () => {
		await send("generic", PAYLOADS.text, { private: true });
		expect(sentBody()).toMatchObject({ private: true, scope: "group" });
		await send("generic", PAYLOADS.text, { private: false });
		expect(sentBody()).toMatchObject({ private: false });
		await send("generic", PAYLOADS.text);
		expect(sentBody()).toMatchObject({ private: false });
	});

	it("请求头:content-type + secret 头", async () => {
		await send("generic", PAYLOADS.text, undefined, "s3cr3t");
		const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
		expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("http://hook.local/in");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"content-type": "application/json",
			"x-bilibili-notify-secret": "s3cr3t",
		});
	});
});

/**
 * 三个机器人方言(钉钉 / 飞书 / 企业微信)**不把内部名写到线上**:载荷先被压成一段文字,
 * 线上只有各家的 `text` 信封。但「怎么压」读的是 `payload.kind` 与段的 `type`,改名时
 * 映射写歪文字就变了 —— 所以五种载荷的文字也各钉一条。
 */
describe("webhook 线上格式 — 机器人方言(只有文字,无内部名)", () => {
	const TEXTS: Record<keyof typeof PAYLOADS, string> = {
		text: "hello",
		image: "卡片标题",
		composite: "正文\n[图片]\n视频 https://example.com/v\nhttps://example.com/bare\n@全体成员",
		"forward-images": "图片:\nhttps://i0.hdslb.com/1.jpg\nhttps://i0.hdslb.com/2.jpg",
		"miniapp-card": "视频标题\nhttps://www.bilibili.com/video/BV1xx",
	};

	const ENVELOPES: Record<string, (content: string) => unknown> = {
		dingtalk: (content) => ({ msgtype: "text", text: { content } }),
		feishu: (text) => ({ msg_type: "text", content: { text } }),
		wecom: (content) => ({ msgtype: "text", text: { content } }),
	};

	for (const [platform, wrap] of Object.entries(ENVELOPES)) {
		for (const kind of Object.keys(PAYLOADS) as (keyof typeof PAYLOADS)[]) {
			it(`${platform} × ${kind}`, async () => {
				await send(platform, PAYLOADS[kind]);
				expect(sentBody()).toEqual(wrap(TEXTS[kind]));
			});
		}
	}
});
