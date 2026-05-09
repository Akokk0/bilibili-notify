/**
 * Standalone-side engine wiring. Mirrors what koishi/dynamic + koishi/live do
 * for the koishi shell, but driven by the file-backed ConfigStore + MultiplexSink
 * instead of koishi's Service / Context plumbing.
 *
 * Construction order (same constraints as the koishi side):
 *
 *   1. Bind SubscriptionStore to ConfigStore
 *   2. Build MultiplexNotificationSink (subscribers: HistoryStore via onDelivery)
 *   3. Construct BilibiliPush({ sink, store, master })
 *   4. Optionally construct CommentaryGenerator (when apiKey + baseUrl set; the
 *      `enabled` flag is enforced at engine-config gating layer in step 5/6)
 *   5. Construct DynamicEngine + LiveEngine with PushLike adapters
 *   6. Wire subscription-changed → engine.applyOps; auth-restored → engine reseed
 *   7. Wire config-changed (globals scope) → DynamicEngine.updateConfig + LiveEngine.updateConfig
 *
 * Engine-stop is registered with serviceCtx.onDispose; the runtime's dispose()
 * propagates correctly.
 */

import { CommentaryGenerator } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	DynamicEngine,
	type DynamicEngineConfig,
	type PushLike as DynamicPushLike,
	type SubscriptionOpView as DynamicSubOp,
	type SubscriptionsView as DynamicSubsView,
	type PushSegment,
} from "@bilibili-notify/dynamic";
import type {
	Disposable,
	FeatureKey,
	GlobalConfig,
	NotificationPayload,
	PayloadSegment,
	PushTarget,
	Subscription,
	SubscriptionOp,
} from "@bilibili-notify/internal";
import { resolve } from "@bilibili-notify/internal";
import {
	LiveEngine,
	type LiveEngineConfig,
	type PushLike as LivePushLike,
	type LiveSubscriptionOp,
	type SubscriptionsView as LiveSubsView,
	type SubItemView as LiveSubView,
} from "@bilibili-notify/live";
import { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { ConfigStore } from "../config/store.js";
import type { HistoryAppendInput, HistoryStore } from "../history/store.js";
import type { PlatformAdapter } from "../platforms/types.js";
import { createMultiplexSink } from "../sink/multiplex.js";
import { segmentToPayload, standaloneContentBuilder } from "./content-builder.js";
import type { NodeServiceContext } from "./service-context.js";

export interface EnginesRuntime extends Disposable {
	readonly dynamic: DynamicEngine;
	readonly live: LiveEngine;
	readonly push: BilibiliPush;
	readonly subscriptionStore: SubscriptionStore;
	readonly commentary: CommentaryGenerator | null;
	/** Live listener UID list for /api/live/listening. */
	listListeningUids(): string[];
}

export interface CreateEnginesOptions {
	/**
	 * NodeServiceContext (not the platform-neutral ServiceContext) — engines.ts
	 * uses `forSubsystem(name, level)` to give each engine its own pino instance
	 * driven by globals.app.logLevels.{dynamic,live,image,ai}. The standalone
	 * runtime constructs the parent context once at boot.
	 */
	serviceCtx: NodeServiceContext;
	api: BilibiliAPI;
	configStore: ConfigStore;
	historyStore: HistoryStore;
	subscriptionStore: SubscriptionStore;
	bus: import("@bilibili-notify/internal").MessageBus;
	adapters: PlatformAdapter[];
}

export function createEngines(opts: CreateEnginesOptions): EnginesRuntime {
	const log = opts.serviceCtx.logger;
	// Per-module sub-contexts. Pino level is fixed at construct time, so editing
	// globals.app.logLevels via /api/globals takes effect on next server restart.
	const initialLevels = opts.configStore.getGlobals().app.logLevels;
	const dynamicCtx = opts.serviceCtx.forSubsystem("dynamic", initialLevels?.dynamic);
	const liveCtx = opts.serviceCtx.forSubsystem("live", initialLevels?.live);
	const aiCtx = opts.serviceCtx.forSubsystem("ai", initialLevels?.ai);
	const globals = (): GlobalConfig => opts.configStore.getGlobals();

	// ---------- Sink + push ----------
	const sink = createMultiplexSink({
		store: opts.configStore,
		adapters: opts.adapters,
		logger: log,
		onDelivery: (target, payload, result, dispatchOpts) => {
			void recordHistoryFromDelivery(
				opts.historyStore,
				target,
				payload,
				result,
				dispatchOpts,
			).catch((e) => log.warn(`[history] append failed: ${String(e)}`));
		},
	});

	const masterTarget = (): PushTarget | undefined => {
		const id = globals().master.targetId;
		if (!id) return undefined;
		return opts.configStore.getTargets().find((t) => t.id === id);
	};

	const push = new BilibiliPush({
		sink,
		store: opts.subscriptionStore,
		master: masterTarget() ?? null,
		logger: log,
	});
	push.start();

	// ---------- AI (optional) ----------
	// 构造仅依赖 apiKey / baseUrl 是否齐备 —— 与 `enabled` 解耦,后者交给引擎 config 层
	// 的 aiEnabled flag 在每次推送前热判断。这样用户在 dashboard 把 AI 开关切关再切开
	// 不需要重启服务,且无需在 config-changed 里 hot-swap 实例。
	let commentary: CommentaryGenerator | null = null;
	const aiSettings = globals().defaults.ai;
	if (aiSettings.apiKey && aiSettings.baseUrl) {
		try {
			commentary = new CommentaryGenerator({
				serviceCtx: aiCtx,
				api: opts.api,
				config: {
					apiKey: aiSettings.apiKey,
					baseURL: aiSettings.baseUrl,
					model: aiSettings.model,
					persona: {
						preset: "custom",
						name: aiSettings.persona.name,
						addressUser: aiSettings.persona.addressUser,
						addressSelf: aiSettings.persona.addressSelf,
						traits: aiSettings.persona.traits,
						catchphrase: aiSettings.persona.catchphrase,
					},
					dynamicPrompt: aiSettings.dynamicPrompt,
					liveSummaryPrompt: aiSettings.liveSummaryPrompt,
					enableConversation: false,
					maxHistory: 6,
					enableThinking: false,
					enableSearch: false,
					enableVision: false,
				},
			});
			commentary.start();
		} catch (err) {
			log.warn(`[ai] commentary init failed: ${String(err)}`);
			commentary = null;
		}
	}

	// ---------- DynamicEngine ----------
	const dynamicPushLike: DynamicPushLike = {
		async broadcastDynamic(uid, segments, _kind) {
			const payload = pushSegmentsToPayload(segments);
			await push.broadcastToFeature(uid, "dynamic", payload);
		},
		sendPrivateMsg: (text) => push.sendPrivateMsg(text),
		sendErrorMsg: (text) => push.sendErrorMsg(text),
	};

	const dynamicConfig = (): DynamicEngineConfig => {
		const f = globals().defaults.filters;
		// New schema uses array-of-regex while the engine takes a single combined
		// regex string; join with `|` (capturing-group safe since users supply
		// alt patterns themselves).
		const blockHasRules =
			f.blockKeywords.length > 0 || f.blockRegex.length > 0 || f.blockForward || f.blockArticle;
		const whitelistHasRules = f.whitelistKeywords.length > 0 || f.whitelistRegex.length > 0;
		return {
			dynamicUrl: true,
			dynamicCron: globals().app.dynamicCron,
			dynamicVideoUrlToBV: false,
			pushImgsInDynamic: true,
			imageEnabled: globals().defaults.cardStyle.enabled,
			aiEnabled: globals().defaults.ai.enabled,
			filter: {
				enable: blockHasRules,
				notify: false,
				regex: f.blockRegex.join("|"),
				keywords: f.blockKeywords,
				forward: f.blockForward,
				article: f.blockArticle,
				whitelistEnable: whitelistHasRules,
				whitelistRegex: f.whitelistRegex.join("|"),
				whitelistKeywords: f.whitelistKeywords,
			},
		};
	};

	const dynamic = new DynamicEngine({
		serviceCtx: dynamicCtx,
		bus: opts.bus,
		api: opts.api,
		push: dynamicPushLike,
		image: undefined, // puppeteer not yet wired in standalone (plan §3 future)
		ai: commentary ?? undefined,
		config: dynamicConfig(),
		getSubs: () => buildDynamicSubsView(opts.subscriptionStore, globals()),
	});
	dynamic.start();

	// ---------- LiveEngine ----------
	const livePushLike: LivePushLike = {
		async broadcastToTargets(uid, content, type) {
			const feature = liveTypeToFeature(type as number);
			const segments = segmentToPayload(content);
			const payload = collapseSegments(segments);
			await push.broadcastToFeature(uid, feature, payload);
		},
		sendPrivateMsg: (text) => push.sendPrivateMsg(text),
	};

	const liveConfig = (): LiveEngineConfig => {
		const g = globals();
		return {
			pushTime: g.defaults.schedule.pushTime,
			restartPush: g.defaults.schedule.restartPush,
			minScPrice: g.defaults.filters.minScPrice,
			minGuardLevel: g.defaults.filters.minGuardLevel,
			liveSummaryDefault: g.defaults.templates.liveSummary,
			imageEnabled: g.defaults.cardStyle.enabled,
			aiEnabled: g.defaults.ai.enabled,
			customGuardBuy: {
				enable: false,
				guardBuyMsg: g.defaults.templates.guardBuy.captain.template,
				captainImgUrl: g.defaults.templates.guardBuy.captain.imageUrl,
				supervisorImgUrl: g.defaults.templates.guardBuy.commander.imageUrl,
				governorImgUrl: g.defaults.templates.guardBuy.governor.imageUrl,
			},
			customLiveMsg: {
				enable: false,
				customLiveStart: g.defaults.templates.liveStart,
				customLive: g.defaults.templates.liveOngoing,
				customLiveEnd: g.defaults.templates.liveEnd,
			},
		};
	};

	const live = new LiveEngine({
		serviceCtx: liveCtx,
		api: opts.api,
		push: livePushLike,
		contentBuilder: standaloneContentBuilder,
		imageRenderer: null,
		commentary: commentary ?? null,
		config: liveConfig(),
		emitPluginError: (msg) => opts.bus.emit("plugin-error", "live-engine", msg),
	});

	// Initialise live with current subs.
	const initialLiveView = buildLiveSubsView(opts.subscriptionStore, globals());
	if (Object.keys(initialLiveView).length > 0) {
		live.start(initialLiveView);
	}

	// ---------- Bus wiring ----------
	const handles: Disposable[] = [];

	handles.push(
		opts.bus.on("subscription-changed", (ops) => {
			const dynOps = subscriptionOpsToDynamic(ops, opts.subscriptionStore);
			dynamic.applyOps(dynOps);
			const liveOps = subscriptionOpsToLive(ops, opts.subscriptionStore, globals());
			live.applyOps(liveOps, (uid) => {
				const sub = opts.subscriptionStore.findByUid(uid);
				return sub ? buildLiveSubViewSingle(sub, globals()) : undefined;
			});
		}),
	);
	handles.push(
		opts.bus.on("auth-restored", () => {
			live.rebuildFromSubs(buildLiveSubsView(opts.subscriptionStore, globals()));
		}),
	);
	handles.push(
		opts.bus.on("auth-lost", () => {
			live.teardown();
		}),
	);
	handles.push(
		opts.bus.on("config-changed", (scope) => {
			if (scope === "globals") {
				dynamic.updateConfig(dynamicConfig());
				live.updateConfig(liveConfig());
				if (commentary) {
					const a = globals().defaults.ai;
					commentary.updateConfig({
						apiKey: a.apiKey ?? "",
						baseURL: a.baseUrl ?? "",
						model: a.model,
						persona: {
							preset: "custom",
							name: a.persona.name,
							addressUser: a.persona.addressUser,
							addressSelf: a.persona.addressSelf,
							traits: a.persona.traits,
							catchphrase: a.persona.catchphrase,
						},
						dynamicPrompt: a.dynamicPrompt,
						liveSummaryPrompt: a.liveSummaryPrompt,
						enableConversation: false,
						maxHistory: 6,
						enableThinking: false,
						enableSearch: false,
						enableVision: false,
					});
				}
			}
		}),
	);

	// ---------- Disposal ----------
	const dispose = (): void => {
		for (const h of handles.splice(0)) {
			try {
				h.dispose();
			} catch {
				// best-effort
			}
		}
		try {
			dynamic.stop();
		} catch (e) {
			log.warn(`[engines] dynamic.stop failed: ${String(e)}`);
		}
		try {
			live.stop();
		} catch (e) {
			log.warn(`[engines] live.stop failed: ${String(e)}`);
		}
		try {
			commentary?.stop();
		} catch (e) {
			log.warn(`[engines] commentary.stop failed: ${String(e)}`);
		}
		try {
			push.stop();
		} catch (e) {
			log.warn(`[engines] push.stop failed: ${String(e)}`);
		}
	};
	opts.serviceCtx.onDispose(dispose);

	return {
		dynamic,
		live,
		push,
		subscriptionStore: opts.subscriptionStore,
		commentary,
		listListeningUids: () => listListeningUids(live),
		dispose,
	};
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function recordHistoryFromDelivery(
	historyStore: HistoryStore,
	target: PushTarget,
	payload: NotificationPayload,
	result: { ok: boolean; latencyMs: number; err?: string },
	dispatchOpts: { private: boolean },
): Promise<void> {
	// History rows always have a uid + subscriptionId, but the multiplex sink
	// doesn't carry that context; we infer "system" rows for master / private
	// notifications. The DynamicEngine / LiveEngine paths embed those fields
	// before reaching us, so for now we record best-effort metadata only.
	const input: HistoryAppendInput = {
		source: dispatchOpts.private ? "live" : "dynamic", // best-effort default
		uid: "",
		subscriptionId: target.id,
		targets: [
			{
				targetId: target.id,
				ok: result.ok,
				latencyMs: result.latencyMs,
				err: result.err,
			},
		],
		payload,
	};
	// Schema requires UUIDs for ids; if subscriptionId isn't a uuid it would
	// fail validation. The store catches that and logs — we don't re-throw.
	try {
		await historyStore.append(input);
	} catch {
		// drop — history is best-effort, not load-bearing for delivery.
	}
}

function pushSegmentsToPayload(segments: PushSegment[]): NotificationPayload {
	if (segments.length === 1 && segments[0]?.type === "text") {
		return { kind: "text", text: segments[0].text };
	}
	if (segments.length === 1 && segments[0]?.type === "image") {
		return {
			kind: "image",
			image: { buffer: segments[0].buffer, mime: segments[0].mime },
		};
	}
	const mapped: PayloadSegment[] = [];
	for (const s of segments) {
		if (s.type === "text") mapped.push({ type: "text", text: s.text });
		else if (s.type === "image") mapped.push({ type: "image", buffer: s.buffer, mime: s.mime });
		else if (s.type === "image-group") {
			for (const url of s.urls) mapped.push({ type: "link", href: url });
		}
	}
	if (mapped.length === 0) return { kind: "text", text: "" };
	return { kind: "composite", segments: mapped };
}

function collapseSegments(segments: PayloadSegment[]): NotificationPayload {
	if (segments.length === 0) return { kind: "text", text: "" };
	if (segments.length === 1) {
		const only = segments[0];
		if (!only) return { kind: "text", text: "" };
		if (only.type === "text") return { kind: "text", text: only.text };
		if (only.type === "image") {
			return { kind: "image", image: { buffer: only.buffer, mime: only.mime } };
		}
	}
	return { kind: "composite", segments };
}

function liveTypeToFeature(type: number): FeatureKey {
	switch (type) {
		case 0:
		case 3:
			return "live";
		case 4:
			return "liveGuardBuy";
		case 5:
			return "wordcloud";
		case 6:
			return "superchat";
		case 7:
			return "specialDanmaku";
		case 8:
			return "specialUserEnter";
		case 9:
			return "liveEnd";
		default:
			return "live";
	}
}

function buildDynamicSubsView(store: SubscriptionStore, globals: GlobalConfig): DynamicSubsView {
	const view: DynamicSubsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		const eff = resolve(sub, globals.defaults);
		const hasDynamic = (eff.routing.dynamic?.length ?? 0) > 0;
		view[sub.uid] = {
			uid: sub.uid,
			uname: sub.cachedProfile?.name ?? sub.uid,
			dynamic: hasDynamic,
			customCardStyle: {
				enable: true,
				cardColorStart: eff.cardStyle.cardColorStart,
				cardColorEnd: eff.cardStyle.cardColorEnd,
				cardBasePlateColor: eff.cardStyle.cardBasePlateColor,
				cardBasePlateBorder: eff.cardStyle.cardBasePlateBorder,
			},
		};
	}
	return view;
}

function buildLiveSubsView(store: SubscriptionStore, globals: GlobalConfig): LiveSubsView {
	const view: LiveSubsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		view[sub.uid] = buildLiveSubViewSingle(sub, globals);
	}
	return view;
}

