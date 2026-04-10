import { resolve } from "node:path";
import type {
	BilibiliAPI,
	LiveRoomInfo,
	MasterInfoData,
	MySelfInfoData,
} from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type { BilibiliPush, SubItem, Subscriptions } from "@bilibili-notify/push";
import { PushType } from "@bilibili-notify/push";
import {
	GuardLevel,
	type MessageListener,
	type MsgHandler,
	startListen,
} from "blive-message-listener";
import { cut as jiebaCut } from "jieba-wasm";
import { type Awaitable, type Context, h, Logger, Service } from "koishi";
// biome-ignore lint/correctness/noUnusedImports: loads bilibili-notify Context augmentation
import {} from "koishi-plugin-bilibili-notify";
import { DateTime } from "luxon";
import protobuf from "protobufjs";
import type { BilibiliNotifyLiveConfig } from "./config";
import definedStopWords from "./stop-words";
import { type LiveData, type LivePushTimerManager, LiveType, type MasterInfo } from "./types";

declare module "koishi" {
	interface Context {
		"bilibili-notify-live": BilibiliNotifyLive;
	}
	interface Events {
		"bilibili-notify/subscription-changed"(subs: Subscriptions): void;
		"bilibili-notify/plugin-error"(source: string, message: string): void;
	}
}

const SERVICE_NAME = "bilibili-notify-live";

// Guard level images
const GUARD_LEVEL_IMG: Record<GuardLevel, string> = {
	[GuardLevel.None]: "",
	[GuardLevel.Jianzhang]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
	[GuardLevel.Tidu]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	[GuardLevel.Zongdu]:
		"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
};

