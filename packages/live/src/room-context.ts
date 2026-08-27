import type { BilibiliAPI } from "@bilibili-notify/api";
import { GuardLevel, type LiveClient } from "@bilibili-notify/blive";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger, MessageKindLayout, ServiceContext } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "./content-builder";
import type { DanmakuCollector } from "./danmaku-collector";
import type { LiveSummaryRequester } from "./live-summary-requester";
import {
	LIVE_ROOM_MASTER_KEYS,
	type LiveMasterFeature,
	type LivePushFeature,
	type PickCardBackground,
	type PushLike,
	type SubItemView,
} from "./push-like";
import type { LiveTemplateRenderer } from "./template-renderer";
import type { WordcloudGenerator } from "./wordcloud-generator";

/** Guard-level → official Bilibili captain/supervisor/governor image URLs. */
export const GUARD_LEVEL_IMG: Record<GuardLevel, string> = {
	[GuardLevel.None]: "",
	[GuardLevel.Captain]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
	[GuardLevel.Admiral]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	[GuardLevel.Governor]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
};

/**
 * 模板 / 渲染层全局配置,listener-manager + room-session 共用。
 *
 * 不含 `pushTime` / `restartPush` / `minScPrice` / `minGuardLevel` —— 那些是
 * per-UP 字段,adapter build SubItemView 时已折算好,引擎直接读 `SubItemView.X`。
 */
export interface ListenerManagerConfig {
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
	/**
	 * 引擎级消息版式(开播切片)。per-UP `SubItemView.messageLayout` 缺失时的兜底,
	 * room-session 在 onLiveStart 时读取(koishi 的默认版式 + 链接开关)。
	 */
	messageLayout?: MessageKindLayout;
	/**
	 * 全局默认卡片背景图廊(`defaults.cardStyle.backgroundImages`)。live/sc/guard
	 * 均无 per-UP / per-kind 覆盖时,`resolvedCardStyle` 拿它做「每次推送轮换」的
	 * 兜底列表 —— 否则这些 UP 会一直渲染同一张图(渲染器自身只认单图静态配置)。
	 */
	defaultBackgroundImages?: string[];
	/**
	 * 全局默认直播封面列表(`defaults.cardStyle.liveCoverImages`,独立端专属)。
	 * 该 UP 无覆盖时 `resolvedCardStyle("live")` 拿它做封面轮换兜底,语义同上。
	 */
	defaultLiveCoverImages?: string[];
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
	/**
	 * 渲染器 provider —— LiveEngine 在 image 服务上下线时通过 setImageRenderer
	 * 替换内部状态;getter `imageRenderer` 每次现取,所有 RoomContext 自动同步。
	 */
	getImageRenderer: () => ImageRenderer | null;
	config: ListenerManagerConfig;
	emitEngineError: (message: string) => void;
	/**
	 * 推送 per-UID 直播状态变化(`onLiveStart` / `onLiveEnd` / `bootstrap 已开播` /
	 * `stopMonitoring 时挂掉的活房间`)。Adapter 实现:
	 *   - standalone: `(uid, status) => bus.emit("live-state-changed", uid, status)`
	 *   - koishi:     `(uid, status) => ctx.emit("bilibili-notify/live-state-changed", uid, status)`
	 * 可选;缺省时不推送 —— 仅在 dashboard 走 WS 实时刷新"正在直播"面板时有意义。
	 */
	emitLiveState?: (uid: string, status: "live" | "idle", startedAt?: string) => void;
	/**
	 * 推送 per-UID 累计观看人数变化(B 站 `WATCHED_CHANGE` 帧节流后转发)。Adapter
	 * 实现与 emitLiveState 同型:
	 *   - standalone: `(uid, viewers) => bus.emit("live-viewers-changed", uid, viewers)`
	 *   - koishi:     `(uid, viewers) => ctx.emit("bilibili-notify/live-viewers-changed", uid, viewers)`
	 * 可选;缺省时不推送。room-session 在调用前做 per-UID 2s throttle,所以这里收到
	 * 的频率已经稀疏(每个直播间最多每 2s 一次)。
	 */
	emitViewers?: (uid: string, viewers: string) => void;
	/**
	 * 背景图轮换选择器(可选)。adapter 注入则多图卡片「每次推送轮换」;缺省(如 koishi)→
	 * 推送点回退单图。standalone 注入由 `createCardBgRotator` 支撑(fs 持久化游标)。
	 */
	pickCardBackground?: PickCardBackground;
	/**
	 * uid → roomId 解析成功后的回调(③)。adapter(独立端)据此把房号写盘,下次启动/
	 * reload 直接读盘复用,省掉每次逐 UP 的 `getUserInfo` 房号解析请求。可选;koishi
	 * 不注入 → 行为不变(每次仍解析)。
	 */
	onRoomIdResolved?: (uid: string, roomId: string) => void;
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
	 * 渲染器 provider —— private 是因为外部应通过 `imageRenderer` getter 访问 ——
	 * 后者会在 `config.imageEnabled === false` 时返回 null,让所有
	 * `if (this.imageRenderer?.generateXxx)` 自然落入文字回退分支。
	 * provider 形式让 LiveEngine 的 setImageRenderer 无需逐 RoomContext 推。
	 *
	 * **不要直接调 `this._getImageRenderer()` 绕过 imageEnabled 门控**,业务路径
	 * 必须通过 `this.imageRenderer` getter,否则用户在 dashboard 关掉卡片渲染时
	 * 这条路径仍会渲图。
	 */
	private readonly _getImageRenderer: () => ImageRenderer | null;
	readonly emitEngineError: (message: string) => void;
	private readonly _emitLiveState:
		| ((uid: string, status: "live" | "idle", startedAt?: string) => void)
		| undefined;
	private readonly _emitViewers: ((uid: string, viewers: string) => void) | undefined;
	private readonly _pickCardBackground: PickCardBackground | undefined;
	/** ③ uid → roomId 解析成功回调(独立端写盘复用;koishi 缺省)。 */
	readonly onRoomIdResolved: ((uid: string, roomId: string) => void) | undefined;