function buildLiveSubViewSingle(sub: Subscription, globals: GlobalConfig): LiveSubView {
	const eff = resolve(sub, globals.defaults);
	const danmakuUsers = sub.specialUsers.filter((u) => u.kinds.includes("danmaku"));
	const enterUsers = sub.specialUsers.filter((u) => u.kinds.includes("enter"));
	return {
		uid: sub.uid,
		uname: sub.cachedProfile?.name ?? sub.uid,
		roomId: "",
		dynamic: (eff.routing.dynamic?.length ?? 0) > 0,
		dynamicAtAll: (eff.routing.dynamicAtAll?.length ?? 0) > 0,
		live: (eff.routing.live?.length ?? 0) > 0,
		liveAtAll: (eff.routing.liveAtAll?.length ?? 0) > 0,
		liveEnd: (eff.routing.liveEnd?.length ?? 0) > 0,
		liveGuardBuy: (eff.routing.liveGuardBuy?.length ?? 0) > 0,
		superchat: (eff.routing.superchat?.length ?? 0) > 0,
		wordcloud: (eff.routing.wordcloud?.length ?? 0) > 0,
		liveSummary: (eff.routing.liveSummary?.length ?? 0) > 0,
		target: eff.routing,
		customCardStyle: {
			enable: true,
			cardColorStart: eff.cardStyle.cardColorStart,
			cardColorEnd: eff.cardStyle.cardColorEnd,
			cardBasePlateColor: eff.cardStyle.cardBasePlateColor,
			cardBasePlateBorder: eff.cardStyle.cardBasePlateBorder,
		},
		customLiveMsg: {
			enable: true,
			customLiveStart: eff.templates.liveStart,
			customLive: eff.templates.liveOngoing,
			customLiveEnd: eff.templates.liveEnd,
		},
		customGuardBuy: {
			enable: true,
			guardBuyMsg: eff.templates.guardBuy.captain.template,
			captainImgUrl: eff.templates.guardBuy.captain.imageUrl,
			supervisorImgUrl: eff.templates.guardBuy.commander.imageUrl,
			governorImgUrl: eff.templates.guardBuy.governor.imageUrl,
		},
		customLiveSummary: {
			enable: true,
			liveSummary: eff.templates.liveSummary,
		},
		customSpecialDanmakuUsers:
			danmakuUsers.length > 0
				? {
						enable: true,
						specialDanmakuUsers: danmakuUsers.map((u) => u.uid),
						msgTemplate: eff.templates.specialDanmaku,
					}
				: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom:
			enterUsers.length > 0
				? {
						enable: true,
						specialUsersEnterTheRoom: enterUsers.map((u) => u.uid),
						msgTemplate: eff.templates.specialUserEnter,
					}
				: { enable: false, msgTemplate: "" },
	};
}

