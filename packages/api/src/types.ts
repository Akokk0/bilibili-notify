// ---- Login / Auth ----

export enum BiliLoginStatus {
	NOT_LOGIN = 0,
	LOADING_LOGIN_INFO = 1,
	LOGIN_QR = 2,
	LOGGING_QR = 3,
	LOGGED_IN = 5,
	LOGIN_FAILED = 7,
}

export interface BiliDataServer {
	status: BiliLoginStatus;
	msg: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic data shape
	data?: any;
}

// ---- Ticket ----

export interface BiliTicket {
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

// ---- Cookies ----

export interface BACookie {
	key: string;
	value: string;
	expires?: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: string;
}

// ---- API Results ----

/**
 * B 站统一响应信封。**`data` 可为 null** —— 错误码(-101/-352/-403/-509…)常
 * 返回 `data:null` 或缺 data;把它建模为必有会诱导调用方无保护解引用(本仓多处
 * "data null" 类缺陷的共同根因)。注:各具体 *Data 接口仍各自把 data 建模为
 * 必有,收敛它们属根因级重构(跨区爆破),本轮仅收信封层 + 逐点修可达解引用。
 */
export interface Result<T = unknown> {
	code: number;
	message: string;
	data: T | null;
}

export interface CreateGroup {
	tagid: number;
}

export interface GroupList {
	tagid: number;
	name: string;
	count: number;
	tip: string;
}

// ---- User Info ----

export interface MySelfInfoData {
	code: number;
	data: {
		mid: number;
		uname: string;
		face: string;
	};
}

export interface UserCard {
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

export interface UserCardSpace {
	s_img: string;
	l_img: string;
}

/** Body of `UserCardInfoData.data` — exported for client-side consumers. */
export interface UserCardInfo {
	card: UserCard;
	space: UserCardSpace;
	like_num: number;
}

export interface UserCardInfoData {
	code: number;
	data: UserCardInfo;
}

/**
 * `x/relation/stat` —— 关系状态数。粉丝计数轮询的轻量数据源(只回数字,不含
 * name/face/sign 等主页卡字段)。`data` 可能为 null(风控/错误码)。
 */
export interface RelationStatData {
	code: number;
	message?: string;
	data: {
		mid: number;
		following: number;
		whisper: number;
		black: number;
		follower: number;
	} | null;
}

/** 批量 `user/cards` 单个成员的精简信息(冷刷 name/avatar 用)。 */
export interface UserCardBrief {
	mid: string;
	name: string;
	face: string;
}

/**
 * `x/polymer/pc-electron/v1/user/cards` —— 多用户详细信息。`data` 以 mid 字符串
 * 为键。单次最多 50 个 uid(超限返回 code=40143)。`data` 可能为 null。
 */
export interface UserCardsBatchData {
	code: number;
	message?: string;
	data: Record<string, UserCardBrief> | null;
}

/**
 * 与某个用户的关系。`attribute`:0=未关注 / 2=已关注 / 6=互相关注 / 128=已拉黑。
 * (悄悄关注的 1 早已废弃。)
 */
export interface UserRelation {
	mid?: number;
	attribute?: number;
}

/** `x/relation/relations` 的响应,`data` 以 mid 字符串为键。 */
export interface RelationsBatchData {
	code: number;
	message?: string;
	data: Record<string, UserRelation> | null;
}

/** `attribute` 里代表「已经关注了」的取值:2=已关注、6=互粉。 */
export const FOLLOWED_ATTRIBUTES: ReadonlySet<number> = new Set([2, 6]);

// ---- Live ----

export interface LiveRoomInfo {
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

export interface LiveRoomDanmuInfo {
	code: number;
	message?: string;
	msg?: string;
	data: {
		token?: string;
		host_list?: unknown[];
		[key: string]: unknown;
	} | null;
}

export interface MasterInfoData {
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

export interface V_VoucherCaptchaData {
	code: number;
	message: string;
	data: {
		type: string;
		token: string;
		geetest: {
			challenge: string;
			gt: string;
		};
		tencent: unknown;
	};
}

export interface ValidateCaptchaData {
	code: number;
	message: string;
	data: {
		grisk_id: string;
		mobile_verify: boolean;
		success_type: number;
	} | null;
}

/** 按 BV 号或 av 号定位一个视频。 */
export type VideoRef = { bvid: string } | { aid: string };

/** `x/web-interface/view` 裁剪后的单视频信息 —— 链接解析的卡片就吃这个。 */
export interface VideoInfo {
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
