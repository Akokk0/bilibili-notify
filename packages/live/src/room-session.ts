import { GuardLevel, type MsgHandler } from "blive-message-listener";
import { DateTime } from "luxon";
import { LivePushType } from "./push-like";
import { GUARD_LEVEL_IMG } from "./room-context";
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

export class RoomSession extends RoomSessionBase {
	private lastViewersEmitMs = 0;

	// ── MsgHandler factory ────────────────────────────────────────────────────

	protected buildHandler(): MsgHandler {
		const base: MsgHandler = {
			onError: () => this.onError(),
			onIncomeDanmu: ({ body }) => this.onIncomeDanmu(body),
			onIncomeSuperChat: ({ body }) => this.onIncomeSuperChat(body),
			onWatchedChange: ({ body }) => {
				this.liveData.watchedNum = body.text_small;
				const now = Date.now();
				if (now - this.lastViewersEmitMs >= VIEWERS_EMIT_THROTTLE_MS) {
					this.lastViewersEmitMs = now;
					this.ctx.emitViewers(this.sub.uid, body.text_small);
				}
			},
			onLikedChange: ({ body }) => {
				this.liveData.likedNum = body.count;
			},
			onGuardBuy: ({ body }) => this.onGuardBuy(body),
			onLiveStart: () => this.onLiveStart(),
			onLiveEnd: () => this.onLiveEnd(),
		};
		if (!this.sub.customSpecialUsersEnterTheRoom.enable) return base;
		return {
			...base,
			raw: {
				INTERACT_WORD_V2: (msg: unknown) => this.onInteractWordV2(msg),
			},
		};
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private async onError(): Promise<void> {
		this.setLiveStatus(false);
		this.cancelPeriodicTimer();
		this.ctx.closeListener(this.sub.roomId);
		if (this.ctx.isDisposed()) return;
		await this.ctx.push.sendPrivateMsg(`[${this.sub.roomId}] 直播间连接发生错误`);
		this.ctx.logger.error(`[conn] 直播间 [${this.sub.roomId}] 连接发生错误`);
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
		// Per-UP minScPrice 优先;adapter 未填时回退到 ListenerManagerConfig 全局值。
		const effMinScPrice = this.sub.minScPrice ?? this.ctx.config.minScPrice;
		if (body.price < effMinScPrice) return;

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
		// Per-UP minGuardLevel 优先(同 SC 阈值的语义);adapter 未填时回退到全局。
		const effMinGuardLevel = this.sub.minGuardLevel ?? this.ctx.config.minGuardLevel;
		if (body.guard_level > effMinGuardLevel) return;
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
			this.ctx.logger.warn(`[live] 直播间 [${this.sub.roomId}] 的开播事件在冷却期内，忽略`);
			return;
		}
		this.lastLiveStart = now;
		if (this.liveStatus) {
			this.ctx.logger.warn(`[live] 直播间 [${this.sub.roomId}] 已经是开播状态，忽略重复的开播事件`);
			return;
		}
		this.setLiveStatus(true);
		if (
			!(await this.useLiveRoomInfo(LiveType.StartBroadcasting)) ||
			!(await this.useMasterInfo(LiveType.StartBroadcasting)) ||
			!this.liveRoomInfo ||
			!this.masterInfo
		) {
			this.setLiveStatus(false);
			if (this.ctx.isDisposed()) return;
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
		this.armPeriodicTimer();
	}

	private async onLiveEnd(): Promise<void> {
		const now = Date.now();
		if (now - this.lastLiveEnd < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.warn(`[live] 直播间 [${this.sub.roomId}] 的下播事件在冷却期内，忽略`);
			return;
		}
		this.lastLiveEnd = now;
		await this.handleLiveEnd("ws");
	}

	private async onInteractWordV2(msg: unknown): Promise<void> {
		if (
			!this.sub.customSpecialUsersEnterTheRoom.enable ||
			!this.ctx.hasTargets(this.sub, "specialUserEnterTheRoom")
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