function subscriptionOpsToDynamic(ops: SubscriptionOp[], store: SubscriptionStore): DynamicSubOp[] {
	const out: DynamicSubOp[] = [];
	for (const op of ops) {
		if (op.type === "add") {
			const hasDynamic = (op.sub.routing.dynamic?.length ?? 0) > 0;
			out.push({
				type: "add",
				sub: {
					uid: op.sub.uid,
					uname: op.sub.cachedProfile?.name ?? op.sub.uid,
					dynamic: hasDynamic,
					customCardStyle: op.sub.overrides.cardStyle
						? {
								enable: true,
								cardColorStart: op.sub.overrides.cardStyle.cardColorStart,
								cardColorEnd: op.sub.overrides.cardStyle.cardColorEnd,
								cardBasePlateColor: op.sub.overrides.cardStyle.cardBasePlateColor,
								cardBasePlateBorder: op.sub.overrides.cardStyle.cardBasePlateBorder,
							}
						: { enable: false },
				},
			});
		} else if (op.type === "remove") {
			out.push({ type: "delete", uid: op.uid });
		} else {
			const sub = store.findByUid(op.sub.uid);
			if (!sub) continue;
			out.push({
				type: "update",
				uid: op.sub.uid,
				changes: [{ scope: "dynamic", dynamic: (sub.routing.dynamic?.length ?? 0) > 0 }],
			});
		}
	}
	return out;
}

