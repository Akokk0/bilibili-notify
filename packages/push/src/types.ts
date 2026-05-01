export enum PushType {
	Live = 0,
	Dynamic = 1,
	DynamicAtAll = 2,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	WordCloudAndLiveSummary = 5,
	Superchat = 6,
	UserDanmakuMsg = 7,
	UserActions = 8,
	LiveEnd = 9,
}

export const PUSH_TYPE_LABEL: Record<PushType, string> = {
	[PushType.Live]: "直播推送",
	[PushType.Dynamic]: "动态推送",
	[PushType.DynamicAtAll]: "动态推送+At全体",
	[PushType.StartBroadcasting]: "开播推送",
	[PushType.LiveGuardBuy]: "上舰推送",
	[PushType.WordCloudAndLiveSummary]: "弹幕词云和直播总结推送",
	[PushType.Superchat]: "SC推送",
	[PushType.UserDanmakuMsg]: "用户弹幕推送",
	[PushType.UserActions]: "用户行为推送",
	[PushType.LiveEnd]: "下播推送",
};

/**
 * 频道级特性：每项可以配置独立的 channel 订阅列表。
 * 用作 Target / PushArrEntry 的 key。
 */
export const PUSH_FEATURES = [
	"dynamic",
	"dynamicAtAll",
	"live",
	"liveAtAll",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnterTheRoom",
] as const;
export type PushFeature = (typeof PUSH_FEATURES)[number];

/**
 * sub 级总开关。各特性互相独立、互不联动（wordcloud 与 liveSummary 例外，
 * 共用同一份弹幕收集结果）。
 * specialDanmaku / specialUserEnterTheRoom 由 customSpecial*.enable 充当总开关，不重复。
 */
export const MASTER_FEATURES = [
	"dynamic",
	"dynamicAtAll",
	"live",
	"liveAtAll",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
] as const satisfies ReadonlyArray<PushFeature>;
export type MasterFeature = (typeof MASTER_FEATURES)[number];

export type SubItemMasters = Record<MasterFeature, boolean>;

/** UID → 各特性的目标 channel 列表（已解析为 "platform:channelId"）。 */
export type PushArrEntry = Partial<Record<PushFeature, string[]>>;
export type PushArrMap = Map<string, PushArrEntry>;

/**
 * Master notification config. The schema makes `platform` / `masterAccount`
 * required only when `enable=true`, but TypeScript can't narrow that
 * conditional shape, so they are typed as optional and validated at runtime.
 */
export interface MasterConfig {
	enable: boolean;
	platform?: string;
	masterAccount?: string;
	masterAccountGuildId?: string;
}

// ---- Subscription types (shared across packages) ----

export interface Channel {
	platform: string;
	channelId: string;
	selfId?: string;
}

export type ChannelArr = Channel[];

export type Target = Partial<Record<PushFeature, ChannelArr>>;

export interface CustomCardStyle {
	enable: boolean;
	cardColorStart?: string;
	cardColorEnd?: string;
	cardBasePlateColor?: string;
	cardBasePlateBorder?: string;
}

export interface CustomLiveMsg {
	enable: boolean;
	customLiveStart?: string;
	customLive?: string;
	customLiveEnd?: string;
}

export interface CustomGuardBuy {
	enable: boolean;
	guardBuyMsg?: string;
	captainImgUrl?: string;
	supervisorImgUrl?: string;
	governorImgUrl?: string;
}

export interface CustomLiveSummary {
	enable: boolean;
	liveSummary?: string;
}

export interface CustomSpecialDanmakuUsers {
	enable: boolean;
	specialDanmakuUsers?: string[];
	msgTemplate: string;
}

export interface CustomSpecialUsersEnterTheRoom {
	enable: boolean;
	specialUsersEnterTheRoom?: string[];
	msgTemplate: string;
}

export interface SpecialUser {
	uid: string;
	danmakuNotify?: boolean;
	enterRoomNotify?: boolean;
}

export interface SubItem extends SubItemMasters {
	uid: string;
	uname: string;
	roomId: string;
	target: Target;
	customCardStyle: CustomCardStyle;
	customLiveMsg: CustomLiveMsg;
	customGuardBuy: CustomGuardBuy;
	customLiveSummary: CustomLiveSummary;
	customSpecialDanmakuUsers: CustomSpecialDanmakuUsers;
	customSpecialUsersEnterTheRoom: CustomSpecialUsersEnterTheRoom;
	specialUsers?: SpecialUser[];
}

export type SubManager = Map<string, SubItem>;
export type Subscriptions = Record<string, SubItem>;
