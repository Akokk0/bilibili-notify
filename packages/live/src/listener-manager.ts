import type { SubItemView } from "./push-like";
import type { ListenerManagerConfig, RoomContextOptions } from "./room-context";
import { RoomContext } from "./room-helpers";
import { RoomSession } from "./room-session";

export type { ListenerManagerConfig } from "./room-context";

/**
 * Constructor options for {@link ListenerManager}. Same shape as
 * {@link RoomContextOptions}; the manager builds its `RoomContext` internally.
 */
export type ListenerManagerOptions = RoomContextOptions;

/**
 * Top-level lifecycle for live-room listeners.
 *
 * Owns:
 * - the per-uid {@link SubItemView} registry (mutable clones we update through
 *   `bilibili-notify/subscription-changed` ops).
 * - the underlying {@link RoomContext} (which in turn owns the listener
 *   record + periodic-timer record and exposes shared helpers consumed by
 *   {@link RoomSession}).
 *
 * Per-room state and the dispatcher closure live in {@link RoomSession}; the
 * manager only orchestrates start / stop / clearAll.
 */
export class ListenerManager {
	private readonly ctx: RoomContext;
	private readonly subRecord: Map<string, SubItemView> = new Map();
	private readonly sessionRecord: Map<string, RoomSession> = new Map();

	constructor(opts: ListenerManagerOptions) {
		this.ctx = new RoomContext(opts);
	}

	/** Replace runtime config (called when the adapter receives a config update). */
	updateConfig(config: ListenerManagerConfig): void {
		this.ctx.updateConfig(config);
	}

	isDisposed(): boolean {
		return this.ctx.isDisposed();
	}

	getListenerCount(): number {
		return this.ctx.getListenerCount();
	}

	/** Active mutable sub by uid (used by `applyOps` to detect existence). */
	getActiveSub(uid: string): SubItemView | undefined {
		return this.subRecord.get(uid);
	}

	/**
	 * Read-only live-state snapshot for every monitored room. Each entry pairs
	 * the room's `isLive` boolean (mirrors RoomSession.liveStatus) with the
	 * latest fetched `liveRoomInfo` fields. Used by the standalone dashboard's
	 * `GET /api/live/listening` route to populate the "正在直播" panel.
	 */
	listLiveSnapshots(): ReturnType<RoomSession["getLiveSnapshot"]>[] {
		return Array.from(this.sessionRecord.values()).map((s) => s.getLiveSnapshot());
	}

	/**
	 * `pushTime` 热更后调用:把所有 active session 的"正在直播"复推 timer 按当前
	 * `pushTime` 重新 arm。LiveEngine.updateConfig 在检测到变化时转发。
	 */
	rearmAllPeriodicTimers(): void {
		for (const session of this.sessionRecord.values()) session.rearmPeriodicTimer();
	}

	/**
	 * 单个 UID 的 pushTime 热更入口。LiveEngine.applyOps 在 update 分支检测到
	 * `LiveScopedChange.pushTime` 变化时调用,仅对该 uid 的活跃 session rearm。
	 */
	rearmPeriodicTimerForUid(uid: string): void {
		this.sessionRecord.get(uid)?.rearmPeriodicTimer();
	}

	/** Whether any feature on this sub requires the live-room WS connection. */
	needsLiveMonitor(sub: SubItemView): boolean {
		return this.ctx.needsLiveMonitor(sub);
	}

	/** Start listeners for everything in `subs` that needs one. */
	startAll(subs: Record<string, SubItemView>): void {
		// 先把旧 session 全部 cancel,**再**翻 setDisposed=false。否则若旧 session
		// 还在退避 sleep 里,setDisposed=false 后 cancelled=false → 醒来时
		// onError 会重新调 startLiveRoomListener,把 listener 装回 listenerRecord,
		// 形成隐性重复监听(sessionRecord 已 clear,但 ctx 内 listener 实存在)。
		for (const session of this.sessionRecord.values()) session.cancel();
		this.ctx.setDisposed(false);
		this.ctx.clearPushTimers();
		this.ctx.clearListeners();
		this.subRecord.clear();
		this.sessionRecord.clear();

		const liveSubUids = Object.values(subs)
			.filter((s) => this.ctx.needsLiveMonitor(s))
			.map((s) => s.uid);
		this.ctx.logger.debug(
			`[start] 启动直播监听，共 ${liveSubUids.length} 个 UID：${liveSubUids.join(", ")}`,
		);
		for (const sub of Object.values(subs)) {
			if (this.ctx.needsLiveMonitor(sub)) this.startForUid(sub, "[start]");
		}
	}

