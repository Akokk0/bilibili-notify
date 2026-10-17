/**
 * startLiveRoomListener 的预检异常映射与 host 轮转(真 RoomContext + 假 api):
 *
 * - 持续 -352 由请求层翻成 rate_limited 失败(见 api/__tests__/live-room-stream-key.test.ts)—— 必须映射成
 *   LiveRoomPreflightBlockedError 交给长尾退避,
 *   否则「-352 永不放弃」在生产链路上整条不可达(吞成 return false,
 *   房间被当普通失败在 31s 内放弃)。
 * - host_list 按建连轮次轮转:首个 host 从用户网络不可达时,重连不至于永远
 *   钉死在死 host 上烧光梯子(被换掉的旧库会跨 host 回退)。
 * - 建连走 api 的弹幕建连口(`openDanmakuSocket`):握手头(身份、cookie)归它背后的
 *   客户端装配,这里不再自己拼 Cookie / User-Agent。
 */

import { fail, ok, type ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { failureFromBili } from "../../../error-codes.js";
import { connectLiveRoom } from "../../protocol/client.js";
import type { RoomContextOptions } from "../room-context";
import {
	LiveRoomAccessDeniedError,
	LiveRoomPreflightBlockedError,
	RoomContext,
} from "../room-helpers";

vi.mock("../../protocol/client.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../protocol/client.js")>();
	return {
		...mod,
		connectLiveRoom: vi.fn(() => ({ closed: false, close: vi.fn() })),
	};
});

const goodDanmakuInfo = ok({
	data: {
		token: "tok",
		host_list: [
			{ host: "h1.example.com", wss_port: 443 },
			{ host: "h2.example.com", wss_port: 2245 },
			{ host: "h3.example.com", wss_port: 443 },
		],
	},
});

const fakeSocket = { binaryType: "", on() {}, send() {}, close() {} };

function makeCtx(streamKeyImpl: () => Promise<unknown>) {
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const api = {
		fetchLiveRoomInfoStreamKey: vi.fn(streamKeyImpl),
		getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 42 } })),
		getBuvid3: vi.fn(async () => "buv"),
		openDanmakuSocket: vi.fn((_url: string) => fakeSocket),
		fetchUserInfoInLive: vi.fn(async (_viewer: string, _up: string) =>
			failureFromBili(-352, "风控"),
		),
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
		imageFetcher: { fetchImage: vi.fn() },
		config: {},
		emitEngineError: vi.fn(),
	} as unknown as RoomContextOptions);
	return { ctx, api };
}

beforeEach(() => {
	vi.mocked(connectLiveRoom).mockClear();
});

describe("startLiveRoomListener × 预检异常", () => {
	// 持续 -352(wbiGet 刷新签名重试后仍 -352)由请求层翻成 rate_limited 失败,见
	// api/__tests__/live-room-stream-key.test.ts;下面「预检读标准码」那组钉住 rate_limited → 长尾。
	it("其他预检异常仍按可重试 setup 失败返回 false(不误伤成风控)", async () => {
		const { ctx } = makeCtx(async () => {
			throw new Error("ECONNRESET");
		});

		await expect(ctx.startLiveRoomListener("5050", () => {})).resolves.toBe(false);
	});
});

/**
 * 预检读请求层翻好的标准码(3b-18):风控类(-352 / -412 / -799 / -509 → rate_limited)走长尾、不判受限房;
 * -403 与没对照的码仍当受限房(B 站对加密 / 付费 / 测试房回什么码没核,R3);-101 不是受限房,是登录的事。
 */
