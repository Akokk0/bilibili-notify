import { resolve } from "node:path";
import type {
	BilibiliAPI,
	LiveRoomInfo,
	MasterInfoData,
	MySelfInfoData,
} from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type {
	BilibiliPush,
	MasterFeature,
	PushFeature,
	SubItem,
	Subscriptions,
} from "@bilibili-notify/push";
import { LIVE_ROOM_MASTERS, PushType } from "@bilibili-notify/push";
import {
	GuardLevel,
	type MessageListener,
	type MsgHandler,
	startListen,
} from "blive-message-listener";
import { cut as jiebaCut } from "jieba-wasm";
import { type Awaitable, type Context, h, type Logger, Service } from "koishi";
import type { SubscriptionOp } from "koishi-plugin-bilibili-notify";
import type {} from "koishi-plugin-bilibili-notify-ai";
import { DateTime } from "luxon";
import protobuf from "protobufjs";
import { liveCommands } from "./commands";
import type { BilibiliNotifyLiveConfig } from "./config";
import definedStopWords from "./stop-words";
import { type LiveData, type LivePushTimerManager, LiveType, type MasterInfo } from "./types";

declare module "koishi" {
	interface Context {
		"bilibili-notify-live": BilibiliNotifyLive;
	}
	interface Events {
		"bilibili-notify/subscription-changed"(ops: SubscriptionOp[]): void;
		"bilibili-notify/plugin-error"(source: string, message: string): void;
		"bilibili-notify/auth-lost"(): void;
		"bilibili-notify/auth-restored"(): void;
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

	private readonly liveLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private api!: BilibiliAPI;
	private push!: BilibiliPush;
	private stopwords: Set<string> = new Set();
	private listenerRecord: Record<string, MessageListener> = {};
	private livePushTimerManager: LivePushTimerManager = new Map();
	private subRecord: Map<string, SubItem> = new Map();
	private disposed = false;
	private readonly instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	constructor(ctx: Context, config: BilibiliNotifyLiveConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
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

		this.liveLogger.debug("[start] 直播插件启动，正在等待订阅数据...");
		// If subscriptions were already loaded before this plugin started, start immediately
		if (internals.subs) {
			this.liveLogger.debug("[start] 订阅已就绪，立即启动直播监听");
			this.startLiveMonitors(internals.subs);
		} else {
			this.liveLogger.debug("[start] 订阅尚未就绪，等待 subscription-changed 事件");
		}
		this.logSideEffectState("start");
		// Listen for future subscription changes from core (incremental ops)
		this.ctx.on("bilibili-notify/subscription-changed", (ops: SubscriptionOp[]) => {
			this.applyOps(ops);
		});
		// Tear down all listeners on auth loss; rebootstrap on auth restore.
		this.ctx.on("bilibili-notify/auth-lost", () => {
			if (this.isDisposed()) return;
			this.liveLogger.info("[live] 收到 auth-lost，关闭所有直播间监听");
			this.clearPushTimers();
			this.clearListeners();
			this.subRecord.clear();
		});
		this.ctx.on("bilibili-notify/auth-restored", () => {
			if (this.isDisposed()) return;
			const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
			if (!internals?.subs) return;
			this.liveLogger.info("[live] 收到 auth-restored，重建直播间监听");
			this.startLiveMonitors(internals.subs);
		});
		// Register commands
		liveCommands.call(this);
	}

