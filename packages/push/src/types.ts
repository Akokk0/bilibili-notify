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
};

/** Targets per UID per push type. Values are "platform:channelId" strings. */
export type PushArrMap = Map<
	string,
	{
		dynamicArr?: string[];
		dynamicAtAllArr?: string[];
		liveArr?: string[];
		liveAtAllArr?: string[];
		liveGuardBuyArr?: string[];
		wordcloudArr?: string[];
		superchatArr?: string[];
		liveSummaryArr?: string[];
		specialDanmakuArr?: string[];
		specialUserEnterTheRoomArr?: string[];
	}
>;

export interface MasterConfig {
	enable: boolean;
	platform: string;
	masterAccount: string;
	masterAccountGuildId?: string;
}

// ---- Subscription types (shared across packages) ----

export interface Channel {
	platform: string;
	channelId: string;
	selfId?: string;
}

export type ChannelArr = Channel[];

export interface Target {
	dynamic?: ChannelArr;
	dynamicAtAll?: ChannelArr;
	live?: ChannelArr;
	liveAtAll?: ChannelArr;
	liveGuardBuy?: ChannelArr;
	wordcloud?: ChannelArr;
	superchat?: ChannelArr;
	liveSummary?: ChannelArr;
	specialDanmaku?: ChannelArr;
	specialUserEnterTheRoom?: ChannelArr;
}

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

export interface SubItem {
	uid: string;
	uname: string;
	roomId: string;
	dynamic: boolean;
	live: boolean;
	liveEnd: boolean;
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
