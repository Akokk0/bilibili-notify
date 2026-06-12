import type { PuppeteerLike } from "@bilibili-notify/image";
import {
	type GlobalConfig,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
} from "@bilibili-notify/internal";
import { createSubscriptionStore } from "@bilibili-notify/subscription";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSidecarEngines } from "./engines.js";
import { createSidecarMessageBus, createSidecarServiceContext } from "./platform.js";

const dynamicMock = vi.hoisted(() => {
	const instances: Array<Record<string, unknown>> = [];
	const DynamicEngine = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
		Object.assign(this, {
			start: vi.fn(),
			stop: vi.fn(),
			applyOps: vi.fn(),
			updateConfig: vi.fn(),
			setAi: vi.fn(),
		});
		instances.push(this);
	});
	return { DynamicEngine, instances };
});

const liveMock = vi.hoisted(() => {
	const instances: Array<Record<string, unknown>> = [];
	const LivePushType = {
		Live: 0,
		StartBroadcasting: 3,
		LiveGuardBuy: 4,
		WordCloudAndLiveSummary: 5,
		Superchat: 6,
		UserDanmakuMsg: 7,
		UserActions: 8,
		LiveEnd: 9,
		LiveSummary: 10,
	} as const;
	const LiveEngine = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
		Object.assign(this, {
			start: vi.fn(),
			stop: vi.fn(),
			applyOps: vi.fn(),
			rebuildFromSubs: vi.fn(),
			teardown: vi.fn(),
			updateConfig: vi.fn(),
			listLiveSnapshots: vi.fn(() => []),
		});
		instances.push(this);
	});
	return { LiveEngine, LivePushType, instances };
});

const imageMock = vi.hoisted(() => {
	const instances: Array<Record<string, unknown>> = [];
	const ImageRenderer = vi.fn().mockImplementation(function (
		this: Record<string, unknown>,
		opts: unknown,
	) {
		Object.assign(this, {
			opts,
			start: vi.fn(),
			stop: vi.fn(),
			updateConfig: vi.fn(),
		});
		instances.push(this);
	});
	return { ImageRenderer, instances };
});

vi.mock("@bilibili-notify/dynamic", () => ({
	DynamicEngine: dynamicMock.DynamicEngine,
}));

vi.mock("@bilibili-notify/live", () => ({
	LiveEngine: liveMock.LiveEngine,
	LivePushType: liveMock.LivePushType,
}));

vi.mock("@bilibili-notify/image", () => ({
	ImageRenderer: imageMock.ImageRenderer,
}));

beforeEach(() => {
	dynamicMock.instances.length = 0;
	liveMock.instances.length = 0;
	imageMock.instances.length = 0;
	dynamicMock.DynamicEngine.mockClear();
	liveMock.LiveEngine.mockClear();
	imageMock.ImageRenderer.mockClear();
});

function makePush() {
	return {
		broadcastToFeature: vi.fn(async () => []),
		sendPrivateMsg: vi.fn(async () => undefined),
		sendErrorMsg: vi.fn(async () => undefined),
		start: vi.fn(),
		stop: vi.fn(),
	} as never;
}

describe("createSidecarEngines", () => {
	it("starts engines and forwards subscription and auth events", () => {
		const bus = createSidecarMessageBus();
		const serviceCtx = createSidecarServiceContext({ name: "astrbot-test" });
		const store = createSubscriptionStore(bus);

		const runtime = createSidecarEngines({
			serviceCtx,
			bus,
			api: {} as never,
			push: makePush(),
			subscriptions: store,
			getGlobals: makeDefaultGlobalConfig,
		});

		expect(dynamicMock.instances).toHaveLength(1);
		expect(liveMock.instances).toHaveLength(1);
		expect(runtime.status()).toEqual({ dynamic: false, live: false });

		runtime.start();
		expect(dynamicMock.instances[0]?.start).toHaveBeenCalledTimes(1);
		expect(liveMock.instances[0]?.start).not.toHaveBeenCalled();
		expect(runtime.status()).toEqual({ dynamic: true, live: false });

		store.upsert(
			makeEmptySubscription({ id: "11111111-1111-4111-8111-111111111111", uid: "123456" }),
		);
		expect(dynamicMock.instances[0]?.applyOps).toHaveBeenCalled();
		expect(liveMock.instances[0]?.applyOps).toHaveBeenCalled();

		const liveInstance = liveMock.instances[0] as {
			listLiveSnapshots?: { mockReturnValue: (value: Array<Record<string, unknown>>) => void };
		};
		liveInstance.listLiveSnapshots?.mockReturnValue([{ uid: "123456" }]);
		bus.emit("auth-restored");
		expect(liveMock.instances[0]?.rebuildFromSubs).toHaveBeenCalledTimes(1);
		expect(runtime.status().live).toBe(true);

		liveInstance.listLiveSnapshots?.mockReturnValue([]);
		bus.emit("auth-lost");
		expect(liveMock.instances[0]?.teardown).toHaveBeenCalledTimes(1);
		expect(runtime.status().live).toBe(false);

		runtime.dispose();
		expect(dynamicMock.instances[0]?.stop).toHaveBeenCalledTimes(1);
		expect(liveMock.instances[0]?.stop).toHaveBeenCalledTimes(1);

		void serviceCtx.dispose();
	});
});

