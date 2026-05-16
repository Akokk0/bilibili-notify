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
	emitEngineError: (message: string) => void;
	/**
	 * 推送 per-UID 直播状态变化(`onLiveStart` / `onLiveEnd` / `bootstrap 已开播` /
	 * `stopMonitoring 时挂掉的活房间`)。Adapter 实现:
	 *   - standalone: `(uid, status) => bus.emit("live-state-changed", uid, status)`
	 *   - koishi:     `(uid, status) => ctx.emit("bilibili-notify/live-state-changed", uid, status)`
	 * 可选;缺省时不推送 —— 仅在 dashboard 走 WS 实时刷新"正在直播"面板时有意义。
	 */
	emitLiveState?: (uid: string, status: "live" | "idle") => void;
	/**
	 * 推送 per-UID 累计观看人数变化(B 站 `WATCHED_CHANGE` 帧节流后转发)。Adapter
	 * 实现与 emitLiveState 同型:
	 *   - standalone: `(uid, viewers) => bus.emit("live-viewers-changed", uid, viewers)`
	 *   - koishi:     `(uid, viewers) => ctx.emit("bilibili-notify/live-viewers-changed", uid, viewers)`
	 * 可选;缺省时不推送。room-session 在调用前做 per-UID 2s throttle,所以这里收到
	 * 的频率已经稀疏(每个直播间最多每 2s 一次)。
	 */
	emitViewers?: (uid: string, viewers: string) => void;
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
	readonly emitEngineError: (message: string) => void;
	private readonly _emitLiveState: ((uid: string, status: "live" | "idle") => void) | undefined;
	private readonly _emitViewers: ((uid: string, viewers: string) => void) | undefined;

	config: ListenerManagerConfig;

	readonly listenerRecord: Record<string, MessageListener> = {};
	readonly livePushTimerManager: Map<string, () => void> = new Map();

	private disposed = false;
	/** Cached protobuf type for INTERACT_WORD_V2 decoding (lazy-loaded). */
	protected interactWord?: protobuf.Type;
	/**
	 * Set once the proto load/lookup has failed (missing/invalid
	 * `proto/interact_word.proto`) so we degrade gracefully instead of
	 * re-attempting + error-spamming on every INTERACT_WORD_V2 frame.
	 */
	protected interactWordUnavailable = false;
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
		this.emitEngineError = opts.emitEngineError;
		this._emitLiveState = opts.emitLiveState;
		this._emitViewers = opts.emitViewers;
	}

	/**
	 * 安全调用方:adapter 未注入时静默 no-op,业务代码无需在调用点判空。
	 */
	emitLiveState(uid: string, status: "live" | "idle"): void {
		this._emitLiveState?.(uid, status);
	}

	/**
	 * 同型 no-op 安全调用方。room-session 已做 per-UID 节流,这里只是分发。
	 */
	emitViewers(uid: string, viewers: string): void {
		this._emitViewers?.(uid, viewers);
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
		// features.X = true 即视为「订阅了该特性」;routing 由推送层(BilibiliPush)兜底,
		// routing 空时 broadcast 自然不外发。这样 features.X=true / routing.X=[] 的 UP 仍开
		// WS、仍 build payload,后续加 routing 时下一次事件立即生效。
		return sub[type];
	}

	needsLiveMonitor(sub: SubItemView): boolean {
		return (
			LIVE_ROOM_MASTER_KEYS.some((k) => this.isSubscribed(sub, k)) ||
			sub.customSpecialDanmakuUsers.enable ||
			sub.customSpecialUsersEnterTheRoom.enable
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
			this.emitEngineError(`[${roomId}] ${reason}`);
			return;
		}
		this.logger.error(`[conn] ${reason}，直播监测已停止`);
		this.clearListeners();
		this.clearPushTimers();
		this.emitEngineError(reason);
	}
}
