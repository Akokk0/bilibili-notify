import type { Disposable, LiveDetails, LiveInteractionReport } from "@bilibili-notify/internal";
import { riskBackoffStepMs } from "../../api/index.js";
import { IMAGE_REQUEST_HEADERS, scaledImageUrl } from "../../images.js";
import { PROBLEM_TEXTS } from "../../problem-texts.js";
import { liveDetailsFromRoomInfo, liveTimeToIso } from "../live-card-input.js";
import { membershipEventFromLiveEvent } from "../membership-event.js";
import type { LiveEvent } from "../protocol/events.js";
import { superchatEventFromLiveEvent } from "../superchat-event.js";
import {
	liveRiskPath,
	MONITOR_STOPPED_CODE,
	ROOM_RESTRICTED_CODE,
	type RoomContext,
} from "./room-context.js";
import { LiveRoomAccessDeniedError, LiveRoomPreflightBlockedError } from "./room-helpers.js";

export const LIVE_EVENT_COOLDOWN = 10 * 1000;
export const LIVE_WS_STALE_MS = 180_000;

const VIEWERS_EMIT_THROTTLE_MS = 2_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const LIVE_WS_WATCHDOG_INTERVAL_MS = 60_000;

type ReconnectReason = "error" | "close" | "watchdog" | "preflight";
type ActivityReason =
	| "connected"
	| "open"
	| "auth-ok"
	| "heartbeat"
	| "danmu"
	| "superchat"
	| "watched"
	| "liked"
	| "guard"
	| "live-start"
	| "live-end"
	| "interact"
	| "raw"
	| "other"
	| "close";

export class RoomSession {
	private masterName = "";
	private watchedNumber: number | undefined;
	private lastLiveStart = 0;
	private lastLiveEnd = 0;
	private lastViewersReportAt = 0;
	private bootstrapped = false;
	private bootstrapInFlight = false;
	private startingUp = false;
	private transitioningToLive = false;
	private endArrivedWhileTransitioning = false;
	private cancelled = false;
	private reconnecting = false;
	private reconnectAttempts = 0;
	private reconnectTimer?: Disposable;
	private reconnectWake?: () => void;
	private watchdogTimer?: Disposable;
	private lastActivityAt = 0;
	private lastActivityReason: ActivityReason = "connected";
	private readonly degradedRawCounts = new Map<string, number>();

	constructor(
		private readonly ctx: RoomContext,
		private readonly room: { externalId: string; roomId: string },
	) {}

	private get alive(): boolean {
		return !this.cancelled && !this.ctx.isDisposed();
	}

	cancel(): void {
		this.cancelled = true;
		this.reconnecting = false;
		this.watchdogTimer?.dispose();
		this.watchdogTimer = undefined;
		this.reconnectTimer?.dispose();
		this.reconnectTimer = undefined;
		this.reconnectWake?.();
		this.reconnectWake = undefined;
		this.retireRisk();
	}

	private reportStopped(reason: () => string): void {
		if (!this.alive) return;
		const text = PROBLEM_TEXTS.liveMonitorStopped;
		this.ctx.problems.reportFailure({
			externalId: this.room.externalId,
			code: MONITOR_STOPPED_CODE,
			message: () => text.text(this.room.roomId, reason()),
			notify: text.notify,
			lasting: true,
			recoveryMessage: () => text.recovery(this.room.roomId),
		});
	}

	private reportRestricted(reason: string): void {
		if (!this.alive) return;
		const text = PROBLEM_TEXTS.liveRoomRestricted;
		this.ctx.problems.reportFailure({
			externalId: this.room.externalId,
			code: ROOM_RESTRICTED_CODE,
			message: () => text.text(this.room.roomId, reason),
			notify: text.notify,
			lasting: true,
			recoveryMessage: () => text.recovery(this.room.roomId),
		});
	}

	private resolveStopped(code: typeof MONITOR_STOPPED_CODE | typeof ROOM_RESTRICTED_CODE): void {
		if (!this.alive) return;
		this.ctx.problems.resolveFailure({ externalId: this.room.externalId, code });
	}

	private reportRisk(): void {
		if (!this.alive) return;
		this.ctx.problems.reportRisk(liveRiskPath(this.room.externalId), {
			notify: PROBLEM_TEXTS.riskControlled.notify.live,
		});
	}

	private resolveRisk(relieved: boolean): void {
		if (!this.alive) return;
		this.ctx.problems.resolveRisk(
			liveRiskPath(this.room.externalId),
			relieved ? undefined : { notify: false },
		);
	}

