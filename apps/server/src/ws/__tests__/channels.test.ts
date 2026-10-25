/**
 * 单元测试 — `attachChannelWiring` / `buildStateHydrate`(WS BusEvents → envelope 桥)。
 *
 * 守护契约:
 *   - 总线事件原样成帧:线上事件名与总线同名,`data` 就是总线的载荷(具名对象),没有载荷的是 null
 *   - `subscription-auth-changed` 只有 {sourceKey, state}(cookie 不上总线),原样成帧;`auth` 频道只剩这一种帧
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

const FOLLOWERS_ENTRY = {
	subscriptionId: "sub-1",
	identity: { sourceKey: "bilibili", externalId: "u1" },
	current: 100,
	refreshedAt: "2026-05-16T09:00:00.000Z",
	deltaSubscribed: 10,
	delta24h: 5,
	delta7d: null,
};

/** 一个值里所有对象的键名(深搜,含数组里的)。 */
function keysDeep(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(keysDeep);
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
	}
	return [];
}

describe("attachChannelWiring — 总线载荷原样成帧", () => {
	let h: Harness;
	beforeEach(() => {
		h = wire();
	});

	// 验红:删掉 `channels.ts` 里 `subscription-auth-changed` 那一条订阅,这条红(面板读新口,不转就永远看不到变化)。
	it("subscription-auth-changed → auth 频道同名帧,data 是总线上那一个对象(来源键 + 状态,没有别的格)", () => {
		const changed = {
			sourceKey: "bilibili",
			state: { status: "confirming", message: "已扫码，请在手机上确认" },
		} as const;
		h.bus.emit("subscription-auth-changed", changed);
		expect(h.last()).toMatchObject({ type: "auth", event: "subscription-auth-changed" });
		expect(h.last().data).toBe(changed);
		expect(Object.keys(h.last().data as object).sort()).toEqual(["sourceKey", "state"]);
	});

	it("载荷是单个对象的事件:data 就是总线上那一个对象", () => {
		const changed = { sourceKey: "bilibili", state: { status: "logged-out" } } as const;
		h.bus.emit("subscription-auth-changed", changed);
		expect(h.last()).toMatchObject({ type: "auth", event: "subscription-auth-changed" });
		expect(h.last().data).toBe(changed);

		const followers = { entries: [FOLLOWERS_ENTRY] };
		h.bus.emit("followers-refreshed", followers);
		expect(h.last()).toMatchObject({ type: "push-events", event: "followers-refreshed" });
		expect(h.last().data).toBe(followers);
	});

	// 验红:转帧时给条目加回 `uid`(或 `extensionId`),这条红 —— 粉丝帧的身份只有 `identity` 一处。
	it("followers-refreshed:条目带 identity,整个帧里没有 uid / extensionId 键", () => {
		h.bus.emit("followers-refreshed", {
			entries: [
				FOLLOWERS_ENTRY,
				{
					...FOLLOWERS_ENTRY,
					subscriptionId: "sub-2",
					identity: { sourceKey: "douyin", externalId: "sec-1" },
				},
			],
		});
		const frame = h.last();
		expect(frame).toMatchObject({ type: "push-events", event: "followers-refreshed" });
		const entries = (frame.data as { entries: Array<{ identity: unknown }> }).entries;
		expect(entries.map((e) => e.identity)).toEqual([
			{ sourceKey: "bilibili", externalId: "u1" },
			{ sourceKey: "douyin", externalId: "sec-1" },
		]);
		expect(keysDeep(frame)).not.toContain("uid");
		expect(keysDeep(frame)).not.toContain("extensionId");
	});

	it("具名载荷:live-session-changed 原样成帧", () => {
		const change = {
			kind: "start" as const,
			subscriptionId: "sub-1",
			session: {
				subscriptionId: "sub-1",
				sourceKey: "douyin",
				detectedAt: "2026-05-16T09:00:00.000Z",
			},
			trigger: "start-signal" as const,
			details: { title: "这一场" },
		};
		h.bus.emit("live-session-changed", change);
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "live-session-changed",
		});
		expect(h.last().data).toBe(change);
	});

	it("live-viewers-changed 原样成帧:只带这一帧有的两格", () => {
		const currentOnly = { subscriptionId: "sub-1", currentViewers: 12 };
		h.bus.emit("live-viewers-changed", currentOnly);
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "live-viewers-changed",
		});
		expect(h.last().data).toBe(currentOnly);

		const both = { subscriptionId: "sub-1", currentViewers: 12, totalViewers: 120 };
		h.bus.emit("live-viewers-changed", both);
		expect(h.last().data).toBe(both);
	});

	it("engine-error 仍走 log 频道并原样带载荷", () => {
		const error = { source: "post-delivery", message: "boom" };
		h.bus.emit("engine-error", error);
		expect(h.last()).toMatchObject({
			type: "log",
			event: "engine-error",
			data: error,
		});
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
	// 部分失败的行有得补:WS 推的行自带「能补、本来几条、还差几条」(不查盘的那一半)。
	repush: { can: true, total: 2, missing: 1 },
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
		// 没有目标可补:不带 repush,面板不画按钮。
		expect(h.last().data).not.toHaveProperty("repush");
	});

	// 面板画不画补发按钮只看 `repush` 这一格;补发途中每追加一条都是一帧 history-updated,整行替换。
	it("补发途中的 history-updated:还差几条跟着变,补齐那一帧不再带 repush", () => {
		const h = wire();
		const retried = {
			payload: { kind: "text", text: "总结" },
			role: "extra",
			repushOf: 1,
		};
		h.bus.emit("history-updated", {
			...ROW,
			messages: [
				...ROW.messages,
				{ ...retried, result: { ok: false, code: "unknown", message: "x" } },
			],
		} as never);
		expect(h.last().data).toMatchObject({ repush: { can: true, total: 2, missing: 1 } });
		h.bus.emit("history-updated", {
			...ROW,
			status: "delivered",
			messages: [...ROW.messages, { ...retried, result: { ok: true, latencyMs: 1 } }],
		} as never);
		expect(h.last().data).not.toHaveProperty("repush");
	});
});