	config: ListenerManagerConfig;

	readonly listenerRecord: Record<string, LiveClient> = {};
	readonly livePushTimerManager: Map<string, () => void> = new Map();

	private disposed = false;
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
		this._getImageRenderer = opts.getImageRenderer;
		this.config = opts.config;
		this.emitEngineError = opts.emitEngineError;
		this._emitLiveState = opts.emitLiveState;
		this._emitViewers = opts.emitViewers;
		this._pickCardBackground = opts.pickCardBackground;
		this.onRoomIdResolved = opts.onRoomIdResolved;
	}

	/**
	 * 背景图轮换:多图时返回本次该用的背景并推进游标;adapter 未注入(koishi)或列表 ≤1 张
	 * → 返回 undefined,调用方回退单图。安全调用方,业务点无需判空。
	 */
	pickBackground(scopeKey: string, images: string[]): string | undefined {
		return this._pickCardBackground?.(scopeKey, images);
	}

	/**
	 * 安全调用方:adapter 未注入时静默 no-op,业务代码无需在调用点判空。
	 */
	emitLiveState(uid: string, status: "live" | "idle", startedAt?: string): void {
		this._emitLiveState?.(uid, status, startedAt);
	}

	/**
	 * 同型 no-op 安全调用方。room-session 已做 per-UID 节流,这里只是分发。
	 */
	emitViewers(uid: string, viewers: string): void {
		this._emitViewers?.(uid, viewers);
	}

	/** 受 `config.imageEnabled` 门控的渲染器视图;关闭时返回 null。 */
	get imageRenderer(): ImageRenderer | null {
		return this.config.imageEnabled === false ? null : this._getImageRenderer();
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
			this.logger.debug(`[conn] 直播间 [${roomId}] 连接已主动关闭过`);
			delete this.listenerRecord[roomId];
			return;
		}
		// close() 之后客户端保证静默(连 close 回声都不会上报),不需要再记
		// 「有意关闭」的账 —— 旧库会把主动关闭的 onClose 也派发出来,只能靠
		// intentionalCloseRooms 集合事后对暗号,那套记账已随之退役。
		listener.close();
		delete this.listenerRecord[roomId];
		this.logger.info(`[conn] 直播间 [${roomId}] 连接已关闭`);
		this.logSideEffectState(`listener:closed room=${roomId}`);
	}

	clearListeners(): void {
		this.logSideEffectState("listeners:before-clear");
		// Object.keys() 已是快照,迭代期间 closeListener 删除 record 不影响本循环;
		// closeListener 内部自身已 delete,此处无需再 delete 一次(原冗余双删)。
		for (const key of Object.keys(this.listenerRecord)) {
			this.closeListener(key);
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
