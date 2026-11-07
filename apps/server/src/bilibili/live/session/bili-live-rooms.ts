import {
	type Disposable,
	fail,
	type Identity,
	type LiveDetails,
	type LiveStatusResult,
	ok,
	type PreviewReport,
	type Result,
	type ServiceContext,
	type SourceAuth,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../../../util/error-message.js";
import type { Api } from "../../api/index.js";
import { failureFromBili } from "../../error-codes.js";
import { t } from "../../i18n.js";
import { IMAGE_REQUEST_HEADERS, scaledImageUrl } from "../../images.js";
import { isLoginLost, watchLoginEdges } from "../../login-edges.js";
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
		ctx.logger.info("[start] 直播监听启动，正在连直播间...");
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
		this.syncSessions(subscriptions);
		this.handles.push(
			ctx.onSubscriptionsChanged(() => {
				this.syncSessions(this.sourceCtx?.subscriptions() ?? []);
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
					// 恢复 = 整批重建:先静默清掉旧会话(连同压着的停止监听问题),再按当前名单重开。
					this.listener?.teardown();
					this.syncSessions(this.sourceCtx?.subscriptions() ?? []);
				},
			}),
		);
	}

	/**
	 * 登录可用才起会话。开机就是 `expired` / `logged-out`、或者掉线期间改订阅,都等恢复时整批重建 ——
	 * 不在未登录时起一堆注定死掉、又留在 `active` 里被增量 `sync` 过滤掉的会话。
	 */
	private syncSessions(subscriptions: readonly SourceSubscriptionView[]): void {
		if (isLoginLost(this.opts.auth.state().status)) return;
		void this.listener?.sync(subscriptions);
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
				this.listener?.noteLiveStatus(externalId, false);
				const offline: LiveStatusResult = ok<{ kind: "offline" }>({ kind: "offline" });
				return offline;
			}
			const details = await this.details(data);
			const startedAt = liveTimeToIso(data.live_time);
			this.listener?.noteLiveStatus(externalId, true);
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

	/**
	 * 卡片页预览要的直播详情(`Source.fetchPreview` 的直播那一支):与 {@link fetchLiveStatus} 同一份翻译,但在不在播
	 * 都给(卡上照「正在直播」画),也不报问题、不记在播状态 —— 预览没有副作用。失败的原话会显示在面板上。
	 */
	async fetchPreview(identity: Identity, signal: AbortSignal): Promise<Result<PreviewReport>> {
		if (signal.aborted || !this.sourceCtx) {
			return fail("unavailable", t("bilibili.preview.notRunning"));
		}
		const resolved = await this.opts.roomIds.resolve(identity.externalId);
		if (!resolved.ok) {
			return resolved.code === "not_found"
				? fail("not_found", t("bilibili.preview.noLiveRoom"))
				: resolved;
		}
		try {
			const response = await this.opts.api.fetchLiveRoomInfo(resolved.roomId);
			if (signal.aborted) return fail("indeterminate", "live preview request was aborted");
			if (response.code !== 0) {
				const message = (response as { message?: unknown }).message;
				return failureFromBili(
					response.code,
					typeof message === "string" && message !== ""
						? message
						: t("bilibili.response.codeOnly", { code: response.code }),
				);
			}
			const data = response.data;
			if (!data) return fail("unavailable", t("bilibili.preview.roomInfoMissing"));
			const details = await this.details(data);
			const startedAt = liveTimeToIso(data.live_time);
			return ok<PreviewReport>({
				kind: "live",
				...(startedAt === undefined ? {} : { startedAt }),
				details,
			});
		} catch (error) {
			return fail("unavailable", errorMessageOf(error));
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
