import type { LiveRoomInfo, MasterInfoData, MySelfInfoData } from "@bilibili-notify/api";
import { type MessageKindLayout, planMessageGroups } from "@bilibili-notify/internal";
import { type MsgHandler, startListen } from "blive-message-listener";
import { DateTime } from "luxon";
import { LivePushType, type SubItemView } from "./push-like";
import { RoomContextBase } from "./room-context";
import { type LiveData, LiveType, type MasterInfo } from "./types";

type LiveRoomDanmuInfo = {
	code: number;
	message?: string;
	msg?: string;
	data: {
		token?: string;
		host_list?: unknown[];
		[key: string]: unknown;
	} | null;
};

export class LiveRoomAccessDeniedError extends Error {
	constructor(readonly reason: string) {
		super(`弹幕连接不可用：${reason}，可能是加密/付费/测试房或当前账号无权限访问`);
		this.name = "LiveRoomAccessDeniedError";
	}
}

export function describeLiveRoomDanmuPreflightFallback(
	info: LiveRoomDanmuInfo,
): string | undefined {
	const message = info.message || info.msg;
	const messageSuffix = message ? ` message=${message}` : "";
	// -352 是 B 站常见风控/校验拦截码。它说明这次 HTTP 预检不可信,不等价于房间
	// 永久不可访问;旧的直接 WS 建连路径可能仍然可用,所以只能降级回退,不能硬停。
	if (info.code === -352) return `B 站返回 code=${info.code}${messageSuffix}`;
	return undefined;
}

export function describeLiveRoomDanmuAccessDenied(info: LiveRoomDanmuInfo): string | undefined {
	if (describeLiveRoomDanmuPreflightFallback(info)) return undefined;
	const message = info.message || info.msg;
	const messageSuffix = message ? ` message=${message}` : "";
	if (info.code !== 0) return `B 站返回 code=${info.code}${messageSuffix}`;
	if (!info.data) return "B 站未返回弹幕连接信息";
	const token = typeof info.data.token === "string" ? info.data.token.trim() : "";
	if (!token) return "B 站未返回弹幕 token";
	if (!Array.isArray(info.data.host_list) || info.data.host_list.length === 0) {
		return "B 站未返回弹幕服务器列表";
	}
	return undefined;
}

/**
 * Extends {@link RoomContextBase} with the data-fetch / card-render /
 * time-format helpers — every call here either hits the Bilibili HTTP API or
 * the optional `ImageRenderer`. Keeping them on a separate class keeps the
 * base file focused on state / lifecycle while preserving the inheritance
 * chain so {@link RoomSession} sees a single `ctx.foo()` API surface.
 */
export class RoomContext extends RoomContextBase {
	/**
	 * Bring up the WebSocket listener for `roomId`.
	 *
	 * L4: returns `true` iff there is an active listener for the room *after*
	 * this call — either freshly created OR already present (the latter lets a
	 * reconnect that races with a backoff-window restore treat the room as
	 * recovered). 可重试的 setup 失败返回 `false`;B 站明确拒绝弹幕连接时抛
	 * {@link LiveRoomAccessDeniedError},让调用方停止监测,不要把受限房当瞬时抖动重连。
	 */
	async startLiveRoomListener(
		roomId: string,
		handler: MsgHandler,
		shouldAbort?: () => boolean,
	): Promise<boolean> {
		// ②6:per-session 取消探针。此方法只认 engine 级 isDisposed(),感知不到
		// 单房间被 stopForUid 取消;getMyselfInfo 这段 await 期间若 session 被取消,
		// 继续建 listener 即孤儿。每个检查点并行查 shouldAbort,已建则关闭。
		const aborted = () => this.isDisposed() || shouldAbort?.() === true;
		if (aborted()) return false;
		const roomIdNum = Number.parseInt(roomId, 10);
		if (!Number.isFinite(roomIdNum) || roomIdNum <= 0) {
			this.logger.error(
				`[conn] roomId 非法（"${roomId}"），跳过 listener 创建。请检查订阅配置或用户是否开通直播间`,
			);
			return false;
		}
		if (this.listenerRecord[roomId]) {
			this.logger.warn(`[conn] 直播间 [${roomId}] 连接已存在，跳过创建`);
			return true;
		}
		this.consumeIntentionalClose(roomId);

		let danmuInfo: LiveRoomDanmuInfo;
		try {
			danmuInfo = await this.api.getLiveRoomInfoStreamKey(roomId);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.logger.warn(`[conn] 获取弹幕连接信息异常，房间 [${roomId}]：${message}`);
			return false;
		}
		const fallbackReason = describeLiveRoomDanmuPreflightFallback(danmuInfo);
		if (fallbackReason) {
			this.logger.warn(
				`[conn] 直播间 [${roomId}] 弹幕连接预检被风控拦截：${fallbackReason}，回退到直接建连`,
			);
		}
		const deniedReason = describeLiveRoomDanmuAccessDenied(danmuInfo);
		if (deniedReason) {
			throw new LiveRoomAccessDeniedError(deniedReason);
		}
		if (aborted()) return false;

		const cookiesStr = this.api.getCookiesHeader();
		let mySelfInfo: MySelfInfoData;
		try {
			// ④ 走客户端共享的账号身份缓存(短 TTL + 在途合流):多房间同时重连时
			// 「自己的信息」只落一次请求;换号/登出由 BilibiliAPI 精准 invalidate。
			mySelfInfo = await this.api.getMyselfInfoCached();
		} catch (e) {
			const message = (e as Error).message ?? String(e);
			this.logger.warn(`[conn] 获取个人信息异常，房间 [${roomId}]：${message}`);
			this.emitEngineError(`[${roomId}] 获取个人信息异常：${message}`);
			return false;
		}
		if (mySelfInfo.code !== 0 || !mySelfInfo.data) {
			this.logger.warn(
				`[conn] 获取个人信息失败 code=${mySelfInfo.code}，无法创建直播间 [${roomId}] 连接`,
			);
			this.emitEngineError(`[${roomId}] 获取个人信息失败 code=${mySelfInfo.code}`);
			return false;
		}
		if (aborted()) return false;

		const listener = startListen(roomIdNum, handler, {
			ws: { headers: { Cookie: cookiesStr }, uid: mySelfInfo.data.mid },
		});
		if (aborted()) {
			listener.close();
			return false;
		}
		this.listenerRecord[roomId] = listener;
		this.logger.info(`[conn] 直播间 [${roomId}] 连接已建立`);
		this.logSideEffectState(`listener:created room=${roomId}`);
		return true;
	}