describe("attachChannelWiring — 被过滤的行", () => {
	// 留痕的行照样发 history-recorded(面板据此实时多出一行):状态、原因过线,不带 repush。
	it("history-recorded:状态 filtered 与 filteredBy 过线,目标是 null,不带 repush", () => {
		const h = wire();
		h.bus.emit("history-recorded", {
			...ROW,
			targetId: null,
			status: "filtered",
			filteredBy: "blocked-keyword",
			messages: [{ payload: { kind: "text", text: "摘要\nhttps://example.com/p" }, role: "main" }],
		} as never);
		expect(h.last()).toMatchObject({ type: "push-events", event: "history-recorded" });
		expect(h.last().data).toMatchObject({
			status: "filtered",
			filteredBy: "blocked-keyword",
			targetId: null,
			messages: [{ text: "摘要\nhttps://example.com/p", role: "main" }],
		});
		expect(h.last().data).not.toHaveProperty("repush");
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

describe("attachChannelWiring — 拓展的上报出入变了", () => {
	/**
	 * 拓展详情页的「上报出入」框(ADR-0019 决策 60)住在拓展表那一行上。这一帧只叫面板重取拓展表 ——
	 * 不借 `extension-status-changed`:那一帧说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表。
	 */
	it("extension-report-discrepancies-changed → state 频道同名帧,只带 extensionId", () => {
		const h = wire();
		h.bus.emit("extension-report-discrepancies-changed", { extensionId: "douyin" });
		expect(h.last()).toMatchObject({
			type: "state",
			event: "extension-report-discrepancies-changed",
		});
		expect(h.last().data).toEqual({ extensionId: "douyin" });
	});
});

describe("attachChannelWiring — 问题表变了", () => {
	/**
	 * 问题表(各集成报上来的「主人该知道的事」)变了,面板据此让 `GET /api/problems` 过期。
	 * 帧里只有报的人,问题本身不上线。
	 */
	it("problems-changed → state 频道同名帧,只带 reporter", () => {
		const h = wire();
		h.bus.emit("problems-changed", { reporter: "bilibili" });
		expect(h.last()).toMatchObject({ type: "state", event: "problems-changed" });
		expect(h.last().data).toEqual({ reporter: "bilibili" });
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
		h.bus.emit("engine-error", { source: "test", message: "before dispose" });
		const before = h.publish.mock.calls.length;
		h.dispose();
		h.bus.emit("engine-error", { source: "test", message: "after dispose" });
		h.bus.emit("config-changed", { scope: "globals" });
		h.log.push({ level: "info", msg: "x", args: [], ts: "t" });
		expect(h.publish.mock.calls.length).toBe(before);
	});
});