	protected stop(): Awaitable<void> {
		this.logSideEffectState("stop:before-clear");
		this.disposed = true;
		this.clearPushTimers();
		this.clearListeners();
		this.subRecord.clear();
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
			`[conn] [live:${this.instanceId}] ${stage} listeners=${this.getListenerCount()} timers=${this.livePushTimerManager?.size ?? 0} disposed=${this.disposed}`,
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

	/** 该订阅在给定特性上是否有至少一个 channel 订阅（仅 channel 级判断）。 */
	private hasTargets(sub: SubItem, ...types: PushFeature[]): boolean {
		return types.some((t) => (sub.target?.[t]?.length ?? 0) > 0);
	}

	/** sub 级总开关 + channel 级订阅同时满足时返回 true。任一关闭即不应通知。 */
	private isSubscribed(sub: SubItem, type: MasterFeature): boolean {
		return sub[type] && (sub.target?.[type]?.length ?? 0) > 0;
	}

	/**
	 * 判断该订阅是否需要建立直播间 WS 连接。
	 * 任一依赖直播间事件流的特性命中（master + target 都有效）就需要 listener。
	 * 注意 schema 里 `live` 已经收窄为"开播通知"，所以不能再单独以 `sub.live` 为门槛。
	 * 与 subscription 包的 `needsLiveRoom` 共用 `LIVE_ROOM_MASTERS` 事实源。
	 */
	private needsLiveMonitor(sub: SubItem): boolean {
		return (
			LIVE_ROOM_MASTERS.some((k) => this.isSubscribed(sub, k)) ||
			(sub.customSpecialDanmakuUsers.enable && this.hasTargets(sub, "specialDanmaku")) ||
			(sub.customSpecialUsersEnterTheRoom.enable && this.hasTargets(sub, "specialUserEnterTheRoom"))
		);
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
		this.subRecord.clear();

		const liveSubUids = Object.values(subs)
			.filter((s) => this.needsLiveMonitor(s))
			.map((s) => s.uid);
		this.liveLogger.debug(
			`[start] 启动直播监听，共 ${liveSubUids.length} 个 UID：${liveSubUids.join(", ")}`,
		);
		for (const sub of Object.values(subs)) {
			if (this.needsLiveMonitor(sub)) this.startLiveForUid(sub, "[start]");
		}
	}

	private startLiveForUid(sub: SubItem, logPrefix = "[ops]"): void {
		const mutable: SubItem = structuredClone(sub);
		this.subRecord.set(sub.uid, mutable);
		this.liveDetectWithListener(mutable).catch((e) => {
			this.liveLogger.error(`${logPrefix} 启动直播监听失败 UID=${sub.uid}：${e}`);
		});
	}

	private stopLiveForUid(uid: string): void {
		const sub = this.subRecord.get(uid);
		if (!sub) return;
		const timer = this.livePushTimerManager.get(sub.roomId);
		timer?.();
		this.livePushTimerManager.delete(sub.roomId);
		this.closeListener(sub.roomId);
		this.subRecord.delete(uid);
	}

	/** Incrementally apply subscription ops without clearing all listeners. */
	private applyOps(ops: SubscriptionOp[]): void {
		for (const op of ops) {
			switch (op.type) {
				case "add": {
					if (!this.needsLiveMonitor(op.sub)) break;
					this.startLiveForUid(op.sub);
					break;
				}
				case "delete": {
					this.stopLiveForUid(op.uid);
					break;
				}
				case "update": {
					// 收集 live-scope（master + custom*）和 target-scope 变更：
					// - live-scope：原地修改 master / 自定义模板
					// - target-scope：必须同步到本地副本，因为 isSubscribed / hasTargets / needsLiveMonitor
					//   全部依赖 sub.target，而 target-scope 与 live-scope 是同一个 op 里的并行变更
					// 全部吸收完再用 needsLiveMonitor 判 start / stop / keep。
					const liveChanges = op.changes.filter((c) => c.scope === "live");
					const targetChanges = op.changes.filter((c) => c.scope === "target");
					if (liveChanges.length === 0 && targetChanges.length === 0) break;

					const existingSub = this.subRecord.get(op.uid);
					if (existingSub) {
						for (const change of liveChanges) {
							const { scope: _, ...fields } = change;
							Object.assign(existingSub, fields);
						}
						for (const change of targetChanges) {
							existingSub.target = change.target;
						}
						if (!this.needsLiveMonitor(existingSub)) {
							this.stopLiveForUid(op.uid);
						}
					} else {
						// 当前未监控：从核心拿最新 sub（target / master 都已是最新）判断是否需要起 listener
						const fullSub =
							this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN)?.subs?.[op.uid];
						if (fullSub && this.needsLiveMonitor(fullSub)) {
							this.startLiveForUid(fullSub);
						}
					}
					break;
				}
			}
		}
	}

