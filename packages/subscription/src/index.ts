import type { BilibiliAPI } from "@bilibili-notify/api";
import type {
	BilibiliPush,
	ChannelArr,
	PushArrMap,
	SubItem,
	SubManager,
	Subscriptions,
	Target,
} from "@bilibili-notify/push";

export interface FlatSubConfigItem {
	name: string;
	uid: string;
	dynamic: boolean;
	dynamicAtAll: boolean;
	live: boolean;
	liveAtAll: boolean;
	liveGuardBuy: boolean;
	superchat: boolean;
	wordcloud: boolean;
	liveSummary: boolean;
	platform: string;
	/** Comma-separated channel IDs */
	target: string;
}

export interface SubLogger {
	debug(msg: string): void;
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface SubscriptionManagerOpts {
	logger: SubLogger;
	sleep: (ms: number) => Promise<void>;
}

export class SubscriptionManager {
	subManager: SubManager = new Map();

	static fromFlatConfig(subs: FlatSubConfigItem[]): Subscriptions {
		const result: Subscriptions = {};
		for (const s of subs) {
			const channels: ChannelArr = s.target
				.split(",")
				.map((id) => ({ platform: s.platform, channelId: id.trim() }))
				.filter((c) => c.channelId);

			const [uid, roomId = ""] = s.uid.split(",").map((v) => v.trim());

			const target: Target = {
				dynamic: s.dynamic ? channels : undefined,
				dynamicAtAll: s.dynamicAtAll ? channels : undefined,
				live: s.live ? channels : undefined,
				liveAtAll: s.liveAtAll ? channels : undefined,
				liveGuardBuy: s.liveGuardBuy ? channels : undefined,
				superchat: s.superchat ? channels : undefined,
				wordcloud: s.wordcloud ? channels : undefined,
				liveSummary: s.liveSummary ? channels : undefined,
			};

			result[s.name] = {
				uid,
				uname: s.name,
				roomId,
				dynamic: s.dynamic,
				live: s.live,
				liveEnd: true,
				target,
				customCardStyle: { enable: false },
				customLiveMsg: { enable: false },
				customGuardBuy: { enable: false },
				customLiveSummary: { enable: false },
				customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
				customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
			};
		}
		return result;
	}

	private readonly api: BilibiliAPI;
	private readonly push: BilibiliPush;
	private readonly opts: SubscriptionManagerOpts;

	constructor(api: BilibiliAPI, push: BilibiliPush, opts: SubscriptionManagerOpts) {
		this.api = api;
		this.push = push;
		this.opts = opts;
	}

	async loadSubscriptions(subs: Subscriptions): Promise<void> {
		const isReload = this.subManager.size > 0;
		const subArray = Object.values(subs);
		if (isReload) {
			this.opts.logger.info("订阅配置已更新，正在重新加载...");
		} else {
			this.opts.logger.info("已获取订阅信息，正在加载订阅...");
		}
		this.opts.logger.debug(`共 ${subArray.length} 个订阅项，isReload=${isReload}`);

		const pushArrMap = this.buildPushArrMap(subs);
		this.push.pushArrMap = pushArrMap;
		this.push.pushArrMapReady = true;
		this.opts.logger.debug(`推送频道映射已初始化，共 ${pushArrMap.size} 个 UID`);

		const prevSubManager = this.subManager;
		this.subManager = new Map();

		for (let i = 0; i < subArray.length; i++) {
			const sub = subArray[i];
			this.opts.logger.debug(`加载订阅 UID：${sub.uid}`);
			const isExisting = prevSubManager.has(sub.uid);

			if (!isExisting) {
				const followResult = await this.followUser(sub.uid);
				if (followResult.code !== 0) {
					this.opts.logger.error(`关注 UID：${sub.uid} 失败：${followResult.message}`);
					try {
						await this.push.sendPrivateMsg(`加载订阅 UID:${sub.uid} 失败：${followResult.message}`);
					} catch (e) {
						this.opts.logger.error(`发送错误通知失败：${e}`);
					}
					continue;
				}
			}

			if (sub.live && !sub.roomId) {
				const prevRoomId = prevSubManager.get(sub.uid)?.roomId;
				if (prevRoomId) {
					sub.roomId = prevRoomId;
				} else {
					const resolved = await this.resolveRoomId(sub);
					if (!resolved) continue;
				}
			}

			this.subManager.set(sub.uid, this.toSubItem(sub));

			if (!isExisting && i < subArray.length - 1) {
				const delay = (Math.floor(Math.random() * 3) + 1) * 1000;
				this.opts.logger.debug(`设置随机延迟：${delay / 1000} 秒`);
				await this.opts.sleep(delay);
			}
		}

		this.opts.logger.info(
			isReload ? "订阅重新加载完成！" : "订阅加载完成！bilibili-notify 已启动！",
		);
	}

