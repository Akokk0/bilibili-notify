/**
 * 单元测试 — `createMultiplexSink`(独立端 NotificationSink 的 targetId → adapter 路由核心)。
 *
 * 守护契约:
 *   - 构造期 adapter.platforms → adapter 注册表;同一 platform 被两个 adapter 声明 → warn + 后者覆盖
 *   - resolve(targetId)            → PushTarget | undefined
 *   - isAvailable                  → target 缺 / PushAdapter 缺 / platformAdapter 缺 任一为 false;否则透传
 *   - send / sendPrivate(dispatch) → 四条分支:target 缺(早退,不触发 onDelivery)/
 *                                    PushAdapter 缺(warn + onDelivery)/ platformAdapter 缺(warn + onDelivery)/
 *                                    happy(委派 platformAdapter.send + onDelivery,private 透传)
 *   - probeAdapter                 → adapter 缺 / platformAdapter 缺 / happy 委派 platformAdapter.probe
 *
 * 纯单元:ConfigStore / PlatformAdapter / Logger 全部用最小 fake,无任何 I/O。
 */

import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "../../config/store.js";
import type { PlatformAdapter, ProbeResult } from "../../platforms/types.js";
import { createMultiplexSink } from "../multiplex.js";

const PAYLOAD: NotificationPayload = { kind: "text", text: "hi" };

// Test fakes use a deliberately loose `platform` (e.g. "telegram") to exercise
// the "no platform adapter" branch, so we bypass the strict union via `unknown`.
function makeAdapter(
	over: { id: string; platform: string } & Record<string, unknown>,
): PushAdapter {
	return {
		name: `adapter-${over.id}`,
		enabled: true,
		config: { url: "https://example.com/hook", headers: {} },
		...over,
	} as unknown as PushAdapter;
}

function makeTarget(over: { id: string; adapterId: string } & Record<string, unknown>): PushTarget {
	return {
		name: `target-${over.id}`,
		platform: "webhook",
		scope: "group",
		enabled: true,
		session: {},
		...over,
	} as unknown as PushTarget;
}

function makeStore(adapters: PushAdapter[], targets: PushTarget[]): ConfigStore {
	return {
		getAdapters: () => adapters,
		getTargets: () => targets,
	} as unknown as ConfigStore;
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function makePlatformAdapter(
	platforms: string[],
	over: Partial<PlatformAdapter> = {},
): PlatformAdapter {
	const sendResult: DeliveryResult = { ok: true, latencyMs: 12 };
	const probeResult: ProbeResult = { ok: true, latencyMs: 8 };
	return {
		platforms,
		isAvailable: vi.fn(() => true),
		send: vi.fn(async () => sendResult),
		probe: vi.fn(async () => probeResult),
		...over,
	};
}

describe("createMultiplexSink — adapter 注册表", () => {
	it("一个 adapter 声明多 platform:全部进表", () => {
		const pa = makePlatformAdapter(["onebot", "webhook"]);
		const sink = createMultiplexSink({
			store: makeStore(
				[makeAdapter({ id: "a1", platform: "onebot" })],
				[makeTarget({ id: "t1", adapterId: "a1", platform: "onebot" })],
			),
			adapters: [pa],
			logger: makeLogger(),
		});
		expect(sink.isAvailable("t1")).toBe(true);
	});

	it("同一 platform 被两个 adapter 声明:warn + 后者覆盖", () => {
		const first = makePlatformAdapter(["webhook"], { isAvailable: vi.fn(() => false) });
		const second = makePlatformAdapter(["webhook"], { isAvailable: vi.fn(() => true) });
		const logger = makeLogger();
		const sink = createMultiplexSink({
			store: makeStore(
				[makeAdapter({ id: "a1", platform: "webhook" })],
				[makeTarget({ id: "t1", adapterId: "a1", platform: "webhook" })],
			),
			adapters: [first, second],
			logger,
		});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("platform=webhook adapter override"),
		);
		// 后注册的 second 生效(isAvailable → true)。
		expect(sink.isAvailable("t1")).toBe(true);
	});
});

describe("createMultiplexSink — resolve / isAvailable", () => {
	it("resolve:命中返回 target,未命中 undefined", () => {
		const target = makeTarget({ id: "t1", adapterId: "a1" });
		const sink = createMultiplexSink({
			store: makeStore([makeAdapter({ id: "a1", platform: "webhook" })], [target]),
			adapters: [makePlatformAdapter(["webhook"])],
			logger: makeLogger(),
		});
		expect(sink.resolve("t1")).toBe(target);
		expect(sink.resolve("nope")).toBeUndefined();
	});

	it("isAvailable:target 缺 / PushAdapter 缺 / platformAdapter 缺 → false", () => {
		const targetNoAdapter = makeTarget({ id: "t1", adapterId: "ghost" });
		const targetNoPA = makeTarget({ id: "t2", adapterId: "a2" });
		const sink = createMultiplexSink({
			store: makeStore(
				[makeAdapter({ id: "a2", platform: "telegram" })],
				[targetNoAdapter, targetNoPA],
			),
			adapters: [makePlatformAdapter(["webhook"])],
			logger: makeLogger(),
		});
		expect(sink.isAvailable("missing")).toBe(false); // target 缺
		expect(sink.isAvailable("t1")).toBe(false); // adapterId 指向不存在的 adapter
		expect(sink.isAvailable("t2")).toBe(false); // adapter.platform 无对应 platformAdapter
	});

	it("isAvailable:链路齐全时透传 platformAdapter.isAvailable", () => {
		const paFalse = makePlatformAdapter(["webhook"], { isAvailable: vi.fn(() => false) });
		const sink = createMultiplexSink({
			store: makeStore(
				[makeAdapter({ id: "a1", platform: "webhook" })],
				[makeTarget({ id: "t1", adapterId: "a1" })],
			),
			adapters: [paFalse],
			logger: makeLogger(),
		});
		expect(sink.isAvailable("t1")).toBe(false);
		expect(paFalse.isAvailable).toHaveBeenCalledTimes(1);
	});
});

