export enum LiveType {
	NotLiveBroadcast = 0,
	StartBroadcasting = 1,
	LiveBroadcast = 2,
	StopBroadcast = 3,
	FirstLiveBroadcast = 4,
}

export interface MasterInfo {
	username: string;
	userface: string;
	roomId: number;
	liveOpenFollowerNum: number;
	liveEndFollowerNum: number;
	liveFollowerChange: number;
	medalName: string;
}

/**
 * 直播引擎攒下的那几个数,出卡与文案要用。都是精确数,**没收到就没有这个键**(不补 0、不写占位文字)。
 * 累计观看是 B 站 `WATCHED_CHANGE` 帧的 `num`(排成「1.2万」归出口的 `formatCount`)。
 *
 * 这份数据是**会话级**的,每开一场就重置观看人数与点赞(见 `RoomSession.onLiveStart`)。
 */
export interface LiveData {
	watchedNum?: number;
	likedNum?: number;
	fansNum?: number;
	fansChanged?: number;
}

export interface UserInfoInLiveData {
	uid: number;
	uname: string;
	face: string;
	is_admin: number;
}

export type LivePushTimerManager = Map<string, () => void>;
