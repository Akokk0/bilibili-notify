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

export interface LiveData {
	watchedNum?: string;
	likedNum?: string;
	fansNum?: string;
	fansChanged?: string;
}

export interface UserInfoInLiveData {
	uid: number;
	uname: string;
	face: string;
	is_admin: number;
}

export type LivePushTimerManager = Map<string, () => void>;
