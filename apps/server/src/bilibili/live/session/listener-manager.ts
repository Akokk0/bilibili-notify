import type { SourceSubscriptionView } from "@bilibili-notify/internal";
import type { RoomContext } from "./room-context.js";
import { RoomSession } from "./room-session.js";

interface ActiveRoom {
	externalId: string;
	roomId: string;
	session: RoomSession;
}

export class ListenerManager {
	private readonly active = new Map<string, ActiveRoom>();
	private disposed = false;

	constructor(private readonly ctx: RoomContext) {}

	async sync(subscriptions: readonly SourceSubscriptionView[]): Promise<void> {
		if (this.disposed) return;
		const wanted = new Set(
			subscriptions.filter((subscription) => subscription.monitorsLive).map((s) => s.externalId),
		);
		this.ctx.logger.debug(
			`[start] 启动直播监听，共 ${wanted.size} 个 UID：${[...wanted].join(", ")}`,
		);
		for (const externalId of [...this.active.keys()]) {
			if (!wanted.has(externalId)) this.stop(externalId);
		}
		await Promise.all(
			[...wanted]
				.filter((externalId) => !this.active.has(externalId))
				.map((externalId) => this.start(externalId)),
		);
	}

	private async start(externalId: string): Promise<void> {
		const known = this.ctx.liveRoomIds.get(externalId);
		const roomId = known ?? (await this.resolveRoomId(externalId));
		if (!roomId || this.disposed || this.active.has(externalId)) return;
		const session = new RoomSession(this.ctx, { externalId, roomId });
		this.active.set(externalId, { externalId, roomId, session });
		session
			.bootstrap()
			.catch((error) =>
				this.ctx.logger.error(`[start] 启动直播监听失败 UID=${externalId}：${String(error)}`),
			);
	}

	private async resolveRoomId(externalId: string): Promise<string | undefined> {
		try {
			const info = (await this.ctx.api.fetchUserInfo(externalId)) as {
				data?: { live_room?: { roomid?: unknown } };
			};
			const roomId = Number(info?.data?.live_room?.roomid);
			if (!Number.isFinite(roomId) || roomId <= 0) {
				this.ctx.logger.warn(
					`[start] UID=${externalId} 未开通直播间或 live_room 解析失败，跳过 listener 创建`,
				);
				return undefined;
			}
			const resolved = String(roomId);
			const existing = this.ctx.liveRoomIds.get(externalId);
			if (!existing) {
				const setter = this.ctx.liveRoomIds as {
					set?(externalId: string, roomId: string): void;
				};
				setter.set?.(externalId, resolved);
			}
			return resolved;
		} catch (error) {
			this.ctx.logger.warn(`[start] UID=${externalId} 解析直播间号失败：${String(error)}`);
			return undefined;
		}
	}

	stop(externalId: string): void {
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
		for (const externalId of [...this.active.keys()]) this.stop(externalId);
	}

	teardown(): void {
		for (const externalId of [...this.active.keys()]) this.stop(externalId);
	}
}