	private retireRisk(): void {
		this.ctx.problems.resolveRisk(liveRiskPath(this.room.externalId), { notify: false });
	}

	private beginLiveTransition(dedupeStart = false): void {
		this.transitioningToLive = true;
		this.endArrivedWhileTransitioning = false;
		this.startingUp = dedupeStart;
	}

	private finishLiveTransition(): boolean {
		this.transitioningToLive = false;
		this.startingUp = false;
		const ended = this.endArrivedWhileTransitioning;
		this.endArrivedWhileTransitioning = false;
		return ended;
	}

	private noteEndDuringTransition(): void {
		if (this.transitioningToLive) this.endArrivedWhileTransitioning = true;
	}

	private async details(
		roomInfo: Record<string, unknown>,
		totalViewers = this.watchedNumber,
		status: "start" | "streaming" = "start",
	): Promise<LiveDetails> {
		const roomCover = typeof roomInfo.user_cover === "string" ? roomInfo.user_cover : "";
		const keyframe = typeof roomInfo.keyframe === "string" ? roomInfo.keyframe : "";
		const coverUrl = status === "streaming" ? keyframe || roomCover : roomCover || keyframe;
		let coverRef: string | undefined;
		if (coverUrl) {
			const fetched = await this.ctx.source.fetchImage(scaledImageUrl(coverUrl), {
				headers: IMAGE_REQUEST_HEADERS,
			});
			if (fetched.ok) coverRef = fetched.ref;
		}
		return liveDetailsFromRoomInfo(roomInfo, {
			...(coverRef === undefined ? {} : { coverRef }),
			...(totalViewers === undefined ? {} : { totalViewers }),
			status,
		});
	}

	private async fetchState(): Promise<Record<string, unknown> | undefined> {
		return this.ctx.fetchRoomInfo(this.room.roomId);
	}

	private async rememberFanClub(): Promise<void> {
		const master = await this.ctx.fetchMasterSnapshot(this.room.externalId);
		if (master.name && !this.masterName) this.masterName = master.name;
	}