	/** Start a single sub's listener via a fresh {@link RoomSession}. */
	startForUid(sub: SubItemView, logPrefix = "[ops]"): void {
		const mutable: SubItemView = structuredClone(sub);
		this.subRecord.set(sub.uid, mutable);
		void this.bootstrapForUid(mutable, logPrefix);
	}

	private async bootstrapForUid(mutable: SubItemView, logPrefix: string): Promise<void> {
		if (!mutable.roomId) {
			const resolved = await this.resolveRoomId(mutable.uid, logPrefix);
			if (!resolved) return;
			mutable.roomId = resolved;
		}
		if (this.ctx.isDisposed()) return;
		// `subRecord` was populated synchronously in `startForUid`; if the entry has
		// been removed during the async resolve (stop/remove), bail out.
		if (!this.subRecord.has(mutable.uid)) return;
		this.ctx.danmakuCollector.registerRoom(mutable.roomId);
		const session = new RoomSession(this.ctx, mutable);
		this.sessionRecord.set(mutable.uid, session);
		session.bootstrap().catch((e) => {
			// Q3 carve-out:bootstrap 失败 → 该房间被弃用、无自动重试,留 error。
			this.ctx.logger.error(
				`${logPrefix} 启动直播监听失败 UID=${mutable.uid}：${e instanceof Error ? e.message : String(e)}`,
			);
		});
	}

	private async resolveRoomId(uid: string, logPrefix: string): Promise<string | undefined> {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: B-station response shape
			const info = (await this.ctx.api.getUserInfo(uid)) as any;
			const roomid = info?.data?.live_room?.roomid;
			const n = Number(roomid);
			if (!Number.isFinite(n) || n <= 0) {
				this.ctx.logger.warn(
					`${logPrefix} UID=${uid} 未开通直播间或 live_room 解析失败，跳过 listener 创建`,
				);
				return undefined;
			}
			return String(n);
		} catch (e) {
			this.ctx.logger.warn(`${logPrefix} UID=${uid} 解析直播间号失败：${(e as Error).message}`);
			return undefined;
		}
	}

	/** Stop a single sub's listener and drop its bookkeeping. */
	stopForUid(uid: string): void {
		const sub = this.subRecord.get(uid);
		if (!sub) return;
		// 若停止时这位 UP 正在直播,等价于"idle"——前端面板需要把这条移出。
		const session = this.sessionRecord.get(uid);
		if (session?.isLive) this.ctx.emitLiveState(uid, "idle");
		// 在 closeListener 触发 onError 之前打 cancelled,避免 onError 跑退避重连
		// 反而把这条已主动停止的 listener 重新接上。
		session?.cancel();
		const timer = this.ctx.livePushTimerManager.get(sub.roomId);
		timer?.();
		this.ctx.livePushTimerManager.delete(sub.roomId);
		this.ctx.closeListener(sub.roomId);
		this.ctx.danmakuCollector.clear(sub.roomId);
		this.subRecord.delete(uid);
		this.sessionRecord.delete(uid);
	}

	/** Tear down everything. Used by engine `stop()` / `auth-lost`. */
	disposeAll(): void {
		this.ctx.logSideEffectState("stop:before-clear");
		this.ctx.setDisposed(true);
		// L3:全局 teardown 也要逐 session cancel(),否则正处于退避 sleep 的
		// session 会留一个无法清除的延迟回调到 expiry(setDisposed 只是让它醒来
		// 后空转返回,定时器本身没被 dispose)。与 reload 路径同款做法。
		for (const session of this.sessionRecord.values()) session.cancel();
		this.ctx.clearPushTimers();
		this.ctx.clearListeners();
		this.subRecord.clear();
		this.sessionRecord.clear();
		this.ctx.danmakuCollector.clearAll();
		this.ctx.logSideEffectState("stop:after-clear");
	}

	/** Tear down listeners + timers but keep registry / disposed flag intact. */
	clearListeners(): void {
		this.ctx.clearListeners();
	}

	/** Cancel every periodic "正在直播" timer. */
	clearPushTimers(): void {
		this.ctx.clearPushTimers();
	}
}
