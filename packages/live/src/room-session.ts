import type { Disposable } from "@bilibili-notify/internal";
import { GuardLevel, type MsgHandler } from "blive-message-listener";
import { DateTime } from "luxon";
import { LivePushType } from "./push-like";
import { GUARD_LEVEL_IMG } from "./room-context";
import { LiveRoomAccessDeniedError } from "./room-helpers";
import { LIVE_EVENT_COOLDOWN, RoomSessionBase } from "./room-session-base";
import { buildRoomLink } from "./template-renderer";
import { LiveType } from "./types";

/**
 * One {@link RoomSession} per UID/room actively being monitored.
 *
 * Extends {@link RoomSessionBase} (state + lifecycle + transitions) with the
 * {@link MsgHandler} factory and the per-event handlers (`onLiveStart`,
 * `onIncomeDanmu`, `onIncomeSuperChat`, `onGuardBuy`, `onLiveEnd`, `onError`,
 * `onWatchedChange`, `onLikedChange`, plus the `INTERACT_WORD_V2` raw branch).
 *
 * Each handler reads / mutates the protected state defined on the base.
 * `bootstrap()` (defined on the base) opens the WS connection and arms the
 * periodic timer if the room is already live; subsequent state transitions
 * are driven by the events routed through these handlers.
 */
/** Dashboard 端期望的"实时观看人数"采样间隔。B 站每几秒推一帧 WATCHED_CHANGE,
 * 这里 per-UID 门控成 2s 最多一次,够人眼感知,WS 不会刷屏。 */
const VIEWERS_EMIT_THROTTLE_MS = 2000;

/**
 * onError 触发后的退避重连节奏(单位 ms)。失败时按下标顺序消耗,直到耗尽 → 真正放弃。
 * 重连成功后 `reconnectAttempts` 复位到 0,后续新一轮 onError 重新从 1s 开始。
 */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;

/** B 站 live WS 静默自愈:每分钟检查一次,3 分钟无 heartbeat/消息即主动重连。 */
export const LIVE_WS_WATCHDOG_INTERVAL_MS = 60_000;
export const LIVE_WS_STALE_MS = 180_000;

type ReconnectReason = "error" | "close" | "watchdog";
type LiveWsActivityReason =
	| "connected"
	| "open"
	| "start-listen"
	| "heartbeat"
	| "danmu"
	| "superchat"
	| "watched"
	| "liked"
	| "guard"
	| "live-start"
	| "live-end"
	| "interact"
	| "close";

export class RoomSession extends RoomSessionBase {
	private lastViewersEmitMs = 0;
	/**
	 * 当前 RoomSession 是否已被外层(stopForUid / disposeAll / liveEnd 主动关闭)取消。
	 * 一旦设为 true,onError 跳过重连。listener-manager.stopForUid 在 closeListener
	 * 之前调用 cancel() 设置。
	 */
	private cancelled = false;
	private reconnectAttempts = 0;
	/**
	 * L1 单飞守卫:并发 onError(WS 错误常突发多帧)若都进入重连路径,会各自
	 * closeListener + 退避 + startLiveRoomListener,装回多个 listener。一旦一个
	 * onError 拿到重连权,其余直接返回。
	 */
	private reconnecting = false;
	/** L3:退避 sleep 的 Disposable + 唤醒句柄,cancel/teardown 时清掉,不留回调到 expiry。 */
	private reconnectTimer?: Disposable;
	private reconnectWake?: () => void;
	private lastLiveWsActivityAt = 0;
	private lastLiveWsActivityReason: LiveWsActivityReason = "connected";
	private watchdogTimer?: Disposable;
	private watchdogReconnectCount = 0;

	/** 外层主动停止 listener 时调用,阻止 onError/onClose/watchdog 触发重连。 */
	cancel(): void {
		this.cancelled = true;
		// P2:即时复位,不再单靠 reconnectLoop 的 finally 时序。onError 顶部
		// cancelled 守卫已足以挡新重连,这里只是让 reconnecting 状态立即自洽。
		this.reconnecting = false;
		this.stopLiveWsWatchdog();
		this.clearReconnectSleep();
	}

