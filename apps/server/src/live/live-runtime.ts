import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { ImageRenderer } from "@bilibili-notify/image";
import {
	aiWritingNeeded,
	type Disposable,
	type GlobalConfig,
	type ImageRef,
	type LiveInteractionReport,
	type LiveSession,
	type LiveSignal,
	type MessageBus,
	needsLiveMonitor,
	resolve,
	type ServiceContext,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { ImageFetcher } from "../images/image-fetcher.js";
import type { SubscriptionStateStore } from "../runtime/subscription-state-store.js";
import { fetchSourceLiveStatus, type SourceGates } from "../subscriptions/call-source.js";
import type { PlatformLabelDeps } from "../subscriptions/platform-label.js";
import { subscriptionIdentityLabelOf } from "../subscriptions/platform-label.js";
import type { SourceRegistry } from "../subscriptions/registry.js";
import type { SourceStatusReader } from "../subscriptions/source-status.js";
import { createLiveInteractions } from "./live-interactions.js";
import type { LiveNotifySend } from "./live-notify.js";
import { bindLivePush } from "./live-push.js";
import { createLiveSessionEngine } from "./live-sessions.js";
import { createLiveSettingsCache, rotateLiveCover } from "./live-settings.js";
import type { LiveTable } from "./live-table.js";
import type { PickLiveCover } from "./live-types.js";
import { LiveSummaryRequester } from "./recap/live-summary-requester.js";
import { mergeStopWords } from "./recap/stop-words.js";
import { ViewerChatCollector } from "./recap/viewer-chat-collector.js";
import { WordcloudGenerator } from "./recap/wordcloud-generator.js";

export interface LiveRuntimeOptions {
	bus: MessageBus;
	serviceCtx: ServiceContext;
	table: Pick<LiveTable, "get" | "replace" | "merge" | "remove">;
	subscriptionStore: Pick<SubscriptionStore, "findById" | "list">;
	subscriptionStateStore: Pick<SubscriptionStateStore, "get">;
	sources: Pick<SourceRegistry, "get">;
	sourceGates: SourceGates;
	/** 这个来源实现了 `fetchLiveStatus`(核心据此给它的每一场挂周期核对)。 */
	hasLiveStatus: (sourceKey: string) => boolean;
	sourceStatus: Pick<SourceStatusReader, "running">;
	labelDeps: PlatformLabelDeps;
	globals: () => GlobalConfig;
	targetIds: () => string[];
	commentary: CommentaryGenerator | null;
	imageRenderer: () => ImageRenderer | null;
	pickExistingCardBg: PickLiveCover;
	imageFetcher: Pick<ImageFetcher, "fetchImage">;
	readImage: (ref: ImageRef) => Promise<{ bytes: Uint8Array; mime: string } | undefined>;
	sendFor: (subscriptionId: string) => LiveNotifySend;
}

export interface LiveRuntime extends Disposable {
	applySignal(signal: LiveSignal): void;
	/** 来源报上来的观众互动(特别弹幕、特别进场……)的入口;和场次引擎同生同灭。 */
	applyInteraction(subscriptionId: string, report: LiveInteractionReport): void;
	pollUnseen(sourceKey: string): void;
	/** 订阅来源的场次;统计页经 `liveSession` 读它。 */
	session(subscriptionId: string): LiveSession | undefined;
	tickNow(subscriptionId: string): Promise<boolean>;
	viewerChatStats(): { subscriptions: number; words: number; senders: number };
	/** 核心下播回顾的总结请求器拿的是构造那一刻的实例;AI 实例热换时要经这里跟着换引用。 */
	setCommentary(commentary: CommentaryGenerator | null): void;
}

export function createLiveRuntime(options: LiveRuntimeOptions): LiveRuntime {
	const liveTable = options.table;
	const logger = options.serviceCtx.logger;

	// 折好的直播设置只有这一份:场次 / 推送 / 互动共用,别再各写一遍 `(sub) => liveSettingsOf(...)`
	// (每次都是一份 globals 深拷贝,互动是每条弹幕一次)。globals 变了由缓存自己作废。
	const liveSettings = createLiveSettingsCache({
		bus: options.bus,
		getGlobals: options.globals,
	});

	// `liveTable` 在这里是写口:场次引擎先写表、再改场次,表自己不听上报。
	const liveSessions = createLiveSessionEngine({
		bus: options.bus,
		logger,
		table: liveTable,
		subscription: (id) => options.subscriptionStore.findById(id),
		sourceStatus: options.sourceStatus,
		fans: (id) => options.subscriptionStateStore.get(id)?.cachedProfile?.followers,
		settings: (sub) => liveSettings.of(sub),
		timers: options.serviceCtx,
		// 拉取式:来源实现了 `fetchLiveStatus` 就按每一场自己的时钟问它(外壳:超时、抛错收口、同一来源串行)。
		liveStatus: {
			has: options.hasLiveStatus,
			fetch: (identity, signal) =>
				fetchSourceLiveStatus(
					{
						sources: options.sources,
						logger,
						gates: options.sourceGates,
					},
					identity,
					signal,
				),
		},
		subscriptions: () => options.subscriptionStore.list(),
		// 要不要监听直播:internal 里那份唯一判定(折好的开关 ∧ 特别关注名单)。
		wantsLive: (sub) =>
			needsLiveMonitor({
				features: resolve(sub, options.globals().defaults).features,
				specialViewers: sub.specialViewers,
			}),
	});

	// 核心回顾的一份收集器与两个生产者:场次开始登记、互动记一条、下播卡同步取快照。
	const wordcloudStopWords = () =>
		mergeStopWords(options.globals().defaults.templates.wordcloudStopWords);
	const viewerChats = new ViewerChatCollector(wordcloudStopWords());
	const stopwordsListener = options.bus.on("config-changed", ({ scope }) => {
		if (scope === "globals") viewerChats.setStopwords(wordcloudStopWords());
	});
	const wordcloudGenerator = new WordcloudGenerator({
		getImageRenderer: () => options.imageRenderer(),
		isImageEnabled: () => options.globals().defaults.cards.enabled,
		logger,
	});
	const liveSummaryRequester = new LiveSummaryRequester({
		commentary: options.commentary,
		isAiEnabled: () => {
			const g = options.globals();
			return g.ai.enabled && aiWritingNeeded(g.ai.writing.liveSummary, options.targetIds());
		},
		isWebSearchEnabled: () => options.globals().ai.search.scenes.live,
		logger,
	});
	const bindPush = bindLivePush({
		bus: options.bus,
		logger,
		serviceCtx: options.serviceCtx,
		sessions: liveSessions,
		table: liveTable,
		subscription: (id) => options.subscriptionStore.findById(id),
		profile: (id) => options.subscriptionStateStore.get(id)?.cachedProfile,
		identityLabel: (identity) => subscriptionIdentityLabelOf(identity, options.labelDeps),
		settings: (sub) => liveSettings.of(sub),
		// 订阅的封面 ?? 全局的,再轮一张自定义封面 —— 与 B 站的直播间同一份规矩;游标键跟着人走(决策 73)。
		liveCover: (sub, settings) => {
			const identity = subscriptionIdentityOf(sub);
			return rotateLiveCover(
				settings.liveCoverImageIds,
				options.globals().defaults.cards.liveCoverImageIds,
				options.pickExistingCardBg,
				`${identity.sourceKey}:${identity.externalId}:live-cover`,
			);
		},
		sourceStatus: options.sourceStatus,
		avatarRef: (id) => options.subscriptionStateStore.get(id)?.cachedProfile?.avatar,
		recap: {
			collector: viewerChats,
			wordcloud: wordcloudGenerator,
			summary: liveSummaryRequester,
		},
		sendFor: options.sendFor,
		renderer: () => (options.globals().defaults.cards.enabled ? options.imageRenderer() : null),
	});
	// 来源报上来的观众互动(R4 甲):特别弹幕、特别进场、醒目留言按这条订阅现折的设置判,发送绑到这条订阅上;
	// 下播回顾的弹幕收集归核心这一份(场次开了登记、结束清掉)。
	const interactions = createLiveInteractions({
		logger,
		subscription: (id) => options.subscriptionStore.findById(id),
		settings: (sub) => liveSettings.of(sub),
		sourceStatus: options.sourceStatus,
		table: liveTable,
		profileName: (id) => options.subscriptionStateStore.get(id)?.cachedProfile?.name,
		identityLabel: (identity) => subscriptionIdentityLabelOf(identity, options.labelDeps),
		profileAvatar: (id) => options.subscriptionStateStore.get(id)?.cachedProfile?.avatar,
		source: (sourceKey) => options.sources.get(sourceKey),
		gates: options.sourceGates,
		renderer: () => (options.globals().defaults.cards.enabled ? options.imageRenderer() : null),
		fetchImage: (url) => options.imageFetcher.fetchImage(url),
		readImage: options.readImage,
		sendFor: options.sendFor,
		sessions: liveSessions,
		collector: viewerChats,
		serviceCtx: options.serviceCtx,
	});

	let disposed = false;
	return {
		applySignal: (signal) => liveSessions.apply(signal),
		applyInteraction: (subscriptionId, report) => interactions.apply(subscriptionId, report),
		pollUnseen: (sourceKey) => liveSessions.pollUnseen(sourceKey),
		session: (subscriptionId) => liveSessions.get(subscriptionId),
		tickNow: (subscriptionId) => liveSessions.tickNow(subscriptionId),
		viewerChatStats: () => viewerChats.stats(),
		setCommentary: (commentary) => liveSummaryRequester.setCommentary(commentary),
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const handle of [
				liveSessions,
				stopwordsListener,
				liveSettings,
				bindPush,
				interactions,
			]) {
				try {
					handle.dispose();
				} catch {
					// best-effort
				}
			}
		},
	};
}