	/** Fetch live-room info; on failure, notifies admin + tears down this room. */
	async getLiveRoomInfo(roomId: string): Promise<LiveRoomInfo["data"] | undefined> {
		try {
			const content = await this.api.getLiveRoomInfo(roomId);
			return content.data;
		} catch (e) {
			// Q3 carve-out:catch 内『已停止该房间监测』—— 非自愈、需最终介入,留 error。
			this.logger.error(`[conn] 获取直播间信息失败：${(e as Error).message}`);
			await this.push.sendPrivateMsg(
				`获取直播间 [${roomId}] 信息失败：${(e as Error).message}，已停止该房间监测`,
			);
			this.stopMonitoring("获取直播间信息失败", roomId);
			return undefined;
		}
	}

	/**
	 * Fetch + project a `MasterInfo` snapshot. Carries forward `liveOpenFollowerNum`
	 * across mid-session refreshes so that the live-end card reports an accurate
	 * follower delta.
	 */
	async getMasterInfo(
		uid: string,
		previous: MasterInfo | undefined,
		liveType: LiveType,
	): Promise<MasterInfo> {
		const res = (await this.api.getMasterInfo(uid)) as MasterInfoData;
		const data = res.data;
		let liveOpenFollowerNum: number;
		let liveEndFollowerNum: number;
		let liveFollowerChange: number;
		if (liveType === LiveType.StartBroadcasting || liveType === LiveType.FirstLiveBroadcast) {
			liveOpenFollowerNum = data.follower_num;
			liveEndFollowerNum = data.follower_num;
			liveFollowerChange = 0;
		} else {
			liveOpenFollowerNum = previous?.liveOpenFollowerNum ?? data.follower_num;
			liveEndFollowerNum = data.follower_num;
			liveFollowerChange = liveEndFollowerNum - liveOpenFollowerNum;
		}
		return {
			username: data.info.uname,
			userface: data.info.face,
			roomId: data.room_id,
			liveOpenFollowerNum,
			liveEndFollowerNum,
			liveFollowerChange,
			medalName: data.medal_name,
		};
	}

	/** Fire-and-forget push wrapper; logs + drops any rejection. */
	safeBroadcast(uid: string, content: unknown, type: LivePushType): void {
		this.push.broadcastToTargets(uid, content, type).catch((e) => {
			this.logger.error(`[push] 推送失败 uid=${uid} type=${type}：${(e as Error).message}`);
		});
	}

