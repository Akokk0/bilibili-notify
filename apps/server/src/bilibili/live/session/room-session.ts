import type { Disposable, LiveDetails, LiveInteractionReport } from "@bilibili-notify/internal";
import { t as serverText } from "../../../i18n/index.js";
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
	/**
	 * 本会话是否已经报过在播。标记属于这一个会话:会话没了(登录失效拆掉、订阅移除、放弃监听)
	 * 它也就没了,不会像挂在 `RoomContext` 上那样带进下一个会话。
	 */
	private reportedLive = false;
	/**
	 * 单调递增的下播序号:每次收到 `LIVE_END` 就 +1。每条「await 完了要宣布在播」的路在第一个 await
	 * 之前记下它,最后一个 await 之后再比一次 —— 变了说明这期间来过下播,别再把状态翻回在播。
	 * 这样以后再加一条要宣布在播的路,不需要记得配对任何开关。
	 */
	private liveEndSeq = 0;
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

	/**
	 * 直播间状态轮询核到的在播 / 不在播,由 `ListenerManager` 转给当前活着的那一个会话。
	 * 没有活着的会话时这一下就落空 —— 断线期间核到的在播不会写进下一个会话。
	 */
	noteLiveStatus(live: boolean): void {
		this.reportedLive = live;
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

		const ready = await this.bootstrapState();
		if (!ready) {
			this.reportStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo);
			this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo());
			this.ctx.closeListener(this.room.roomId);
			this.cancel();
		}
	}

	private async bootstrapState(reportEnd = false): Promise<boolean> {
		this.bootstrapInFlight = true;
		try {
			return await this.refreshLiveStatus(reportEnd);
		} finally {
			this.bootstrapInFlight = false;
		}
	}

	/**
	 * 拿房间信息核一次在播状态。启动与重连后补跑共用这一条路:
	 * 在播 → 这期间没来过下播才报 `status`;不在播时,只有 `reportEnd`(重连后核对「刚才还在播的那一场」)
	 * 才收口成 `end`。启动那一次不收口:这一刻的标记可能是并发的开播事件刚设的,或者是上一场留下的,
	 * 都不能拿它宣布下播。
	 * 回 `false` 只有一种情况:拿不到房间信息。
	 */
	private async refreshLiveStatus(reportEnd: boolean): Promise<boolean> {
		const endSeq = this.liveEndSeq;
		const info = await this.fetchState();
		if (!info?.uid) return false;
		this.bootstrapped = true;
		this.resolveStopped(MONITOR_STOPPED_CODE);
		if (Number(info.live_status) !== 1) {
			if (!reportEnd || !this.reportedLive) return true;
			this.reportedLive = false;
			this.ctx.source.reportLive(this.room.externalId, {
				kind: "end",
				endedAt: new Date().toISOString(),
			});
			return true;
		}

		const [details] = await Promise.all([
			this.details(info, this.watchedNumber, "streaming"),
			this.rememberFanClub(),
		]);
		if (this.liveEndSeq !== endSeq) {
			if (reportEnd) {
				this.ctx.logger.info(
					`[conn] 直播间 [${this.room.roomId}] 重连核对期间已收到下播事件，保持下播状态`,
				);
			} else {
				this.ctx.logger.info(
					`[live] 直播间 [${this.room.roomId}] 启动期间已收到下播事件，不按在播处理`,
				);
			}
			return true;
		}
		this.reportedLive = true;
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
					void this.reconnect(
						"error",
						serverText("bilibili.live.session.room-session.text.1", { value0: event.code }),
					);
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
			fallbackText: serverText("bilibili.live.session.room-session.text.2", {
				value0: name,
				value1: report.viewer.name,
				value2: report.text,
				value3: report.amount,
			}),
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
			fallbackText: serverText("bilibili.live.session.room-session.text.3", {
				value0: this.masterName,
				value1: report.viewer.name,
				value2: report.tier.name,
			}),
		});
	}

	private reportViewers(viewers: number): void {
		if (!this.alive || !this.reportedLive) return;
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
		if (this.startingUp || this.reportedLive) {
			this.ctx.logger.debug(
				`[live] 直播间 [${this.room.roomId}] 已经是开播状态或正在开播准备中，忽略重复的开播事件`,
			);
			return;
		}
		this.lastLiveStart = now;
		this.startingUp = true;
		const endSeq = this.liveEndSeq;
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
		if (!info || !details || !this.alive) {
			if (!info && this.alive) {
				this.reportStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo);
				this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.roomInfo());
				this.ctx.closeListener(this.room.roomId);
				this.cancel();
			}
			return;
		}
		if (this.liveEndSeq !== endSeq) {
			this.ctx.logger.info(
				`[live] 直播间 [${this.room.roomId}] 开播准备期间已收到下播事件，放弃本次开播推送`,
			);
			return;
		}
		const startedAt = liveTimeToIso(String(info.live_time ?? ""));
		this.reportedLive = true;
		this.ctx.source.reportLive(this.room.externalId, {
			kind: "start",
			...(startedAt === undefined ? {} : { startedAt }),
			details,
		});
	}

	private async onLiveEnd(): Promise<void> {
		const now = Date.now();
		// 先记序号,再看冷却:落在冷却期里的那条也算数(冷却是给重复帧用的,不是给新一场用的)。
		this.liveEndSeq++;
		if (now - this.lastLiveEnd < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.debug(`[live] 直播间 [${this.room.roomId}] 的下播事件在冷却期内，忽略`);
			return;
		}
		this.lastLiveEnd = now;
		if (!this.reportedLive) return;
		this.reportedLive = false;
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
					serverText("bilibili.live.session.room-session.text.4", {
						value0: Math.floor(staleMs / 1000),
						value1: this.lastActivityReason,
					}),
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

			// 还没补跑过初始房态、或者已经在播(重连后要核对还在不在播)才多拉一次房间信息;
			// 没报过在播就不拉,保持 3b-63 压请求量的出发点。
			if (!this.bootstrapped || this.reportedLive) {
				if (this.bootstrapInFlight) return;
				const ready = await this.bootstrapState(this.bootstrapped);
				if (ready) return;
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.room.roomId}] 重连后初始房态拉取失败,回长尾退避重试`,
				);
				preflightBlocked = true;
				continue;
			}
			return;
		}
		const reasonText = this.describeReconnectReason(reason, detail);
		this.ctx.logger.error(
			`[conn] 直播间 [${this.room.roomId}] ${reasonText}后连接持续失败,重试 ${RECONNECT_BACKOFF_MS.length} 次后放弃监听`,
		);
		this.logMonitoringStopped(PROBLEM_TEXTS.liveStopReasons.gaveUp());
		const wasReportedLive = this.reportedLive;
		this.reportedLive = false;
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
		if (reason === "error")
			return detail
				? serverText("bilibili.live.session.room-session.text.5", { value0: detail })
				: serverText("bilibili.live.session.room-session.text.6");
		if (reason === "close") return serverText("bilibili.live.session.room-session.text.7");
		if (reason === "preflight") return serverText("bilibili.live.session.room-session.text.8");
		return detail
			? serverText("bilibili.live.session.room-session.text.9", { value0: detail })
			: serverText("bilibili.live.session.room-session.text.10");
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