describe("createMultiplexSink — dispatch (send / sendPrivate)", () => {
	let onDelivery: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		onDelivery = vi.fn();
	});

	it("target 缺:返回 target not found,不触发 onDelivery", async () => {
		const sink = createMultiplexSink({
			store: makeStore([], []),
			adapters: [makePlatformAdapter(["webhook"])],
			logger: makeLogger(),
			onDelivery,
		});
		const r = await sink.send("ghost", PAYLOAD);
		expect(r).toEqual({ ok: false, latencyMs: 0, err: "target not found" });
		expect(onDelivery).not.toHaveBeenCalled();
	});

	it("PushAdapter 缺:返回带 adapterId 的错误 + warn + onDelivery", async () => {
		const logger = makeLogger();
		const sink = createMultiplexSink({
			store: makeStore([], [makeTarget({ id: "t1", adapterId: "ghost" })]),
			adapters: [makePlatformAdapter(["webhook"])],
			logger,
			onDelivery,
		});
		const r = await sink.send("t1", PAYLOAD);
		expect(r.ok).toBe(false);
		expect(r.err).toBe("adapter not found: adapterId=ghost");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("adapter not found"));
		expect(onDelivery).toHaveBeenCalledTimes(1);
	});

	it("platformAdapter 缺:返回 no platform adapter + warn + onDelivery", async () => {
		const logger = makeLogger();
		const sink = createMultiplexSink({
			store: makeStore(
				[makeAdapter({ id: "a1", platform: "telegram" })],
				[makeTarget({ id: "t1", adapterId: "a1", platform: "telegram" })],
			),
			adapters: [makePlatformAdapter(["webhook"])],
			logger,
			onDelivery,
		});
		const r = await sink.send("t1", PAYLOAD);
		expect(r.ok).toBe(false);
		expect(r.err).toBe("no platform adapter for telegram");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("no platform adapter for telegram"),
		);
		expect(onDelivery).toHaveBeenCalledTimes(1);
	});

	it("happy:委派 platformAdapter.send,回传其 result,onDelivery 带 {private:false}", async () => {
		const target = makeTarget({ id: "t1", adapterId: "a1" });
		const adapter = makeAdapter({ id: "a1", platform: "webhook" });
		const pa = makePlatformAdapter(["webhook"]);
		const sink = createMultiplexSink({
			store: makeStore([adapter], [target]),
			adapters: [pa],
			logger: makeLogger(),
			onDelivery,
		});
		const r = await sink.send("t1", PAYLOAD);
		expect(r).toEqual({ ok: true, latencyMs: 12 });
		expect(pa.send).toHaveBeenCalledWith(adapter, target, PAYLOAD, { private: false });
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, r, { private: false });
	});

	it("sendPrivate:private:true 透传到 platformAdapter.send 与 onDelivery", async () => {
		const target = makeTarget({ id: "t1", adapterId: "a1" });
		const adapter = makeAdapter({ id: "a1", platform: "webhook" });
		const pa = makePlatformAdapter(["webhook"]);
		const sink = createMultiplexSink({
			store: makeStore([adapter], [target]),
			adapters: [pa],
			logger: makeLogger(),
			onDelivery,
		});
		await sink.sendPrivate("t1", PAYLOAD);
		expect(pa.send).toHaveBeenCalledWith(adapter, target, PAYLOAD, { private: true });
		expect(onDelivery).toHaveBeenCalledWith(
			target,
			PAYLOAD,
			expect.objectContaining({ ok: true }),
			{ private: true },
		);
	});
});

describe("createMultiplexSink — probeAdapter", () => {
	it("adapter 缺:adapter not found", async () => {
		const sink = createMultiplexSink({
			store: makeStore([], []),
			adapters: [makePlatformAdapter(["webhook"])],
			logger: makeLogger(),
		});
		expect(await sink.probeAdapter("ghost")).toEqual({
			ok: false,
			latencyMs: 0,
			err: "adapter not found",
		});
	});

	it("platformAdapter 缺:no platform adapter for <platform>", async () => {
		const sink = createMultiplexSink({
			store: makeStore([makeAdapter({ id: "a1", platform: "telegram" })], []),
			adapters: [makePlatformAdapter(["webhook"])],
			logger: makeLogger(),
		});
		expect(await sink.probeAdapter("a1")).toEqual({
			ok: false,
			latencyMs: 0,
			err: "no platform adapter for telegram",
		});
	});

	it("happy:委派 platformAdapter.probe(adapter) 并回传其 ProbeResult", async () => {
		const adapter = makeAdapter({ id: "a1", platform: "webhook" });
		const pa = makePlatformAdapter(["webhook"], {
			probe: vi.fn(async () => ({ ok: null as boolean | null, latencyMs: 0 })),
		});
		const sink = createMultiplexSink({
			store: makeStore([adapter], []),
			adapters: [pa],
			logger: makeLogger(),
		});
		const r = await sink.probeAdapter("a1");
		expect(pa.probe).toHaveBeenCalledWith(adapter);
		expect(r).toEqual({ ok: null, latencyMs: 0 });
	});
});
