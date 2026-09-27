import { afterEach, describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";

/**
 * 开机不碰 B 站:start() 只起 HTTP 客户端与每日 ticket 定时,不预取 ticket。
 *
 * 预取是插件年代带过来的,且 start() 会 await 它 —— 开机那一刻连不上 api.bilibili.com
 * (断网、B 站故障、所在网络屏蔽 B 站,或 ticket 接口回了风控码)时 start() 抛错,
 * createAuthSystem 把它当致命错误,整台 BN 起不来。WBI 签名在 key 为空时本来就会现取
 * ticket(getWbi,带在途去重),预取省不下什么。
 *
 * 测试运行里连外网会被根 setup 的守卫拦下(scripts/network-guard.mjs),所以 start()
 * 一旦又去联网,第一条就会红。
 */
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeApi() {
	return new BilibiliAPI({ serviceCtx: { logger } as never, config: {} as never, callbacks: {} });
}

describe("开机不碰 B 站", () => {
	let api: BilibiliAPI | undefined;
	afterEach(() => api?.stop());

	it("start() 不联网,连不上 B 站也照样起来", async () => {
		api = makeApi();
		await expect(api.start()).resolves.toBeUndefined();
	});

	it("第一次签名请求时才现取 ticket,只取一次", async () => {
		api = makeApi();
		await api.start();
		const calls: string[] = [];
		(
			api as unknown as {
				client: { get(url: string): Promise<unknown>; postForm(url: string): Promise<unknown> };
			}
		).client = {
			get: async (url: string) => {
				calls.push(`GET ${new URL(url).pathname}`);
				return { code: 0, data: {} };
			},
			postForm: async (url: string) => {
				calls.push(`POST ${new URL(url).pathname}`);
				return {
					code: 0,
					data: {
						nav: { img: `https://x/${"a".repeat(32)}.png`, sub: `https://x/${"b".repeat(32)}.png` },
					},
				};
			},
		};
		await Promise.all([api.getUserInfo("1"), api.getUserInfo("2")]);
		expect(calls.filter((c) => c.startsWith("POST"))).toEqual([
			"POST /bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket",
		]);
		expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(2);
	});
});
