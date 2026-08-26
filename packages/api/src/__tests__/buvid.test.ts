import { describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";
import { GET_FINGER_SPI } from "../endpoints";

/**
 * 弹幕连接认证包需要**真** buvid3。cookie 罐里的那条是 loadCookies 填的占位假值
 * (`some_non_empty_value`),进认证包会露馅;真值只能问 finger/spi。
 * 设备指纹与登录态无关,同一进程内取一次缓存即可。
 */
function makeApi() {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: { userAgent: "test-UA" } as never,
		callbacks: {},
	});
	const calls: string[] = [];
	(api as unknown as { client: { get(url: string): Promise<unknown> } }).client = {
		get: async (url: string) => {
			calls.push(url);
			return { code: 0, data: { b_3: "real-buvid3-value", b_4: "b4" } };
		},
	};
	return { api, calls };
}

describe("getBuvid3", () => {
	it("向 finger/spi 要真 buvid3", async () => {
		const { api, calls } = makeApi();

		await expect(api.getBuvid3()).resolves.toBe("real-buvid3-value");
		expect(calls).toEqual([GET_FINGER_SPI]);
	});

	it("同进程缓存,第二次不再联网", async () => {
		const { api, calls } = makeApi();
		await api.getBuvid3();
		await api.getBuvid3();

		expect(calls).toHaveLength(1);
	});

	it("接口失败时返回空串,不抛 —— 认证包缺 buvid 仍可尝试", async () => {
		const { api, calls } = makeApi();
		(api as unknown as { client: { get(url: string): Promise<unknown> } }).client = {
			get: async (url: string) => {
				calls.push(url);
				throw new Error("network down");
			},
		};

		await expect(api.getBuvid3()).resolves.toBe("");
		// 失败不缓存,下次调用还会联网再试(底层 retry 的具体次数不在此约束)
		const afterFirst = calls.length;
		await api.getBuvid3();
		expect(calls.length).toBeGreaterThan(afterFirst);
	});
});
