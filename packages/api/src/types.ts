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
