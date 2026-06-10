import type { LiveRoomInfo } from "@bilibili-notify/api";
import type { Disposable } from "@bilibili-notify/internal";
import type { MsgHandler } from "blive-message-listener";
import { DateTime } from "luxon";
import { LivePushType, type SubItemView } from "./push-like";
import { LiveRoomAccessDeniedError, type RoomContext } from "./room-helpers";
import { buildRoomLink } from "./template-renderer";
import { type LiveData, LiveType, type MasterInfo } from "./types";

/**
 * Cooldown window between accepting `onLiveStart` / `onLiveEnd` events; the
 * Bilibili WS sometimes fires duplicates for the same transition.
 */
export const LIVE_EVENT_COOLDOWN = 10 * 1000;

/**
 * Base class for {@link import("./room-session").RoomSession}, holding all
 * per-room mutable state and the high-level lifecycle / transition logic
 * (bootstrap, periodic-timer arm/cancel, live-end pipeline). Event handlers
 * (`onLiveStart`, `onIncomeSuperChat`, etc.) live in the subclass.
 *
 * State fields are `protected` so the subclass can read & mutate them
 * directly when handling MsgHandler events.
 */
export abstract class RoomSessionBase {
	protected readonly ctx: RoomContext;
	protected readonly sub: SubItemView;

	protected liveTime!: string;
	protected liveStatus = false;
	protected liveRoomInfo: LiveRoomInfo["data"] | undefined;
	protected masterInfo: MasterInfo | undefined;
	protected readonly liveData: LiveData = { likedNum: "0" };

	protected pushAtTimeTimer: Disposable | null = null;
	protected lastLiveStart = 0;
	protected lastLiveEnd = 0;

	constructor(ctx: RoomContext, sub: SubItemView) {
		this.ctx = ctx;
		this.sub = sub;
	}

	/** Whether the underlying B-station room is currently broadcasting. */
	get isLive(): boolean {
		return this.liveStatus;
	}

	/**
	 * 唯一允许翻转 `liveStatus` 的入口。只在真实 transition 时通过 RoomContext
	 * 推送 `live-state-changed` 事件,前端的"正在直播"面板靠它实时收敛。
	 * 直接赋值 `this.liveStatus = ...` 会绕过这里,**不要这样做**。
	 */
	protected setLiveStatus(next: boolean): void {
		if (this.liveStatus === next) return;
		this.liveStatus = next;
		this.ctx.emitLiveState(this.sub.uid, next ? "live" : "idle");
	}

	/**
	 * Read-only diagnostic snapshot for routes / dashboards. Includes `uid`,
	 * `roomId`, and — when `liveRoomInfo` was successfully fetched — `title`,
	 * `cover`, `areaName`, `startedAt`. Returns undefined fields rather than
	 * partial data so consumers can render fallbacks deterministically.
	 */
	getLiveSnapshot(): {
		uid: string;
		roomId: string;
		isLive: boolean;
		title?: string;
		cover?: string;
		areaName?: string;
		startedAt?: string;
		/**
		 * B 站 WS `WATCHED_CHANGE` 帧给出的"累计观看人数",预格式化字符串(如 "1.2万")。
		 * 还没收到该帧时为 undefined,前端显示 "—"。我们不存原始 num,因为 bilibili 自己
		 * 给的 text_small 已是用户预期的中文压缩形式。
		 */
		viewers?: string;
	} {
		const w = this.liveData.watchedNum;
		const viewers = typeof w === "number" ? String(w) : w;
		return {
			uid: this.sub.uid,
			roomId: this.sub.roomId,
			isLive: this.liveStatus,
			title: this.liveRoomInfo?.title,
			cover: this.liveRoomInfo?.user_cover || this.liveRoomInfo?.keyframe || undefined,
			areaName: this.liveRoomInfo?.area_name,
			startedAt: this.liveRoomInfo?.live_time || undefined,
			viewers: viewers && viewers !== "暂未获取到" ? viewers : undefined,
		};
	}

