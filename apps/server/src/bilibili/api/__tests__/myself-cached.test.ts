import { describe, expect, it } from "vite-plus/test";
import { MYSELF_INFO_URL } from "../endpoints";
import { makeApi as makeBaseApi } from "./support/make-api";

/**
 * getMyselfInfoCached 挂在客户端上、被直播建连 / 卡片预览共享:
 *   - 连续调用去重(命中缓存),只落一次 MYSELF_INFO_URL;
 *   - 登出(clearCookies)后缓存失效,下次真调 —— 换号不会用旧账号身份。
 */
function makeApi() {
	const { api } = makeBaseApi();
	let myselfCalls = 0;
	const mockClient = {
		get: async (url: string) => {
			if (url.startsWith(MYSELF_INFO_URL)) myselfCalls++;
			return { code: 0, data: { mid: 1, uname: "me", face: "f" } };
		},
	};
	const inject = () => {
		(api as unknown as { client: typeof mockClient }).client = mockClient;
	};
	inject();
	return { api, inject, calls: () => myselfCalls };
}

describe("Api.getMyselfInfoCached", () => {
	it("连续调用去重,只落一次 MYSELF_INFO_URL", async () => {
		const { api, calls } = makeApi();
		await Promise.all([api.getMyselfInfoCached(), api.getMyselfInfoCached()]);
		await api.getMyselfInfoCached();
		expect(calls()).toBe(1);
	});

	it("clearCookies(登出/换号)后缓存失效,下次真调", async () => {
		const { api, inject, calls } = makeApi();
		await api.getMyselfInfoCached();
		expect(calls()).toBe(1);
		await api.clearCookies(); // 会 invalidate + 重建 client
		inject(); // clearCookies 里 initClient 换掉了 client,测试重新注入 mock
		await api.getMyselfInfoCached();
		expect(calls()).toBe(2); // 缓存已清 → 又真调了一次
	});
});