	private buildPushArrMap(subs: Subscriptions): PushArrMap {
		const map: PushArrMap = new Map();
		const toStrings = (arr?: ChannelArr) => (arr ?? []).map((c) => `${c.platform}:${c.channelId}`);
		for (const sub of Object.values(subs)) {
			map.set(sub.uid, {
				dynamicArr: toStrings(sub.target.dynamic),
				dynamicAtAllArr: toStrings(sub.target.dynamicAtAll),
				liveArr: toStrings(sub.target.live),
				liveAtAllArr: toStrings(sub.target.liveAtAll),
				liveGuardBuyArr: toStrings(sub.target.liveGuardBuy),
				superchatArr: toStrings(sub.target.superchat),
				wordcloudArr: toStrings(sub.target.wordcloud),
				liveSummaryArr: toStrings(sub.target.liveSummary),
			});
		}
		return map;
	}

	private async followUser(uid: string): Promise<{ code: number; message: string }> {
		this.opts.logger.debug(`关注 UID：${uid}`);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const res = (await this.api.follow(uid)) as any;
			const code: number = res.code ?? -1;
			const message: string = res.message ?? "";
			// 22001 = self, 22014 = already following → treat as OK
			if (code === 22001 || code === 22014 || code === 0) {
				this.opts.logger.debug(`关注 UID：${uid} 成功（code=${code}）`);
				return { code: 0, message: "OK" };
			}
			this.opts.logger.debug(`关注 UID：${uid} 失败，code=${code}，${message}`);
			return { code, message };
		} catch (e) {
			return { code: -1, message: String(e) };
		}
	}

	private async resolveRoomId(sub: SubItem): Promise<boolean> {
		this.opts.logger.debug(`查询 UID：${sub.uid} 的直播间号`);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const info = (await this.api.getUserInfo(sub.uid)) as any;
			if (info.code !== 0) {
				this.opts.logger.warn(`获取 UID:${sub.uid} 用户信息失败：${info.message}`);
				return false;
			}
			if (!info.data?.live_room) {
				this.opts.logger.warn(`UID:${sub.uid} 用户没有开通直播间，已跳过直播订阅`);
				sub.live = false;
				return true;
			}
			sub.roomId = String(info.data.live_room.roomid);
			this.opts.logger.debug(`UID：${sub.uid} 直播间号已解析：${sub.roomId}`);
			return true;
		} catch (e) {
			this.opts.logger.error(`获取用户信息时出错：${e}`);
			return false;
		}
	}

	private toSubItem(sub: SubItem): SubItem {
		return {
			uid: sub.uid,
			uname: sub.uname,
			roomId: sub.roomId,
			dynamic: sub.dynamic,
			live: sub.live,
			liveEnd: sub.liveEnd,
			target: sub.target,
			customCardStyle: sub.customCardStyle,
			customLiveMsg: sub.customLiveMsg,
			customGuardBuy: sub.customGuardBuy,
			customLiveSummary: sub.customLiveSummary,
			customSpecialDanmakuUsers: sub.customSpecialDanmakuUsers,
			customSpecialUsersEnterTheRoom: sub.customSpecialUsersEnterTheRoom,
		};
	}
}
