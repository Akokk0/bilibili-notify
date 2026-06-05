import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	DynamicEngine,
	type DynamicEngineConfig,
	type PushLike as DynamicPushLike,
	type SubscriptionOpView as DynamicSubOp,
	type SubscriptionsView as DynamicSubsView,
	type PushSegment,
} from "@bilibili-notify/dynamic";
import {
	type Disposable,
	type FeatureKey,
	type GlobalConfig,
	type MessageBus,
	makeDefaultGlobalConfig,
	type NotificationPayload,
	type PayloadSegment,
	resolve,
	type Subscription,
	type SubscriptionOp,
} from "@bilibili-notify/internal";
import {
	type LiveContentBuilder,
	LiveEngine,
	type LiveEngineConfig,
	type PushLike as LivePushLike,
	LivePushType,
	type LiveSubscriptionOp,
	type SubscriptionsView as LiveSubsView,
	type SubItemView as LiveSubView,
} from "@bilibili-notify/live";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { SidecarServiceContext } from "./platform.js";

export interface SidecarEngineStatus {
	readonly dynamic: boolean;
	readonly live: boolean;
}

export interface SidecarEnginesRuntime extends Disposable {
	readonly dynamic: DynamicEngine;
	readonly live: LiveEngine;
	start(): void;
	status(): SidecarEngineStatus;
}

export interface CreateSidecarEnginesOptions {
	readonly serviceCtx: SidecarServiceContext;
	readonly bus: MessageBus;
	readonly api: BilibiliAPI;
	readonly push: BilibiliPush;
	readonly subscriptions: SubscriptionStore;
}

export function createSidecarEngines(options: CreateSidecarEnginesOptions): SidecarEnginesRuntime {
	const globals = makeDefaultGlobalConfig();
	const dynamicPushLike: DynamicPushLike = {
		async broadcastDynamic(uid, segments) {
			await options.push.broadcastToFeature(uid, "dynamic", pushSegmentsToPayload(segments));
		},
		sendPrivateMsg: (text) => options.push.sendPrivateMsg(text),
		sendErrorMsg: (text) => options.push.sendErrorMsg(text),
	};
	const livePushLike: LivePushLike = {
		async broadcastToTargets(uid, content, type) {
			const payload = collapseSegments(segmentToPayload(content));
			await options.push.broadcastToFeature(uid, liveTypeToFeature(type), payload, {
				allowAtAll: type === LivePushType.StartBroadcasting,
			});
		},
		sendPrivateMsg: (text) => options.push.sendPrivateMsg(text),
	};

	const dynamic = new DynamicEngine({
		serviceCtx: options.serviceCtx,
		bus: options.bus,
		api: options.api,
		push: dynamicPushLike,
		config: buildDynamicConfig(globals),
		getSubs: () => buildDynamicSubsView(options.subscriptions, globals),
	});
	const live = new LiveEngine({
		serviceCtx: options.serviceCtx,
		api: options.api,
		push: livePushLike,
		contentBuilder: sidecarContentBuilder,
		imageRenderer: null,
		commentary: null,
		config: buildLiveConfig(globals),
		emitEngineError: (message) => options.bus.emit("engine-error", "live-engine", message),
		emitLiveState: (uid, status) => options.bus.emit("live-state-changed", uid, status),
		emitViewers: (uid, viewers) => options.bus.emit("live-viewers-changed", uid, viewers),
	});
	const handles: Disposable[] = [];
	let started = false;
	let liveStarted = false;
	let disposed = false;
	const updateLiveStatus = (): void => {
		liveStarted = live.listLiveSnapshots().length > 0;
	};

	handles.push(
		options.bus.on("subscription-changed", (ops) => {
			dynamic.applyOps(subscriptionOpsToDynamic(ops, options.subscriptions, globals));
			live.applyOps(subscriptionOpsToLive(ops, options.subscriptions, globals), (uid) => {
				const sub = options.subscriptions.findByUid(uid);
				return sub ? buildLiveSubViewSingle(sub, globals) : undefined;
			});
			updateLiveStatus();
		}),
	);
	handles.push(
		options.bus.on("auth-restored", () => {
			live.rebuildFromSubs(buildLiveSubsView(options.subscriptions, globals));
			updateLiveStatus();
		}),
	);
	handles.push(
		options.bus.on("auth-lost", () => {
			live.teardown();
			liveStarted = false;
		}),
	);

	const runtime: SidecarEnginesRuntime = {
		dynamic,
		live,
		start() {
			if (started) return;
			started = true;
			dynamic.start();
			const liveSubs = buildLiveSubsView(options.subscriptions, globals);
			if (Object.keys(liveSubs).length > 0) {
				live.start(liveSubs);
			}
			updateLiveStatus();
		},
		status: () => ({ dynamic: started, live: liveStarted }),
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const handle of handles.splice(0)) handle.dispose();
			try {
				dynamic.stop();
			} catch (error) {
				options.serviceCtx.logger.warn(`[astrbot] dynamic engine stop failed: ${String(error)}`);
			}
			try {
				live.stop();
			} catch (error) {
				options.serviceCtx.logger.warn(`[astrbot] live engine stop failed: ${String(error)}`);
			}
			started = false;
			liveStarted = false;
		},
	};
	options.serviceCtx.onDispose(() => runtime.dispose());
	return runtime;
}

