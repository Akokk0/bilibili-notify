/**
 * 链接解析要的两样网络能力:按 BV/av 号取单个视频的信息,以及把 b23.tv 短链
 * 解成落地地址。
 *
 * 短链解析只看重定向的 Location、不跟过去 —— 落地页是整张 HTML,我们只要地址;
 * 而且只认落在 bilibili.com 的目标:短链是别人贴的,跟到哪儿就是让谁指挥我们。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";
import { BiliCookieJar } from "../cookie-jar";
import { GET_VIDEO_INFO } from "../endpoints";
import { BiliHttpClient } from "../http-client";

/** 真实接口 data 的形状(字段照 x/web-interface/view 抓包裁剪)。 */
const RAW_VIDEO = {
	bvid: "BV1zMtU6uEEb",
	aid: 114514,
	videos: 1,
	tid: 21,
	tname: "日常",
	pic: "http://i0.hdslb.com/bfs/archive/cover.jpg",
	title: "示例标题",
	pubdate: 1756800000,
	desc: "示例简介",
	duration: 754,
	owner: { mid: 12345, name: "示例UP", face: "http://i0.hdslb.com/bfs/face/face.jpg" },
	stat: { view: 65000, danmaku: 120, reply: 30, favorite: 400, coin: 200, share: 15, like: 3000 },
	extra_field_we_do_not_care_about: true,
};

function makeApi(respond: (url: string) => unknown, redirects: Record<string, string | null> = {}) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: {} as never,
		callbacks: {},
	});
	const calls: string[] = [];
	const redirectCalls: string[] = [];
	(api as unknown as { client: unknown }).client = {
		get: async (url: string) => {
			calls.push(url);
			return respond(url);
		},
		redirectLocation: async (url: string) => {
			redirectCalls.push(url);
			return redirects[url] ?? null;
		},
	};
	return { api, calls, redirectCalls };
}

describe("getVideoInfo", () => {
	it("按 bvid 打到 web-interface/view,回来的是裁剪过的视频信息", async () => {
		const { api, calls } = makeApi(() => ({ code: 0, message: "0", data: RAW_VIDEO }));
		const info = await api.getVideoInfo({ bvid: "BV1zMtU6uEEb" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(GET_VIDEO_INFO);
		expect(calls[0]).toContain("bvid=BV1zMtU6uEEb");
		expect(info).toEqual({
			bvid: "BV1zMtU6uEEb",
			aid: 114514,
			title: "示例标题",
			pic: "http://i0.hdslb.com/bfs/archive/cover.jpg",
			desc: "示例简介",
			duration: 754,
			pubdate: 1756800000,
			tname: "日常",
			owner: { mid: 12345, name: "示例UP", face: "http://i0.hdslb.com/bfs/face/face.jpg" },
			stat: {
				view: 65000,
				danmaku: 120,
				reply: 30,
				favorite: 400,
				coin: 200,
				share: 15,
				like: 3000,
			},
		});
	});

	it("按 av 号则带 aid 参数", async () => {
		const { api, calls } = makeApi(() => ({ code: 0, message: "0", data: RAW_VIDEO }));
		await api.getVideoInfo({ aid: "170001" });
		expect(calls[0]).toContain("aid=170001");
		expect(calls[0]).not.toContain("bvid=");
	});

	it("接口报错(视频不存在 / 不可见)就抛,带上对方的说法", async () => {
		const { api } = makeApi(() => ({ code: -404, message: "啥都木有", data: null }));
		await expect(api.getVideoInfo({ bvid: "BV1zMtU6uEEb" })).rejects.toThrow(/啥都木有/);
	});
});

describe("resolveShortLink", () => {
	it("b23.tv 短链解成 bilibili.com 的落地地址", async () => {
		const { api, redirectCalls } = makeApi(() => null, {
			"https://b23.tv/abc123": "https://www.bilibili.com/video/BV1zMtU6uEEb?share_source=copy_web",
		});
		await expect(api.resolveShortLink("https://b23.tv/abc123")).resolves.toBe(
			"https://www.bilibili.com/video/BV1zMtU6uEEb?share_source=copy_web",
		);
		expect(redirectCalls).toEqual(["https://b23.tv/abc123"]);
	});

	it("落到别的域名不算数;没有重定向也不算数", async () => {
		const { api } = makeApi(() => null, {
			"https://b23.tv/evil": "https://evil.example/phish",
			"https://b23.tv/dead": null,
		});
		await expect(api.resolveShortLink("https://b23.tv/evil")).resolves.toBeNull();
		await expect(api.resolveShortLink("https://b23.tv/dead")).resolves.toBeNull();
	});

	it("不是 b23.tv 的地址根本不去连", async () => {
		const { api, redirectCalls } = makeApi(() => null, {
			"https://evil.example/x": "https://www.bilibili.com/video/BV1zMtU6uEEb",
		});
		await expect(api.resolveShortLink("https://evil.example/x")).resolves.toBeNull();
		expect(redirectCalls).toEqual([]);
	});
});

describe("BiliHttpClient.redirectLocation", () => {
	let server: Server;
	let baseURL: string;
	let hits: string[];

	beforeEach(async () => {
		hits = [];
		server = createServer((req, res) => {
			hits.push(`${req.method} ${req.url}`);
			if (req.url === "/hop") {
				res.statusCode = 302;
				res.setHeader("Location", "/landing?x=1");
				res.end();
			} else {
				res.statusCode = 200;
				res.end("<html>landing</html>");
			}
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterEach(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	it("只取第一跳的 Location(补成绝对地址),不跟过去", async () => {
		const client = new BiliHttpClient({ jar: new BiliCookieJar() });
		await expect(client.redirectLocation(`${baseURL}/hop`)).resolves.toBe(`${baseURL}/landing?x=1`);
		expect(hits).toEqual(["GET /hop"]);
	});

	it("没有重定向就是 null", async () => {
		const client = new BiliHttpClient({ jar: new BiliCookieJar() });
		await expect(client.redirectLocation(`${baseURL}/landing`)).resolves.toBeNull();
	});
});