	private async startLiveRoomListener(roomId: string, handler: MsgHandler): Promise<void> {
		if (this.isDisposed()) return;
		// 防御：上游应保证 roomId 已解析；若仍空/非法则拒绝建连，避免 tiny-bilibili-ws 抛 NaN
		const roomIdNum = Number.parseInt(roomId, 10);
		if (!Number.isFinite(roomIdNum) || roomIdNum <= 0) {
			this.liveLogger.error(
				`[conn] roomId 非法（"${roomId}"），跳过 listener 创建。请检查订阅配置或用户是否开通直播间`,
			);
			return;
		}
		if (this.listenerRecord[roomId]) {
			this.liveLogger.warn(`[conn] 直播间 [${roomId}] 连接已存在，跳过创建`);
			return;
		}

		const cookiesStr = this.api.getCookiesHeader();
		let mySelfInfo: MySelfInfoData;
		try {
			// API 内部已 retry 3 次；外层不再二次重试
			mySelfInfo = await this.api.getMyselfInfo();
		} catch (e) {
			const message = (e as Error).message ?? String(e);
			this.liveLogger.error(`[conn] 获取个人信息异常，房间 [${roomId}]：${message}`);
			this.ctx.emit(
				"bilibili-notify/plugin-error",
				SERVICE_NAME,
				`[${roomId}] 获取个人信息异常：${message}`,
			);
			return;
		}

		if (mySelfInfo.code !== 0 || !mySelfInfo.data) {
			// -101 已由 api interceptor 上报至 controller；此处仅广播插件错误供运维感知
			this.liveLogger.error(
				`[conn] 获取个人信息失败 code=${mySelfInfo.code}，无法创建直播间 [${roomId}] 连接`,
			);
			this.ctx.emit(
				"bilibili-notify/plugin-error",
				SERVICE_NAME,
				`[${roomId}] 获取个人信息失败 code=${mySelfInfo.code}`,
			);
			return;
		}

		if (this.isDisposed()) return;

		const listener = startListen(roomIdNum, handler, {
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
		this.liveLogger.info(`[conn] 直播间 [${roomId}] 连接已建立`);
		this.logSideEffectState(`listener:created room=${roomId}`);
	}

	private closeListener(roomId: string): void {
		const listener = this.listenerRecord[roomId];
		if (!listener) {
			this.liveLogger.debug(`[conn] 直播间 [${roomId}] 连接不存在，跳过关闭`);
			return;
		}
		if (listener.closed) {
			this.liveLogger.debug(`[conn] 直播间 [${roomId}] 连接已被远端断开`);
			delete this.listenerRecord[roomId];
			return;
		}
		listener.close();
		delete this.listenerRecord[roomId];
		this.liveLogger.info(`[conn] 直播间 [${roomId}] 连接已关闭`);
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

	/**
	 * 停止直播监测。传入 roomId 时仅停止该房间，避免单个房间异常波及其他订阅。
	 */
	private stopMonitoring(reason: string, roomId?: string): void {
		if (roomId) {
			this.liveLogger.error(`[conn] [${roomId}] ${reason}，已停止该房间的监测`);
			this.closeListener(roomId);
			const timer = this.livePushTimerManager.get(roomId);
			if (timer) {
				timer();
				this.livePushTimerManager.delete(roomId);
			}
			this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, `[${roomId}] ${reason}`);
			return;
		}
		this.liveLogger.error(`[conn] ${reason}，直播监测已停止`);
		this.clearListeners();
		this.clearPushTimers();
		this.ctx.emit("bilibili-notify/plugin-error", SERVICE_NAME, reason);
	}

	private async getLiveRoomInfo(roomId: string): Promise<LiveRoomInfo["data"] | undefined> {
		try {
			const content = await this.api.getLiveRoomInfo(roomId);
			return content.data;
		} catch (e) {
			this.liveLogger.error(`[conn] 获取直播间信息失败：${(e as Error).message}`);
			await this.push.sendPrivateMsg(
				`获取直播间 [${roomId}] 信息失败：${(e as Error).message}，已停止该房间监测`,
			);
			this.stopMonitoring("获取直播间信息失败", roomId);
			return undefined;
		}
	}

	/**
	 * 在事件处理器中 fire-and-forget 推送的安全包装：捕获并记录错误，避免 unhandled rejection。
	 */
	private safeBroadcast(
		uid: string,
		// biome-ignore lint/suspicious/noExplicitAny: Koishi message content
		content: any,
		type: PushType,
	): void {
		this.push.broadcastToTargets(uid, content, type).catch((e) => {
			this.liveLogger.error(`[push] 推送失败 uid=${uid} type=${type}：${(e as Error).message}`);
		});
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
				this.liveLogger.error(`[image] 生成直播图片失败：${(e as Error).message}，降级为文字推送`);
			}
		}

		if (this.isDisposed()) return;

		const pushType =
			liveType === LiveType.StartBroadcasting
				? PushType.StartBroadcasting
				: liveType === LiveType.StopBroadcast
					? PushType.LiveEnd
					: PushType.Live;

		if (!buffer) {
			this.liveLogger.debug(`[push] [${masterInfo.username}] 无图片，降级为文字推送`);
			const fallbackMsg = h("message", [
				h.text(liveNotifyMsg || `直播通知 - ${masterInfo.username}`),
			]);

			await this.push.broadcastToTargets(uid, fallbackMsg, pushType);
			return;
		}

		const msg = h("message", [h.image(buffer, "image/jpeg"), h.text(liveNotifyMsg || "")]);
		await this.push.broadcastToTargets(uid, msg, pushType);
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
		masterAvatarUrl?: string,
	): Promise<ReturnType<typeof h.image> | undefined> {
		if (sortedWords.length < 50) {
			this.liveLogger.debug("[wordcloud] 热词不足50个，放弃生成弹幕词云");
			return undefined;
		}
		// biome-ignore lint/suspicious/noExplicitAny: optional image service
		const imageService = (this.ctx as any)["bilibili-notify-image"];
		if (!imageService?.generateWordCloudImg) return undefined;
		try {
			const buf = await imageService.generateWordCloudImg(
				sortedWords.slice(0, 90),
				masterName,
				masterAvatarUrl,
			);
			return h.image(buf, "image/jpeg");
		} catch (e) {
			this.liveLogger.error(`[wordcloud] 生成词云失败：${(e as Error).message}`);
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
			this.liveLogger.debug("[summary] 发言人数不足5位，放弃生成直播总结");
			return undefined;
		}

		const danmakuCount = Object.values(danmakuSenderRecord).reduce((sum, val) => sum + val, 0);
		const top5Senders = Object.entries(danmakuSenderRecord)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);

