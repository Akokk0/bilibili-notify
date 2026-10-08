/**
 * 单元测试 — `attachChannelWiring` / `buildStateHydrate`(WS BusEvents → envelope 桥)。
 *
 * 守护契约:
 *   - 总线事件原样成帧:线上事件名与总线同名,`data` 就是总线的载荷(具名对象),没有载荷的是 null
 *   - `cookies-refreshed` 只有 {refreshedAt}(cookie 不上总线,源头由 auth 的测试钉着),原样成帧
 *   - `history-recorded` / `history-updated` 投影成精简 view(非 raw HistoryEntry)
 *   - `config-changed` 按 scope 带快照;secrets scope → snapshot=null
 *   - log channel:LogChannel.push → {type:"log",event:level,ts:entry.ts,data:{msg,args}}
 *   - dispose() 解绑所有 bus 订阅(之后再 emit 不再 publish)
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { ALL_CHANNELS, attachChannelWiring, buildStateHydrate } from "../channels.js";
import { createLogChannel } from "../log-channel.js";
import type { WsEventEnvelope } from "../types.js";

interface Harness {
	bus: ReturnType<typeof createNodeMessageBus>;
	log: ReturnType<typeof createLogChannel>;
	publish: ReturnType<typeof vi.fn>;
	dispose: () => void;
	last(): WsEventEnvelope;
	all(): WsEventEnvelope[];
}

function wire(): Harness {
	const bus = createNodeMessageBus();
	const log = createLogChannel();
	const publish = vi.fn();
	const handle = attachChannelWiring({ bus, log, publish });
	return {
		bus,
		log,
		publish,
		dispose: () => handle.dispose(),
		last: () => publish.mock.calls.at(-1)?.[0] as WsEventEnvelope,
		all: () => publish.mock.calls.map((c) => c[0] as WsEventEnvelope),
	};
}

describe("buildStateHydrate", () => {
	/**
	 * 这条钉的是「**不带载荷**」。
	 *
	 * 原来它打包 { globals, subscriptions, targets },而 globals 里有各家 AI 的
	 * 明文 apiKey 与联网搜索 key —— `GET /api/settings` 早就走 globalConfigView 打码了
	 * (25e4210),WS 这条路漏了。客户端 handleStateEnvelope 又一个字节都不读,
	 * 只 invalidate 三个 query,所以明文一路传过去然后进垃圾。
	 *
	 * 谁要是想把载荷加回来省一次 REST 往返:先过 globalConfigView,别直接 getGlobals()。
	 */
	it("state/hydrate 不带载荷 —— 明文 key 不上线", () => {
		const env = buildStateHydrate();
		expect(env.type).toBe("state");
		expect(env.event).toBe("hydrate");
		expect(typeof env.ts).toBe("string");
		expect(env.data).toBeNull();
	});

	it("ALL_CHANNELS 即五频道注册表", () => {
		expect(ALL_CHANNELS).toEqual(["auth", "push-events", "log", "state", "resources"]);
	});
});

describe("attachChannelWiring — 总线载荷原样成帧", () => {
	let h: Harness;
	beforeEach(() => {
		h = wire();
	});

	it("无载荷事件(auth-lost / auth-restored):data=null", () => {
		h.bus.emit("auth-lost");
		expect(h.last()).toMatchObject({ type: "auth", event: "auth-lost", data: null });
		h.bus.emit("auth-restored");
		expect(h.last()).toMatchObject({ type: "auth", event: "auth-restored", data: null });
	});

	/**
	 * 拓展订阅的在播表变了(ADR-0019 决策 12 / 57)—— 面板靠这一帧让「正在直播」重取。不转的话拓展的
	 * 在播要等切页才出来 / 才下去;它也不能借 `live-state-changed` 走(统计按 uid 订着那一个)。
	 */
	it("extension-live-changed → push-events 频道同名帧,data=null", () => {
		h.bus.emit("extension-live-changed");
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "extension-live-changed",
			data: null,
		});
	});

	it("载荷是单个对象的事件:data 就是总线上那一个对象", () => {
		const snap = { status: 5, msg: "ok" };
		h.bus.emit("login-status-report", snap);
		expect(h.last()).toMatchObject({ type: "auth", event: "login-status-report" });
		expect(h.last().data).toBe(snap);

		const fans = { entries: [{ uid: "u1", current: 1 }] as never };
		h.bus.emit("fans-refreshed", fans);
		expect(h.last()).toMatchObject({ type: "push-events", event: "fans-refreshed" });
		expect(h.last().data).toBe(fans);
	});

	it("具名载荷:live-state-changed / live-viewers-changed / engine-error 各自带命名的格子", () => {
		h.bus.emit("live-state-changed", { uid: "u1", status: "live" });
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "live-state-changed",
			data: { uid: "u1", status: "live" },
		});
		h.bus.emit("live-viewers-changed", { uid: "u1", viewers: 12_000 });
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "live-viewers-changed",
			data: { uid: "u1", viewers: 12_000 },
		});
		h.bus.emit("engine-error", { source: "dynamic-engine", message: "boom" });
		expect(h.last()).toMatchObject({
			type: "log",
			event: "engine-error",
			data: { source: "dynamic-engine", message: "boom" },
		});
	});

	/**
	 * `at` 是这次状态翻转的真实发生时刻(开播时刻 / 下播时刻),总线上有它、帧里就得有 ——
	 * 面板与拓展凭它认场次。帧以前只发 `[uid, status]`,这一格在线上被吞掉。
	 */
	it("live-state-changed 总线载荷带 at:帧里也带 at", () => {
		h.bus.emit("live-state-changed", { uid: "u1", status: "live", at: "2026-05-16T09:00:00.000Z" });
		expect(h.last().data).toEqual({ uid: "u1", status: "live", at: "2026-05-16T09:00:00.000Z" });
		h.bus.emit("live-state-changed", { uid: "u1", status: "idle", at: "2026-05-16T11:30:00.000Z" });
		expect(h.last().data).toEqual({ uid: "u1", status: "idle", at: "2026-05-16T11:30:00.000Z" });
	});
});