	/** L3:dispose 退避定时器并唤醒重连循环,使其立刻重校 cancelled/disposed 后退出。 */
	private clearReconnectSleep(): void {
		this.reconnectTimer?.dispose();
		this.reconnectTimer = undefined;
		this.reconnectWake?.();
		this.reconnectWake = undefined;
	}

	protected override onListenerStarted(): void {
		this.markLiveWsActivity("connected");
		this.startLiveWsWatchdog();
	}

	protected override onMonitoringStopped(): void {
		this.cancel();
	}

	getWsHealthSnapshot(): {
		lastActivityAt: number;
		lastActivityReason: LiveWsActivityReason;
		watchdogReconnectCount: number;
	} {
		return {
			lastActivityAt: this.lastLiveWsActivityAt,
			lastActivityReason: this.lastLiveWsActivityReason,
			watchdogReconnectCount: this.watchdogReconnectCount,
		};
	}

	private markLiveWsActivity(reason: LiveWsActivityReason): void {
		this.lastLiveWsActivityAt = Date.now();
		this.lastLiveWsActivityReason = reason;
	}

	private startLiveWsWatchdog(): void {
		if (this.watchdogTimer || this.cancelled || this.ctx.isDisposed()) return;
		this.watchdogTimer = this.ctx.serviceCtx.setInterval(
			() => this.checkLiveWsWatchdog(),
			LIVE_WS_WATCHDOG_INTERVAL_MS,
		);
	}

	private stopLiveWsWatchdog(): void {
		this.watchdogTimer?.dispose();
		this.watchdogTimer = undefined;
	}

	private checkLiveWsWatchdog(): void {
		if (this.cancelled || this.ctx.isDisposed() || this.reconnecting) return;
		if (this.lastLiveWsActivityAt <= 0) return;
		const staleMs = Date.now() - this.lastLiveWsActivityAt;
		if (staleMs < LIVE_WS_STALE_MS) return;
		this.watchdogReconnectCount++;
		void this.reconnect(
			"watchdog",
			`${Math.floor(staleMs / 1000)}s 无 heartbeat/消息(last=${this.lastLiveWsActivityReason},watchdog=${this.watchdogReconnectCount})`,
		);
	}

	// ── MsgHandler factory ────────────────────────────────────────────────────

