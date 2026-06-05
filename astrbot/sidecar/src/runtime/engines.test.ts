import { makeEmptySubscription } from "@bilibili-notify/internal";
import { createSubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@bilibili-notify/dynamic", () => ({
	DynamicEngine: dynamicMock.DynamicEngine,
}));

vi.mock("@bilibili-notify/live", () => ({
	LiveEngine: liveMock.LiveEngine,
	LivePushType: liveMock.LivePushType,
}));

describe("createSidecarEngines", () => {
	it("starts engines and forwards subscription and auth events", () => {
		const bus = createSidecarMessageBus();
		const serviceCtx = createSidecarServiceContext({ name: "astrbot-test" });
		const store = createSubscriptionStore(bus);
		const push = {
			broadcastToFeature: vi.fn(async () => []),
			sendPrivateMsg: vi.fn(async () => undefined),
			sendErrorMsg: vi.fn(async () => undefined),
			start: vi.fn(),
			stop: vi.fn(),
		} as never;

		const runtime = createSidecarEngines({
			serviceCtx,
			bus,
			api: {} as never,
			push,
			subscriptions: store,
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
