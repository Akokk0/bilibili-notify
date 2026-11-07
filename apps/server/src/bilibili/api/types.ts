// ---- Ticket ----

export interface TicketResponse {
	code: number;
	message: string;
	data: {
		ticket: string;
		created_at: number;
		ttl: number;
		context: Record<string, unknown>;
		nav: {
			img: string;
			sub: string;
		};
	};
}

// ---- API Results ----

// ---- User Info ----

export interface UserInfoResponse {
	code: number;
	message?: string;
	data?: {
		live_room?: {
			roomid?: number;
		} | null;
	} | null;
}

export interface MyselfResponse {
	code: number;
	data: {
		mid: number;
		uname: string;
		face: string;
	};
}

interface UserCard {
	mid: string;
	name: string;
	face: string;
	sign: string;
	attention: number;
	fans: number;
	level_info: { current_level: number };
	official: { role: number; title: string; type: number };
	vip: {
		type: number;
		status: number;
		vipStatus: number;
		label: {
			text: string;
			img_label_uri_hans_static: string;
		};
	};
}

interface UserCardSpace {
	s_img: string;
	l_img: string;
}

/** Body of `UserCardResponse.data` — exported for client-side consumers. */
interface UserCardDetails {
	card: UserCard;
	space: UserCardSpace;
	like_num: number;
}

export interface UserCardResponse {
	code: number;
	data: UserCardDetails;
}

export interface LoginQrCodeResponse {
	code: number;
	data: {
		url: string;
		qrcode_key: string;
	};
}

/**
 * 与某个用户的关系。`attribute`:0=未关注 / 2=已关注 / 6=互相关注 / 128=已拉黑。
 * (悄悄关注的 1 早已废弃。)
 */
interface UserRelation {
	mid?: number;
	attribute?: number;
}

/** `x/relation/relations` 的响应,`data` 以 mid 字符串为键。 */
export interface RelationsResponse {
	code: number;
	message?: string;
	data: Record<string, UserRelation> | null;
}

/** `attribute` 里代表「已经关注了」的取值:2=已关注、6=互粉。 */
export const FOLLOWED_ATTRIBUTES: ReadonlySet<number> = new Set([2, 6]);

// ---- Live ----

export interface LiveRoomResponse {
	code: number;
	data: {
		uid: number;
		room_id: number;
		short_id: number;
		live_status: number; // 0=not live, 1=live, 2=rotate
		live_time: string;
		title: string;
		user_cover: string;
		keyframe: string;
		tags: string;
		area_name: string;
		parent_area_name: string;
	};
}

export interface LiveRoomDanmakuResponse {
	code: number;
	message?: string;
	msg?: string;
	data: {
		token?: string;
		host_list?: unknown[];
		[key: string]: unknown;
	} | null;
}

export interface LiveUpResponse {
	code: number;
	data: {
		info: {
			uid: number;
			uname: string;
			face: string;
			gender: number;
		};
		exp: {
			master_level: { level: number; color: number };
		};
		follower_num: number;
		room_id: number;
		medal_name: string;
	};
}

// ---- Risk Control ----

/** 按 BV 号或 av 号定位一个视频。 */
export type VideoRef = { bvid: string } | { aid: string };

/** `x/web-interface/view` 裁剪后的单视频信息 —— 链接解析的卡片就吃这个。 */
export interface VideoResponse {
	bvid: string;
	aid: number;
	title: string;
	/** 封面。 */
	pic: string;
	desc: string;
	/** 时长,秒。 */
	duration: number;
	/** 发布时刻,epoch 秒。 */
	pubdate: number;
	/** 分区名。 */
	tname: string;
	owner: { mid: number; name: string; face: string };
	stat: {
		view: number;
		danmaku: number;
		reply: number;
		favorite: number;
		coin: number;
		share: number;
		like: number;
	};
}
