import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../../push-like";
import type { RoomContextOptions } from "../room-context";
import { describeLiveRoomDanmakuAccessDenied, RoomContext } from "../room-helpers";

/** 预检成功后体里缺不缺东西(上游的非 0 码已由请求层翻成失败,由 `startLiveRoomListener` 分流)。 */
describe("describeLiveRoomDanmakuAccessDenied", () => {
	it("accepts a complete danmu info", () => {
		expect(
			describeLiveRoomDanmakuAccessDenied({ token: "token", host_list: [{ host: "example.com" }] }),
		).toBeUndefined();
	});

	it("rejects a missing body", () => {
		expect(describeLiveRoomDanmakuAccessDenied(null)).toBe("B 站未返回弹幕连接信息");
	});

	it("rejects missing token or host list", () => {
		expect(describeLiveRoomDanmakuAccessDenied({ host_list: [{ host: "example.com" }] })).toBe(
			"B 站未返回弹幕 token",
		);

		expect(describeLiveRoomDanmakuAccessDenied({ token: "token", host_list: [] })).toBe(
			"B 站未返回弹幕服务器列表",
		);
	});
});

/**
 * 「要不要为这位 UP 开直播间监听」:任一直播类开关开着就要(只看开关、不看有没有目标)。
 * ⑬d 之后周期「正在直播」有了自己的开关,**只开它**也得监听 —— 清单漏了它,这位 UP 的计时器永远没人挂。
 */
describe("RoomContext.needsListener", () => {
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
			viewerChat: false,
			viewerEnter: false,
			customSpecialDanmakuUsers: { specialViewers: [], template: "" },
			customSpecialUsersEnterTheRoom: { specialViewers: [], template: "" },
			...over,
		}) as SubItemView;

	it("全关 → 不监听", () => {
		expect(makeRoomCtx().needsListener(allOff())).toBe(false);
	});

	it.each(["liveStart", "liveStreaming", "liveEnd", "membership", "superchat"] as const)(
		"只开 %s → 要监听",
		(key) => {
			expect(makeRoomCtx().needsListener(allOff({ [key]: true }))).toBe(true);
		},
	);

	// 特别关注:开关 ∧ 名单上有人带它(3b-16)。两块设置带同一份名单。
	const listed = (feature: "viewerChat" | "viewerEnter") => ({
		customSpecialDanmakuUsers: { specialViewers: [{ id: "1", features: [feature] }], template: "" },
		customSpecialUsersEnterTheRoom: {
			specialViewers: [{ id: "1", features: [feature] }],
			template: "",
		},
	});

	it.each(["viewerChat", "viewerEnter"] as const)("%s:开关开着、名单上有人带它 → 监听", (key) => {
		expect(makeRoomCtx().needsListener(allOff({ [key]: true, ...listed(key) }))).toBe(true);
	});

	it.each(["viewerChat", "viewerEnter"] as const)("%s:名单上有人带它、开关关着 → 不监听", (key) => {
		expect(makeRoomCtx().needsListener(allOff({ ...listed(key) }))).toBe(false);
	});

	it("viewerChat 开着、名单上的人只带 viewerEnter → 不监听", () => {
		expect(
			makeRoomCtx().needsListener(allOff({ viewerChat: true, ...listed("viewerEnter") })),
		).toBe(false);
	});
});
