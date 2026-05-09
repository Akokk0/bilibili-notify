import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { GuardLevel, type MessageListener } from "blive-message-listener";
import type protobuf from "protobufjs";
import type { LiveContentBuilder } from "./content-builder";
import type { DanmakuCollector } from "./danmaku-collector";
import type { LiveSummaryRequester } from "./live-summary-requester";
import {
	LIVE_ROOM_MASTER_KEYS,
	type LiveMasterFeature,
	type LivePushFeature,
	type PushLike,
	type SubItemView,
} from "./push-like";
import type { LiveTemplateRenderer } from "./template-renderer";
import type { WordcloudGenerator } from "./wordcloud-generator";

/** Guard-level → official Bilibili captain/supervisor/governor image URLs. */
export const GUARD_LEVEL_IMG: Record<GuardLevel, string> = {
	[GuardLevel.None]: "",
	[GuardLevel.Jianzhang]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
	[GuardLevel.Tidu]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	[GuardLevel.Zongdu]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
};

/**
 * Configuration that listener-manager + room-session both consume.
 * Mirrors the koishi `BilibiliNotifyLiveConfig` minus the `logLevel` /
 * `wordcloudStopWords` fields (those are owned at the LiveEngine level).
 */
export interface ListenerManagerConfig {
	pushTime: number;
	restartPush: boolean;
	minScPrice: number;
	minGuardLevel: 1 | 2 | 3;
	customGuardBuy: {
		enable: boolean;
		guardBuyMsg?: string;
		captainImgUrl?: string;
		supervisorImgUrl?: string;
		governorImgUrl?: string;
	};
	customLiveMsg: {
		enable: boolean;
		customLiveStart?: string;
		customLive?: string;
		customLiveEnd?: string;
	};
	/** Default global `liveSummary` template (joined with `\n`). */
	liveSummaryDefault: string;
	/**
	 * 图片卡片渲染总开关。`false` 时 RoomContext 暴露的 imageRenderer 始终为 null,
	 * 直播开播 / SC / 上舰 等路径自然走 `if (renderer?.generateXxx)` 落入文字回退。缺省视为 true。
	 */
	imageEnabled?: boolean;
}

/**
 * Constructor options for {@link RoomContext}. Mirrors the dependency set
 * passed into `LiveEngine`; the engine builds one `RoomContext` and shares it
 * with both {@link import("./listener-manager").ListenerManager} (for lifecycle
 * + connection setup) and {@link import("./room-session").RoomSession} (for
 * per-room dispatcher).
 */
export interface RoomContextOptions {
	serviceCtx: ServiceContext;
	api: BilibiliAPI;
	push: PushLike;
	contentBuilder: LiveContentBuilder;
	templateRenderer: LiveTemplateRenderer;
	wordcloudGenerator: WordcloudGenerator;
	liveSummaryRequester: LiveSummaryRequester;
	danmakuCollector: DanmakuCollector;
	imageRenderer: ImageRenderer | null;
	config: ListenerManagerConfig;
	emitPluginError: (message: string) => void;
}

/**
 * Shared room-level infrastructure surface. Stores all engine-injected deps,
 * the per-room listener registry, and the periodic-timer registry; offers the
 * lifecycle / predicate / disposal primitives consumed by both
 * {@link import("./listener-manager").ListenerManager} and
 * {@link import("./room-session").RoomSession}.
 *
 * The data-fetch / card-render / time-format helpers live in
 * {@link import("./room-helpers").RoomContextHelpers} (a subclass of this
 * class). The split keeps each file focused: this one handles state + WS
 * lifecycle, the helpers file wraps every external API/IO call.
 */
export class RoomContextBase {
	readonly serviceCtx: ServiceContext;
	readonly logger: Logger;
	readonly api: BilibiliAPI;
	readonly push: PushLike;
	readonly contentBuilder: LiveContentBuilder;
	readonly templateRenderer: LiveTemplateRenderer;
	readonly wordcloudGenerator: WordcloudGenerator;
	readonly liveSummaryRequester: LiveSummaryRequester;
	readonly danmakuCollector: DanmakuCollector;
	/**
	 * 真实注入的渲染器引用,private 是因为外部应通过 `imageRenderer` getter 访问 ——
	 * 后者会在 `config.imageEnabled === false` 时返回 null,让所有
	 * `if (this.imageRenderer?.generateXxx)` 自然落入文字回退分支。
	 */
	private readonly _imageRenderer: ImageRenderer | null;
	readonly emitPluginError: (message: string) => void;