function subscriptionOpsToLive(
	ops: SubscriptionOp[],
	store: SubscriptionStore,
	globals: GlobalConfig,
): LiveSubscriptionOp[] {
	const out: LiveSubscriptionOp[] = [];
	for (const op of ops) {
		if (op.type === "add") {
			out.push({ type: "add", sub: buildLiveSubViewSingle(op.sub, globals) });
		} else if (op.type === "remove") {
			out.push({ type: "delete", uid: op.uid });
		} else {
			const sub = store.findByUid(op.sub.uid);
			if (!sub) continue;
			const eff = resolve(sub, globals.defaults);
			out.push({
				type: "update",
				uid: op.sub.uid,
				changes: [
					{
						scope: "live",
						live: (eff.routing.live?.length ?? 0) > 0,
						liveEnd: (eff.routing.liveEnd?.length ?? 0) > 0,
						liveGuardBuy: (eff.routing.liveGuardBuy?.length ?? 0) > 0,
						superchat: (eff.routing.superchat?.length ?? 0) > 0,
						wordcloud: (eff.routing.wordcloud?.length ?? 0) > 0,
						liveSummary: (eff.routing.liveSummary?.length ?? 0) > 0,
					},
				],
			});
		}
	}
	return out;
}

function listListeningUids(live: LiveEngine): string[] {
	// LiveEngine doesn't expose its listener manager directly, but exposes a
	// listenerCount accessor. For now we read the active subscription set off
	// the engine's internal config — see plan §3 (live-engine getter API
	// expansion). Until that lands, return an empty list (the dashboard's
	// "正在直播" panel renders empty state which matches an idle backend).
	void live;
	return [];
}
