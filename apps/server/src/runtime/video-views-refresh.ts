import {
	type Disposable,
	type Failure,
	fail,
	type GlobalSettings,
	type Identity,
	type MessageBus,
	type Result,
	resolveCreatorStats,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { logText, t } from "../i18n/index.js";
import type { VideoViewsStore } from "../stats/video-views-store.js";
import type { SourceRegistry } from "../subscriptions/registry.js";

const HOUR_MS = 3_600_000;

export interface VideoViewsRefreshOptions {
	bus: MessageBus;
	serviceCtx: ServiceContext;
	store: VideoViewsStore;
	sources: Pick<SourceRegistry, "get">;
	getGlobals(): GlobalSettings;
	subscriptions(): Subscription[];
	fetchVideoViews(identity: Identity, signal: AbortSignal): Promise<Result<{ views: number }>>;
}
export interface VideoViewsRefreshHandle extends Disposable {
	pollNow(): Promise<void>;
	getFailure(id: string): Failure | undefined;
	getRevision(): number;
	clear(): Promise<void>;
}

/** 自己的采集时钟，不借作品上报，不依赖推送开关，也不由页面读取触发。 */
export function startVideoViewsRefresh(opts: VideoViewsRefreshOptions): VideoViewsRefreshHandle {
	const attempts = new Map<string, number>();
	const failures = new Map<string, Failure>();
	const pending = new Map<string, { controller: AbortController; source: unknown }>();
	let disposed = false;
	let clearing = false;
	let revision = 0;
	let running: Promise<void> | undefined;
	let again = false;
	let globals = opts.getGlobals();
	let subscriptionsNow = new Map(opts.subscriptions().map((sub) => [sub.id, sub]));
	const eligible = (sub: Subscription) =>
		!disposed &&
		!clearing &&
		!opts.serviceCtx.signal.aborted &&
		sub.enabled &&
		globals.stats.enabled &&
		resolveCreatorStats(sub, globals.defaults).videoViews &&
		Boolean(opts.sources.get(sub.identity.sourceKey)?.fetchVideoViews);
	const current = (id: string) => subscriptionsNow.get(id);
	function reconcile() {
		globals = opts.getGlobals();
		subscriptionsNow = new Map(opts.subscriptions().map((sub) => [sub.id, sub]));
		for (const [id, call] of pending) {
			const sub = current(id);
			if (!sub || !eligible(sub) || opts.sources.get(sub.identity.sourceKey) !== call.source)
				call.controller.abort();
		}
		for (const id of attempts.keys()) {
			const sub = current(id);
			if (!sub || !eligible(sub)) attempts.delete(id);
		}
	}
	async function tick() {
		// 同身份的遗留多条订阅各有文件，但一轮共用一次来源读取。
		const readings = new Map<
			string,
			{ source: unknown; result: Result<{ views: number }>; sampledAt: string }
		>();
		for (const id of subscriptionsNow.keys()) {
			const sub = current(id);
			if (!sub || !eligible(sub)) continue;
			const now = Date.now();
			const last = attempts.get(sub.id);
			if (last !== undefined && now - last < HOUR_MS) continue;
			const controller = new AbortController();
			const call = { controller, source: opts.sources.get(sub.identity.sourceKey) };
			pending.set(sub.id, call);
			attempts.set(sub.id, now);
			try {
				const key = JSON.stringify([sub.identity.sourceKey, sub.identity.externalId]);
				let reading = readings.get(key);
				if (!reading || reading.source !== call.source) {
					const result = await opts.fetchVideoViews(sub.identity, controller.signal);
					reading = { source: call.source, result, sampledAt: new Date().toISOString() };
					if (!controller.signal.aborted) readings.set(key, reading);
				}
				const { result, sampledAt } = reading;
				const latest = current(sub.id);
				if (
					!latest ||
					!eligible(latest) ||
					controller.signal.aborted ||
					opts.sources.get(latest.identity.sourceKey) !== call.source
				)
					continue;
				if (!result.ok) {
					failures.set(sub.id, result);
					revision++;
					continue;
				}
				if (!Number.isSafeInteger(result.views) || result.views < 0) {
					failures.set(sub.id, fail("invalid", t("stats.videoViews.invalidValue")));
					revision++;
					continue;
				}
				await opts.store.append(sub.id, {
					sampledAt,
					views: result.views,
				});
				failures.delete(sub.id);
				revision++;
			} catch (error) {
				if (!controller.signal.aborted) {
					failures.set(sub.id, fail("unavailable", t("stats.videoViews.sampleFailed")));
					revision++;
					opts.serviceCtx.logger.warn(logText("log.videoViews.refreshFailed"), {
						subscriptionId: sub.id,
						error,
					});
				}
			} finally {
				pending.delete(sub.id);
			}
		}
	}
	function pollNow(): Promise<void> {
		reconcile();
		if (disposed || clearing) return Promise.resolve();
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			do {
				again = false;
				await tick();
			} while (again && !disposed && !clearing);
		})().finally(() => {
			running = undefined;
		});
		return running;
	}
	const launch = () => opts.serviceCtx.track(pollNow());
	const timer = opts.serviceCtx.setInterval(launch, 60_000);
	const first = opts.serviceCtx.setTimeout(launch, 0);
	const config = opts.bus.on("config-changed", launch);
	const subscriptions = opts.bus.on("subscription-changed", ({ ops }) => {
		reconcile();
		for (const op of ops)
			if (op.kind === "remove") {
				attempts.delete(op.sub.id);
				failures.delete(op.sub.id);
				revision++;
				opts.serviceCtx.track(
					opts.store.drop(op.sub.id).catch((error) =>
						opts.serviceCtx.logger.warn(logText("log.videoViews.refreshFailed"), {
							subscriptionId: op.sub.id,
							error,
						}),
					),
				);
			}
		launch();
	});
	const shutdown = () => {
		for (const call of pending.values()) call.controller.abort();
	};
	opts.serviceCtx.signal.addEventListener("abort", shutdown);
	return {
		pollNow,
		getFailure: (id) => failures.get(id),
		getRevision: () => revision,
		async clear() {
			clearing = true;
			shutdown();
			try {
				await running;
				await opts.store.clear();
				attempts.clear();
				failures.clear();
				revision++;
			} finally {
				clearing = false;
			}
		},
		async dispose() {
			disposed = true;
			shutdown();
			timer.dispose();
			first.dispose();
			config.dispose();
			subscriptions.dispose();
			opts.serviceCtx.signal.removeEventListener("abort", shutdown);
			await running;
		},
	};
}