	async bootstrap(): Promise<void> {
		let listening = false;
		try {
			listening = await this.ctx.startLiveRoomListener(
				this.room.roomId,
				this.buildEventHandler(),
				() => this.cancelled,
			);
		} catch (error) {
			if (error instanceof LiveRoomAccessDeniedError) {
				this.resolveRisk(false);
				this.reportRestricted(error.message);
				this.logMonitoringStopped(error.message);
				this.ctx.closeListener(this.room.roomId);
				this.cancel();
				return;
			}
			if (error instanceof LiveRoomPreflightBlockedError) {
				this.reportRisk();
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.room.roomId}] ${error.message},进入长尾重试,不放弃监测`,
				);
				void this.reconnect("preflight");
				return;
			}
			this.resolveRisk(false);
			throw error;
		}
		this.resolveRisk(listening);
		if (!listening) {
			this.reportStopped(PROBLEM_TEXTS.liveStopReasons.danmakuConnect);
			this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.danmakuConnect());
			this.ctx.closeListener(this.room.roomId);
			this.cancel();
			return;
		}
		this.resolveStopped(ROOM_RESTRICTED_CODE);
		this.startWatchdog();

		this.beginLiveTransition();
		let ready = false;
		try {
			ready = await this.bootstrapState();
		} finally {
			this.finishLiveTransition();
		}
		if (!ready) {
			this.reportStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo);
			this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo());
			this.ctx.closeListener(this.room.roomId);
			this.cancel();
		}
	}

	private async bootstrapState(): Promise<boolean> {
		this.bootstrapInFlight = true;
		try {
			return await this.bootstrapStateInner();
		} finally {
			this.bootstrapInFlight = false;
		}
	}

	private async bootstrapStateInner(): Promise<boolean> {
		const info = await this.fetchState();
		if (!info?.uid) return false;
		this.bootstrapped = true;
		this.resolveStopped(MONITOR_STOPPED_CODE);
		if (Number(info.live_status) !== 1) return true;

		const [details] = await Promise.all([
			this.details(info, this.watchedNumber, "streaming"),
			this.rememberFanClub(),
		]);
		if (this.finishLiveTransition()) {
			this.ctx.logger.info(
				`[live] 直播间 [${this.room.roomId}] 启动期间已收到下播事件，不按在播处理`,
			);
			return true;
		}
		this.ctx.markReportedLive(this.room.externalId, true);
		this.ctx.source.reportLive(this.room.externalId, {
			kind: "status",
			isLive: true,
			...(liveTimeToIso(String(info.live_time ?? "")) === undefined
				? {}
				: { startedAt: liveTimeToIso(String(info.live_time ?? "")) }),
			details,
		});
		return true;
	}

	private buildEventHandler(): (event: LiveEvent) => void | Promise<void> {
		return (event) => {
			switch (event.kind) {
				case "open":
					this.markActivity("open");
					return;
				case "auth-ok":
					this.markActivity("auth-ok");
					return;
				case "auth-failed":
					this.ctx.logger.warn(
						`[conn] 直播间 [${this.room.roomId}] 弹幕认证失败 code=${event.code}`,
					);
					void this.reconnect("error", `认证失败 code=${event.code}`);
					return;
				case "heartbeat":
					this.markActivity("heartbeat");
					return;
				case "closed":
					this.markActivity("close");
					if (!this.cancelled && !this.ctx.isDisposed()) void this.reconnect("close");
					return;
				case "error":
					return this.reconnect("error");
				case "danmu":
					this.markActivity("danmu");
					this.reportInteraction({
						kind: "viewerChat",
						viewer: { id: String(event.user.uid), name: event.user.name },
						text: event.content,
					});
					return;
				case "superchat":
					this.markActivity("superchat");
					return this.onSuperchat(event);
				case "guard-buy":
					this.markActivity("guard");
					return this.onMembership(event);
				case "watched":
					this.markActivity("watched");
					this.watchedNumber = event.num;
					this.reportViewers(event.num);
					return;
				case "liked":
					this.markActivity("liked");
					return;
				case "live-start":
					this.markActivity("live-start");
					return this.onLiveStart();
				case "live-end":
					this.markActivity("live-end");
					return this.onLiveEnd();
				case "user-action":
					if (event.action === "enter") {
						this.markActivity("interact");
						this.reportInteraction({
							kind: "viewerEnter",
							viewer: { id: String(event.user.uid), name: event.user.name },
						});
					}
					return;
				case "raw":
					this.markActivity("raw");
					if (event.degraded) this.noteDegradedRaw(event.cmd);
					return;
				default:
					this.markActivity("other");
			}
		};
	}

	private reportInteraction(report: LiveInteractionReport): void {
		if (!this.alive) return;
		this.ctx.source.reportLiveInteraction(this.room.externalId, report);
	}

	private async onSuperchat(event: Extract<LiveEvent, { kind: "superchat" }>): Promise<void> {
		if (!this.masterName) await this.rememberFanClub();
		if (event.user.avatarUrl) {
			this.ctx.rememberSuperchatAvatar(String(event.user.uid), event.user.avatarUrl);
		}
		const translated = superchatEventFromLiveEvent(event, "");
		const { subscriptionId: _subscriptionId, ...report } = translated;
		const name = this.masterName;
		this.reportInteraction({
			kind: "superchat",
			...report,
			fallbackText: `【${name}的直播间】${report.viewer.name}的SC:${report.text}（${report.amount}元）`,
		});
	}

	private async onMembership(event: Extract<LiveEvent, { kind: "guard-buy" }>): Promise<void> {
		if (!this.masterName) await this.rememberFanClub();
		const translated = membershipEventFromLiveEvent(event, "");
		if (!translated) {
			this.ctx.logger.warn(
				`[guard] 直播间 [${this.room.roomId}] 认不出的档位 guard_level=${event.guardLevel},已丢弃这条事件`,
			);
			return;
		}
		const { subscriptionId: _subscriptionId, ...report } = translated;
		this.reportInteraction({
			kind: "membership",
			...report,
			fallbackText: `【${this.masterName}的直播间】${report.viewer.name}加入了大航海（${report.tier.name}）`,
		});
	}

	private reportViewers(viewers: number): void {
		if (!this.alive || !this.ctx.hasReportedLive(this.room.externalId)) return;
		const now = Date.now();
		if (now - this.lastViewersReportAt < VIEWERS_EMIT_THROTTLE_MS) return;
		this.lastViewersReportAt = now;
		this.ctx.source.reportLive(this.room.externalId, {
			kind: "status",
			isLive: true,
			details: { totalViewers: viewers },
		});
	}

	private async onLiveStart(): Promise<void> {
		const now = Date.now();
		if (now - this.lastLiveStart < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.debug(`[live] 直播间 [${this.room.roomId}] 的开播事件在冷却期内，忽略`);
			return;
		}
		if (this.startingUp || this.ctx.hasReportedLive(this.room.externalId)) {
			this.ctx.logger.debug(
				`[live] 直播间 [${this.room.roomId}] 已经是开播状态或正在开播准备中，忽略重复的开播事件`,
			);
			return;
		}
		this.lastLiveStart = now;
		this.beginLiveTransition(true);
		let info: Record<string, unknown> | undefined;
		let details: LiveDetails | undefined;
		try {
			info = await this.fetchState();
			if (info) {
				[details] = await Promise.all([this.details(info), this.rememberFanClub()]);
			}
		} finally {
			this.startingUp = false;
		}
		const endedMeanwhile = this.finishLiveTransition();
		if (!info || !details || !this.alive) {
			if (!info && this.alive) {
				this.reportStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo);
				this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo());
				this.ctx.closeListener(this.room.roomId);
				this.cancel();
			}
			return;
		}
		if (endedMeanwhile) {
			this.ctx.logger.info(
				`[live] 直播间 [${this.room.roomId}] 开播准备期间已收到下播事件，放弃本次开播推送`,
			);
			return;
		}
		const startedAt = liveTimeToIso(String(info.live_time ?? ""));
		this.ctx.markReportedLive(this.room.externalId, true);
		this.ctx.source.reportLive(this.room.externalId, {
			kind: "start",
			...(startedAt === undefined ? {} : { startedAt }),
			details,
		});
	}

	private async onLiveEnd(): Promise<void> {
		const now = Date.now();
		if (this.transitioningToLive) {
			this.noteEndDuringTransition();
			return;
		}
		if (now - this.lastLiveEnd < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.debug(`[live] 直播间 [${this.room.roomId}] 的下播事件在冷却期内，忽略`);
			return;
		}
		this.lastLiveEnd = now;
		if (!this.ctx.hasReportedLive(this.room.externalId)) return;
		this.ctx.markReportedLive(this.room.externalId, false);
		if (this.alive) {
			this.ctx.source.reportLive(this.room.externalId, {
				kind: "end",
				endedAt: new Date(now).toISOString(),
			});
		}
	}

	private markActivity(reason: ActivityReason): void {
		this.lastActivityAt = Date.now();
		this.lastActivityReason = reason;
	}

	private startWatchdog(): void {
		if (this.watchdogTimer || this.cancelled || this.ctx.isDisposed()) return;
		this.watchdogTimer = this.ctx.liveContext.setInterval(() => {
			if (this.cancelled || this.ctx.isDisposed() || this.reconnecting) return;
			const staleMs = Date.now() - this.lastActivityAt;
			if (staleMs >= LIVE_WS_STALE_MS) {
				void this.reconnect(
					"watchdog",
					`${Math.floor(staleMs / 1000)}s 无 heartbeat/消息(last=${this.lastActivityReason})`,
				);
			}
		}, LIVE_WS_WATCHDOG_INTERVAL_MS);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.reconnectWake = resolve;
			this.reconnectTimer = this.ctx.liveContext.setTimeout(() => {
				this.reconnectTimer = undefined;
				this.reconnectWake = undefined;
				resolve();
			}, ms);
		});
	}

	private async reconnect(reason: ReconnectReason, detail?: string): Promise<void> {
		if (!this.alive || this.reconnecting) return;
		this.reconnecting = true;
		try {
			await this.reconnectLoop(reason, detail);
		} catch (error) {
			this.ctx.logger.error(
				`[conn] 直播间 [${this.room.roomId}] 重连流程内部异常:${String(error)}`,
			);
		} finally {
			this.reconnecting = false;
		}
	}

	private async reconnectLoop(reason: ReconnectReason, detail?: string): Promise<void> {
		let preflightBlocked = reason === "preflight";
		let preflightAttempts = 0;
		while (true) {
			if (!this.alive) return;
			this.ctx.closeListener(this.room.roomId);
			let delay: number | undefined;
			const reasonText = this.describeReconnectReason(reason, detail);
			if (preflightBlocked) {
				delay = riskBackoffStepMs(preflightAttempts++);
				this.reconnectAttempts = 0;
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.room.roomId}] ${reasonText},${Math.round((delay as number) / 1000)}s 后重试预检(长尾第 ${preflightAttempts} 次,不放弃)`,
				);
			} else {
				if (this.reconnectAttempts >= RECONNECT_BACKOFF_MS.length) break;
				delay = RECONNECT_BACKOFF_MS[this.reconnectAttempts];
				this.reconnectAttempts++;
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.room.roomId}] ${reasonText},${(delay as number) / 1000}s 后重连(第 ${this.reconnectAttempts}/${RECONNECT_BACKOFF_MS.length} 次)`,
				);
			}
			if (delay === undefined) break;
			await this.sleep(delay);
			if (!this.alive) return;

			let connected = false;
			preflightBlocked = false;
			try {
				connected = await this.ctx.startLiveRoomListener(
					this.room.roomId,
					this.buildEventHandler(),
					() => this.cancelled,
				);
			} catch (error) {
				if (error instanceof LiveRoomAccessDeniedError) {
					this.reportRestricted(error.message);
					this.logMonitoringStopped(error.message);
					this.ctx.closeListener(this.room.roomId);
					this.cancel();
					return;
				}
				if (error instanceof LiveRoomPreflightBlockedError) {
					this.reportRisk();
					preflightBlocked = true;
					continue;
				}
				this.ctx.logger.warn(`[conn] 直播间 [${this.room.roomId}] 重连发起异常:${String(error)}`);
			}
			this.resolveRisk(connected);
			if (!connected) {
				this.ctx.logger.warn(`[conn] 直播间 [${this.room.roomId}] 重连未成功,继续退避`);
				continue;
			}
			this.ctx.logger.info(`[conn] 直播间 [${this.room.roomId}] 重连成功`);
			this.markActivity("connected");
			this.startWatchdog();
			this.reconnectAttempts = 0;

			if (!this.bootstrapped) {
				if (this.bootstrapInFlight) return;
				const ready = await this.bootstrapState();
				if (ready) return;
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.room.roomId}] 重连后初始房态拉取失败,回长尾退避重试`,
				);
				preflightBlocked = true;
				continue;
			}
			if (this.ctx.hasReportedLive(this.room.externalId)) {
				const info = await this.fetchState();
				if (!info) {
					preflightBlocked = true;
					continue;
				}
				if (Number(info.live_status) === 1) {
					if (!this.ctx.hasReportedLive(this.room.externalId)) {
						this.ctx.logger.info(
							`[conn] 直播间 [${this.room.roomId}] 重连核对期间已收到下播事件，保持下播状态`,
						);
						return;
					}
					const details = await this.details(info, this.watchedNumber, "streaming");
					const startedAt = liveTimeToIso(String(info.live_time ?? ""));
					this.ctx.source.reportLive(this.room.externalId, {
						kind: "status",
						isLive: true,
						...(startedAt === undefined ? {} : { startedAt }),
						details,
					});
					return;
				}
				this.ctx.markReportedLive(this.room.externalId, false);
				this.ctx.source.reportLive(this.room.externalId, {
					kind: "end",
					endedAt: new Date().toISOString(),
				});
			}
			return;
		}
		const reasonText = this.describeReconnectReason(reason, detail);
		this.ctx.logger.error(
			`[conn] 直播间 [${this.room.roomId}] ${reasonText}后连接持续失败,重试 ${RECONNECT_BACKOFF_MS.length} 次后放弃监听`,
		);
		this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.gaveUp());
		const wasReportedLive = this.ctx.hasReportedLive(this.room.externalId);
		this.ctx.markReportedLive(this.room.externalId, false);
		try {
			if (wasReportedLive) {
				this.ctx.source.reportLive(this.room.externalId, {
					kind: "end",
					endedAt: new Date().toISOString(),
				});
			}
			this.reportStopped(PROBLEM_TEXTS.liveStopReasons.gaveUp);
		} catch (error) {
			this.ctx.logger.warn(
				`[conn] 直播间 [${this.room.roomId}] 放弃监听时的下播处理失败:${String(error)}`,
			);
		} finally {
			this.ctx.closeListener(this.room.roomId);
			this.cancel();
		}
	}

	private describeReconnectReason(reason: ReconnectReason, detail?: string): string {
		if (reason === "error") return detail ? `连接错误(${detail})` : "连接错误";
		if (reason === "close") return "连接关闭";
		if (reason === "preflight") return "弹幕预检被风控拦截";
		return detail ? `连接静默(${detail})` : "连接静默";
	}

	private logMonitoringStopped(reason: string): void {
		this.ctx.logger.error(`[conn] [${this.room.roomId}] ${reason}，已停止该房间的监测`);
	}

	private noteDegradedRaw(cmd: string): void {
		const count = (this.degradedRawCounts.get(cmd) ?? 0) + 1;
		this.degradedRawCounts.set(cmd, count);
		if (count === 1 || count % 100 === 0) {
			this.ctx.logger.warn(
				`[proto] 直播间 [${this.room.roomId}] 已知命令 ${cmd} 解析降级(累计 ${count} 次)—— B 站可能调整了字段形状,请检查更新`,
			);
		}
	}
}
