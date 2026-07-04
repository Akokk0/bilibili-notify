import { describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";

/**
 * ⑤ 风控收敛:持续 -352 的 wbi 签名请求不该被外层 this.retry 快速重试放大。
 *
 * wbiGet 内部已有「清 wbiKeys 重取 ticket 重试一次」的自愈;但持续 -352 时它抛错,
 * 旧行为让外层 this.retry(4 次)把同一套刷新+重试再跑 3 遍 → 最坏 ~8 次 GET + 3 次
 * ticket POST 打在正被风控的账号上。改为抛「不可重试」的风控错误,外层 fail-fast。
 *
 * 单次 -352 的自愈(刷新后成功)必须保留,不能误伤。
 */
function makeApi(getImpl: (url: string) => unknown) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: {} as never,
		callbacks: {},
	});
	const calls = { get: 0, post: 0 };
	(
		api as unknown as {
			client: { get(url: string): Promise<unknown>; postForm(url: string): Promise<unknown> };
		}
	).client = {
		get: async (url: string) => {
			calls.get++;
			return getImpl(url);
		},
		// 清 wbiKeys 后 getWbi 会触发 updateBiliTicket → 这里回一张可解析的 ticket。
		postForm: async () => {
			calls.post++;
			return {
				code: 0,
				data: {
					nav: { img: `https://x/${"a".repeat(32)}.png`, sub: `https://x/${"b".repeat(32)}.png` },
				},
			};
		},
	};
	(api as unknown as { wbiKeys: { imgKey: string; subKey: string } }).wbiKeys = {
		imgKey: "a".repeat(32),
		subKey: "b".repeat(32),
	};
	return { api, calls };
}

describe("wbiGet 持续 -352 收敛", () => {
	it("持续 -352 → 抛错但不被外层 retry 放大(GET 次数收敛,不是 4 轮)", async () => {
		const { api, calls } = makeApi(() => ({ code: -352 }));
		await expect(api.getUserInfo("123")).rejects.toThrow();
		// 一轮 wbiGet 至多 2 次 GET(首发 + 刷新后重试一次);外层不再重跑 3 轮。
		expect(calls.get).toBeLessThanOrEqual(2);
	});

	it("回归:单次 -352 刷新 wbiKeys 后成功 —— 自愈保留", async () => {
		let n = 0;
		const { api } = makeApi(() => {
			n++;
			return n === 1 ? { code: -352 } : { code: 0, data: { ok: true } };
		});
		const res = (await api.getUserInfo("123")) as { code: number };
		expect(res.code).toBe(0);
	});
});
