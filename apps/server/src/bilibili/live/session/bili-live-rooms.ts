import {
	type Disposable,
	fail,
	type Identity,
	type LiveDetails,
	type LiveStatusResult,
	ok,
	type ServiceContext,
	type SourceAuth,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import type { Api } from "../../api/index.js";
import { IMAGE_REQUEST_HEADERS, scaledImageUrl } from "../../images.js";
import { watchLoginEdges } from "../../login-edges.js";
import { PROBLEM_TEXTS } from "../../problem-texts.js";
import { liveDetailsFromRoomInfo, liveTimeToIso } from "../live-card-input.js";
import type { RoomIds } from "../room-ids.js";
import { ListenerManager } from "./listener-manager.js";
import { type LiveProblems, RoomContext } from "./room-context.js";

const LIVE_STATUS_UNAVAILABLE = "live_status_unavailable";

export class BiliLiveRooms implements Disposable {
	private roomContext: RoomContext | undefined;
	private listener: ListenerManager | undefined;
	private sourceCtx: SourceContext | undefined;
	private readonly handles: Disposable[] = [];

	constructor(
		private readonly opts: {
			api: Api;
			auth: Pick<SourceAuth, "state" | "onChange">;
			liveContext: ServiceContext;
			roomIds: RoomIds;
			rememberFanClubName(externalId: string, name: string): void;
			problems: LiveProblems;
			rememberSuperchatAvatar?(viewerId: string, url: string): void;
		},
	) {}

	start(ctx: SourceContext, subscriptions: readonly SourceSubscriptionView[]): void {
		if (this.listener) throw new Error("bilibili live rooms are already started");
		this.sourceCtx = ctx;
		ctx.logger.info("[start] 直播引擎启动，正在初始化直播监听...");
		this.roomContext = new RoomContext({
			api: this.opts.api,
			liveContext: this.opts.liveContext,
			source: ctx,
			problems: this.opts.problems,
			roomIds: this.opts.roomIds,
			rememberFanClubName: this.opts.rememberFanClubName,
			rememberSuperchatAvatar: this.opts.rememberSuperchatAvatar ?? (() => {}),
		});
		this.listener = new ListenerManager(this.roomContext);
		void this.listener.sync(subscriptions);
		this.handles.push(
			ctx.onSubscriptionsChanged(() => {
				void this.listener?.sync(this.sourceCtx?.subscriptions() ?? []);
			}),
		);
		this.handles.push(
			watchLoginEdges(this.opts.auth, {
				onLost: () => {
					ctx.logger.warn("[auth] 账号登录已失效，直播间监听已全部关闭（登录恢复后重建）");
					this.listener?.teardown();
				},
				onRestored: () => {
					ctx.logger.info("[auth] 账号登录已恢复，正在重建直播间监听");
					void this.listener?.sync(this.sourceCtx?.subscriptions() ?? []);
				},
			}),
		);
	}

	stop(): void {
		for (const handle of this.handles.splice(0)) handle.dispose();
		this.listener?.dispose();
		this.listener = undefined;
		this.roomContext?.dispose();
		this.roomContext = undefined;
		this.sourceCtx = undefined;
	}

	dispose(): void {
		this.stop();
	}

	async fetchLiveStatus(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult> {
		if (signal.aborted || !this.sourceCtx) {
			return fail("unavailable", "bilibili live rooms are not running");
		}
		const externalId = identity.externalId;
		const resolved = await this.opts.roomIds.resolve(externalId);
		if (!resolved.ok) {
			return resolved;
		}
		const roomId = resolved.roomId;
		try {
			const response = await this.opts.api.fetchLiveRoomInfo(roomId);
			if (signal.aborted) return fail("indeterminate", "live status request was aborted");
			const data = response.data;
			if (!data) {
				this.reportStatusUnavailable(externalId, roomId);
				return fail("unavailable", "live room info is unavailable");
			}
			const status = Number(data.live_status);
			if (status !== 1 && status !== 0 && status !== 2) {
				this.reportStatusUnavailable(externalId, roomId);
				return fail("unavailable", `unknown live status ${String(data.live_status)}`);
			}
			this.opts.problems.resolveFailure({ externalId, code: LIVE_STATUS_UNAVAILABLE });
			if (status !== 1) {
				this.roomContext?.markReportedLive(externalId, false);
				const offline: LiveStatusResult = ok<{ kind: "offline" }>({ kind: "offline" });
				return offline;
			}
			const details = await this.details(data);
			const startedAt = liveTimeToIso(data.live_time);
			this.roomContext?.markReportedLive(externalId, true);
			const live: LiveStatusResult = ok<{
				kind: "live";
				startedAt?: string;
				details: LiveDetails;
			}>({
				kind: "live",
				...(startedAt === undefined ? {} : { startedAt }),
				details,
			});
			return live;
		} catch (error) {
			this.sourceCtx.logger.warn(`[live] 房间 [${roomId}] 这一轮取直播状态失败：${String(error)}`);
			this.reportStatusUnavailable(externalId, roomId);
			return fail("unavailable", "live status is unavailable");
		}
	}

	private reportStatusUnavailable(externalId: string, roomId: string): void {
		this.opts.problems.reportFailure({
			externalId,
			code: LIVE_STATUS_UNAVAILABLE,
			message: () => PROBLEM_TEXTS.liveStatusUnavailable.text(roomId),
			notify: PROBLEM_TEXTS.liveStatusUnavailable.notify,
			lasting: false,
		});
	}

	private async details(data: Record<string, unknown>): Promise<LiveDetails> {
		const coverUrl =
			typeof data.keyframe === "string"
				? data.keyframe || (typeof data.user_cover === "string" ? data.user_cover : "")
				: typeof data.user_cover === "string"
					? data.user_cover
					: "";
		let coverRef: string | undefined;
		if (coverUrl && this.sourceCtx) {
			const fetched = await this.sourceCtx.fetchImage(scaledImageUrl(coverUrl), {
				headers: IMAGE_REQUEST_HEADERS,
			});
			if (fetched.ok) coverRef = fetched.ref;
		}
		return liveDetailsFromRoomInfo(data, {
			...(coverRef === undefined ? {} : { coverRef }),
			status: "streaming",
		});
	}
}
