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
import type { Context, Logger } from "koishi";

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

function parseChannels(target: string, platform: string): ChannelArr {
	return target
		.split(",")
		.map((id) => ({ platform, channelId: id.trim() }))
		.filter((c) => c.channelId);
}

function buildTargetFromFlat(item: FlatSubConfigItem): Target {
	const channels = parseChannels(item.target, item.platform);
	return {
		dynamic: item.dynamic ? channels : undefined,
		dynamicAtAll: item.dynamicAtAll ? channels : undefined,
		live: item.live ? channels : undefined,
		liveAtAll: item.liveAtAll ? channels : undefined,
		liveGuardBuy: item.liveGuardBuy ? channels : undefined,
		superchat: item.superchat ? channels : undefined,
		wordcloud: item.wordcloud ? channels : undefined,
		liveSummary: item.liveSummary ? channels : undefined,
	};
}

function defaultCustomFields() {
	return {
		customCardStyle: { enable: false as const },
		customLiveMsg: { enable: false as const },
		customGuardBuy: { enable: false as const },
		customLiveSummary: { enable: false as const },
		customSpecialDanmakuUsers: { enable: false as const, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: { enable: false as const, msgTemplate: "" },
	};
}

function pushArrEntryFromTarget(target: Target) {
	const toStrings = (arr?: ChannelArr) => (arr ?? []).map((c) => `${c.platform}:${c.channelId}`);
	return {
		dynamicArr: toStrings(target.dynamic),
		dynamicAtAllArr: toStrings(target.dynamicAtAll),
		liveArr: toStrings(target.live),
		liveAtAllArr: toStrings(target.liveAtAll),
		liveGuardBuyArr: toStrings(target.liveGuardBuy),
		superchatArr: toStrings(target.superchat),
		wordcloudArr: toStrings(target.wordcloud),
		liveSummaryArr: toStrings(target.liveSummary),
	};
}

export class SubscriptionManager {
	subManager: SubManager = new Map();

	static fromFlatConfig(subs: FlatSubConfigItem[]): Subscriptions {
		const result: Subscriptions = {};
		for (const s of subs) {
			const [uid, roomId = ""] = s.uid.split(",").map((v) => v.trim());
			result[s.name] = {
				uid,
				uname: s.name,
				roomId,
				dynamic: s.dynamic,
				live: s.live,
				liveEnd: true,
				target: buildTargetFromFlat(s),
				...defaultCustomFields(),
			};
		}
		return result;
	}

	private readonly api: BilibiliAPI;
	private readonly push: BilibiliPush;
	private readonly logger: Logger;
	private readonly ctx: Context;

	constructor(api: BilibiliAPI, push: BilibiliPush, ctx: Context) {
		this.api = api;
		this.push = push;
		this.ctx = ctx;
		this.logger = ctx.logger("bilibili-notify-subscription");
	}

	/** Add a single subscription entry. Returns the resolved SubItem, or null on failure. */
	async addEntry(item: FlatSubConfigItem): Promise<SubItem | null> {
		const [uid, roomId = ""] = item.uid.split(",").map((v) => v.trim());

		if (this.subManager.has(uid)) {
			this.logger.warn(`[add] UID ${uid} 已在订阅列表中，跳过`);
			return null;
		}

		const followResult = await this.followUser(uid);
		if (followResult.code !== 0) {
			this.logger.error(`[add] 关注 UID：${uid} 失败：${followResult.message}`);
			try {
				await this.push.sendPrivateMsg(`加载订阅 UID:${uid} 失败：${followResult.message}`);
			} catch (e) {
				this.logger.error(`[add] 发送错误通知失败：${e}`);
			}
			return null;
		}

		const sub: SubItem = {
			uid,
			uname: item.name,
			roomId,
			dynamic: item.dynamic,
			live: item.live,
			liveEnd: true,
			target: buildTargetFromFlat(item),
			...defaultCustomFields(),
		};

		if (sub.live && !sub.roomId) {
			const resolved = await this.resolveRoomId(sub);
			if (!resolved) return null;
		}

		const finalSub = this.toSubItem(sub);
		this.subManager.set(uid, finalSub);
		this.updatePushMapEntry(uid, finalSub);
		this.logger.info(`[add] 已添加订阅 UID：${uid}（${item.name}）`);
		return finalSub;
	}

	/** Remove a single subscription entry. Returns the removed SubItem, or null if not found. */
	removeEntry(uid: string): SubItem | null {
		const sub = this.subManager.get(uid);
		if (!sub) return null;
		this.subManager.delete(uid);
		this.push.pushArrMap.delete(uid);
		this.logger.info(`[remove] 已移除订阅 UID：${uid}（${sub.uname}）`);
		return sub;
	}

	/** Update an existing subscription entry's config. Returns the updated SubItem, or null if not found. */
	updateEntry(item: FlatSubConfigItem): SubItem | null {
		const [uid] = item.uid.split(",").map((v) => v.trim());
		const existing = this.subManager.get(uid);
		if (!existing) return null;

		Object.assign(existing, {
			dynamic: item.dynamic,
			live: item.live,
			target: buildTargetFromFlat(item),
		});
		this.updatePushMapEntry(uid, existing);
		this.logger.info(`[update] 已更新订阅 UID：${uid}（${existing.uname}）`);
		return existing;
	}

	private updatePushMapEntry(uid: string, sub: SubItem): void {
		this.push.pushArrMap.set(uid, pushArrEntryFromTarget(sub.target));
	}

	async loadSubscriptions(subs: Subscriptions, opts: { isReload?: boolean } = {}): Promise<void> {
		const isReload = opts.isReload ?? this.subManager.size > 0;
		const subArray = Object.values(subs);
		if (isReload) {
			this.logger.info("[load] 订阅配置已更新，正在重新加载...");
		} else {
			this.logger.info("[load] 已获取订阅信息，正在加载订阅...");
		}
		this.logger.debug(`[load] 共 ${subArray.length} 个订阅项，isReload=${isReload}`);

		const pushArrMap = this.buildPushArrMap(subs);
		this.push.pushArrMap = pushArrMap;
		this.push.pushArrMapReady = true;
		this.logger.debug(`[load] 推送频道映射已初始化，共 ${pushArrMap.size} 个 UID`);

		const prevSubManager = this.subManager;
		this.subManager = new Map();

		for (let i = 0; i < subArray.length; i++) {
			const sub = subArray[i];
			this.logger.debug(`[load] 加载订阅 UID：${sub.uid}`);
			const isExisting = prevSubManager.has(sub.uid);

			if (!isExisting) {
				const followResult = await this.followUser(sub.uid);
				if (followResult.code !== 0) {
					this.logger.error(`[follow] 关注 UID：${sub.uid} 失败：${followResult.message}`);
					try {
						await this.push.sendPrivateMsg(`加载订阅 UID:${sub.uid} 失败：${followResult.message}`);
					} catch (e) {
						this.logger.error(`[follow] 发送错误通知失败：${e}`);
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
				this.logger.debug(`[load] 设置随机延迟：${delay / 1000} 秒`);
				await this.ctx.sleep(delay);
			}
		}

		this.logger.info(
			isReload ? "[load] 订阅重新加载完成！" : "[load] 订阅加载完成！bilibili-notify 已启动！",
		);
	}

	private buildPushArrMap(subs: Subscriptions): PushArrMap {
		const map: PushArrMap = new Map();
		for (const sub of Object.values(subs)) {
			map.set(sub.uid, pushArrEntryFromTarget(sub.target));
		}
		return map;
	}

	private async followUser(uid: string): Promise<{ code: number; message: string }> {
		this.logger.debug(`[follow] 关注 UID：${uid}`);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const res = (await this.api.follow(uid)) as any;
			const code: number = res.code ?? -1;
			const message: string = res.message ?? "";
			// 22001 = self, 22014 = already following → treat as OK
			if (code === 22001 || code === 22014 || code === 0) {
				this.logger.debug(`[follow] 关注 UID：${uid} 成功（code=${code}）`);
				return { code: 0, message: "OK" };
			}
			this.logger.debug(`[follow] 关注 UID：${uid} 失败，code=${code}，${message}`);
			return { code, message };
		} catch (e) {
			const msg = e instanceof Error ? (e.message ?? e.toString()) : String(e);
			return { code: -1, message: msg };
		}
	}

	private async resolveRoomId(sub: SubItem): Promise<boolean> {
		this.logger.debug(`[room] 查询 UID：${sub.uid} 的直播间号`);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const info = (await this.api.getUserInfo(sub.uid)) as any;
			if (info.code !== 0) {
				this.logger.warn(`[room] 获取 UID:${sub.uid} 用户信息失败：${info.message}`);
				return false;
			}
			if (!info.data?.live_room) {
				this.logger.warn(`[room] UID:${sub.uid} 用户没有开通直播间，已跳过直播订阅`);
				sub.live = false;
				return true;
			}
			sub.roomId = String(info.data.live_room.roomid);
			this.logger.debug(`[room] UID：${sub.uid} 直播间号已解析：${sub.roomId}`);
			return true;
		} catch (e) {
			this.logger.error(`[room] 获取用户信息时出错：${e}`);
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