	protected buildHandler(): MsgHandler {
		const base: MsgHandler = {
			onOpen: () => this.markLiveWsActivity("open"),
			onStartListen: () => this.markLiveWsActivity("start-listen"),
			onClose: () => {
				if (this.cancelled || this.ctx.isDisposed()) return;
				if (this.ctx.consumeIntentionalClose(this.sub.roomId)) return;
				this.markLiveWsActivity("close");
				void this.reconnect("close");
			},
			onError: () => this.onError(),
			onAttentionChange: () => this.markLiveWsActivity("heartbeat"),
			onIncomeDanmu: ({ body }) => {
				this.markLiveWsActivity("danmu");
				this.onIncomeDanmu(body);
			},
			onIncomeSuperChat: ({ body }) => {
				this.markLiveWsActivity("superchat");
				return this.onIncomeSuperChat(body);
			},
			onWatchedChange: ({ body }) => {
				this.markLiveWsActivity("watched");
				this.liveData.watchedNum = body.text_small;
				const now = Date.now();
				if (now - this.lastViewersEmitMs >= VIEWERS_EMIT_THROTTLE_MS) {
					this.lastViewersEmitMs = now;
					this.ctx.emitViewers(this.sub.uid, body.text_small);
				}
			},
			onLikedChange: ({ body }) => {
				this.markLiveWsActivity("liked");
				this.liveData.likedNum = body.count;
			},
			onGuardBuy: ({ body }) => {
				this.markLiveWsActivity("guard");
				return this.onGuardBuy(body);
			},
			onLiveStart: () => {
				this.markLiveWsActivity("live-start");
				return this.onLiveStart();
			},
			onLiveEnd: () => {
				this.markLiveWsActivity("live-end");
				return this.onLiveEnd();
			},
		};
		if (!this.sub.customSpecialUsersEnterTheRoom.enable) return base;
		return {
			...base,
			raw: {
				INTERACT_WORD_V2: (msg: unknown) => {
					this.markLiveWsActivity("interact");
					return this.onInteractWordV2(msg);
				},
			},
		};
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private onError(): Promise<void> {
		return this.reconnect("error");
	}

	private async reconnect(reason: ReconnectReason, detail?: string): Promise<void> {
		if (this.cancelled || this.ctx.isDisposed()) return;
		if (this.reconnecting) return; // L1:并发 error/close/watchdog,已有重连在跑,丢弃
		this.reconnecting = true;
		try {
			await this.reconnectLoop(reason, detail);
		} finally {
			this.reconnecting = false;
		}
	}

	/**
	 * 退避重连循环(单飞,由 reconnect 持有)。`while` 取代旧的 `setTimeout(0)`
	 * 递归续链 —— 杜绝深栈递归 + 每步都丢弃的定时器 Disposable;每次 sleep 后
	 * 重校 cancelled/disposed,sleep 自身可被 cancel/teardown dispose。
	 */
	private async reconnectLoop(reason: ReconnectReason, detail?: string): Promise<void> {
		while (this.reconnectAttempts < RECONNECT_BACKOFF_MS.length) {
			if (this.cancelled || this.ctx.isDisposed()) return;
			if (reason === "error") {
				this.setLiveStatus(false);
				this.cancelPeriodicTimer();
			}
			this.ctx.closeListener(this.sub.roomId);

			const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempts];
			this.reconnectAttempts++;
			const reasonText = this.describeReconnectReason(reason, detail);
			this.ctx.logger.warn(
				`[conn] 直播间 [${this.sub.roomId}] ${reasonText},${delay / 1000}s 后重连(第 ${this.reconnectAttempts}/${RECONNECT_BACKOFF_MS.length} 次)`,
			);
			await this.sleepReconnect(delay);
			if (this.cancelled || this.ctx.isDisposed()) return;

			// L4:startLiveRoomListener 现返回是否真有 listener(新建,或退避窗口
			// 内已被别处恢复)。throw(blive 库内部异常等)与 false 一并视为本轮
			// 失败,继续退避(while 续链,无递归、无丢弃定时器)。只有真成功才
			// 复位 backoff。
			let ok = false;
			try {
				ok = await this.ctx.startLiveRoomListener(
					this.sub.roomId,
					this.buildHandler(),
					() => this.cancelled,
				);
			} catch (e) {
				if (e instanceof LiveRoomAccessDeniedError) {
					this.reconnectAttempts = 0;
					this.setLiveStatus(false);
					this.cancelPeriodicTimer();
					this.cancel();
					this.ctx.stopMonitoring(e.message, this.sub.roomId);
					return;
				}
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.sub.roomId}] 重连发起异常:${(e as Error).message}`,
				);
			}
			// ②6:post-await 重校。startLiveRoomListener 期间若与 stopForUid /
			// teardown 交错(cancelled / disposed 翻转),刚建的 listener 是孤儿 ——
			// 主动关掉再退出,绝不留永不关闭的连接(此前只判 ok 漏了这条)。
			if (this.cancelled || this.ctx.isDisposed()) {
				if (ok) this.ctx.closeListener(this.sub.roomId);
				return;
			}
			if (ok) {
				this.onListenerStarted();
				this.ctx.logger.info(`[conn] 直播间 [${this.sub.roomId}] 重连成功`);
				this.reconnectAttempts = 0;
				return;
			}
			this.ctx.logger.warn(`[conn] 直播间 [${this.sub.roomId}] 重连未成功,继续退避`);
		}
		// 退避耗尽 → 真正放弃 + 走 engine-error(adapter 转 master DM / log channel)。
		this.reconnectAttempts = 0;
		const msg = `直播间 [${this.sub.roomId}] ${this.describeReconnectReason(reason, detail)}后连接持续失败,重试 ${RECONNECT_BACKOFF_MS.length} 次后放弃监听`;
		this.ctx.logger.error(`[conn] ${msg}`);
		this.ctx.emitEngineError(msg);
		this.cancel();
	}

	private describeReconnectReason(reason: ReconnectReason, detail?: string): string {
		if (reason === "error") return "连接错误";
		if (reason === "close") return "连接关闭";
		return detail ? `连接静默(${detail})` : "连接静默";
	}

	/**
	 * L3:可被 {@link clearReconnectSleep} 取消的退避 sleep。dispose 时立即
	 * resolve,让 reconnectLoop 醒来重校 cancelled/disposed 后退出 —— 不再留
	 * 一个无法清除的延迟回调到 expiry。
	 */
	private sleepReconnect(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			this.reconnectWake = resolve;
			this.reconnectTimer = this.ctx.serviceCtx.setTimeout(() => {
				this.reconnectTimer = undefined;
				this.reconnectWake = undefined;
				resolve();
			}, ms);
		});
	}

	private onIncomeDanmu(body: { content: string; user: { uname: string; uid: number } }): void {
		if (
			this.ctx.isSubscribed(this.sub, "wordcloud") ||
			this.ctx.isSubscribed(this.sub, "liveSummary")
		) {
			this.ctx.danmakuCollector.recordDanmaku(this.sub.roomId, body.content, body.user.uname);
		}
		if (
			this.sub.customSpecialDanmakuUsers.enable &&
			this.ctx.hasTargets(this.sub, "specialDanmaku") &&
			this.sub.customSpecialDanmakuUsers.specialDanmakuUsers?.includes(body.user.uid.toString())
		) {
			const text = this.ctx.templateRenderer.renderSpecialDanmaku({
				template: this.sub.customSpecialDanmakuUsers.msgTemplate,
				uname: body.user.uname,
				master: this.masterInfo,
				content: body.content,
			});
			if (this.ctx.isDisposed()) return;
			this.ctx.safeBroadcast(
				this.sub.uid,
				this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(text)]),
				LivePushType.UserDanmakuMsg,
			);
		}
	}

	private async onIncomeSuperChat(body: {
		content: string;
		user: { uname: string; uid: number };
		price: number;
	}): Promise<void> {
		const collectsDanmaku =
			this.ctx.isSubscribed(this.sub, "wordcloud") ||
			this.ctx.isSubscribed(this.sub, "liveSummary");
		const pushesSC = this.ctx.isSubscribed(this.sub, "superchat");
		if (!collectsDanmaku && !pushesSC) return;
		if (collectsDanmaku) {
			this.ctx.danmakuCollector.recordDanmaku(this.sub.roomId, body.content, body.user.uname);
		}
		if (!pushesSC) return;
		// minScPrice 已由 adapter 折算好(per-UP ?? 全局)。
		if (body.price < this.sub.minScPrice) return;

		const data = await this.ctx.api.getUserInfoInLive(body.user.uid.toString(), this.sub.uid);
		if (data.code !== 0) {
			const text = `【${this.masterInfo?.username ?? ""}的直播间】${body.user.uname}的SC:${body.content}（${body.price}元）`;
			if (this.ctx.isDisposed()) return;
			await this.ctx.push.broadcastToTargets(
				this.sub.uid,
				this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(text)]),
				LivePushType.Superchat,
			);
			return;
		}
		if (this.ctx.imageRenderer?.generateSCCard) {
			try {
				const userInfo = data.data;
				const buf = await this.ctx.imageRenderer.generateSCCard({
					senderFace: userInfo.face,
					senderName: userInfo.uname,
					masterName: this.masterInfo?.username ?? "",
					masterAvatarUrl: this.masterInfo?.userface ?? "",
					text: body.content,
					price: body.price,
				});
				if (this.ctx.isDisposed()) return;
				await this.ctx.push.broadcastToTargets(
					this.sub.uid,
					this.ctx.contentBuilder.image(buf, "image/jpeg"),
					LivePushType.Superchat,
				);
				return;
			} catch (e) {
				this.ctx.logger.error(`[sc] 生成SC图片失败：${(e as Error).message}`);
			}
		}
		const fallback = `【${this.masterInfo?.username ?? ""}的直播间】${data.data.uname}的SC:${body.content}（${body.price}元）`;
		if (this.ctx.isDisposed()) return;
		await this.ctx.push.broadcastToTargets(
			this.sub.uid,
			this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(fallback)]),
			LivePushType.Superchat,
		);
	}

	private async onGuardBuy(body: {
		guard_level: GuardLevel;
		gift_name: string;
		user: { uname: string; uid: number };
	}): Promise<void> {
		if (!this.ctx.isSubscribed(this.sub, "liveGuardBuy")) return;
		// minGuardLevel 已由 adapter 折算好(per-UP ?? 全局,同 SC 阈值语义)。
		if (body.guard_level > this.sub.minGuardLevel) return;
		const guardImg = GUARD_LEVEL_IMG[body.guard_level];
		const effectiveGuardBuy = this.sub.customGuardBuy.enable
			? this.sub.customGuardBuy
			: this.ctx.config.customGuardBuy;
		if (effectiveGuardBuy.enable) {
			const customGuardImg: Record<GuardLevel, string | undefined> = {
				[GuardLevel.None]: undefined,
				[GuardLevel.Jianzhang]: effectiveGuardBuy.captainImgUrl,
				[GuardLevel.Tidu]: effectiveGuardBuy.supervisorImgUrl,
				[GuardLevel.Zongdu]: effectiveGuardBuy.governorImgUrl,
			};
			const text = this.ctx.templateRenderer.renderGuardBuy({
				guardBuyConfig: effectiveGuardBuy,
				uname: body.user.uname,
				master: this.masterInfo,
				giftName: body.gift_name,
			});
			if (this.ctx.isDisposed()) return;
			await this.ctx.push.broadcastToTargets(
				this.sub.uid,
				this.ctx.contentBuilder.message([
					this.ctx.contentBuilder.image(customGuardImg[body.guard_level] ?? guardImg),
					this.ctx.contentBuilder.text(text),
				]),
				LivePushType.LiveGuardBuy,
			);
			return;
		}
		if (this.ctx.imageRenderer?.generateGuardCard) {
			const data = await this.ctx.api.getUserInfoInLive(body.user.uid.toString(), this.sub.uid);
			if (data.code === 0) {
				try {
					const buf = await this.ctx.imageRenderer.generateGuardCard(
						{
							guardLevel: body.guard_level,
							uname: data.data.uname,
							face: data.data.face,
							isAdmin: data.data.is_admin,
						},
						{
							masterName: this.masterInfo?.username ?? "",
							masterAvatarUrl: this.masterInfo?.userface ?? "",
						},
					);
					if (this.ctx.isDisposed()) return;
					await this.ctx.push.broadcastToTargets(
						this.sub.uid,
						this.ctx.contentBuilder.image(buf, "image/jpeg"),
						LivePushType.LiveGuardBuy,
					);
					return;
				} catch (e) {
					this.ctx.logger.error(`[guard] 生成上舰图片失败：${(e as Error).message}`);
				}
			}
		}
		if (this.ctx.isDisposed()) return;
		await this.ctx.push.broadcastToTargets(
			this.sub.uid,
			this.ctx.contentBuilder.message([
				this.ctx.contentBuilder.image(guardImg),
				this.ctx.contentBuilder.text(
					`【${this.masterInfo?.username ?? ""}的直播间】${body.user.uname}加入了大航海（${body.gift_name}）`,
				),
			]),
			LivePushType.LiveGuardBuy,
		);
	}

	private async onLiveStart(): Promise<void> {
		const now = Date.now();
		if (now - this.lastLiveStart < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.debug(`[live] 直播间 [${this.sub.roomId}] 的开播事件在冷却期内，忽略`);
			return;
		}
		if (this.liveStatus) {
			this.ctx.logger.debug(
				`[live] 直播间 [${this.sub.roomId}] 已经是开播状态，忽略重复的开播事件`,
			);
			return;
		}
		// L2:仅在真正“接受”一次开播(过冷却 + 过 liveStatus 去重)时才打冷却
		// 戳。此前在去重前就 lastLiveStart=now,一条 >10s 的重复 START 也会刷新
		// 窗口,导致紧随其后 10s 内的“真重启”被冷却静默吞掉。
		this.lastLiveStart = now;
		this.setLiveStatus(true);
		if (
			!(await this.useLiveRoomInfo(LiveType.StartBroadcasting)) ||
			!(await this.useMasterInfo(LiveType.StartBroadcasting)) ||
			!this.liveRoomInfo ||
			!this.masterInfo
		) {
			this.setLiveStatus(false);
			if (this.ctx.isDisposed()) return;
			this.onMonitoringStopped();
			this.ctx.stopMonitoring("获取直播间信息失败，推送直播开播卡片失败", this.sub.roomId);
			return;
		}
		this.ctx.logger.info(
			`[stat] 房间号：${this.masterInfo.roomId}，开播时的粉丝数：${this.masterInfo.liveOpenFollowerNum}`,
		);
		this.liveTime = this.liveRoomInfo.live_time || DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
		const diffTime = await this.ctx.getTimeDifference(this.liveTime);
		const followerNum =
			this.masterInfo.liveOpenFollowerNum >= 10_000
				? `${(this.masterInfo.liveOpenFollowerNum / 10000).toFixed(1)}万`
				: this.masterInfo.liveOpenFollowerNum.toString();
		this.liveData.fansNum = this.masterInfo.liveOpenFollowerNum;
		const roomLink = buildRoomLink(this.liveRoomInfo);
		const liveStartMsg = this.ctx.templateRenderer.renderLiveStart({
			sub: this.sub,
			globalCustom: this.ctx.config.customLiveMsg,
			master: this.masterInfo,
			diffTime,
			followerNum,
			roomLink,
		});

		await this.ctx.sendLiveNotifyCard({
			liveType: LiveType.StartBroadcasting,
			liveData: this.liveData,
			liveRoomInfo: this.liveRoomInfo,
			master: this.masterInfo,
			cardStyle: this.sub.customCardStyle,
			uid: this.sub.uid,
			notifyMsg: liveStartMsg,
		});

		if (this.ctx.isDisposed()) return;
		// 跨 useLiveRoomInfo / useMasterInfo / getTimeDifference / sendLiveNotifyCard
		// 这串长 await(卡片渲染+推送可数秒)后重校 liveStatus:期间可能已交错
		// onLiveEnd → handleLiveEnd 把状态翻 idle 并 teardown。此刻若已非开播态,
		// 这条 stale start 绝不能再 armPeriodicTimer,否则 idle 房间被挂上 live
		// 周期定时器(轮询/词云/总结全部错位触发)。
		if (!this.liveStatus) {
			this.ctx.logger.warn(
				`[live] 直播间 [${this.sub.roomId}] 开播流程完成时已非开播态（疑似交错下播），跳过周期任务`,
			);
			return;
		}
		this.armPeriodicTimer();
	}

	private async onLiveEnd(): Promise<void> {
		const now = Date.now();
		if (now - this.lastLiveEnd < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.debug(`[live] 直播间 [${this.sub.roomId}] 的下播事件在冷却期内，忽略`);
			return;
		}
		this.lastLiveEnd = now;
		await this.handleLiveEnd("ws");
	}

	private async onInteractWordV2(msg: unknown): Promise<void> {
		if (
			!this.sub.customSpecialUsersEnterTheRoom.enable ||
			!this.ctx.hasTargets(this.sub, "specialUserEnter")
		) {
			return;
		}
		const pb = (msg as { data?: { pb?: unknown } })?.data?.pb;
		if (typeof pb !== "string") {
			this.ctx.logger.warn(
				`[live] INTERACT_WORD_V2 缺少 data.pb 字段，跳过 (room=${this.sub.roomId})`,
			);
			return;
		}
		const data = await this.ctx.decodeBase64PB(pb);
		const uid = typeof data.uid === "string" ? data.uid : String(data.uid ?? "");
		const uname = typeof data.uname === "string" ? data.uname : "";
		if (
			data.msgType === "1" &&
			this.sub.customSpecialUsersEnterTheRoom.specialUsersEnterTheRoom?.includes(uid)
		) {
			const text = this.ctx.templateRenderer.renderSpecialUserEnter({
				template: this.sub.customSpecialUsersEnterTheRoom.msgTemplate,
				uname,
				master: this.masterInfo,
			});
			this.ctx.safeBroadcast(
				this.sub.uid,
				this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(text)]),
				LivePushType.UserActions,
			);
		}
	}
}