describe("createSidecarEngines — image renderer 接线", () => {
	const fakePuppeteer = {} as unknown as PuppeteerLike;

	function make(globals: GlobalConfig, puppeteer: PuppeteerLike | null) {
		const bus = createSidecarMessageBus();
		const serviceCtx = createSidecarServiceContext({ name: "astrbot-image-test" });
		const store = createSubscriptionStore(bus);
		const runtime = createSidecarEngines({
			serviceCtx,
			bus,
			api: {} as never,
			push: makePush(),
			subscriptions: store,
			getGlobals: () => globals,
			puppeteer,
		});
		return { runtime, serviceCtx };
	}

	function dynOpts() {
		return dynamicMock.DynamicEngine.mock.calls[0]?.[0] as Record<string, unknown>;
	}
	function liveOpts() {
		return liveMock.LiveEngine.mock.calls[0]?.[0] as Record<string, unknown>;
	}

	it("puppeteer 在位:构造 ImageRenderer 并 start,注入 dynamic.image 与 live.imageRenderer(同一实例)", () => {
		const { runtime } = make(makeDefaultGlobalConfig(), fakePuppeteer);
		expect(imageMock.instances).toHaveLength(1);
		expect(
			(imageMock.instances[0] as { start: ReturnType<typeof vi.fn> }).start,
		).toHaveBeenCalledTimes(1);
		expect(dynOpts().image).toBe(imageMock.instances[0]);
		expect(liveOpts().imageRenderer).toBe(imageMock.instances[0]);
		runtime.dispose();
	});

	it("无 puppeteer:不构造 ImageRenderer,dynamic.image=undefined / live.imageRenderer=null(降级文字)", () => {
		const { runtime } = make(makeDefaultGlobalConfig(), null);
		expect(imageMock.instances).toHaveLength(0);
		expect(dynOpts().image).toBeUndefined();
		expect(liveOpts().imageRenderer).toBeNull();
		runtime.dispose();
	});

	it("imageEnabled 跟随 cardStyle.enabled=true", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.cardStyle.enabled = true;
		const { runtime } = make(g, fakePuppeteer);
		expect((dynOpts().config as { imageEnabled: boolean }).imageEnabled).toBe(true);
		expect((liveOpts().config as { imageEnabled: boolean }).imageEnabled).toBe(true);
		runtime.dispose();
	});

	it("imageEnabled 跟随 cardStyle.enabled=false", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.cardStyle.enabled = false;
		const { runtime } = make(g, fakePuppeteer);
		expect((dynOpts().config as { imageEnabled: boolean }).imageEnabled).toBe(false);
		expect((liveOpts().config as { imageEnabled: boolean }).imageEnabled).toBe(false);
		runtime.dispose();
	});

	it("updateGlobals 改 cardStyle 配色 → imageRenderer.updateConfig 带新配色(仅一次)", () => {
		const { runtime } = make(makeDefaultGlobalConfig(), fakePuppeteer);
		const renderer = imageMock.instances[0] as { updateConfig: ReturnType<typeof vi.fn> };
		const next = makeDefaultGlobalConfig();
		next.defaults.cardStyle.cardColorStart = "#123456";
		runtime.updateGlobals(next);
		expect(renderer.updateConfig).toHaveBeenCalledTimes(1);
		expect(renderer.updateConfig.mock.calls[0]?.[0]).toMatchObject({ cardColorStart: "#123456" });
		runtime.dispose();
	});

	it("updateGlobals 未改 cardStyle(只改 schedule) → 不调 imageRenderer.updateConfig", () => {
		const { runtime } = make(makeDefaultGlobalConfig(), fakePuppeteer);
		const renderer = imageMock.instances[0] as { updateConfig: ReturnType<typeof vi.fn> };
		const next = makeDefaultGlobalConfig();
		next.defaults.schedule.pushTime = 99;
		runtime.updateGlobals(next);
		expect(renderer.updateConfig).not.toHaveBeenCalled();
		runtime.dispose();
	});
});