function buildDynamicConfig(globals: GlobalConfig): DynamicEngineConfig {
	const filters = globals.defaults.filters;
	const blockHasRules =
		filters.blockKeywords.length > 0 ||
		filters.blockRegex.length > 0 ||
		filters.blockForward ||
		filters.blockArticle ||
		filters.blockDraw ||
		filters.blockAv;
	const whitelistHasRules =
		filters.whitelistKeywords.length > 0 || filters.whitelistRegex.length > 0;
	return {
		dynamicUrl: true,
		dynamicCron: globals.app.dynamicCron,
		dynamicVideoUrlToBV: false,
		imageGroup: globals.defaults.imageGroup,
		imageEnabled: false,
		aiEnabled: false,
		dynamicTemplate: globals.defaults.templates.dynamic,
		videoTemplate: globals.defaults.templates.dynamicVideo,
		filter: {
			enable: blockHasRules,
			notify: false,
			regex: filters.blockRegex.join("|"),
			keywords: filters.blockKeywords,
			forward: filters.blockForward,
			article: filters.blockArticle,
			draw: filters.blockDraw,
			av: filters.blockAv,
			whitelistEnable: whitelistHasRules,
			whitelistRegex: filters.whitelistRegex.join("|"),
			whitelistKeywords: filters.whitelistKeywords,
		},
	};
}

function buildLiveConfig(globals: GlobalConfig): LiveEngineConfig {
	return {
		pushTime: globals.defaults.schedule.pushTime,
		liveSummaryDefault: globals.defaults.templates.liveSummary,
		imageEnabled: false,
		aiEnabled: false,
		customGuardBuy: {
			enable: globals.defaults.templates.guardBuy.enable,
			guardBuyMsg: globals.defaults.templates.guardBuy.captain.template,
			captainImgUrl: globals.defaults.templates.guardBuy.captain.imageUrl,
			supervisorImgUrl: globals.defaults.templates.guardBuy.commander.imageUrl,
			governorImgUrl: globals.defaults.templates.guardBuy.governor.imageUrl,
		},
		customLiveMsg: {
			enable: true,
			customLiveStart: globals.defaults.templates.liveStart,
			customLive: globals.defaults.templates.liveOngoing,
			customLiveEnd: globals.defaults.templates.liveEnd,
		},
	};
}

function buildDynamicSubsView(store: SubscriptionStore, globals: GlobalConfig): DynamicSubsView {
	const view: DynamicSubsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		view[sub.uid] = buildDynamicSubViewSingle(sub, globals);
	}
	return view;
}