		const aiService = this.ctx.get("bilibili-notify-ai");
		if (aiService) {
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
				const aiResult = await aiService.comment(prompt, "liveSummary");
				this.liveLogger.debug(`[summary] AI 直播总结生成完毕，长度=${aiResult.length}`);
				return aiResult;
			} catch (e) {
				this.liveLogger.error(`[summary] AI 直播总结生成失败：${(e as Error).message}，回退到模板`);
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
			// wordcloud 和 liveSummary 各自独立判定，可以单独打开/关闭
			const wantWordcloud = this.isSubscribed(sub, "wordcloud");
			const wantSummary = this.isSubscribed(sub, "liveSummary");
			if (!wantWordcloud && !wantSummary) return;

			this.liveLogger.debug(
				`[wordcloud] 开始制作下播总结 wordcloud=${wantWordcloud} summary=${wantSummary}`,
			);
			const sortedWords = Object.entries(danmakuWeightRecord).sort((a, b) => b[1] - a[1]);

			const [img, summary] = await Promise.all([
				wantWordcloud
					? this.generateWordCloud(sortedWords, masterInfo?.username ?? "", masterInfo?.userface)
					: Promise.resolve(undefined),
				wantSummary
					? this.generateLiveSummaryText(
							danmakuSenderRecord,
							sortedWords,
							masterInfo,
							customLiveSummary,
						)
					: Promise.resolve(undefined),
			]);

			if (this.isDisposed()) return;

			const wcMsg = img;
			const summaryMsg = summary ? h.text(summary) : undefined;
			if (wcMsg || summaryMsg) {
				await this.push.broadcastToTargets(
					sub.uid,
					[wcMsg, summaryMsg],
					PushType.WordCloudAndLiveSummary,
				);
			}
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

		const clearDanmakuRecords = (): void => {
			for (const key of Object.keys(danmakuWeightRecord)) delete danmakuWeightRecord[key];
			for (const key of Object.keys(danmakuSenderRecord)) delete danmakuSenderRecord[key];
		};

		const handleLiveEnd = async (source: "ws" | "polling"): Promise<void> => {
			if (!liveStatus) {
				this.liveLogger.warn(
					`[live] 直播间 [${sub.roomId}] 已经是下播状态，忽略 (source=${source})`,
				);
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
				clearDanmakuRecords();
				if (this.isDisposed()) return;
				this.stopMonitoring("获取直播间信息失败，推送直播下播卡片失败", sub.roomId);
				return;
			}

			liveStatus = false;
			this.liveLogger.debug(
				`[stat] 开播时粉丝数：${masterInfo.liveOpenFollowerNum}，下播时粉丝数：${masterInfo.liveEndFollowerNum}，粉丝数变化：${masterInfo.liveFollowerChange}`,
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

			try {
				// 三个动作互相独立：下播卡片、词云、直播总结各看各的 master+target
				if (this.isSubscribed(sub, "liveEnd")) {
					await this.sendLiveNotifyCard({
						liveType: LiveType.StopBroadcast,
						liveData,
						liveRoomInfo,
						masterInfo,
						cardStyle: sub.customCardStyle,
						uid: sub.uid,
						notifyMsg: liveEndMsg,
					});
				}
				await sendDanmakuWordCloudAndLiveSummary(
					sub.customLiveSummary.liveSummary || this.config.liveSummary.join("\n"),
				);
			} finally {
				// Always clear records to free memory regardless of master flags or send errors
				clearDanmakuRecords();
			}
		};

		const pushAtTimeFunc = async () => {
			if (!(await useLiveRoomInfo(LiveType.LiveBroadcast)) || !liveRoomInfo) {
				this.stopMonitoring("获取直播间信息失败，推送直播卡片失败", sub.roomId);
				return;
			}
			if (liveRoomInfo.live_status === 0 || liveRoomInfo.live_status === 2) {
				this.liveLogger.warn(
					`[live] 直播间 [${sub.roomId}] 检测到已下播但未收到 onLiveEnd 事件，进入兜底处理`,
				);
				await this.push.sendPrivateMsg(
					`直播间 [${sub.roomId}] 已下播但未收到 WS 下播事件，已自动触发兜底总结`,
				);
				await handleLiveEnd("polling");
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
				this.liveLogger.error(`[conn] 直播间 [${sub.roomId}] 连接发生错误`);
			},

			onIncomeDanmu: ({ body }) => {
				// 弹幕分词服务于下播时生成的 wordcloud / liveSummary。
				// 任一开关 + 对应 channel 有订阅，才需要收集；两者都未订阅则跳过。
				if (this.isSubscribed(sub, "wordcloud") || this.isSubscribed(sub, "liveSummary")) {
					this.segmentDanmaku(body.content, danmakuWeightRecord);
					this.addUserToDanmakuMaker(body.user.uname, danmakuSenderRecord);
				}

				// 特别关注弹幕：sub.customSpecialDanmakuUsers.enable 是这条特性的总开关，
				// channel 级再看 specialDanmaku target；用户 UID 命中名单时按模板推送。
				if (
					sub.customSpecialDanmakuUsers.enable &&
					this.hasTargets(sub, "specialDanmaku") &&
					sub.customSpecialDanmakuUsers.specialDanmakuUsers?.includes(body.user.uid.toString())
				) {
					const msgTemplate = this.applyTemplate(sub.customSpecialDanmakuUsers.msgTemplate, {
						"-mastername": masterInfo?.username ?? "",
						"-uname": body.user.uname,
						"-msg": body.content,
					});
					const content = h("message", [h.text(msgTemplate)]);
					if (this.isDisposed()) return;
					this.safeBroadcast(sub.uid, content, PushType.UserDanmakuMsg);
				}
			},

			onIncomeSuperChat: async ({ body }) => {
				// SC 监听双职责：1) 给 wordcloud/liveSummary 收集分词；2) 渲染并推送 SC 卡片。
				// 先判断订阅，再做业务过滤（minScPrice）：两个目的都没有订阅时整段跳过；
				// 只为词云收集时跳过昂贵的 API+渲染。
				const collectsDanmaku =
					this.isSubscribed(sub, "wordcloud") || this.isSubscribed(sub, "liveSummary");
				const pushesSC = this.isSubscribed(sub, "superchat");
				if (!collectsDanmaku && !pushesSC) return;

				if (collectsDanmaku) {
					this.segmentDanmaku(body.content, danmakuWeightRecord);
					this.addUserToDanmakuMaker(body.user.uname, danmakuSenderRecord);
				}
				if (!pushesSC) return;
				if (body.price < this.config.minScPrice) return;

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
						this.liveLogger.error(`[sc] 生成SC图片失败：${(e as Error).message}`);
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
				if (!this.isSubscribed(sub, "liveGuardBuy")) return;
				if (body.guard_level > this.config.minGuardLevel) return;
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
							this.liveLogger.error(`[guard] 生成上舰图片失败：${(e as Error).message}`);
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
					this.liveLogger.warn(`[live] 直播间 [${sub.roomId}] 的开播事件在冷却期内，忽略`);
					return;
				}
				lastLiveStart = now;

				if (liveStatus) {
					this.liveLogger.warn(`[live] 直播间 [${sub.roomId}] 已经是开播状态，忽略重复的开播事件`);
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
					this.stopMonitoring("获取直播间信息失败，推送直播开播卡片失败", sub.roomId);
					return;
				}

				this.liveLogger.info(
					`[stat] 房间号：${masterInfo.roomId}，开播时的粉丝数：${masterInfo.liveOpenFollowerNum}`,
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
					this.liveLogger.warn(`[live] 直播间 [${sub.roomId}] 的下播事件在冷却期内，忽略`);
					return;
				}
				lastLiveEnd = now;
				await handleLiveEnd("ws");
			},
		};

		const userAction: MsgHandler = {
			raw: {
				INTERACT_WORD_V2: async (msg: unknown) => {
					// 与 onIncomeDanmu 里的特别弹幕分支保持对称：master(enable) + channel target 双守卫
					if (
						!sub.customSpecialUsersEnterTheRoom.enable ||
						!this.hasTargets(sub, "specialUserEnterTheRoom")
					) {
						return;
					}
					const pb = (msg as { data?: { pb?: unknown } })?.data?.pb;
					if (typeof pb !== "string") {
						this.liveLogger.warn(
							`[live] INTERACT_WORD_V2 缺少 data.pb 字段，跳过 (room=${sub.roomId})`,
						);
						return;
					}
					const data = await this.decodeBase64PB(pb);
					const uid = typeof data.uid === "string" ? data.uid : String(data.uid ?? "");
					const uname = typeof data.uname === "string" ? data.uname : "";
					if (
						data.msgType === "1" &&
						sub.customSpecialUsersEnterTheRoom.specialUsersEnterTheRoom?.includes(uid)
					) {
						const msgTemplate = this.applyTemplate(sub.customSpecialUsersEnterTheRoom.msgTemplate, {
							"-mastername": masterInfo?.username ?? "",
							"-uname": uname,
						});
						const content = h("message", [h.text(msgTemplate)]);
						this.safeBroadcast(sub.uid, content, PushType.UserActions);
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
			this.closeListener(sub.roomId);
			return;
		}

		this.liveLogger.debug(`[stat] 当前粉丝数：${masterInfo.liveOpenFollowerNum}`);

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