	/**
	 * Open the WS connection (via `RoomContext.startLiveRoomListener`), pull
	 * the initial live-room snapshot, and — if the room is already live —
	 * kick off the `restartPush` branch + arm the periodic timer.
	 */
	async bootstrap(): Promise<void> {
		// listener 建失败时此前丢弃返回值仍继续:下文 live_status===1 会
		// armPeriodicTimer + setLiveStatus(true) → 房间标"直播中"、周期复推在跑,
		// 但无 WS,永不收弹幕 / onLiveEnd。建不起来即同"获取信息失败"一并放弃。
		let listening = false;
		try {
			listening = await this.ctx.startLiveRoomListener(this.sub.roomId, this.buildHandler());
		} catch (e) {
			if (e instanceof LiveRoomAccessDeniedError) {
				this.onMonitoringStopped();
				this.ctx.stopMonitoring(e.message, this.sub.roomId);
				return;
			}
			throw e;
		}
		if (!listening) {
			await this.ctx.push.sendPrivateMsg(
				`直播间 [${this.sub.roomId}] 弹幕连接建立失败，已停止该房间监测`,
			);
			this.onMonitoringStopped();
			this.ctx.closeListener(this.sub.roomId);
			return;
		}

		if (
			!(await this.useLiveRoomInfo(LiveType.FirstLiveBroadcast)) ||
			!(await this.useMasterInfo(LiveType.FirstLiveBroadcast)) ||
			!this.liveRoomInfo ||
			!this.masterInfo
		) {
			await this.ctx.push.sendPrivateMsg("获取直播间信息失败，启动直播间弹幕检测失败");
			this.onMonitoringStopped();
			this.ctx.closeListener(this.sub.roomId);
			return;
		}

		this.onListenerStarted();
		this.ctx.logger.debug(`[stat] 当前粉丝数：${this.masterInfo.liveOpenFollowerNum}`);

		if (this.liveRoomInfo.live_status === 1) {
			this.liveTime = this.liveRoomInfo.live_time;
			const watched = String(this.liveData.watchedNum ?? "暂未获取到");
			this.liveData.watchedNum = watched;
			const diffTime = await this.ctx.getTimeDifference(this.liveTime);
			const roomLink = buildRoomLink(this.liveRoomInfo);
			const liveMsg = this.ctx.templateRenderer.renderLiveOngoing({
				sub: this.sub,
				globalCustom: this.ctx.config.customLiveMsg,
				master: this.masterInfo,
				diffTime,
				watched,
				roomLink,
			});

			// restartPush 已由 adapter 折算好(per-UP ?? 全局)。
			if (this.sub.restartPush) {
				await this.ctx.sendLiveNotifyCard({
					liveType: LiveType.LiveBroadcast,
					liveData: this.liveData,
					liveRoomInfo: this.liveRoomInfo,
					master: this.masterInfo,
					cardStyle: this.sub.customCardStyle,
					uid: this.sub.uid,
					notifyMsg: liveMsg,
				});
			}
			// P2:与 onLiveStart 同序(先 setLiveStatus 再 arm)。此前 bootstrap
			// 反着写,当前无害但语义不一致 —— 统一为「先翻状态再 arm 周期复推」。
			this.setLiveStatus(true);
			this.armPeriodicTimer();
		}
	}

	/** Build the platform-specific {@link MsgHandler}; provided by the subclass. */
	protected abstract buildHandler(): MsgHandler;

	/** Hook for subclass-owned connection-health bookkeeping after listener bootstrap succeeds. */
	protected onListenerStarted(): void {}

	/** Hook for subclass-owned cleanup before this session intentionally stops monitoring. */
	protected onMonitoringStopped(): void {}

	// ── State transitions ─────────────────────────────────────────────────────

	protected async useLiveRoomInfo(liveType: LiveType): Promise<boolean> {
		const data = await this.ctx.getLiveRoomInfo(this.sub.roomId);
		if (!data?.uid) return false;
		if (liveType === LiveType.StartBroadcasting || liveType === LiveType.FirstLiveBroadcast) {
			this.liveRoomInfo = data;
			return true;
		}
		// Preserve `live_time` across mid-session refreshes so that the live-end
		// elapsed-time card matches the original live start.
		this.liveRoomInfo = { ...data, live_time: this.liveRoomInfo?.live_time ?? data.live_time };
		return true;
	}