export class BilibiliNotifyLive extends Service<BilibiliNotifyLiveConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static readonly inject = ["bilibili-notify"];

	private readonly liveLogger: Logger;
	private api!: BilibiliAPI;
	private push!: BilibiliPush;
	private stopwords: Set<string> = new Set();
	private listenerRecord: Record<string, MessageListener> = {};
	private livePushTimerManager: LivePushTimerManager = new Map();
	private disposed = false;
	private readonly instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	constructor(ctx: Context, config: BilibiliNotifyLiveConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		this.liveLogger = new Logger(SERVICE_NAME);
		this.liveLogger.level = config.logLevel;
		this.mergeStopWords(config.wordcloudStopWords ?? "");
	}

	protected start(): Awaitable<void> {
		const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
		if (!internals) throw new Error("无法获取 bilibili-notify 内部实例，请确认核心插件已启动");
		this.api = internals.api;
		this.push = internals.push;

		this.disposed = false;
		this.livePushTimerManager = new Map();
		this.listenerRecord = {};

		// If subscriptions were already loaded before this plugin started, start immediately
		if (internals.subs) {
			this.startLiveMonitors(internals.subs);
		}
		this.logSideEffectState("start");
		// Listen for future subscription changes from core
		this.ctx.on("bilibili-notify/subscription-changed", (subs: Subscriptions) => {
			this.startLiveMonitors(subs);
		});
	}

	protected stop(): Awaitable<void> {
		this.logSideEffectState("stop:before-clear");
		this.disposed = true;
		this.clearPushTimers();
		this.clearListeners();
		this.logSideEffectState("stop:after-clear");
	}

	private isDisposed(): boolean {
		return this.disposed;
	}

	private getListenerCount(): number {
		return Object.keys(this.listenerRecord).length;
	}

	private logSideEffectState(stage: string): void {
		if (this.liveLogger.level < 3) return;
		this.liveLogger.debug(
			`[live:${this.instanceId}] ${stage} listeners=${this.getListenerCount()} timers=${this.livePushTimerManager?.size ?? 0} disposed=${this.disposed}`,
		);
	}

	/** Replace all template variables in one pass to avoid chained replacement issues */
	private applyTemplate(template: string, vars: Record<string, string>): string {
		let result = template;
		for (const [key, value] of Object.entries(vars)) {
			result = result.replaceAll(key, value);
		}
		return result.replaceAll("\\n", "\n");
	}

	private mergeStopWords(stopWordsStr: string): void {
		if (!stopWordsStr || stopWordsStr.trim() === "") {
			this.stopwords = new Set(definedStopWords);
			return;
		}
		const additionalStopWords = stopWordsStr
			.split(",")
			.map((word) => word.trim())
			.filter((word) => word !== "");
		this.stopwords = new Set([...definedStopWords, ...additionalStopWords]);
	}

	startLiveMonitors(subs: Subscriptions): void {
		this.clearPushTimers();
		this.clearListeners();

		for (const sub of Object.values(subs)) {
			if (sub.live) {
				this.liveDetectWithListener(sub).catch((e) => {
					this.liveLogger.error(`启动直播监听失败 UID=${sub.uid}：${e}`);
				});
			}
		}
	}

	private async startLiveRoomListener(roomId: string, handler: MsgHandler): Promise<void> {
		if (this.isDisposed()) return;
		if (this.listenerRecord[roomId]) {
			this.liveLogger.warn(`直播间 [${roomId}] 连接已存在，跳过创建`);
			return;
		}

		const cookiesStr = this.api.getCookiesHeader();
		let mySelfInfo: MySelfInfoData | undefined;
		for (let attempt = 1; attempt <= 3; attempt++) {
			mySelfInfo = await this.api.getMyselfInfo();
			if (mySelfInfo.code === 0 && mySelfInfo.data) break;
			this.liveLogger.warn(
				`获取个人信息失败（第 ${attempt}/3 次），直播间 [${roomId}]，code=${mySelfInfo.code}`,
			);
		}

		if (!mySelfInfo || mySelfInfo.code !== 0 || !mySelfInfo.data) {
			this.liveLogger.error(`获取个人信息连续失败，无法创建直播间 [${roomId}] 连接`);
			return;
		}

		if (this.isDisposed()) return;

		const listener = startListen(Number.parseInt(roomId, 10), handler, {
			ws: {
				headers: { Cookie: cookiesStr },
				uid: mySelfInfo.data.mid,
			},
		});

		if (this.isDisposed()) {
			listener.close();
			return;
		}

		this.listenerRecord[roomId] = listener;
		this.liveLogger.info(`直播间 [${roomId}] 连接已建立`);
		this.logSideEffectState(`listener:created room=${roomId}`);
	}

	private closeListener(roomId: string): void {
		const listener = this.listenerRecord[roomId];
		if (!listener) {
			this.liveLogger.debug(`直播间 [${roomId}] 连接不存在，跳过关闭`);
			return;
		}
		if (listener.live.closed) {
			this.liveLogger.debug(`直播间 [${roomId}] 连接已被远端断开`);
			delete this.listenerRecord[roomId];
			return;
		}
		listener.close();
		delete this.listenerRecord[roomId];
		this.liveLogger.info(`直播间 [${roomId}] 连接已关闭`);
		this.logSideEffectState(`listener:closed room=${roomId}`);
	}

	clearListeners(): void {
		this.logSideEffectState("listeners:before-clear");
		for (const key of Object.keys(this.listenerRecord)) {
			this.closeListener(key);
			delete this.listenerRecord[key];
		}
		this.listenerRecord = {};
		this.logSideEffectState("listeners:after-clear");
	}

	clearPushTimers(): void {
		this.logSideEffectState("timers:before-clear");
		for (const [, timer] of this.livePushTimerManager) {
			timer?.();
		}
		this.livePushTimerManager.clear();
		this.logSideEffectState("timers:after-clear");
	}

	private stopMonitoring(reason: string): void {
		this.liveLogger.error(`${reason}，直播监测已停止`);
		this.clearListeners();
		this.clearPushTimers();
		this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, reason);
	}

	private async getLiveRoomInfo(roomId: string): Promise<LiveRoomInfo["data"] | undefined> {
		try {
			const content = await this.api.getLiveRoomInfo(roomId);
			return content.data;
		} catch (e) {
			this.liveLogger.error(`获取直播间信息失败：${(e as Error).message}`);
			await this.push.sendPrivateMsg(`获取直播间信息失败：${(e as Error).message}，直播监测已停止`);
			this.stopMonitoring("获取直播间信息失败");
			return undefined;
		}
	}

	private async getMasterInfo(
		uid: string,
		masterInfo: MasterInfo | undefined,
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
			liveOpenFollowerNum = masterInfo?.liveOpenFollowerNum ?? data.follower_num;
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

	private async sendLiveNotifyCard(params: {
		liveType: LiveType;
		liveData: LiveData;
		liveRoomInfo: LiveRoomInfo["data"];
		masterInfo: MasterInfo;
		cardStyle: SubItem["customCardStyle"];
		uid: string;
		notifyMsg: string;
	}): Promise<void> {
		const {
			liveType,
			liveData,
			liveRoomInfo,
			masterInfo,
			cardStyle,
			uid,
			notifyMsg: liveNotifyMsg,
		} = params;
		// biome-ignore lint/suspicious/noExplicitAny: optional image service
		const imageService = (this.ctx as any)["bilibili-notify-image"];

		// biome-ignore lint/suspicious/noExplicitAny: image buffer result
		let buffer: any;
		if (imageService?.generateLiveCard) {
			try {
				buffer = await imageService.generateLiveCard(
					liveRoomInfo,
					masterInfo.username,
					masterInfo.userface,
					liveData,
					liveType,
					cardStyle?.enable ? cardStyle : undefined,
				);
			} catch (e) {
				this.liveLogger.error(`生成直播图片失败：${(e as Error).message}，降级为文字推送`);
			}
		}

		if (this.isDisposed()) return;

		if (!buffer) {
			const fallbackMsg = h("message", [
				h.text(liveNotifyMsg || `直播通知 - ${masterInfo.username}`),
			]);

			await this.push.broadcastToTargets(
				uid,
				fallbackMsg,
				liveType === LiveType.StartBroadcasting ? PushType.StartBroadcasting : PushType.Live,
			);
			return;
		}

		const msg = h("message", [h.image(buffer, "image/jpeg"), h.text(liveNotifyMsg || "")]);
		await this.push.broadcastToTargets(
			uid,
			msg,
			liveType === LiveType.StartBroadcasting ? PushType.StartBroadcasting : PushType.Live,
		);
	}

	private segmentDanmaku(danmaku: string, danmakuWeightRecord: Record<string, number>): void {
		jiebaCut(danmaku, true)
			.filter((word: string) => word.length >= 2 && !this.stopwords.has(word))
			.forEach((w: string) => {
				danmakuWeightRecord[w] = (danmakuWeightRecord[w] || 0) + 1;
			});
	}

	private addUserToDanmakuMaker(
		username: string,
		danmakuMakerRecord: Record<string, number>,
	): void {
		danmakuMakerRecord[username] = (danmakuMakerRecord[username] || 0) + 1;
	}

	private interactWord?: protobuf.Type;

	private async decodeBase64PB(base64: string): Promise<Record<string, unknown>> {
		const buffer = Uint8Array.from(Buffer.from(base64, "base64"));

		if (!this.interactWord) {
			const protoPath = resolve(__dirname, "./proto/interact_word.proto");
			const root = await protobuf.load(protoPath);
			this.interactWord = root.lookupType("bilibili.live.xuserreward.v1.InteractWord");
		}

		const message = this.interactWord.decode(buffer);
		return this.interactWord.toObject(message, {
			longs: String,
			enums: String,
			defaults: true,
		}) as Record<string, unknown>;
	}

	private async generateWordCloud(
		sortedWords: [string, number][],
		masterName: string,
	): Promise<ReturnType<typeof h.image> | undefined> {
		if (sortedWords.length < 50) {
			this.liveLogger.debug("热词不足50个，放弃生成弹幕词云");
			return undefined;
		}
		// biome-ignore lint/suspicious/noExplicitAny: optional image service
		const imageService = (this.ctx as any)["bilibili-notify-image"];
		if (!imageService?.generateWordCloudImg) return undefined;
		try {
			const buf = await imageService.generateWordCloudImg(sortedWords.slice(0, 90), masterName);
			return h.image(buf, "image/jpeg");
		} catch (e) {
			this.liveLogger.error(`生成词云失败：${(e as Error).message}`);
			return undefined;
		}
	}

	private async generateLiveSummaryText(
		danmakuSenderRecord: Record<string, number>,
		sortedWords: [string, number][],
		masterInfo: MasterInfo | undefined,
		customLiveSummary: string,
	): Promise<string | undefined> {
		const senderCount = Object.keys(danmakuSenderRecord).length;
		if (senderCount < 5) {
			this.liveLogger.debug("发言人数不足5位，放弃生成直播总结");
			return undefined;
		}

		const danmakuCount = Object.values(danmakuSenderRecord).reduce((sum, val) => sum + val, 0);
		const top5Senders = Object.entries(danmakuSenderRecord)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);

		if (this.api.isAIEnabled()) {
			try {
				const top10Words = sortedWords.slice(0, 10).map(([word, count]) => `${word}(${count})`);
				const prompt = [
					"请生成直播总结",
					`弹幕发言人数：${senderCount}`,
					`粉丝牌名：${masterInfo?.medalName ?? ""}`,
					`弹幕总数：${danmakuCount}`,
					`热词TOP10：${top10Words.join("、")}`,
					`弹幕排行TOP5：${top5Senders.map(([u, c]) => `${u}(${c}条)`).join("、")}`,
				].join("，");
				const aiResult = await this.api.chatWithAI(prompt);
				this.liveLogger.debug("AI 直播总结生成完毕");
				return aiResult;
			} catch (e) {
				this.liveLogger.error(`AI 直播总结生成失败：${(e as Error).message}，回退到模板`);
			}
		}

		return this.applyTemplate(customLiveSummary, {
			"-dmc": `${senderCount}`,
			"-mdn": masterInfo?.medalName ?? "",
			"-dca": `${danmakuCount}`,
			"-un1": top5Senders[0][0],
			"-dc1": `${top5Senders[0][1]}`,
			"-un2": top5Senders[1][0],
			"-dc2": `${top5Senders[1][1]}`,
			"-un3": top5Senders[2][0],
			"-dc3": `${top5Senders[2][1]}`,
			"-un4": top5Senders[3][0],
			"-dc4": `${top5Senders[3][1]}`,
			"-un5": top5Senders[4][0],
			"-dc5": `${top5Senders[4][1]}`,
		});
	}

	private async getTimeDifference(dateString: string): Promise<string> {
		// biome-ignore lint/suspicious/noExplicitAny: optional image service
		const imageService = (this.ctx as any)["bilibili-notify-image"];
		if (imageService?.getTimeDifference) {
			return imageService.getTimeDifference(dateString);
		}
		// Fallback calculation
		const start = DateTime.fromFormat(dateString, "yyyy-MM-dd HH:mm:ss");
		const now = DateTime.now();
		const diff = now.diff(start, ["hours", "minutes"]);
		const hours = Math.floor(diff.hours);
		const minutes = Math.floor(diff.minutes % 60);
		return hours > 0 ? `${hours}小时${minutes}分钟` : `${minutes}分钟`;
	}

	async liveDetectWithListener(sub: SubItem): Promise<void> {
		let liveTime: string;
		let pushAtTimeTimer: (() => void) | null = null;
		const danmakuWeightRecord: Record<string, number> = {};
		const danmakuSenderRecord: Record<string, number> = {};
		let liveStatus = false;
		let liveRoomInfo: LiveRoomInfo["data"] | undefined;
		let masterInfo: MasterInfo | undefined;
		const liveData: LiveData = { likedNum: "0" };

		const sendDanmakuWordCloudAndLiveSummary = async (customLiveSummary: string) => {
			this.liveLogger.debug("开始制作弹幕词云");
			const sortedWords = Object.entries(danmakuWeightRecord).sort((a, b) => b[1] - a[1]);

			const [img, summary] = await Promise.all([
				this.generateWordCloud(sortedWords, masterInfo?.username ?? ""),
				this.generateLiveSummaryText(
					danmakuSenderRecord,
					sortedWords,
					masterInfo,
					customLiveSummary,
				),
			]);

			if (this.isDisposed()) return;

			const parts = [img, summary ? h.text(summary) : undefined].filter(Boolean);
			if (parts.length > 0) {
				await this.push.broadcastToTargets(
					sub.uid,
					h("message", parts),
					PushType.WordCloudAndLiveSummary,
				);
			}

			for (const key of Object.keys(danmakuWeightRecord)) delete danmakuWeightRecord[key];
			for (const key of Object.keys(danmakuSenderRecord)) delete danmakuSenderRecord[key];
		};

		const useLiveRoomInfo = async (liveType: LiveType): Promise<boolean> => {
			const data = await this.getLiveRoomInfo(sub.roomId);
			if (!data?.uid) return false;
			if (liveType === LiveType.StartBroadcasting || liveType === LiveType.FirstLiveBroadcast) {
				liveRoomInfo = data;
				return true;
			}
			// Preserve live_time on live/stop
			liveRoomInfo = { ...data, live_time: liveRoomInfo?.live_time ?? data.live_time };
			return true;
		};

		const useMasterInfo = async (liveType: LiveType): Promise<boolean> => {
			try {
				masterInfo = await this.getMasterInfo(
					liveRoomInfo?.uid.toString() ?? sub.uid,
					masterInfo,
					liveType,
				);
				return true;
			} catch {
				return false;
			}
		};

		const pushAtTimeFunc = async () => {
			if (!(await useLiveRoomInfo(LiveType.LiveBroadcast)) || !liveRoomInfo) {
				this.stopMonitoring("获取直播间信息失败，推送直播卡片失败");
				return;
			}
			if (liveRoomInfo.live_status === 0 || liveRoomInfo.live_status === 2) {
				liveStatus = false;
				pushAtTimeTimer?.();
				pushAtTimeTimer = null;
				await this.push.sendPrivateMsg(
					"直播间已下播，可能与直播间的连接断开，请使用 `bn restart` 重启插件",
				);
				return;
			}
			if (!(await useMasterInfo(LiveType.LiveBroadcast)) || !masterInfo) return;

			liveTime = liveRoomInfo.live_time;
			const watched = String(liveData.watchedNum ?? "暂未获取到");
			liveData.watchedNum = watched;
			const diffTime = await this.getTimeDifference(liveTime);
			const roomLink = `https://live.bilibili.com/${liveRoomInfo.short_id === 0 ? liveRoomInfo.room_id : liveRoomInfo.short_id}`;
			const liveMsg = this.applyTemplate(
				sub.customLiveMsg.customLive ??
					this.config.customLiveMsg.customLive ??
					"-name 正在直播，已播 -time，累计观看：-watched\n-link",
				{ "-name": masterInfo.username, "-time": diffTime, "-watched": watched, "-link": roomLink },
			);

			await this.sendLiveNotifyCard({
				liveType: LiveType.LiveBroadcast,
				liveData,
				liveRoomInfo,
				masterInfo,
				cardStyle: sub.customCardStyle,
				uid: sub.uid,
				notifyMsg: liveMsg,
			});
		};

		const LIVE_EVENT_COOLDOWN = 10 * 1000;
		let lastLiveStart = 0;
		let lastLiveEnd = 0;

		const handler: MsgHandler = {
			onError: async () => {
				liveStatus = false;
				pushAtTimeTimer?.();
				pushAtTimeTimer = null;
				this.closeListener(sub.roomId);
				if (this.isDisposed()) return;
				await this.push.sendPrivateMsg(`[${sub.roomId}] 直播间连接发生错误`);
				this.liveLogger.error(`[${sub.roomId}] 直播间连接发生错误`);
			},

			onIncomeDanmu: ({ body }) => {
				this.segmentDanmaku(body.content, danmakuWeightRecord);
				this.addUserToDanmakuMaker(body.user.uname, danmakuSenderRecord);
				if (
					sub.customSpecialDanmakuUsers.enable &&
					sub.customSpecialDanmakuUsers.specialDanmakuUsers?.includes(body.user.uid.toString())
				) {
					const msgTemplate = this.applyTemplate(sub.customSpecialDanmakuUsers.msgTemplate, {
						"-mastername": masterInfo?.username ?? "",
						"-uname": body.user.uname,
						"-msg": body.content,
					});
					const content = h("message", [h.text(msgTemplate)]);
					if (this.isDisposed()) return;
					this.push.broadcastToTargets(sub.uid, content, PushType.UserDanmakuMsg);
				}
			},

			onIncomeSuperChat: async ({ body }) => {
				this.segmentDanmaku(body.content, danmakuWeightRecord);
				this.addUserToDanmakuMaker(body.user.uname, danmakuSenderRecord);
				const data = await this.api.getUserInfoInLive(body.user.uid.toString(), sub.uid);
				if (data.code !== 0) {
					const content = h("message", [
						h.text(
							`【${masterInfo?.username ?? ""}的直播间】${body.user.uname}的SC:${body.content}（${body.price}元）`,
						),
					]);
					if (this.isDisposed()) return;
					await this.push.broadcastToTargets(sub.uid, content, PushType.Superchat);
					return;
				}
				// biome-ignore lint/suspicious/noExplicitAny: optional image service
				const imageService = (this.ctx as any)["bilibili-notify-image"];
				if (imageService?.generateSCCard) {
					try {
						const userInfo = data.data;
						const buf = await imageService.generateSCCard({
							senderFace: userInfo.face,
							senderName: userInfo.uname,
							masterName: masterInfo?.username ?? "",
							masterAvatarUrl: masterInfo?.userface ?? "",
							text: body.content,
							price: body.price,
						});
						if (this.isDisposed()) return;
						await this.push.broadcastToTargets(
							sub.uid,
							h.image(buf, "image/jpeg"),
							PushType.Superchat,
						);
						return;
					} catch (e) {
						this.liveLogger.error(`生成SC图片失败：${(e as Error).message}`);
					}
				}
				// Fallback text
				const content = h("message", [
					h.text(
						`【${masterInfo?.username ?? ""}的直播间】${data.data.uname}的SC:${body.content}（${body.price}元）`,
					),
				]);
				if (this.isDisposed()) return;
				await this.push.broadcastToTargets(sub.uid, content, PushType.Superchat);
			},

			onWatchedChange: ({ body }) => {
				liveData.watchedNum = body.text_small;
			},

			onLikedChange: ({ body }) => {
				liveData.likedNum = body.count;
			},

			onGuardBuy: async ({ body }) => {
				const guardImg = GUARD_LEVEL_IMG[body.guard_level];
				const effectiveGuardBuy = sub.customGuardBuy.enable
					? sub.customGuardBuy
					: this.config.customGuardBuy;
				if (effectiveGuardBuy.enable) {
					const customGuardImg: Record<GuardLevel, string | undefined> = {
						[GuardLevel.None]: undefined,
						[GuardLevel.Jianzhang]: effectiveGuardBuy.captainImgUrl,
						[GuardLevel.Tidu]: effectiveGuardBuy.supervisorImgUrl,
						[GuardLevel.Zongdu]: effectiveGuardBuy.governorImgUrl,
					};
					const msg = this.applyTemplate(effectiveGuardBuy.guardBuyMsg ?? "", {
						"-uname": body.user.uname,
						"-mname": masterInfo?.username ?? "",
						"-guard": body.gift_name,
					});
					if (this.isDisposed()) return;
					await this.push.broadcastToTargets(
						sub.uid,
						h("message", [h.image(customGuardImg[body.guard_level] ?? guardImg), h.text(msg)]),
						PushType.LiveGuardBuy,
					);
					return;
				}

				// biome-ignore lint/suspicious/noExplicitAny: optional image service
				const imageService = (this.ctx as any)["bilibili-notify-image"];
				if (imageService?.generateGuardCard) {
					const data = await this.api.getUserInfoInLive(body.user.uid.toString(), sub.uid);
					if (data.code === 0) {
						try {
							const buf = await imageService.generateGuardCard(
								{
									guardLevel: body.guard_level,
									uname: data.data.uname,
									face: data.data.face,
									isAdmin: data.data.is_admin,
								},
								{
									masterName: masterInfo?.username ?? "",
									masterAvatarUrl: masterInfo?.userface ?? "",
								},
							);
							if (this.isDisposed()) return;
							await this.push.broadcastToTargets(
								sub.uid,
								h.image(buf, "image/jpeg"),
								PushType.LiveGuardBuy,
							);
							return;
						} catch (e) {
							this.liveLogger.error(`生成上舰图片失败：${(e as Error).message}`);
						}
					}
				}

				// Fallback text
				if (this.isDisposed()) return;
				await this.push.broadcastToTargets(
					sub.uid,
					h("message", [
						h.image(guardImg),
						h.text(
							`【${masterInfo?.username ?? ""}的直播间】${body.user.uname}加入了大航海（${body.gift_name}）`,
						),
					]),
					PushType.LiveGuardBuy,
				);
			},

			onLiveStart: async () => {
				const now = Date.now();
				if (now - lastLiveStart < LIVE_EVENT_COOLDOWN) {
					this.liveLogger.warn(`[${sub.roomId}] 的开播事件在冷却期内，忽略`);
					return;
				}
				lastLiveStart = now;

				if (liveStatus) {
					this.liveLogger.warn(`[${sub.roomId}] 已经是开播状态，忽略重复的开播事件`);
					return;
				}
				liveStatus = true;

				if (
					!(await useLiveRoomInfo(LiveType.StartBroadcasting)) ||
					!(await useMasterInfo(LiveType.StartBroadcasting)) ||
					!liveRoomInfo ||
					!masterInfo
				) {
					liveStatus = false;
					if (this.isDisposed()) return;
					this.stopMonitoring("获取直播间信息失败，推送直播开播卡片失败");
					return;
				}

				this.liveLogger.info(
					`房间号：${masterInfo.roomId}，开播时的粉丝数：${masterInfo.liveOpenFollowerNum}`,
				);

				liveTime = liveRoomInfo.live_time || DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
				const diffTime = await this.getTimeDifference(liveTime);
				const followerNum =
					masterInfo.liveOpenFollowerNum >= 10_000
						? `${(masterInfo.liveOpenFollowerNum / 10000).toFixed(1)}万`
						: masterInfo.liveOpenFollowerNum.toString();
				liveData.fansNum = masterInfo.liveOpenFollowerNum;

				const roomLink = `https://live.bilibili.com/${liveRoomInfo.short_id === 0 ? liveRoomInfo.room_id : liveRoomInfo.short_id}`;
				const liveStartMsg = this.applyTemplate(
					sub.customLiveMsg.customLiveStart ??
						this.config.customLiveMsg.customLiveStart ??
						"-name 开播啦，当前粉丝数：-follower\n-link",
					{
						"-name": masterInfo.username,
						"-time": diffTime,
						"-follower": followerNum,
						"-link": roomLink,
					},
				);

				await this.sendLiveNotifyCard({
					liveType: LiveType.StartBroadcasting,
					liveData,
					liveRoomInfo,
					masterInfo,
					cardStyle: sub.customCardStyle,
					uid: sub.uid,
					notifyMsg: liveStartMsg,
				});

				if (this.isDisposed()) return;
				if (this.config.pushTime !== 0 && !pushAtTimeTimer) {
					pushAtTimeTimer = this.ctx.setInterval(
						pushAtTimeFunc,
						this.config.pushTime * 1000 * 60 * 60,
					);
					this.livePushTimerManager.set(sub.roomId, pushAtTimeTimer);
					this.logSideEffectState(`timer:created room=${sub.roomId}`);
				}
			},

			onLiveEnd: async () => {
				const now = Date.now();
				if (now - lastLiveEnd < LIVE_EVENT_COOLDOWN) {
					this.liveLogger.warn(`[${sub.roomId}] 的下播事件在冷却期内，忽略`);
					return;
				}
				lastLiveEnd = now;

				if (!liveStatus) {
					this.liveLogger.warn(`[${sub.roomId}] 已经是下播状态，忽略重复的下播事件`);
					return;
				}

				if (pushAtTimeTimer) {
					pushAtTimeTimer();
					pushAtTimeTimer = null;
					this.livePushTimerManager.delete(sub.roomId);
					this.logSideEffectState(`timer:deleted room=${sub.roomId}`);
				}

				if (
					!(await useLiveRoomInfo(LiveType.StopBroadcast)) ||
					!(await useMasterInfo(LiveType.StopBroadcast)) ||
					!liveRoomInfo ||
					!masterInfo
				) {
					liveStatus = false;
					if (this.isDisposed()) return;
					this.stopMonitoring("获取直播间信息失败，推送直播下播卡片失败");
					return;
				}

				liveStatus = false;
				this.liveLogger.debug(
					`开播时粉丝数：${masterInfo.liveOpenFollowerNum}，下播时粉丝数：${masterInfo.liveEndFollowerNum}，粉丝数变化：${masterInfo.liveFollowerChange}`,
				);

				liveTime = liveRoomInfo.live_time || DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
				const diffTime = await this.getTimeDifference(liveTime);
				liveData.fansChanged = masterInfo.liveFollowerChange;
				const n = masterInfo.liveFollowerChange;
				const followerChangeStr =
					n > 0
						? n >= 10_000
							? `+${(n / 10000).toFixed(1)}万`
							: `+${n}`
						: n <= -10_000
							? `${(n / 10000).toFixed(1)}万`
							: n.toString();

				const liveEndMsg = this.applyTemplate(
					sub.customLiveMsg.customLiveEnd ??
						this.config.customLiveMsg.customLiveEnd ??
						"-name 下播啦，本次直播了 -time，粉丝变化 -follower_change",
					{
						"-name": masterInfo.username,
						"-time": diffTime,
						"-follower_change": followerChangeStr,
					},
				);

				if (sub.liveEnd) {
					await this.sendLiveNotifyCard({
						liveType: LiveType.StopBroadcast,
						liveData,
						liveRoomInfo,
						masterInfo,
						cardStyle: sub.customCardStyle,
						uid: sub.uid,
						notifyMsg: liveEndMsg,
					});
					await sendDanmakuWordCloudAndLiveSummary(
						sub.customLiveSummary.liveSummary || this.config.liveSummary.join("\n"),
					);
				}
			},
		};

		const userAction: MsgHandler = {
			raw: {
				INTERACT_WORD_V2: async (msg) => {
					const data = await this.decodeBase64PB(
						(msg as unknown as Record<string, Record<string, string>>).data.pb,
					);
					if (
						data.msgType === "1" &&
						sub.customSpecialUsersEnterTheRoom.specialUsersEnterTheRoom?.includes(
							data.uid as string,
						)
					) {
						const msgTemplate = this.applyTemplate(sub.customSpecialUsersEnterTheRoom.msgTemplate, {
							"-mastername": masterInfo?.username ?? "",
							"-uname": data.uname as string,
						});
						const content = h("message", [h.text(msgTemplate)]);
						this.push.broadcastToTargets(sub.uid, content, PushType.UserActions);
					}
				},
			},
		};

		await this.startLiveRoomListener(sub.roomId, {
			...handler,
			...(sub.customSpecialUsersEnterTheRoom.enable ? userAction : {}),
		});

		if (
			!(await useLiveRoomInfo(LiveType.FirstLiveBroadcast)) ||
			!(await useMasterInfo(LiveType.FirstLiveBroadcast)) ||
			!liveRoomInfo ||
			!masterInfo
		) {
			await this.push.sendPrivateMsg("获取直播间信息失败，启动直播间弹幕检测失败");
			return;
		}

		this.liveLogger.debug(`当前粉丝数：${masterInfo.liveOpenFollowerNum}`);

		if (liveRoomInfo.live_status === 1) {
			liveTime = liveRoomInfo.live_time;
			const watched = String(liveData.watchedNum ?? "暂未获取到");
			liveData.watchedNum = watched;
			const diffTime = await this.getTimeDifference(liveTime);
			const roomLink = `https://live.bilibili.com/${liveRoomInfo.short_id === 0 ? liveRoomInfo.room_id : liveRoomInfo.short_id}`;
			const liveMsg = this.applyTemplate(
				sub.customLiveMsg.customLive ??
					this.config.customLiveMsg.customLive ??
					"-name 正在直播，已播 -time，累计观看：-watched\n-link",
				{ "-name": masterInfo.username, "-time": diffTime, "-watched": watched, "-link": roomLink },
			);

			if (this.config.restartPush) {
				await this.sendLiveNotifyCard({
					liveType: LiveType.LiveBroadcast,
					liveData,
					liveRoomInfo,
					masterInfo,
					cardStyle: sub.customCardStyle,
					uid: sub.uid,
					notifyMsg: liveMsg,
				});
			}

			if (this.config.pushTime !== 0 && !pushAtTimeTimer) {
				pushAtTimeTimer = this.ctx.setInterval(
					pushAtTimeFunc,
					this.config.pushTime * 1000 * 60 * 60,
				);
				this.livePushTimerManager.set(sub.roomId, pushAtTimeTimer);
				this.logSideEffectState(`timer:created room=${sub.roomId}`);
			}
			liveStatus = true;
		}
	}
}