	config: ListenerManagerConfig;

	readonly listenerRecord: Record<string, MessageListener> = {};
	readonly livePushTimerManager: Map<string, () => void> = new Map();

	private disposed = false;
	/** Cached protobuf type for INTERACT_WORD_V2 decoding (lazy-loaded). */
	protected interactWord?: protobuf.Type;
	private readonly instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	constructor(opts: RoomContextOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.logger = opts.serviceCtx.logger;
		this.api = opts.api;
		this.push = opts.push;
		this.contentBuilder = opts.contentBuilder;
		this.templateRenderer = opts.templateRenderer;
		this.wordcloudGenerator = opts.wordcloudGenerator;
		this.liveSummaryRequester = opts.liveSummaryRequester;
		this.danmakuCollector = opts.danmakuCollector;
		this._imageRenderer = opts.imageRenderer;
		this.config = opts.config;
		this.emitPluginError = opts.emitPluginError;
	}

	/** 受 `config.imageEnabled` 门控的渲染器视图;关闭时返回 null。 */
	get imageRenderer(): ImageRenderer | null {
		return this.config.imageEnabled === false ? null : this._imageRenderer;
	}

	updateConfig(config: ListenerManagerConfig): void {
		this.config = config;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	setDisposed(value: boolean): void {
		this.disposed = value;
	}

	getListenerCount(): number {
		return Object.keys(this.listenerRecord).length;
	}

	logSideEffectState(stage: string): void {
		this.logger.debug(
			`[conn] [live:${this.instanceId}] ${stage} listeners=${this.getListenerCount()} timers=${this.livePushTimerManager.size} disposed=${this.disposed}`,
		);
	}

	hasTargets(sub: SubItemView, ...types: LivePushFeature[]): boolean {
		return types.some((t) => (sub.target?.[t]?.length ?? 0) > 0);
	}

	isSubscribed(sub: SubItemView, type: LiveMasterFeature): boolean {
		return sub[type] && (sub.target?.[type]?.length ?? 0) > 0;
	}

	needsLiveMonitor(sub: SubItemView): boolean {
		return (
			LIVE_ROOM_MASTER_KEYS.some((k) => this.isSubscribed(sub, k)) ||
			(sub.customSpecialDanmakuUsers.enable && this.hasTargets(sub, "specialDanmaku")) ||
			(sub.customSpecialUsersEnterTheRoom.enable && this.hasTargets(sub, "specialUserEnterTheRoom"))
		);
	}

	closeListener(roomId: string): void {
		const listener = this.listenerRecord[roomId];
		if (!listener) {
			this.logger.debug(`[conn] 直播间 [${roomId}] 连接不存在，跳过关闭`);
			return;
		}
		if (listener.closed) {
			this.logger.debug(`[conn] 直播间 [${roomId}] 连接已被远端断开`);
			delete this.listenerRecord[roomId];
			return;
		}
		listener.close();
		delete this.listenerRecord[roomId];
		this.logger.info(`[conn] 直播间 [${roomId}] 连接已关闭`);
		this.logSideEffectState(`listener:closed room=${roomId}`);
	}

	clearListeners(): void {
		this.logSideEffectState("listeners:before-clear");
		for (const key of Object.keys(this.listenerRecord)) {
			this.closeListener(key);
			delete this.listenerRecord[key];
		}
		this.logSideEffectState("listeners:after-clear");
	}

	clearPushTimers(): void {
		this.logSideEffectState("timers:before-clear");
		for (const [, timer] of this.livePushTimerManager) timer?.();
		this.livePushTimerManager.clear();
		this.logSideEffectState("timers:after-clear");
	}

	stopMonitoring(reason: string, roomId?: string): void {
		if (roomId) {
			this.logger.error(`[conn] [${roomId}] ${reason}，已停止该房间的监测`);
			this.closeListener(roomId);
			const timer = this.livePushTimerManager.get(roomId);
			if (timer) {
				timer();
				this.livePushTimerManager.delete(roomId);
			}
			this.emitPluginError(`[${roomId}] ${reason}`);
			return;
		}
		this.logger.error(`[conn] ${reason}，直播监测已停止`);
		this.clearListeners();
		this.clearPushTimers();
		this.emitPluginError(reason);
	}
}