function buildDynamicSubViewSingle(
	sub: Subscription,
	globals: GlobalConfig,
): DynamicSubsView[string] {
	const effective = resolve(sub, globals.defaults);
	return {
		uid: sub.uid,
		uname: sub.name ?? sub.uid,
		dynamic: sub.enabled && effective.features.dynamic,
		customCardStyle: sub.overrides.cardStyle
			? {
					enable: true,
					cardColorStart: sub.overrides.cardStyle.cardColorStart,
					cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
				}
			: { enable: false },
		imageGroupEnable: sub.overrides.imageGroup?.enable,
		imageGroupForward: sub.overrides.imageGroup?.forward,
		customDynamicTemplate: sub.overrides.templates?.dynamic,
		customVideoTemplate: sub.overrides.templates?.dynamicVideo,
	};
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
	const effective = resolve(sub, globals.defaults);
	const danmakuUsers = sub.specialUsers.filter((user) => user.kinds.includes("danmaku"));
	const enterUsers = sub.specialUsers.filter((user) => user.kinds.includes("enter"));
	return {
		uid: sub.uid,
		uname: sub.name ?? sub.uid,
		roomId: "",
		dynamic: effective.features.dynamic,
		live: effective.features.live,
		liveEnd: effective.features.liveEnd,
		liveGuardBuy: effective.features.liveGuardBuy,
		superchat: effective.features.superchat,
		wordcloud: effective.features.wordcloud,
		liveSummary: effective.features.liveSummary,
		target: effective.routing,
		customCardStyle: sub.overrides.cardStyle
			? {
					enable: true,
					cardColorStart: sub.overrides.cardStyle.cardColorStart,
					cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
				}
			: { enable: false },
		customLiveMsg: {
			enable: true,
			customLiveStart: effective.templates.liveStart,
			customLive: effective.templates.liveOngoing,
			customLiveEnd: effective.templates.liveEnd,
		},
		customGuardBuy: {
			enable: effective.templates.guardBuy.enable,
			guardBuyMsg: effective.templates.guardBuy.captain.template,
			captainImgUrl: effective.templates.guardBuy.captain.imageUrl,
			supervisorImgUrl: effective.templates.guardBuy.commander.imageUrl,
			governorImgUrl: effective.templates.guardBuy.governor.imageUrl,
		},
		customLiveSummary: {
			enable: true,
			liveSummary: effective.templates.liveSummary,
		},
		customSpecialDanmakuUsers:
			danmakuUsers.length > 0
				? {
						enable: true,
						specialDanmakuUsers: danmakuUsers.map((user) => user.uid),
						msgTemplate: effective.templates.specialDanmaku,
					}
				: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom:
			enterUsers.length > 0
				? {
						enable: true,
						specialUsersEnterTheRoom: enterUsers.map((user) => user.uid),
						msgTemplate: effective.templates.specialUserEnter,
					}
				: { enable: false, msgTemplate: "" },
		minScPrice: effective.filters.minScPrice,
		minGuardLevel: effective.filters.minGuardLevel,
		pushTime: effective.schedule.pushTime,
		restartPush: effective.schedule.restartPush,
	};
}

