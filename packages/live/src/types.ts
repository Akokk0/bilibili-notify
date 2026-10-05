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
 * 直播引擎攒下的那几个数,出卡与文案要用。除累计观看外都是精确数,**没收到就没有这个键**(不补 0)。
 * 累计观看今天存的是 B 站排好的字符串(`text_small`,如「1.2万」),㉒d 改存精确数。
 */
export interface LiveData {
	watchedNum?: string | number;
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
