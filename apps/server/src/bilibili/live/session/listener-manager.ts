import type { Disposable, SourceSubscriptionView } from "@bilibili-notify/internal";
import { PROBLEM_TEXTS } from "../../problem-texts.js";
import { liveRiskPath, type RoomContext } from "./room-context.js";
import { liveLongTailBackoffMs, RoomSession } from "./room-session.js";

interface ActiveRoom {
	externalId: string;
	roomId: string;
	session: RoomSession;
}

interface RoomIdRetry {
	attempts: number;
	riskReported: boolean;
	timer?: Disposable;
}

export class ListenerManager {
	private readonly active = new Map<string, ActiveRoom>();
	private readonly retries = new Map<string, RoomIdRetry>();
	private readonly starting = new Set<string>();
	private wanted = new Set<string>();
	private syncTail = Promise.resolve();
	private disposed = false;

	constructor(private readonly ctx: RoomContext) {}

	sync(subscriptions: readonly SourceSubscriptionView[]): Promise<void> {
		const wanted = new Set(
			subscriptions.filter((subscription) => subscription.monitorsLive).map((s) => s.externalId),
		);
		const made = this.syncTail.then(
			() => this.applySubscriptions(wanted),
			() => this.applySubscriptions(wanted),
		);
		this.syncTail = made.then(
			() => undefined,
			() => undefined,
		);
		return made;
	}

	private async applySubscriptions(wanted: Set<string>): Promise<void> {
		if (this.disposed) return;
		this.wanted = wanted;
		this.ctx.logger.debug(
			`[start] 启动直播监听，共 ${wanted.size} 个 UID：${[...wanted].join(", ")}`,
		);
		for (const externalId of new Set([...this.active.keys(), ...this.retries.keys()])) {
			if (!wanted.has(externalId)) this.stop(externalId);
		}
		await Promise.all(
			[...wanted]
				.filter((externalId) => !this.active.has(externalId))
				.map((externalId) => this.start(externalId)),
		);
	}

	private async start(externalId: string): Promise<void> {
		if (
			this.disposed ||
			!this.wanted.has(externalId) ||
			this.active.has(externalId) ||
			this.starting.has(externalId) ||
			this.retries.has(externalId)
		) {
			return;
		}
		this.starting.add(externalId);
		try {
			await this.resolveAndStart(externalId);
		} finally {
			this.starting.delete(externalId);
		}
	}

	private async resolveAndStart(externalId: string, retry?: RoomIdRetry): Promise<void> {
		const result = await this.ctx.roomIds.resolve(externalId);
		if (this.disposed || !this.wanted.has(externalId) || this.active.has(externalId)) return;
		if (!result.ok) {
			this.logResolutionFailure(externalId, result);
			if (
				result.code === "rate_limited" ||
				result.code === "unavailable" ||
				result.code === "unknown" ||
				result.code === "timeout"
			) {
				this.scheduleRetry(externalId, result.code === "rate_limited", retry);
			} else if (retry) {
				this.retries.delete(externalId);
				if (retry.riskReported) {
					this.ctx.problems.resolveRisk(liveRiskPath(externalId), { notify: false });
				}
			}
			return;
		}
		if (retry) {
			this.retries.delete(externalId);
			if (retry.riskReported) this.ctx.problems.resolveRisk(liveRiskPath(externalId));
		}
		const roomId = result.roomId;
		const session = new RoomSession(this.ctx, { externalId, roomId });
		this.active.set(externalId, { externalId, roomId, session });
		session
			.bootstrap()
			.catch((error) =>
				this.ctx.logger.error(`[start] 启动直播监听失败 UID=${externalId}：${String(error)}`),
			);
	}

	private logResolutionFailure(
		externalId: string,
		failure: { code: string; message: string },
	): void {
		if (failure.code === "not_found") {
			this.ctx.logger.warn(
				`[start] UID=${externalId} 未开通直播间或 live_room 解析失败，跳过 listener 创建`,
			);
			return;
		}
		this.ctx.logger.warn(
			`[start] UID=${externalId} 解析直播间号失败：${failure.code}：${failure.message}`,
		);
	}

	private scheduleRetry(externalId: string, riskControl: boolean, existing?: RoomIdRetry): void {
		if (this.disposed || !this.wanted.has(externalId) || this.active.has(externalId)) return;
		const retry = existing ?? { attempts: 0, riskReported: false };
		if (!existing) this.retries.set(externalId, retry);
		if (riskControl && !retry.riskReported) {
			retry.riskReported = true;
			this.ctx.problems.reportRisk(liveRiskPath(externalId), {
				notify: PROBLEM_TEXTS.riskControlled.notify.live,
			});
		}
		const delay = liveLongTailBackoffMs(retry.attempts++);
		retry.timer?.dispose();
		retry.timer = this.ctx.liveContext.setTimeout(() => {
			retry.timer = undefined;
			if (this.retries.get(externalId) !== retry) return;
			if (
				this.disposed ||
				!this.wanted.has(externalId) ||
				this.active.has(externalId) ||
				this.starting.has(externalId)
			) {
				return;
			}
			this.starting.add(externalId);
			void this.resolveAndStart(externalId, retry).finally(() => {
				this.starting.delete(externalId);
			});
		}, delay);
	}

	stop(externalId: string): void {
		this.wanted.delete(externalId);
		const retry = this.retries.get(externalId);
		if (retry) {
			retry.timer?.dispose();
			this.retries.delete(externalId);
			if (retry.riskReported) {
				this.ctx.problems.resolveRisk(liveRiskPath(externalId), { notify: false });
			}
		}
		const active = this.active.get(externalId);
		if (!active) return;
		active.session.cancel();
		this.ctx.closeListener(active.roomId);
		this.ctx.problems.resolveFailure(
			{ externalId, code: "live_monitor_stopped" },
			{ notify: false },
		);
		this.ctx.problems.resolveFailure(
			{ externalId, code: "live_room_restricted" },
			{ notify: false },
		);
		this.active.delete(externalId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const externalId of new Set([...this.active.keys(), ...this.retries.keys()])) {
			this.stop(externalId);
		}
	}

	teardown(): void {
		for (const externalId of new Set([...this.active.keys(), ...this.retries.keys()])) {
			this.stop(externalId);
		}
	}
}