describe("startLiveRoomListener × 预检读标准码", () => {
	it.each([-352, -412, -799, -509])(
		"预检回 %i(rate_limited)→ LiveRoomPreflightBlockedError(长尾),不判受限房",
		async (code) => {
			const { ctx } = makeCtx(async () => failureFromBili(code, "被拦截"));

			await expect(ctx.startLiveRoomListener("5050", () => {})).rejects.toBeInstanceOf(
				LiveRoomPreflightBlockedError,
			);
		},
	);

	it("预检回 -403 → 受限房(接口自己判,不进共用表)", async () => {
		const { ctx } = makeCtx(async () => failureFromBili(-403, "无权限"));

		await expect(ctx.startLiveRoomListener("5050", () => {})).rejects.toMatchObject({
			name: "LiveRoomAccessDeniedError",
			reason: "B 站返回 code=-403 message=无权限",
		});
	});

	it("预检回没对照的码 → 仍是受限房(R3:取证靠请求层的 warn)", async () => {
		const { ctx } = makeCtx(async () => failureFromBili(4101132, "没见过"));

		await expect(ctx.startLiveRoomListener("5050", () => {})).rejects.toBeInstanceOf(
			LiveRoomAccessDeniedError,
		);
	});

	it("预检回 -101(unauthorized)→ 不是受限房:当弹幕连接没建起来,返回 false", async () => {
		const { ctx } = makeCtx(async () => failureFromBili(-101, "账号未登录"));

		await expect(ctx.startLiveRoomListener("5050", () => {})).resolves.toBe(false);
	});

	it("预检回应形状不对(unavailable)→ 一时失败,返回 false", async () => {
		const { ctx } = makeCtx(async () => fail("unavailable", "回应不是预期的形状"));

		await expect(ctx.startLiveRoomListener("5050", () => {})).resolves.toBe(false);
	});

	it("预检成功但没有 data / token / 服务器列表 → 受限房", async () => {
		for (const data of [null, { host_list: [{ host: "h", wss_port: 443 }] }, { token: "t" }]) {
			const { ctx } = makeCtx(async () => ok({ data }));
			await expect(ctx.startLiveRoomListener("5050", () => {})).rejects.toBeInstanceOf(
				LiveRoomAccessDeniedError,
			);
		}
	});
});

// 接线:RoomContext 自己造一个观众头像部件,用的是它手里的 api;冷却是它(也就是全引擎)共用的状态。
describe("RoomContext × 观众头像冷却", () => {
	it("头像查询撞到限流后,同一个 ctx 上别的上舰(哪个房间都一样)在冷却里不再查接口", async () => {
		const { ctx, api } = makeCtx(async () => goodDanmakuInfo);

		expect(await ctx.viewerAvatars.fetch("7", "u1")).toBeUndefined();
		expect(await ctx.viewerAvatars.fetch("8", "u2")).toBeUndefined();

		expect(api.fetchUserInfoInLive).toHaveBeenCalledExactlyOnceWith("7", "u1");
	});
});

describe("startLiveRoomListener × 建连口", () => {
	it("createSocket 接的是 api 的弹幕建连口:真调一次,地址原样交给它,拿回的 socket 原样交出去", async () => {
		const { ctx, api } = makeCtx(async () => goodDanmakuInfo);
		await ctx.startLiveRoomListener("5050", () => {});

		const options = vi.mocked(connectLiveRoom).mock.calls[0]?.[0];
		if (!options) throw new Error("connectLiveRoom 没被调用");
		expect(api.openDanmakuSocket).not.toHaveBeenCalled();
		const socket = options.createSocket("wss://h1.example.com/sub");
		expect(api.openDanmakuSocket).toHaveBeenCalledExactlyOnceWith("wss://h1.example.com/sub");
		expect(socket).toBe(fakeSocket);
	});

	it("不再自己拼握手头:交给 blive 的参数里没有 cookieHeader / userAgent", async () => {
		const { ctx } = makeCtx(async () => goodDanmakuInfo);
		await ctx.startLiveRoomListener("5050", () => {});

		const options = vi.mocked(connectLiveRoom).mock.calls[0]?.[0];
		expect(Object.keys(options ?? {})).not.toContain("cookieHeader");
		expect(Object.keys(options ?? {})).not.toContain("userAgent");
	});
});

describe("startLiveRoomListener × host 轮转", () => {
	it("每轮建连换下一个 host,轮完回卷 —— 不钉死 host_list 首项", async () => {
		const { ctx } = makeCtx(async () => goodDanmakuInfo);
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
		const { ctx } = makeCtx(async () => goodDanmakuInfo);
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
