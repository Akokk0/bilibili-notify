import { describe, expect, it } from "vitest";
import { BilibiliAPI } from "../bilibili-api";
import { GET_LIVE_ROOM_INFO_STREAM_KEY } from "../endpoints";

/**
 * 复现并锁住「弹幕连接预检漏 wbi 签名」回归：B 站 getDanmuInfo 现在强制要 wbi 签名，
 * 不带 w_rid/wts 一律返回 code=-352。getLiveRoomInfoStreamKey 必须走 wbiGet，否则
 * 预检每次被风控拦截、一路回退直接建连，#810 的受限房识别形同空转。
 */
function makeApi() {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: { userAgent: "test-UA" } as never,
		callbacks: {},
	});
	const calls: string[] = [];
	// 注入 mock client + 预置非空 wbiKeys（imgKey 非空 → getWbi 不触发 updateBiliTicket 联网）
	(api as unknown as { client: { get(url: string): Promise<unknown> } }).client = {
		get: async (url: string) => {
			calls.push(url);
			return { data: { code: 0, data: { token: "tok", host_list: [{ host: "x" }] } } };
		},
	};
	(api as unknown as { wbiKeys: { imgKey: string; subKey: string } }).wbiKeys = {
		imgKey: "a".repeat(32),
		subKey: "b".repeat(32),
	};
	return { api, calls };
}

describe("getLiveRoomInfoStreamKey 弹幕连接预检", () => {
	it("请求必须带 wbi 签名（w_rid + wts），否则 B 站固定 -352", async () => {
		const { api, calls } = makeApi();
		const res = await api.getLiveRoomInfoStreamKey("6154037");

		expect(calls).toHaveLength(1);
		const url = calls[0];
		expect(url).toContain(GET_LIVE_ROOM_INFO_STREAM_KEY);
		expect(url).toContain("id=6154037");
		expect(url).toMatch(/[?&]wts=\d+/);
		expect(url).toMatch(/[?&]w_rid=[a-f0-9]{32}/);
		expect((res as { code: number }).code).toBe(0);
	});
});
