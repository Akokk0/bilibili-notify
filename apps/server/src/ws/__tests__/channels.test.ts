/**
 * 单元测试 — `attachChannelWiring` / `buildStateHydrate`(WS BiliEvents → envelope 桥)。
 *
 * 守护契约:
 *   - envelope() 参数 unwrap:0 参 → data=null;1 参 → 直接 unwrap;N 参 → 保留 tuple
 *   - `cookies-refreshed` **安全脱敏**:绝不转发 cookiesJson/refreshToken,只发 {refreshedAt, ok?}
 *   - `history-recorded` 投影成精简 view(非 raw HistoryEntry)
 *   - `config-changed` 按 scope 带快照;secrets scope → snapshot=null
 *   - log channel:LogChannel.push → {type:"log",event:level,ts:entry.ts,data:{msg,args}}
 *   - dispose() 解绑所有 bus 订阅(之后再 emit 不再 publish)
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { ALL_CHANNELS, attachChannelWiring, buildStateHydrate } from "../channels.js";
import { createLogChannel } from "../log-channel.js";
import type { ServerEventEnvelope } from "../types.js";

const GLOBALS = { app: { logLevel: "info" } };
const SUBS = [{ id: "s1" }];
const TARGETS = [{ id: "t1" }];

function makeStore(): ConfigStore {
	return {
		getGlobals: () => GLOBALS,
		getSubscriptions: () => SUBS,
		getTargets: () => TARGETS,
	} as unknown as ConfigStore;
}

interface Harness {
	bus: ReturnType<typeof createNodeMessageBus>;
	log: ReturnType<typeof createLogChannel>;
	publish: ReturnType<typeof vi.fn>;
	dispose: () => void;
	last(): ServerEventEnvelope;
	all(): ServerEventEnvelope[];
}

function wire(): Harness {
	const bus = createNodeMessageBus();
	const log = createLogChannel();
	const publish = vi.fn();
	const handle = attachChannelWiring({ bus, store: makeStore(), log, publish });
	return {
		bus,
		log,
		publish,
		dispose: () => handle.dispose(),
		last: () => publish.mock.calls.at(-1)?.[0] as ServerEventEnvelope,
		all: () => publish.mock.calls.map((c) => c[0] as ServerEventEnvelope),
	};
}

describe("buildStateHydrate", () => {
	it("从 store 三视图组装 state/hydrate 信封", () => {
		const env = buildStateHydrate(makeStore());
		expect(env.type).toBe("state");
		expect(env.event).toBe("hydrate");
		expect(typeof env.ts).toBe("string");
		expect(env.data).toEqual({ globals: GLOBALS, subscriptions: SUBS, targets: TARGETS });
	});

	it("ALL_CHANNELS 即四频道注册表", () => {
		expect(ALL_CHANNELS).toEqual(["auth", "push-events", "log", "state"]);
	});
});

describe("attachChannelWiring — envelope 参数 unwrap", () => {
	let h: Harness;
	beforeEach(() => {
		h = wire();
	});

	it("0 参事件(auth-lost / auth-restored):data=null", () => {
		h.bus.emit("auth-lost");
		expect(h.last()).toMatchObject({ type: "auth", event: "auth-lost", data: null });
		h.bus.emit("auth-restored");
		expect(h.last()).toMatchObject({ type: "auth", event: "auth-restored", data: null });
	});

	it("1 参事件:直接 unwrap 为值本身", () => {
		const snap = { status: 5, msg: "ok" };
		h.bus.emit("login-status-report", snap as never);
		expect(h.last()).toMatchObject({ type: "auth", event: "login-status-report" });
		expect(h.last().data).toBe(snap);

		const entries = [{ uid: "u1", current: 1 }];
		h.bus.emit("fans-refreshed", entries as never);
		expect(h.last()).toMatchObject({ type: "push-events", event: "fans-refreshed" });
		expect(h.last().data).toBe(entries);
	});

	it("N 参事件:保留 tuple", () => {
		h.bus.emit("live-state-changed", "u1", "live");
		expect(h.last()).toMatchObject({
			type: "push-events",
			event: "live-state-changed",
			data: ["u1", "live"],
		});
		h.bus.emit("live-viewers-changed", "u1", "1.2万");
		expect(h.last().data).toEqual(["u1", "1.2万"]);
		h.bus.emit("engine-error", "dynamic-engine", "boom");
		expect(h.last()).toMatchObject({
			type: "log",
			event: "engine-error",
			data: ["dynamic-engine", "boom"],
		});
	});
});

describe("attachChannelWiring — history-recorded 投影", () => {
	it("投影为精简 view,不外泄 raw entry 结构", () => {
		const h = wire();
		const entry = {
			id: "h1",
			ts: "2026-05-16T00:00:00.000Z",
			source: "dynamic",
			uid: "u1",
			subscriptionId: "sub1",
			targetIds: ["t1"],
			result: { ok: true, per: [{ targetId: "t1", ok: true, latencyMs: 5 }] },
			payload: { kind: "text", text: "hello", imageRef: undefined },
			unameSnapshot: "UP",
			uavatarSnapshot: "http://a/x.jpg",
		};
		h.bus.emit("history-recorded", entry as never);
		const env = h.last();
		expect(env.type).toBe("push-events");
		expect(env.event).toBe("history-recorded");
		expect(env.data).toEqual({
			id: "h1",
			ts: "2026-05-16T00:00:00.000Z",
			source: "dynamic",
			uid: "u1",
			subscriptionId: "sub1",
			targetIds: ["t1"],
			ok: true,
			text: "hello",
			imageRef: undefined,
			unameSnapshot: "UP",
			uavatarSnapshot: "http://a/x.jpg",
		});
		// 不应携带内部 result.per 等结构。
		expect(env.data).not.toHaveProperty("result");
	});
});

describe("attachChannelWiring — cookies-refreshed 安全脱敏", () => {
	let h: Harness;
	beforeEach(() => {
		h = wire();
	});

	it("绝不转发 cookiesJson / refreshToken,只发 {refreshedAt, ok}", () => {
		h.bus.emit("cookies-refreshed", {
			cookiesJson: "SUPER_SECRET_COOKIE",
			refreshToken: "SECRET_REFRESH",
			ok: true,
		} as never);
		const data = h.last().data as Record<string, unknown>;
		expect(h.last()).toMatchObject({ type: "auth", event: "cookies-refreshed" });
		expect(typeof data.refreshedAt).toBe("string");
		expect(data.ok).toBe(true);
		expect(data).not.toHaveProperty("cookiesJson");
		expect(data).not.toHaveProperty("refreshToken");
		expect(JSON.stringify(data)).not.toContain("SECRET");
	});

	it("ok 非 boolean 时不带 ok 字段", () => {
		h.bus.emit("cookies-refreshed", { cookiesJson: "x", ok: "yes" } as never);
		const data = h.last().data as Record<string, unknown>;
		expect(data).not.toHaveProperty("ok");
		expect(typeof data.refreshedAt).toBe("string");
	});

	it("payload 非对象时只发 {refreshedAt}", () => {
		h.bus.emit("cookies-refreshed", null as never);
		expect(Object.keys(h.last().data as object)).toEqual(["refreshedAt"]);
	});
});

describe("attachChannelWiring — config-changed 按 scope 带快照", () => {
	let h: Harness;
	beforeEach(() => {
		h = wire();
	});

	it("globals / subscriptions / targets 带对应快照", () => {
		h.bus.emit("config-changed", "globals");
		expect(h.last()).toMatchObject({ type: "state", event: "config-changed" });
		expect(h.last().data).toEqual({ scope: "globals", snapshot: GLOBALS });
		h.bus.emit("config-changed", "subscriptions");
		expect(h.last().data).toEqual({ scope: "subscriptions", snapshot: SUBS });
		h.bus.emit("config-changed", "targets");
		expect(h.last().data).toEqual({ scope: "targets", snapshot: TARGETS });
	});

	it("secrets scope:snapshot=null(绝不经 WS 推 secrets)", () => {
		h.bus.emit("config-changed", "secrets");
		expect(h.last().data).toEqual({ scope: "secrets", snapshot: null });
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
		h.bus.emit("config-changed", "globals");
		h.log.push({ level: "info", msg: "x", args: [], ts: "t" });
		expect(h.publish.mock.calls.length).toBe(before);
	});
});