function subscriptionOpsToDynamic(
	ops: SubscriptionOp[],
	store: SubscriptionStore,
	globals: GlobalConfig,
): DynamicSubOp[] {
	const out: DynamicSubOp[] = [];
	for (const op of ops) {
		if (op.type === "add") {
			out.push({ type: "add", sub: buildDynamicSubViewSingle(op.sub, globals) });
		} else if (op.type === "remove") {
			out.push({ type: "delete", uid: op.uid });
		} else {
			const sub = store.findByUid(op.sub.uid);
			if (!sub) continue;
			const effective = resolve(sub, globals.defaults);
			out.push({
				type: "update",
				uid: op.sub.uid,
				changes: [{ scope: "dynamic", dynamic: sub.enabled && effective.features.dynamic }],
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
			if (op.sub.enabled) out.push({ type: "add", sub: buildLiveSubViewSingle(op.sub, globals) });
		} else if (op.type === "remove") {
			out.push({ type: "delete", uid: op.uid });
		} else {
			const sub = store.findByUid(op.sub.uid);
			if (!sub) continue;
			if (!sub.enabled) {
				out.push({ type: "delete", uid: op.sub.uid });
				continue;
			}
			const view = buildLiveSubViewSingle(sub, globals);
			out.push({
				type: "update",
				uid: op.sub.uid,
				changes: [
					{
						scope: "live",
						live: view.live,
						liveEnd: view.liveEnd,
						liveGuardBuy: view.liveGuardBuy,
						superchat: view.superchat,
						wordcloud: view.wordcloud,
						liveSummary: view.liveSummary,
						minScPrice: view.minScPrice,
						minGuardLevel: view.minGuardLevel,
						pushTime: view.pushTime,
						restartPush: view.restartPush,
						customCardStyle: view.customCardStyle,
						customLiveMsg: view.customLiveMsg,
						customGuardBuy: view.customGuardBuy,
						customLiveSummary: view.customLiveSummary,
						customSpecialDanmakuUsers: view.customSpecialDanmakuUsers,
						customSpecialUsersEnterTheRoom: view.customSpecialUsersEnterTheRoom,
					},
				],
			});
		}
	}
	return out;
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
	if (segments.length === 1 && segments[0]?.type === "image-group") {
		return {
			kind: "forward-images",
			urls: segments[0].urls,
			forward: segments[0].forward,
		};
	}
	const mapped: PayloadSegment[] = [];
	for (const segment of segments) {
		if (segment.type === "text") mapped.push({ type: "text", text: segment.text });
		else if (segment.type === "image") {
			mapped.push({ type: "image", buffer: segment.buffer, mime: segment.mime });
		} else {
			for (const url of segment.urls) mapped.push({ type: "link", href: url });
		}
	}
	return mapped.length === 0 ? { kind: "text", text: "" } : { kind: "composite", segments: mapped };
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

function liveTypeToFeature(type: LivePushType): FeatureKey {
	switch (type) {
		case LivePushType.Live:
		case LivePushType.StartBroadcasting:
			return "live";
		case LivePushType.LiveGuardBuy:
			return "liveGuardBuy";
		case LivePushType.WordCloudAndLiveSummary:
			return "wordcloud";
		case LivePushType.Superchat:
			return "superchat";
		case LivePushType.UserDanmakuMsg:
			return "specialDanmaku";
		case LivePushType.UserActions:
			return "specialUserEnter";
		case LivePushType.LiveEnd:
			return "liveEnd";
		case LivePushType.LiveSummary:
			return "liveSummary";
	}
}

type SegmentValue =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "image-url"; readonly url: string }
	| { readonly kind: "image-buf"; readonly buffer: Buffer; readonly mime: string }
	| { readonly kind: "at-all" }
	| { readonly kind: "message"; readonly segments: readonly SegmentValue[] };

const sidecarContentBuilder: LiveContentBuilder = {
	text(text: string): SegmentValue {
		return { kind: "text", text };
	},
	image(source: string | Buffer, mime?: string): SegmentValue {
		if (typeof source === "string") return { kind: "image-url", url: source };
		return { kind: "image-buf", buffer: source, mime: mime ?? "image/jpeg" };
	},
	atAll(): SegmentValue {
		return { kind: "at-all" };
	},
	message(segments: unknown[]): SegmentValue {
		return {
			kind: "message",
			segments: segments.filter((segment): segment is SegmentValue => segment != null),
		};
	},
};

function segmentToPayload(value: unknown): PayloadSegment[] {
	if (value == null) return [];
	if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
	const segment = value as SegmentValue;
	switch (segment.kind) {
		case "text":
			return segment.text ? [{ type: "text", text: segment.text }] : [];
		case "image-url":
			return [{ type: "link", href: segment.url }];
		case "image-buf":
			return [{ type: "image", buffer: segment.buffer, mime: segment.mime }];
		case "at-all":
			return [{ type: "at-all" }];
		case "message":
			return segment.segments.flatMap((entry) => segmentToPayload(entry));
	}
}
