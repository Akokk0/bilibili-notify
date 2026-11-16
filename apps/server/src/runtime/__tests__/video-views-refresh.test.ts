import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fail,
	makeDefaultGlobalSettings,
	makeEmptySubscription,
	ok,
	type Result,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createVideoViewsStore } from "../../stats/video-views-store.js";
import { createSourceGates, fetchSourceVideoViews } from "../../subscriptions/call-source.js";
import { createNodeMessageBus } from "../message-bus.js";
import { startVideoViewsRefresh } from "../video-views-refresh.js";

let root: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime("2026-11-16T00:00:00.000Z");
	root = await mkdtemp(join(tmpdir(), "bn-video-views-"));
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	vi.useRealTimers();
	await rm(root, { recursive: true, force: true });
});

function harness() {
	const globals = makeDefaultGlobalSettings();
	const sub = makeEmptySubscription({
		id: "11111111-1111-4111-8111-111111111111",
		identity: { sourceKey: "test", externalId: "42" },
	});
	const subscriptions: Subscription[] = [sub];
	const bus = createNodeMessageBus();
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const fetchVideoViews = vi.fn(
		async (_identity: unknown, _signal: AbortSignal): Promise<Result<{ views: number }>> =>
			ok({ views: 1200 }),
	);
	const source = { fetchVideoViews };
	const sources = { get: (key: string) => (key === "test" ? source : undefined) } as never;
	const controller = new AbortController();
	const serviceCtx = {
		signal: controller.signal,
		logger,
		setTimeout(fn: () => void, ms: number) {
			const id = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(id) };
		},
		setInterval(fn: () => void, ms: number) {
			const id = setInterval(fn, ms);
			return { dispose: () => clearInterval(id) };
		},
		track: (_promise: Promise<unknown>) => {},
	} as unknown as ServiceContext;
	const store = createVideoViewsStore({ dataRoot: root });
	const gates = createSourceGates();
	const handle = startVideoViewsRefresh({
		bus,
		serviceCtx,
		store,
		sources,
		getGlobals: () => globals,
		subscriptions: () => subscriptions,
		fetchVideoViews: (identity, signal) =>
			fetchSourceVideoViews({ sources, logger, gates }, identity, signal),
	});
	stop = async () => {
		await handle.dispose();
		await store.close();
	};
	return { globals, sub, subscriptions, bus, fetchVideoViews, handle, store, controller };
}

it("默认不采集；仅当前开启立即记录，此后每小时取一次真实累计值", async () => {
	const h = harness();
	await h.handle.pollNow();
	expect(h.fetchVideoViews).not.toHaveBeenCalled();
	h.sub.overrides.stats = { videoViews: true };
	h.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: h.sub }] });
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(1);
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toEqual([
		{ sampledAt: "2026-11-16T00:00:00.000Z", views: 1200 },
	]);
	await vi.advanceTimersByTimeAsync(59 * 60_000);
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(1);
	h.fetchVideoViews.mockResolvedValueOnce(ok({ views: 1250 }));
	await vi.advanceTimersByTimeAsync(60_000);
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(2);
	expect(
		(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).map((x) => x.views),
	).toEqual([1200, 1250]);
});

it("全局开启包括新增创作者，单独关闭、统计关闭和停用订阅均不再采集，历史仍在", async () => {
	const h = harness();
	h.globals.defaults.stats.videoViews = true;
	await h.handle.pollNow();
	const added = makeEmptySubscription({
		id: "22222222-2222-4222-8222-222222222222",
		identity: { sourceKey: "test", externalId: "99" },
	});
	h.subscriptions.push(added);
	h.bus.emit("subscription-changed", { ops: [{ kind: "add", sub: added }] });
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(2);
	expect(await h.store.listSamplesSince(added.id, "2026-11-01T00:00:00.000Z")).toHaveLength(1);
	h.sub.overrides.stats = { videoViews: false };
	added.enabled = false;
	h.bus.emit("subscription-changed", {
		ops: [
			{ kind: "update", sub: h.sub },
			{ kind: "update", sub: added },
		],
	});
	await vi.advanceTimersByTimeAsync(3_600_000);
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(2);
	added.enabled = true;
	h.globals.stats.enabled = false;
	h.bus.emit("config-changed", { scope: "globals" });
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(2);
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toHaveLength(1);
});

it("遗留的同身份订阅共用一次累计值请求，各自记录自己的样本", async () => {
	const h = harness();
	h.globals.defaults.stats.videoViews = true;
	const duplicate = { ...h.sub, id: "22222222-2222-4222-8222-222222222222" };
	h.subscriptions.push(duplicate);
	await h.handle.pollNow();
	expect(h.fetchVideoViews).toHaveBeenCalledTimes(1);
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toEqual(
		await h.store.listSamplesSince(duplicate.id, "2026-11-01T00:00:00.000Z"),
	);
});

it("失败与无效读数不记零；取消在途后即使来源迟到成功也不写，清空和删除不会复活旧样本", async () => {
	const h = harness();
	h.sub.overrides.stats = { videoViews: true };
	h.fetchVideoViews.mockResolvedValueOnce(fail("unauthorized", "sign in"));
	await h.handle.pollNow();
	expect(h.handle.getFailure(h.sub.id)?.code).toBe("unauthorized");
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toEqual([]);
	let complete: (result: Result<{ views: number }>) => void = () => {};
	let signal: AbortSignal | undefined;
	h.fetchVideoViews.mockImplementationOnce(async (_, active) => {
		signal = active;
		return new Promise((done) => {
			complete = done;
		});
	});
	vi.setSystemTime("2026-11-16T01:00:00.000Z");
	const pending = h.handle.pollNow();
	await vi.advanceTimersByTimeAsync(0);
	h.sub.overrides.stats.videoViews = false;
	h.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: h.sub }] });
	expect(signal?.aborted).toBe(true);
	await pending;
	complete(ok({ views: 0 }));
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toEqual([]);
	h.sub.overrides.stats.videoViews = true;
	h.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: h.sub }] });
	await h.handle.pollNow();
	expect(h.handle.getFailure(h.sub.id)).toBeUndefined();
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toHaveLength(1);
	await h.handle.clear();
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toEqual([]);
	await h.handle.pollNow();
	h.subscriptions.length = 0;
	h.bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: h.sub }] });
	await h.handle.pollNow();
	await h.store.close();
	expect(await h.store.listSamplesSince(h.sub.id, "2026-11-01T00:00:00.000Z")).toEqual([]);
});