const IMAGE_REF = `${"a".repeat(64)}.png`;
const AVATAR_REF = `${"b".repeat(64)}.png`;

const ROW = {
	id: "h1",
	pushId: "p1",
	createdAt: "2026-05-16T00:00:00.000Z",
	feature: "liveEnd",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	subscriptionId: "sub1",
	targetId: "t1",
	status: "partial",
	messages: [
		{
			payload: { kind: "image", text: "[卡片图]", image: IMAGE_REF },
			role: "main",
			result: { ok: true, latencyMs: 5 },
		},
		{
			payload: { kind: "text", text: "总结" },
			role: "extra",
			result: { ok: false, code: "unknown", message: "boom", upstreamCode: 1200 },
		},
	],
	nameSnapshot: "UP",
	avatarSnapshot: AVATAR_REF,
};

const ROW_VIEW = {
	id: "h1",
	pushId: "p1",
	createdAt: "2026-05-16T00:00:00.000Z",
	feature: "liveEnd",
	status: "partial",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	subscriptionId: "sub1",
	targetId: "t1",
	messages: [
		{ text: "[卡片图]", kind: "image", image: IMAGE_REF, role: "main", ok: true },
		{
			text: "总结",
			kind: "text",
			image: undefined,
			role: "extra",
			ok: false,
			code: "unknown",
			message: "boom",
			upstreamCode: 1200,
		},
	],
	nameSnapshot: "UP",
	avatarSnapshot: AVATAR_REF,
};

describe("attachChannelWiring — history-recorded / history-updated 投影", () => {
	it("history-recorded 投影为精简 view:消息逐条带文案 / 种类 / 图库引用 / 结果(铺平:没送达带码 / 原话 / upstreamCode,没有 err),头像快照也是图库引用,不外泄 latency", () => {
		const h = wire();
		h.bus.emit("history-recorded", ROW as never);
		const env = h.last();
		expect(env.type).toBe("push-events");
		expect(env.event).toBe("history-recorded");
		expect(env.data).toEqual(ROW_VIEW);
	});

	it("history-updated 走同一投影、事件名不同 —— 前端按 id 换缓存", () => {
		const h = wire();
		h.bus.emit("history-updated", ROW as never);
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "history-updated",
			data: ROW_VIEW,
		});
	});

	it("无目标行:targetId 为 null,消息没有 ok", () => {
		const h = wire();
		h.bus.emit("history-recorded", {
			...ROW,
			targetId: null,
			status: "no-targets",
			messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
		} as never);
		expect(h.last().data).toMatchObject({
			targetId: null,
			status: "no-targets",
			messages: [{ text: "卡片", role: "main" }],
		});
		expect(h.last().data).not.toHaveProperty(["messages", 0, "ok"]);
	});
});

describe("attachChannelWiring — 被静音 / 免扰挡下的行", () => {
	it("状态 silenced 与消息上的 isSilenced 过线;后来补到了的那条不带", () => {
		const h = wire();
		h.bus.emit("history-recorded", {
			...ROW,
			status: "silenced",
			messages: [{ payload: { kind: "text", text: "卡片" }, role: "main", isSilenced: true }],
		} as never);
		expect(h.last()).toMatchObject({ type: "push-events", event: "history-recorded" });
		expect(h.last().data).toMatchObject({
			status: "silenced",
			messages: [{ text: "卡片", role: "main", isSilenced: true }],
		});
		expect(h.last().data).not.toHaveProperty(["messages", 0, "ok"]);

		h.bus.emit("history-updated", {
			...ROW,
			status: "delivered",
			messages: [
				{ payload: { kind: "text", text: "卡片" }, role: "main", isSilenced: true },
				{
					payload: { kind: "text", text: "卡片" },
					role: "main",
					repushOf: 0,
					result: { ok: true, latencyMs: 4 },
				},
			],
		} as never);
		expect(h.last().data).toMatchObject({
			status: "delivered",
			messages: [{ isSilenced: true }, { ok: true, repushOf: 0 }],
		});
		expect(h.last().data).not.toHaveProperty(["messages", 1, "isSilenced"]);
	});
});