	protected async useMasterInfo(liveType: LiveType): Promise<boolean> {
		try {
			this.masterInfo = await this.ctx.getMasterInfo(
				this.liveRoomInfo?.uid.toString() ?? this.sub.uid,
				this.masterInfo,
				liveType,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Live 配置 `pushTime` 热更后调用:重新按当前(可能已变更的) `pushTime`
	 * arm 定时器。仅对正在直播的房间生效,因为只有 live 状态下才会有 timer。
	 *
	 * 注意:`setInterval` 句柄的 ms 参数是 immutable,只能 dispose 重建。
	 */
	rearmPeriodicTimer(): void {
		if (!this.isLive) return;
		this.cancelPeriodicTimer();
		this.armPeriodicTimer();
	}

	protected armPeriodicTimer(): void {
		// pushTime 已由 adapter 折算好(per-UP ?? 全局)。0 = 关闭该 UP 的「正在直播」复推。
		const pushTime = this.sub.pushTime;
		if (pushTime === 0 || this.pushAtTimeTimer) return;
		this.pushAtTimeTimer = this.ctx.serviceCtx.setInterval(
			() => this.tickPushAtTime(),
			pushTime * 1000 * 60 * 60,
		);
		this.ctx.livePushTimerManager.set(this.sub.roomId, () => this.pushAtTimeTimer?.dispose());
		this.ctx.logSideEffectState(`timer:created room=${this.sub.roomId}`);
	}

	protected cancelPeriodicTimer(): void {
		if (!this.pushAtTimeTimer) return;
		this.pushAtTimeTimer.dispose();
		this.pushAtTimeTimer = null;
		this.ctx.livePushTimerManager.delete(this.sub.roomId);
		this.ctx.logSideEffectState(`timer:deleted room=${this.sub.roomId}`);
	}

	/** Periodic "正在直播" tick (callback for `setInterval`). */
	protected async tickPushAtTime(): Promise<void> {
		if (!(await this.useLiveRoomInfo(LiveType.LiveBroadcast)) || !this.liveRoomInfo) {
			this.onMonitoringStopped();
			this.ctx.stopMonitoring("获取直播间信息失败，推送直播卡片失败", this.sub.roomId);
			return;
		}
		// Fallback when the room actually closed but no onLiveEnd event arrived.
		if (this.liveRoomInfo.live_status === 0 || this.liveRoomInfo.live_status === 2) {
			this.ctx.logger.warn(
				`[live] 直播间 [${this.sub.roomId}] 检测到已下播但未收到 onLiveEnd 事件，进入兜底处理`,
			);
			await this.ctx.push.sendPrivateMsg(
				`直播间 [${this.sub.roomId}] 已下播但未收到 WS 下播事件，已自动触发兜底总结`,
			);
			await this.handleLiveEnd("polling");
			return;
		}
		if (!(await this.useMasterInfo(LiveType.LiveBroadcast)) || !this.masterInfo) return;

		this.liveTime = this.liveRoomInfo.live_time;
		const watched = String(this.liveData.watchedNum ?? "暂未获取到");
		this.liveData.watchedNum = watched;
		const diffTime = await this.ctx.getTimeDifference(this.liveTime);
		const roomLink = buildRoomLink(this.liveRoomInfo);
		const liveMsg = this.ctx.templateRenderer.renderLiveOngoing({
			sub: this.sub,
			globalCustom: this.ctx.config.customLiveMsg,
			master: this.masterInfo,
			diffTime,
			watched,
			roomLink,
		});

		await this.ctx.sendLiveNotifyCard({
			liveType: LiveType.LiveBroadcast,
			liveData: this.liveData,
			liveRoomInfo: this.liveRoomInfo,
			master: this.masterInfo,
			cardStyle: this.sub.customCardStyle,
			uid: this.sub.uid,
			notifyMsg: liveMsg,
		});
	}

	/**
	 * Live-end pipeline (shared by the WS `onLiveEnd` event and the polling
	 * fallback in {@link tickPushAtTime}).
	 *
	 * Order: cancel periodic timer → refresh room/master info → push live-end
	 * card → kick off wordcloud + summary → drain danmaku buffer.
	 */
	protected async handleLiveEnd(source: "ws" | "polling"): Promise<void> {
		if (!this.liveStatus) {
			this.ctx.logger.warn(
				`[live] 直播间 [${this.sub.roomId}] 已经是下播状态，忽略 (source=${source})`,
			);
			return;
		}
		this.cancelPeriodicTimer();

		if (
			!(await this.useLiveRoomInfo(LiveType.StopBroadcast)) ||
			!(await this.useMasterInfo(LiveType.StopBroadcast)) ||
			!this.liveRoomInfo ||
			!this.masterInfo
		) {
			this.setLiveStatus(false);
			this.ctx.danmakuCollector.clear(this.sub.roomId);
			if (this.ctx.isDisposed()) return;
			this.onMonitoringStopped();
			this.ctx.stopMonitoring("获取直播间信息失败，推送直播下播卡片失败", this.sub.roomId);
			return;
		}
		this.setLiveStatus(false);
		this.ctx.logger.debug(
			`[stat] 开播时粉丝数：${this.masterInfo.liveOpenFollowerNum}，下播时粉丝数：${this.masterInfo.liveEndFollowerNum}，粉丝数变化：${this.masterInfo.liveFollowerChange}`,
		);

		this.liveTime = this.liveRoomInfo.live_time || DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
		const diffTime = await this.ctx.getTimeDifference(this.liveTime);
		this.liveData.fansChanged = this.masterInfo.liveFollowerChange;

		const liveEndMsg = this.ctx.templateRenderer.renderLiveEnd({
			sub: this.sub,
			globalCustom: this.ctx.config.customLiveMsg,
			master: this.masterInfo,
			diffTime,
			followerChange: this.masterInfo.liveFollowerChange,
		});

		try {
			if (this.ctx.isSubscribed(this.sub, "liveEnd")) {
				await this.ctx.sendLiveNotifyCard({
					liveType: LiveType.StopBroadcast,
					liveData: this.liveData,
					liveRoomInfo: this.liveRoomInfo,
					master: this.masterInfo,
					cardStyle: this.sub.customCardStyle,
					uid: this.sub.uid,
					notifyMsg: liveEndMsg,
				});
			}
			await this.dispatchWordCloudAndSummary(
				this.sub.customLiveSummary.liveSummary || this.ctx.config.liveSummaryDefault,
			);
		} finally {
			this.ctx.danmakuCollector.clear(this.sub.roomId);
			this.ctx.danmakuCollector.registerRoom(this.sub.roomId);
		}
	}

	/**
	 * Run wordcloud + AI live-summary in parallel and dispatch whichever
	 * succeeded. Skipped entirely when neither feature is subscribed.
	 */
	protected async dispatchWordCloudAndSummary(customLiveSummary: string): Promise<void> {
		const wantWordcloud = this.ctx.isSubscribed(this.sub, "wordcloud");
		const wantSummary = this.ctx.isSubscribed(this.sub, "liveSummary");
		if (!wantWordcloud && !wantSummary) return;

		this.ctx.logger.debug(
			`[wordcloud] 开始制作下播总结 wordcloud=${wantWordcloud} summary=${wantSummary}`,
		);
		const snapshot = this.ctx.danmakuCollector.snapshot(this.sub.roomId);

		const [img, summary] = await Promise.all([
			wantWordcloud
				? this.ctx.wordcloudGenerator.generate(
						snapshot.sortedWords,
						this.masterInfo?.username ?? "",
						this.masterInfo?.userface,
					)
				: Promise.resolve(undefined),
			wantSummary
				? this.ctx.liveSummaryRequester.generate({
						senderRecord: snapshot.senderRecord,
						sortedWords: snapshot.sortedWords,
						master: this.masterInfo,
						customLiveSummary,
						// per-UP persona/prompt 覆盖;adapter 未填则交由 CommentaryGenerator 用全局 config。
						aiOverride: this.sub.aiOverride,
					})
				: Promise.resolve(undefined),
		]);

		if (this.ctx.isDisposed()) return;
		const wcMsg = img ? this.ctx.contentBuilder.image(img, "image/jpeg") : undefined;
		const summaryMsg = summary ? this.ctx.contentBuilder.text(summary) : undefined;
		if (wcMsg) {
			await this.ctx.push.broadcastToTargets(
				this.sub.uid,
				wcMsg,
				LivePushType.WordCloudAndLiveSummary,
			);
		}
		if (summaryMsg) {
			await this.ctx.push.broadcastToTargets(this.sub.uid, summaryMsg, LivePushType.LiveSummary);
		}
	}
}
