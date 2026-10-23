import { describe, expect, it } from "vite-plus/test";
import { makeApi as makeBaseApi } from "./support/make-api";

/**
 * ⑤ 风控收敛:持续 -352 的 wbi 签名请求不该被外层 this.retry 快速重试放大。
 *
 * wbiGet 内部已有「清 wbiKeys 重取 ticket 重试一次」的自愈;但持续 -352 时它抛错,
 * 旧行为让外层 this.retry(4 次)把同一套刷新+重试再跑 3 遍 → 最坏 ~8 次 GET + 3 次
 * ticket POST 打在正被风控的账号上。改为抛「不可重试」的风控错误,外层 fail-fast。
 *
 * 单次 -352 的自愈(刷新后成功)必须保留,不能误伤。
 */
async function makeApi(getImpl: (url: string) => unknown) {
	const { api } = await makeBaseApi();
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
	it("持续 -352 → rate_limited,不被外层 retry 放大(GET 次数收敛,不是 4 轮)", async () => {
		const { api, calls } = await makeApi(() => ({ code: -352 }));
		expect(await api.fetchUserInfo("123")).toMatchObject({
			ok: false,
			code: "rate_limited",
			upstreamCode: -352,
		});
		// 一轮 wbiGet 至多 2 次 GET(首发 + 刷新后重试一次);外层不再重跑 3 轮。
		expect(calls.get).toBeLessThanOrEqual(2);
	});

	it("回归:单次 -352 刷新 wbiKeys 后成功 —— 自愈保留", async () => {
		let n = 0;
		const { api } = await makeApi(() => {
			n++;
			return n === 1 ? { code: -352 } : { code: 0, data: { ok: true } };
		});
		expect(await api.fetchUserInfo("123")).toEqual({
			ok: true,
			data: { ok: true },
		});
	});
});