describe("attachChannelWiring — cookies-refreshed", () => {
	/**
	 * cookie 本身不上总线:载荷只有刷新的时刻(源头上的这一条由 `auth/__tests__/
	 * cookies-refreshed-payload.test.ts` 钉着)。所以这里不再有「脱敏」这一步,总线上的载荷
	 * 原样成帧 —— 帧里就是那一格。
	 */
	it("总线上的 {refreshedAt} 原样成帧", () => {
		const h = wire();
		h.bus.emit("cookies-refreshed", { refreshedAt: "2026-05-16T00:00:00.000Z" });
		expect(h.last()).toMatchObject({ type: "auth", event: "cookies-refreshed" });
		expect(h.last().data).toEqual({ refreshedAt: "2026-05-16T00:00:00.000Z" });
	});
});

describe("attachChannelWiring — config-changed 按 scope 带快照", () => {
	let h: Harness;
	beforeEach(() => {
		h = wire();
	});

	/**
	 * 四个 scope 一律**只带 scope 标记**。secrets 从第一天起就是这样(注释写着
	 * 「绝不经 WS 推 secrets」),其余三个是在脱敏纪律落地后才补齐的 —— globals
	 * 那份快照里有明文 apiKey,而客户端只读 .scope。
	 */
	it("四个 scope 都只带 scope 标记,不带快照", () => {
		for (const scope of ["globals", "subscriptions", "targets", "secrets"] as const) {
			h.bus.emit("config-changed", { scope });
			expect(h.last()).toMatchObject({ type: "state", event: "config-changed" });
			expect(h.last().data).toEqual({ scope });
		}
	});
});

describe("attachChannelWiring — 拓展喊「面板数据变了」", () => {
	/**
	 * 拓展交给面板的数据是现取的(`/api/ext/:id/status`),面板不知道什么时候该再取 ——
	 * 桥那头握完手,面板上那张卡还灰着。这一帧只带拓展 id:面板按 id 失效缓存、自己去取。
	 */
	it("extension-status-changed → state 频道同名帧,只带 extensionId", () => {
		const h = wire();
		h.bus.emit("extension-status-changed", { extensionId: "bridge" });
		expect(h.last()).toMatchObject({ type: "state", event: "extension-status-changed" });
		expect(h.last().data).toEqual({ extensionId: "bridge" });
	});
});

describe("attachChannelWiring — 拓展的上报问题变了", () => {
	/**
	 * 拓展详情页的「上报问题」框(ADR-0019 决策 60)住在拓展表那一行上。这一帧只叫面板重取拓展表 ——
	 * 不借 `extension-status-changed`:那一帧说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表。
	 */
	it("extension-report-problems-changed → state 频道同名帧,只带 extensionId", () => {
		const h = wire();
		h.bus.emit("extension-report-problems-changed", { extensionId: "douyin" });
		expect(h.last()).toMatchObject({ type: "state", event: "extension-report-problems-changed" });
		expect(h.last().data).toEqual({ extensionId: "douyin" });
	});
});

describe("attachChannelWiring — 拓展订阅的资料变了", () => {
	/**
	 * 拓展报的资料更新落进了资料缓存(ADR-0019 决策 7 / 62)—— 那不是配置,不走 `config-changed`。
	 * 不转这一帧的话,订阅页上的名字 / 头像 / 粉丝要等切页才换。
	 */
	it("subscription-profiles-changed → state 频道同名帧,带订阅 id", () => {
		const h = wire();
		h.bus.emit("subscription-profiles-changed", { subscriptionIds: ["a", "b"] });
		expect(h.last()).toMatchObject({ type: "state", event: "subscription-profiles-changed" });
		expect(h.last().data).toEqual({ subscriptionIds: ["a", "b"] });
	});
});

describe("attachChannelWiring — log channel + dispose", () => {
	it("LogChannel.push 转 log 信封(ts 用 entry.ts)", () => {
		const h = wire();
		h.log.push({ level: "warn", msg: "disk full", args: [1, "x"], ts: "2026-05-16T09:00:00.000Z" });
		expect(h.last()).toEqual({
			type: "log",
			event: "warn",
			ts: "2026-05-16T09:00:00.000Z",
			data: { msg: "disk full", args: [1, "x"] },
		});
	});

	it("dispose() 后所有 bus / log 订阅解绑,不再 publish", () => {
		const h = wire();
		h.bus.emit("auth-lost");
		const before = h.publish.mock.calls.length;
		h.dispose();
		h.bus.emit("auth-lost");
		h.bus.emit("config-changed", { scope: "globals" });
		h.log.push({ level: "info", msg: "x", args: [], ts: "t" });
		expect(h.publish.mock.calls.length).toBe(before);
	});
});
