import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveRoomInfo, MasterInfoData, MySelfInfoData } from "@bilibili-notify/api";
import { type MsgHandler, startListen } from "blive-message-listener";
import { DateTime } from "luxon";
import protobuf from "protobufjs";
import { LivePushType, type SubItemView } from "./push-like";
import { RoomContextBase } from "./room-context";
import { type LiveData, LiveType, type MasterInfo } from "./types";

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
	 * recovered). Returns `false` on every failure mode so the reconnect caller
	 * only resets its backoff on a real success instead of the old
	 * void-swallow that recorded "reconnected" with no listener attached.
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

		const cookiesStr = this.api.getCookiesHeader();
		let mySelfInfo: MySelfInfoData;
		try {
			mySelfInfo = await this.api.getMyselfInfo();
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
	 */
	async sendLiveNotifyCard(params: {
		liveType: LiveType;
		liveData: LiveData;
		liveRoomInfo: LiveRoomInfo["data"];
		master: MasterInfo;
		cardStyle: SubItemView["customCardStyle"];
		uid: string;
		notifyMsg: string;
	}): Promise<void> {
		const { liveType, liveData, liveRoomInfo, master, cardStyle, uid, notifyMsg } = params;

		let buffer: Buffer | undefined;
		if (this.imageRenderer?.generateLiveCard) {
			try {
				buffer = await this.imageRenderer.generateLiveCard(
					liveRoomInfo,
					master.username,
					master.userface,
					liveData,
					liveType,
					cardStyle?.enable ? cardStyle : undefined,
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

	/**
	 * Decode a base64-encoded INTERACT_WORD_V2 protobuf payload.
	 *
	 * P0-4: 此前用 `resolve(__dirname, "./proto/interact_word.proto")` —— (a) 该
	 * .proto 文件从未随包提交、tsdown 也不拷进 lib;(b) ESM(.mjs)产物里裸
	 * `__dirname` 为 undefined。两者叠加导致每个 INTERACT_WORD_V2 帧必抛,
	 * "特别关注用户进房"特性在双端构建里全死。
	 *
	 * 现:`__dirname` 改 `import.meta.url`(与 routes/health.ts 同款,tsdown
	 * cjs/esm 双产物都正确);proto 缺失/损坏时**优雅降级**——只在首次告警一
	 * 次并置 `interactWordUnavailable`,后续帧直接返回 `{}`(调用方
	 * onInteractWordV2 对空对象天然 no-op:`msgType==="1"` 为 false,零误推),
	 * 不再每帧崩/刷屏。
	 *
	 * 注:让该特性真正可用仍需在 `src/proto/interact_word.proto` 放入**经核实
	 * 的**权威 schema(`bilibili.live.xuserreward.v1.InteractWord`)并在打包时
	 * 拷进 `lib/proto/`——字段号必须来自可信源,不可臆造,故作为独立后续任务。
	 */
	async decodeBase64PB(base64: string): Promise<Record<string, unknown>> {
		if (this.interactWordUnavailable) return {};
		if (!this.interactWord) {
			try {
				const here = dirname(fileURLToPath(import.meta.url));
				const protoPath = resolve(here, "./proto/interact_word.proto");
				const root = await protobuf.load(protoPath);
				this.interactWord = root.lookupType("bilibili.live.xuserreward.v1.InteractWord");
			} catch (e) {
				this.interactWordUnavailable = true;
				this.logger.warn(
					`[live] INTERACT_WORD_V2 解码不可用,"特别关注用户进房"已禁用:缺少或无法加载 proto/interact_word.proto (${(e as Error).message})`,
				);
				return {};
			}
		}
		try {
			const buffer = Uint8Array.from(Buffer.from(base64, "base64"));
			const message = this.interactWord.decode(buffer);
			return this.interactWord.toObject(message, {
				longs: String,
				enums: String,
				defaults: true,
			}) as Record<string, unknown>;
		} catch (e) {
			this.logger.warn(
				`[live] INTERACT_WORD_V2 protobuf 解码失败,跳过该帧: ${(e as Error).message}`,
			);
			return {};
		}
	}
}
