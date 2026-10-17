import { describe, expect, it } from "vite-plus/test";
import { LIVE_ROOM_INFO_STREAM_KEY_URL } from "../endpoints";
import { makeApi as makeBaseApi } from "./support/make-api";

/**
 * 复现并锁住「弹幕连接预检漏 wbi 签名」回归：B 站 getDanmuInfo 现在强制要 wbi 签名，
 * 不带 w_rid/wts 一律返回 code=-352。fetchLiveRoomInfoStreamKey 必须走 wbiGet，否则
 * 预检每次被风控拦截、一路回退直接建连，#810 的受限房识别形同空转。
 */
async function makeApi(
	reply: () => unknown = () => ({ code: 0, data: { token: "tok", host_list: [{ host: "x" }] } }),
) {
	const { api } = await makeBaseApi();
	const calls: string[] = [];
	// 注入 mock client + 预置非空 wbiKeys（imgKey 非空 → getWbi 不触发 updateBiliTicket 联网）
	// fetch 传输层的 client.get 直接返回响应体（无 axios 的 .data 包裹）
	(api as unknown as { client: { get(url: string): Promise<unknown> } }).client = {
		get: async (url: string) => {
			calls.push(url);
			return reply();
		},
	};
	(api as unknown as { wbiKeys: { imgKey: string; subKey: string } }).wbiKeys = {
		imgKey: "a".repeat(32),
		subKey: "b".repeat(32),
	};
	return { api, calls };
}

describe("fetchLiveRoomInfoStreamKey 弹幕连接预检", () => {
	it("请求必须带 wbi 签名（w_rid + wts），否则 B 站固定 -352", async () => {
		const { api, calls } = await makeApi();
		const res = await api.fetchLiveRoomInfoStreamKey("6154037");

		expect(calls).toHaveLength(1);
		const url = calls[0];
		expect(url).toContain(LIVE_ROOM_INFO_STREAM_KEY_URL);
		expect(url).toContain("id=6154037");
		expect(url).toMatch(/[?&]wts=\d+/);
		expect(url).toMatch(/[?&]w_rid=[a-f0-9]{32}/);
		expect(res).toEqual({ ok: true, data: { token: "tok", host_list: [{ host: "x" }] } });
	});

	// 持续 -352:wbiGet 刷新签名重试后仍 -352 会抛 RiskControlError,请求层把它翻成同一个 rate_limited 失败,
	// 预检只看标准码(room-helpers-conn.test.ts 钉「rate_limited → 长尾」)。
	it("持续 -352(刷新 wbiKeys 重试后仍被拒)→ rate_limited,upstreamCode 是 -352,不抛", async () => {
		const { api, calls } = await makeApi(() => ({ code: -352, message: "风控" }));
		// 重试那一次要重取 ticket:这里让它直接补上 key,不联网
		(api as unknown as { updateBiliTicket(): Promise<void> }).updateBiliTicket = async () => {
			(api as unknown as { wbiKeys: unknown }).wbiKeys = {
				imgKey: "a".repeat(32),
				subKey: "b".repeat(32),
			};
		};

		const res = await api.fetchLiveRoomInfoStreamKey("6154037");

		expect(calls).toHaveLength(2);
		expect(res).toMatchObject({ ok: false, code: "rate_limited", upstreamCode: -352 });
	});

	it.each([
		[-412, "rate_limited"],
		[-403, "unknown"],
		[-101, "unauthorized"],
	] as const)("B 站回 %i → %s,原话与原码都带着", async (code, standard) => {
		const { api } = await makeApi(() => ({ code, message: "原话" }));

		expect(await api.fetchLiveRoomInfoStreamKey("6154037")).toEqual({
			ok: false,
			code: standard,
			message: "原话",
			upstreamCode: code,
		});
	});
});
