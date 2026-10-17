import type { CardSkinChoice } from "@bilibili-notify/image";
import { isBlockVisible, type MessageKindLayout } from "@bilibili-notify/internal";
import { segmentsToContent } from "../../../live/content-builder";
import {
	type LiveNotifyPushType,
	type LiveNotifySend,
	pushLiveNotify,
} from "../../../live/live-notify";
import { LivePushType } from "../../../live/live-types";
import {
	type LiveRoomResponse,
	type MasterInfoData,
	type MyselfResponse,
	RiskControlError,
} from "../../api/index.js";
import { fetchLiveCover } from "../../images";
import { PROBLEM_TEXTS } from "../../problem-texts";
import { liveCardInputFromRoomInfo } from "../live-card-input";
import { connectLiveRoom, type DanmakuHost } from "../protocol/client.js";
import type { LiveEvent } from "../protocol/events.js";
import type { LivePushAnchor } from "../push-like";
import { type LiveData, LiveType, type MasterInfo } from "../types";
import { RoomContextBase } from "./room-context";

type LiveRoomDanmakuResponse = {
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

/**
 * 预检 getDanmuInfo 被 -352 风控拦截。瞬时风控不是永久拒绝:调用方应走**长尾**
 * 退避重试预检(分钟级,不放弃房间),而不是消耗 WS 错误那条秒级重连梯子。
 *
 * 旧路径(blive 库时代)是「回退直连,让库用自己的指纹再试」;自实现后 HTTP 只有
 * 我们这一套指纹,没 token 连不上,回退直连已无意义。
 */
export class LiveRoomPreflightBlockedError extends Error {
	constructor(readonly reason: string) {
		super(`弹幕连接预检被风控拦截：${reason}`);
		this.name = "LiveRoomPreflightBlockedError";
	}
}

export function describeLiveRoomDanmakuPreflightFallback(
	info: LiveRoomDanmakuResponse,
): string | undefined {
	const message = info.message || info.msg;
	const messageSuffix = message ? ` message=${message}` : "";
	// -352 是 B 站常见风控/校验拦截码。它说明这次 HTTP 预检不可信,不等价于房间
	// 永久不可访问;旧的直接 WS 建连路径可能仍然可用,所以只能降级回退,不能硬停。
	if (info.code === -352) return `B 站返回 code=${info.code}${messageSuffix}`;
	return undefined;
}

export function describeLiveRoomDanmakuAccessDenied(
	info: LiveRoomDanmakuResponse,
): string | undefined {
	if (describeLiveRoomDanmakuPreflightFallback(info)) return undefined;
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
 * Extends {@link RoomContextBase} with the data-fetch / card-render
 * helpers — every call here either hits the Bilibili HTTP API or
 * the optional `ImageRenderer`. Keeping them on a separate class keeps the
 * base file focused on state / lifecycle while preserving the inheritance
 * chain so {@link RoomSession} sees a single `ctx.foo()` API surface.
 */
export class RoomContext extends RoomContextBase {
	/**
	 * Per-room 建连轮次计数,用于 host_list 轮转:首个 host 从用户网络不可达时,
	 * 重连换下一个 host 而不是永远钉死首项烧光梯子。**特意不在 closeListener 清**
	 * —— 重连循环每轮顶部都会 close,清了就等于永远连同一个 host。
	 */
	private readonly hostRotation = new Map<string, number>();

	/**
	 * Bring up the WebSocket listener for `roomId`.
	 *
	 * L4: returns `true` iff there is an active listener for the room *after*
	 * this call — either freshly created OR already present (the latter lets a
	 * reconnect that races with a backoff-window restore treat the room as
	 * recovered). 可重试的 setup 失败返回 `false`;B 站明确拒绝弹幕连接时抛
	 * {@link LiveRoomAccessDeniedError},让调用方停止监测,不要把受限房当瞬时抖动重连;
	 * 预检被 -352 风控拦截时抛 {@link LiveRoomPreflightBlockedError},调用方走长尾
	 * 退避重试预检(每次重试都会重新拿 token,顺带修掉旧库复用过期 token 的暗雷)。
	 */
	async startLiveRoomListener(
		roomId: string,
		onEvent: (ev: LiveEvent) => void,
		shouldAbort?: () => boolean,
	): Promise<boolean> {
		// ②6:per-session 取消探针。此方法只认 engine 级 isDisposed(),感知不到
		// 单房间被 stopForUid 取消;fetchMyselfInfo 这段 await 期间若 session 被取消,
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

		let danmakuInfo: LiveRoomDanmakuResponse;
		try {
			danmakuInfo = await this.api.fetchLiveRoomInfoStreamKey(roomId);
		} catch (e) {
			// 持续 -352 经 wbiGet 以 RiskControlError **异常**到达(它绝不把 -352 body
			// 返回给调用方)—— 必须映射成预检拦截交给长尾退避;吞成 return false 会让
			// 「-352 永不放弃」整条不可达,房间被当普通失败在秒级梯子内放弃。
			if (e instanceof RiskControlError) {
				throw new LiveRoomPreflightBlockedError(e.message);
			}
			const message = e instanceof Error ? e.message : String(e);
			this.logger.warn(`[conn] 获取弹幕连接信息异常，房间 [${roomId}]：${message}`);
			return false;
		}
		const fallbackReason = describeLiveRoomDanmakuPreflightFallback(danmakuInfo);
		if (fallbackReason) {
			throw new LiveRoomPreflightBlockedError(fallbackReason);
		}
		const deniedReason = describeLiveRoomDanmakuAccessDenied(danmakuInfo);
		if (deniedReason) {
			throw new LiveRoomAccessDeniedError(deniedReason);
		}
		// describeLiveRoomDanmakuAccessDenied 已保证 token / host_list 非空
		const token = this.readDanmakuToken(danmakuInfo);
		const hostList = this.readDanmakuHosts(danmakuInfo);
		if (!token || hostList.length === 0) {
			this.logger.warn(`[conn] 直播间 [${roomId}] 弹幕连接信息不完整,视为本轮失败`);
			return false;
		}
		if (aborted()) return false;

		let mySelfInfo: MyselfResponse;
		try {
			// ④ 走客户端共享的账号身份缓存(短 TTL + 在途合流):多房间同时重连时
			// 「自己的信息」只落一次请求;换号/登出由 Api 精准 invalidate。
			mySelfInfo = await this.api.getMyselfInfoCached();
		} catch (e) {
			const message = (e as Error).message ?? String(e);
			this.logger.warn(`[conn] 获取个人信息异常，房间 [${roomId}]：${message}`);
			// 只记日志:后果(建连没建起来 / 重连用尽)由随后那条「停止监听」去报,单独报一条没人会清。
			return false;
		}
		if (mySelfInfo.code !== 0 || !mySelfInfo.data) {
			this.logger.warn(
				`[conn] 获取个人信息失败 code=${mySelfInfo.code}，无法创建直播间 [${roomId}] 连接`,
			);
			return false;
		}
		// 真 buvid3(设备指纹)进认证包;cookie 罐里那条是占位假值。失败返回空串,
		// 认证包缺 buvid 仍可尝试。
		const buvid = await this.api.getBuvid3();
		if (aborted()) return false;

		// host_list 轮转:client 是哑管道恒取首项,这里按建连轮次旋转列表次序。
		const attempt = this.hostRotation.get(roomId) ?? 0;
		this.hostRotation.set(roomId, attempt + 1);
		const offset = attempt % hostList.length;
		const rotatedHosts = [...hostList.slice(offset), ...hostList.slice(0, offset)];

		const listener = connectLiveRoom({
			// sub.roomId 来自主播信息解析,已是真实长房号(短号在这里连预检都过不了)
			roomId: roomIdNum,
			uid: mySelfInfo.data.mid,
			token,
			buvid,
			hostList: rotatedHosts,
			// 握手头(身份、cookie)归 api 背后的客户端装配,这里只递建连的口
			createSocket: (socketUrl) => this.api.openDanmakuSocket(socketUrl),
			onEvent,
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

	private readDanmakuToken(info: LiveRoomDanmakuResponse): string {
		const token = info.data?.token;
		return typeof token === "string" ? token.trim() : "";
	}

	private readDanmakuHosts(info: LiveRoomDanmakuResponse): DanmakuHost[] {
		const raw = Array.isArray(info.data?.host_list) ? info.data.host_list : [];
		const hosts: DanmakuHost[] = [];
		for (const entry of raw) {
			const h = entry as { host?: unknown; wss_port?: unknown };
			if (typeof h.host === "string" && h.host && typeof h.wss_port === "number") {
				hosts.push({ host: h.host, wssPort: h.wss_port });
			}
		}
		return hosts;
	}

	/**
	 * Fetch live-room info; on failure, reports "这个房间不监听了" to the problem table + tears down this room.
	 * `uid` 是这个房间的主人,问题挂在他的订阅名下。`shouldReport`:失败回来时问一声「还该不该报」
	 * (调用它的会话已被停掉就不该报:迟到的失败会在表里留下谁也清不掉的条目);不给就照报。
	 */
	async getLiveRoomInfo(
		roomId: string,
		uid: string,
		shouldReport?: () => boolean,
	): Promise<LiveRoomResponse["data"] | undefined> {
		try {
			const content = await this.api.fetchLiveRoomInfo(roomId);
			return content.data;
		} catch (e) {
			// Q3 carve-out:catch 内『已停止该房间监测』—— 非自愈、需最终介入,留 error。
			this.logger.error(`[conn] 获取直播间信息失败：${(e as Error).message}`);
			if (shouldReport?.() !== false) {
				this.reportMonitorStopped(uid, roomId, PROBLEM_TEXTS.liveStopReasons.roomInfo);
			}
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
		this.push.push({ uid, type, anchors: [{ role: "main", messages: [content] }] }).catch((e) => {
			this.logger.error(`[push] 推送失败 uid=${uid} type=${type}：${(e as Error).message}`);
		});
	}

	/**
	 * 推一张「开播 / 直播中 / 下播」卡 —— **B 站那头的适配**:房间接口数据经
	 * `liveCardInputFromRoomInfo` 翻成中立的直播卡输入,「按 uid 推」绑成发送({@link sendToUid}),
	 * 再交给中立的直播装配 {@link pushLiveNotify}(出卡 → 按版式分组 → 发送;出卡失败降级
	 * 为文字)。拓展订阅的直播走同一个装配,只是输入与发送换成它自己的(ADR-0019 决策 67)。
	 *
	 * 消息版式(`messageLayout`)覆盖开播 / 直播中 / 下播三类(调用方按各自 liveType 传参):
	 * 卡片 / 文本(各自模板,模板里没有链接变量)/ 链接(roomLink)按块序装配,分条符切出的多条是
	 * 本体那个锚点里的一串。SC / 上舰不经此方法。
	 *
	 * 这张卡是这次推送的本体;`extras`(下播的词云、总结)是排在它后面的锚点,同一次交给推送层。
	 * 版式把部件全藏了、本体不发时,附加项照样交出去。
	 *
	 * 皮肤两格来自 `CardSkinChoice`(ADR-0014):`cardSkin` 这张卡用哪套皮肤,undefined = 内置默认;
	 * `cardSkinKnobs` 这位 UP 那层旋钮覆盖(按皮肤 id 分,决策 17 的 🔗),undefined = 全跟全局。
	 */
	async sendLiveNotifyCard(
		params: CardSkinChoice & {
			liveType: LiveType;
			/**
			 * 推送类型。缺省按 `liveType` 推出({@link livePushTypeOf});重启补报画的是「直播中」那张卡
			 * (`LiveType.LiveBroadcast`)、却不是周期那一档,所以由调用方显式给 `LivePushType.CatchUp`。
			 */
			pushType?: LiveNotifyPushType;
			liveData: LiveData;
			liveRoomInfo: LiveRoomResponse["data"];
			master: MasterInfo;
			/** 这一张卡的自定义封面(资产 id,已轮好);不给 = 卡吃来源自己的封面。 */
			liveCover?: string;
			/** 订阅 id:出卡那一刻按它现读订阅资料里的主播头像(`avatarOf`),没有就不画。 */
			subscriptionId: string;
			uid: string;
			notifyMsg: string;
			messageLayout: MessageKindLayout;
			roomLink?: string;
			/** 排在这张卡后面的附加项锚点(下播卡带词云、总结);内容可以是还在做的约定。 */
			extras?: LivePushAnchor[];
		},
	): Promise<void> {
		const { liveType, liveData, liveRoomInfo, master, uid } = params;
		const extras = params.extras ?? [];
		// 附加项的约定先接住一次:下面出卡要好几个 await,万一没走到交给推送层那一步,
		// 做不出来的内容也不会变成没人处理的拒绝。推送层照样看得见它被拒绝(那边记警告)。
		for (const anchor of extras) {
			void Promise.resolve(anchor.messages).catch(() => {});
			void Promise.resolve(anchor.aiMessages).catch(() => {});
		}
		const pushType = params.pushType ?? livePushTypeOf(liveType);
		let input = liveCardInputFromRoomInfo(
			liveRoomInfo,
			master.username,
			liveData,
			liveType,
			this.avatarOf(params.subscriptionId),
		);
		// 封面在**确定要出卡时**才抓进图库(3a-34):出卡条件与 `pushLiveNotify` 同一份(有渲染器、版式里卡片块可见)。
		if (this.imageRenderer && isBlockVisible(params.messageLayout, "card")) {
			input = await fetchLiveCover(input, { images: this.imageFetcher, logger: this.logger });
		}
		let mainSent = false;
		await pushLiveNotify(
			{
				input,
				text: params.notifyMsg,
				link: params.roomLink ?? "",
				layout: params.messageLayout,
				// 没有自定义封面就不带这一格(`pushLiveNotify` 缺省 = 吃来源自己的封面)。
				...(params.liveCover === undefined ? {} : { liveCover: params.liveCover }),
				cardSkin: params.cardSkin,
				cardSkinKnobs: params.cardSkinKnobs,
				pushType,
				label: `uid=${uid}`,
			},
			{
				renderer: this.imageRenderer,
				send: (groups, type) => {
					mainSent = true;
					return this.sendToUid(uid, extras)(groups, type);
				},
				logger: this.logger,
			},
		);
		// 版式把部件全藏了、本体没发:附加项照交(开关、静音与免扰就在交出去的这一刻判)。
		if (!mainSent && extras.length > 0 && !this.isDisposed()) {
			await this.push.push({ uid, type: pushType, anchors: extras });
		}
	}

	/**
	 * 绑到这位 UP 上的发送:中立的段包成 contentBuilder 的形状,按版式分好的几条消息是本体那个
	 * 锚点里的一串;`extras` 是同一次推送里排在本体后面的锚点。
	 */
	private sendToUid(uid: string, extras: LivePushAnchor[]): LiveNotifySend {
		return async (groups, type) => {
			// 出卡要好几秒:这期间引擎被拆了,就不再往外推。
			if (this.isDisposed()) return;
			await this.push.push({
				uid,
				type,
				anchors: [
					{
						role: "main",
						messages: groups.map((segs) => segmentsToContent(this.contentBuilder, segs)),
					},
					...extras,
				],
			});
		};
	}
}

/**
 * B 站引擎的 `LiveType` → 直播卡的推送类型。只有真开播是 `StartBroadcasting`(唯一允许
 * @全体的那一档),下播是 `LiveEnd`,其余(周期「正在直播」)一律 `Live`。重启补报同样画
 * 「直播中」的卡,但它的类型 `CatchUp` 不由 `LiveType` 推出,调用方显式传(见 `sendLiveNotifyCard`)。
 */
function livePushTypeOf(liveType: LiveType): LiveNotifyPushType {
	if (liveType === LiveType.StartBroadcasting) return LivePushType.StartBroadcasting;
	if (liveType === LiveType.StopBroadcast) return LivePushType.LiveEnd;
	return LivePushType.Live;
}
