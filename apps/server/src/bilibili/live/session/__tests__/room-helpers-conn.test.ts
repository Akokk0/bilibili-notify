import { fail, ok, type ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { failureFromBili } from "../../../error-codes.js";
import { connectLiveRoom } from "../../protocol/client.js";
import { RoomContext } from "../room-context.js";
import { LiveRoomAccessDeniedError, LiveRoomPreflightBlockedError } from "../room-helpers.js";

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
	const serviceCtx: ServiceContext = {
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
		openDanmakuSocket: vi.fn(() => fakeSocket),
		fetchLiveRoomInfo: vi.fn(),
		getMasterInfo: vi.fn(),
		fetchUserInfo: vi.fn(async () => ok({ data: {} })),
	};
	const ctx = new RoomContext({
		api: api as never,
		liveContext: serviceCtx,
		source: { subscriptions: () => [] } as never,
		problems: {
			reportRisk() {},
			resolveRisk() {},
			reportFailure() {},
			resolveFailure() {},
		},
		liveRoomIds: { get: () => undefined },
		rememberFanClubName() {},
		rememberSuperchatAvatar() {},
	});
	return { ctx, api };
}

beforeEach(() => {
	vi.mocked(connectLiveRoom).mockClear();
});

describe("startLiveRoomListener × 预检异常", () => {
	it("其他预检异常仍按可重试 setup 失败返回 false(不误伤成风控)", async () => {
		const { ctx } = makeCtx(async () => {
			throw new Error("ECONNRESET");
		});
		await expect(ctx.startLiveRoomListener("5050", () => {})).resolves.toBe(false);
	});
});

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
		for (let i = 0; i < 4; i++) {
			await ctx.startLiveRoomListener("5050", () => {});
			ctx.closeListener("5050");
		}
		expect(vi.mocked(connectLiveRoom).mock.calls.map((call) => call[0].hostList[0]?.host)).toEqual([
			"h1.example.com",
			"h2.example.com",
			"h3.example.com",
			"h1.example.com",
		]);
	});

	it("轮转只改次序不丢 host:每轮传给 client 的列表仍是全量", async () => {
		const { ctx } = makeCtx(async () => goodDanmakuInfo);
		await ctx.startLiveRoomListener("5050", () => {});
		ctx.closeListener("5050");
		await ctx.startLiveRoomListener("5050", () => {});
		for (const call of vi.mocked(connectLiveRoom).mock.calls) {
			expect(call[0].hostList.map((host) => host.host).sort()).toEqual([
				"h1.example.com",
				"h2.example.com",
				"h3.example.com",
			]);
		}
	});
});

describe("startLiveRoomListener × 取消竞态", () => {
	it("startLiveRoomListener 返回 true 但其间 cancelled 翻转 → 关闭孤儿 listener,不计成功", async () => {
		const { ctx } = makeCtx(async () => goodDanmakuInfo);
		let cancelled = false;
		const close = vi.fn();
		vi.mocked(connectLiveRoom).mockImplementationOnce((options) => {
			options.createSocket("wss://h1.example.com/sub");
			cancelled = true;
			return { closed: false, close };
		});

		await expect(
			ctx.startLiveRoomListener(
				"5050",
				() => {},
				() => cancelled,
			),
		).resolves.toBe(false);

		expect(close).toHaveBeenCalledTimes(1);
	});
});
