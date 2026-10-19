/**
 * 刻画测试 — webhook 适配器**发到线上的报文**。
 *
 * 通用 webhook 的 JSON 当初是把内部的 `NotificationPayload` 直接序列化出去的(`kind: "forward-images"`、
 * `forward`、composite 段的 `type` 都曾是内部名),所以内部改名会静默改掉别人接收端看到的
 * JSON。这里把每种载荷的**完整请求体**钉成字面值:内部怎么改名,下面的期望值都不许动
 * (要改只能在适配器里映射回这些名字;3a-16 起内部已改叫 `image-group` / `mergeForward` / `kind`,适配器在映射)。
 *
 * 钉的是今天的真实输出,看着别扭也照实钉 —— 例如 `private` 这一格已经没有「强制私聊」可表达,
 * 但线上格式冻结(ADR-0024 决策 5),所以留着、恒为 false。
 *
 * 断言对象是 `JSON.parse(body)`:`undefined` 字段在线上不存在,用 toEqual 直接比内存对象
 * 会把「缺格」和「值是 undefined」混为一谈。fetch 用 stub,不打真实网络;`ts` 用假时钟。
 */

import type { Connection, NotificationPayload, PushTarget } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { createWebhookAdapter } from "../webhook.js";

const FIXED_NOW = new Date("2026-10-07T08:00:00.000Z");

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(FIXED_NOW);
	fetchMock = vi.fn(
		async () => new Response(JSON.stringify({ errcode: 0, code: 0 }), { status: 200 }),
	);
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
		adapterKey: "webhook",
		platformSnapshot: snapshotFor(platform),
		enabled: true,
		settings: { url: "http://hook.local/in", secret, headers: {} },
	} as unknown as Connection;
}

function target(over: Record<string, unknown> = {}): PushTarget {
	return {
		id: "wt1",
		name: "团队群",
		connectionId: "w1",
		kind: "endpoint",
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

/**
 * 五种载荷各一份有代表性的(composite 含 text / image / link / at-all 四种段)。这里写的是**内部**的名字
 * (图集叫 `image-group`、开关叫 `mergeForward`、段的判别键叫 `kind`);下面的期望值是线上的名字,不跟着改。
 */
const PAYLOADS = {
	text: { kind: "text", text: "hello" },
	image: { kind: "image", image: { buffer: PNG, mime: "image/png" }, caption: "卡片标题" },
	composite: {
		kind: "composite",
		segments: [
			{ kind: "text", text: "正文" },
			{ kind: "image", buffer: JPG, mime: "image/jpeg" },
			{ kind: "link", href: "https://example.com/v", title: "视频" },
			{ kind: "link", href: "https://example.com/bare" },
			{ kind: "at-all" },
		],
	},
	// 图是 `PostImage`:带着的图库引用与 `isAnimated` 不上线,线上每张图只有 url / width / height。
	"image-group": {
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

const send = (platform: string, payload: NotificationPayload, secret?: string) => {
	const ad = createWebhookAdapter({ logger });
	ad.start(fakeAdapterContext().ctx);
	return ad.send(connection(platform, secret), target(), payload);
};

describe("webhook 线上格式 — generic 通用 JSON", () => {
	const envelope = {
		targetId: "wt1",
		targetName: "团队群",
		scope: "channel",
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
		await send("generic", PAYLOADS["image-group"]);
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

	it("image-group 里没有 url 的图(只带图库引用)不上线:`images` 里只有带 url 的", async () => {
		await send("generic", {
			kind: "image-group",
			images: [{ ref: `${"a".repeat(64)}.jpg` }, { url: "https://i0.hdslb.com/2.jpg" }],
			mergeForward: false,
		});
		expect(sentBody()).toEqual({
			...envelope,
			payload: {
				kind: "forward-images",
				images: [{ url: "https://i0.hdslb.com/2.jpg" }],
				forward: false,
			},
		});
		await send("dingtalk", {
			kind: "image-group",
			images: [{ ref: `${"a".repeat(64)}.jpg` }, { url: "https://i0.hdslb.com/2.jpg" }],
			mergeForward: false,
		});
		expect(sentBody()).toEqual({
			msgtype: "text",
			text: { content: "图片:\nhttps://i0.hdslb.com/2.jpg" },
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

	it("`private` 这一格留着、恒为 false(线上格式冻结,ADR-0024 决策 5):私聊目标也一样", async () => {
		await send("generic", PAYLOADS.text);
		expect(sentBody()).toMatchObject({ private: false, scope: "channel" });
		const ad = createWebhookAdapter({ logger });
		ad.start(fakeAdapterContext().ctx);
		await ad.send(connection("generic"), target({ scope: "private" }), PAYLOADS.text);
		expect(sentBody()).toMatchObject({ private: false, scope: "channel" });
	});

	it("请求头:content-type + secret 头", async () => {
		await send("generic", PAYLOADS.text, "s3cr3t");
		const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
		expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("http://hook.local/in");
		expect(init.method).toBe("POST");
		expect(Object.fromEntries(new Headers(init.headers).entries())).toEqual({
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
		"image-group": "图片:\nhttps://i0.hdslb.com/1.jpg\nhttps://i0.hdslb.com/2.jpg",
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