	/**
	 * Push a "live start / live ongoing / live end" notification card. Generates
	 * an image via {@link ImageRenderer.generateLiveCard} when available; falls
	 * back to plain text on failure.
	 *
	 * 消息版式(`messageLayout`)覆盖开播 / 直播中 / 下播三类(调用方按各自 liveType
	 * 传参,未传即走旧路径不受影响):卡片 / 文本(各自模板,调用方已按 omitLink 剥掉
	 * {link})/ 链接(roomLink)按块序装配,分条符切多条经 `broadcastSequenceToTargets`。
	 * SC / 上舰不经此方法,始终维持现状。
	 */
	async sendLiveNotifyCard(params: {
		liveType: LiveType;
		liveData: LiveData;
		liveRoomInfo: LiveRoomInfo["data"];
		master: MasterInfo;
		cardStyle: SubItemView["customCardStyle"];
		cardLayout?: SubItemView["cardLayout"];
		uid: string;
		notifyMsg: string;
		messageLayout?: MessageKindLayout;
		roomLink?: string;
	}): Promise<void> {
		const { liveType, liveData, liveRoomInfo, master, cardStyle, cardLayout, uid, notifyMsg } =
			params;
		const layout = params.messageLayout;
		// 版式里 card 块隐藏 → 连图片渲染都跳过(白渲染更亏)。
		const wantCard = !layout || layout.blocks.some((b) => b.visible && b.type === "card");

		let buffer: Buffer | undefined;
		if (this.imageRenderer?.generateLiveCard && wantCard) {
			try {
				buffer = await this.imageRenderer.generateLiveCard(
					liveRoomInfo,
					master.username,
					master.userface,
					liveData,
					liveType,
					cardStyle?.enable ? cardStyle : undefined,
					cardLayout?.live,
				);
			} catch (e) {
				this.logger.error(`[image] 生成直播图片失败：${(e as Error).message}，降级为文字推送`);
			}
		}
		if (this.isDisposed()) return;

		const pushType =
			liveType === LiveType.StartBroadcasting
				? LivePushType.StartBroadcasting
				: liveType === LiveType.StopBroadcast
					? LivePushType.LiveEnd
					: LivePushType.Live;

		if (layout) {
			await this.broadcastWithMessageLayout({
				layout,
				buffer,
				notifyMsg,
				uid,
				pushType,
				roomLink: params.roomLink ?? "",
			});
			return;
		}

		if (!buffer) {
			this.logger.debug(`[push] [${master.username}] 无图片，降级为文字推送`);
			const fallbackMsg = this.contentBuilder.message([
				this.contentBuilder.text(notifyMsg || `直播通知 - ${master.username}`),
			]);
			await this.push.broadcastToTargets(uid, fallbackMsg, pushType);
			return;
		}
		const msg = this.contentBuilder.message([
			this.contentBuilder.image(buffer, "image/jpeg"),
			this.contentBuilder.text(notifyMsg || ""),
		]);
		await this.push.broadcastToTargets(uid, msg, pushType);
	}

	/**
	 * 版式路径的装配与投递:按块序分组(分条符切组),同条内相邻文本类部件以
	 * separator 连接;多条走 `broadcastSequenceToTargets`,adapter 未实现时合并
	 * 回一条兜底(逐条 broadcast 会让 @全体 每条重复)。
	 */
	private async broadcastWithMessageLayout(args: {
		layout: MessageKindLayout;
		buffer: Buffer | undefined;
		notifyMsg: string;
		roomLink: string;
		uid: string;
		pushType: LivePushType;
	}): Promise<void> {
		const { layout, buffer, notifyMsg, roomLink, uid, pushType } = args;
		const text = layout.blocks.some((b) => b.visible && b.type === "text") ? notifyMsg : "";
		const present = new Set<string>();
		if (buffer) present.add("card");
		if (text) present.add("text");
		if (roomLink) present.add("link");
		const groups = planMessageGroups(layout.blocks, present);
		const buildContent = (group: readonly string[]): unknown => {
			const segs: unknown[] = [];
			let texts: string[] = [];
			const flushText = (): void => {
				if (texts.length > 0) {
					segs.push(this.contentBuilder.text(texts.join(layout.separator)));
					texts = [];
				}
			};
			for (const part of group) {
				if (part === "card" && buffer) {
					flushText();
					segs.push(this.contentBuilder.image(buffer, "image/jpeg"));
				} else if (part === "text") {
					texts.push(text);
				} else if (part === "link") {
					texts.push(roomLink);
				}
			}
			flushText();
			return this.contentBuilder.message(segs);
		};
		if (groups.length === 0) {
			this.logger.debug(`[push] uid=${uid} 消息版式所有部件隐藏/缺失,本次开播不推送`);
			return;
		}
		if (groups.length === 1) {
			await this.push.broadcastToTargets(uid, buildContent(groups[0] ?? []), pushType);
			return;
		}
		if (this.push.broadcastSequenceToTargets) {
			await this.push.broadcastSequenceToTargets(uid, groups.map(buildContent), pushType);
			return;
		}
		this.logger.warn("[push] adapter 未实现 broadcastSequenceToTargets,分条已合并为单条");
		await this.push.broadcastToTargets(uid, buildContent(groups.flat()), pushType);
	}

	/** Format `dateString` (yyyy-MM-dd HH:mm:ss UTC+8) as elapsed-time text. */
	async getTimeDifference(dateString: string): Promise<string> {
		if (this.imageRenderer?.getTimeDifference) {
			return this.imageRenderer.getTimeDifference(dateString);
		}
		const start = DateTime.fromFormat(dateString, "yyyy-MM-dd HH:mm:ss");
		const now = DateTime.now();
		const diff = now.diff(start, ["hours", "minutes"]);
		const hours = Math.floor(diff.hours);
		const minutes = Math.floor(diff.minutes % 60);
		return hours > 0 ? `${hours}小时${minutes}分钟` : `${minutes}分钟`;
	}
}
