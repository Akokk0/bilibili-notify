import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../../push-like";
import type { RoomContextOptions } from "../room-context";
import {
	describeLiveRoomDanmakuAccessDenied,
	describeLiveRoomDanmakuPreflightFallback,
	RoomContext,
} from "../room-helpers";

describe("describeLiveRoomDanmakuAccessDenied", () => {
	it("accepts a complete danmu info response", () => {
		expect(
			describeLiveRoomDanmakuAccessDenied({
				code: 0,
				data: { token: "token", host_list: [{ host: "example.com" }] },
			}),
		).toBeUndefined();
	});

	it("rejects upstream non-zero responses without exposing token-like data", () => {
		expect(
			describeLiveRoomDanmakuAccessDenied({
				code: -400,
				message: "room is encrypted",
				data: null,
			}),
		).toBe("B 站返回 code=-400 message=room is encrypted");
	});

	it("treats -352 as preflight risk-control fallback instead of hard denial", () => {
		const info = {
			code: -352,
			message: "-352",
			data: null,
		};
		expect(describeLiveRoomDanmakuPreflightFallback(info)).toBe("B 站返回 code=-352 message=-352");
		expect(describeLiveRoomDanmakuAccessDenied(info)).toBeUndefined();
	});

	it("rejects missing token or host list", () => {
		expect(
			describeLiveRoomDanmakuAccessDenied({
				code: 0,
				data: { host_list: [{ host: "example.com" }] },
			}),
		).toBe("B 站未返回弹幕 token");

		expect(
			describeLiveRoomDanmakuAccessDenied({
				code: 0,
				data: { token: "token", host_list: [] },
			}),
		).toBe("B 站未返回弹幕服务器列表");
	});
});

/**
 * 「要不要为这位 UP 开直播间监听」:任一直播类开关开着就要(只看开关、不看有没有目标)。
 * ⑬d 之后周期「正在直播」有了自己的开关,**只开它**也得监听 —— 清单漏了它,这位 UP 的计时器永远没人挂。
 */
describe("RoomContext.needsLiveMonitor", () => {
	function makeRoomCtx(): RoomContext {
		const serviceCtx: ServiceContext = {
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
			signal: new AbortController().signal,
			track: () => {},
		};
		return new RoomContext({
			serviceCtx,
			api: {},
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
	}

	/** 全部开关关着的订阅;用例只开自己要的那一把。 */
	const allOff = (over: Partial<SubItemView> = {}): SubItemView =>
		({
			liveStart: false,
			liveStreaming: false,
			liveEnd: false,
			membership: false,
			superchat: false,
			customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
			customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
			...over,
		}) as SubItemView;

	it("全关 → 不监听", () => {
		expect(makeRoomCtx().needsLiveMonitor(allOff())).toBe(false);
	});

	it.each(["liveStart", "liveStreaming", "liveEnd", "membership", "superchat"] as const)(
		"只开 %s → 要监听",
		(key) => {
			expect(makeRoomCtx().needsLiveMonitor(allOff({ [key]: true }))).toBe(true);
		},
	);
});
