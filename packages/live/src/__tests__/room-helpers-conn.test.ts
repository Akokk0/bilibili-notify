/**
 * startLiveRoomListener 的预检异常映射与 host 轮转(真 RoomContext + 假 api):
 *
 * - 持续 -352 经 wbiGet 以 **RiskControlError 异常**到达(它绝不把 -352 body
 *   返回给调用方)—— 必须映射成 LiveRoomPreflightBlockedError 交给长尾退避,
 *   否则「-352 永不放弃」在生产链路上整条不可达(catch 吞成 return false,
 *   房间被当普通失败在 31s 内放弃)。
 * - host_list 按建连轮次轮转:首个 host 从用户网络不可达时,重连不至于永远
 *   钉死在死 host 上烧光梯子(被换掉的旧库会跨 host 回退)。
 */

import { RiskControlError } from "@bilibili-notify/api";
import { connectLiveRoom } from "@bilibili-notify/blive";
import type { ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RoomContextOptions } from "../room-context";
import { LiveRoomPreflightBlockedError, RoomContext } from "../room-helpers";

vi.mock("@bilibili-notify/blive", async (importOriginal) => {
	const mod = await importOriginal<typeof import("@bilibili-notify/blive")>();
	return {
		...mod,
		connectLiveRoom: vi.fn(() => ({ closed: false, close: vi.fn() })),
	};
});

const goodDanmuInfo = {
	code: 0,
	data: {
		token: "tok",
		host_list: [
			{ host: "h1.example.com", wss_port: 443 },
			{ host: "h2.example.com", wss_port: 2245 },
			{ host: "h3.example.com", wss_port: 443 },
		],
	},
};

function makeCtx(streamKeyImpl: () => Promise<unknown>) {
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const api = {
		getLiveRoomInfoStreamKey: vi.fn(streamKeyImpl),
		getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 42 } })),
		getBuvid3: vi.fn(async () => "buv"),
		getCookiesHeader: () => "SESSDATA=x",
		getUserAgent: () => "UA/1.0",
	};
	const ctx = new RoomContext({
		serviceCtx: fakeServiceCtx,
		api,
		push: {},
		contentBuilder: {},
		templateRenderer: {},
		wordcloudGenerator: {},
		liveSummaryRequester: {},
		danmakuCollector: {},
		getImageRenderer: () => null,
		config: {},
		emitEngineError: vi.fn(),
	} as unknown as RoomContextOptions);
	return { ctx, api };
}

beforeEach(() => {
	vi.mocked(connectLiveRoom).mockClear();
});

describe("startLiveRoomListener × 持续风控", () => {
	it("预检抛 RiskControlError → 映射成 LiveRoomPreflightBlockedError 交给长尾", async () => {
		const { ctx } = makeCtx(async () => {
			throw new RiskControlError("[wbi] 刷新 wbiKeys 后仍 -352(WBI 签名持续被拒/风控)");
		});

		await expect(ctx.startLiveRoomListener("5050", () => {})).rejects.toBeInstanceOf(
			LiveRoomPreflightBlockedError,
		);
	});

	it("其他预检异常仍按可重试 setup 失败返回 false(不误伤成风控)", async () => {
		const { ctx } = makeCtx(async () => {
			throw new Error("ECONNRESET");
		});

		await expect(ctx.startLiveRoomListener("5050", () => {})).resolves.toBe(false);
	});
});

describe("startLiveRoomListener × host 轮转", () => {
	it("每轮建连换下一个 host,轮完回卷 —— 不钉死 host_list 首项", async () => {
		const { ctx } = makeCtx(async () => goodDanmuInfo);
		const onEvent = () => {};

		for (let i = 0; i < 4; i++) {
			await ctx.startLiveRoomListener("5050", onEvent);
			ctx.closeListener("5050"); // 模拟重连循环每轮顶部的 close
		}

		const firstHosts = vi.mocked(connectLiveRoom).mock.calls.map((c) => c[0].hostList[0]?.host);
		expect(firstHosts).toEqual([
			"h1.example.com",
			"h2.example.com",
			"h3.example.com",
			"h1.example.com",
		]);
	});

	it("轮转只改次序不丢 host:每轮传给 client 的列表仍是全量", async () => {
		const { ctx } = makeCtx(async () => goodDanmuInfo);
		const onEvent = () => {};
		await ctx.startLiveRoomListener("5050", onEvent);
		ctx.closeListener("5050");
		await ctx.startLiveRoomListener("5050", onEvent);

		for (const call of vi.mocked(connectLiveRoom).mock.calls) {
			expect(call[0].hostList.map((h) => h.host).sort()).toEqual([
				"h1.example.com",
				"h2.example.com",
				"h3.example.com",
			]);
		}
	});
});
