/**
 * 直播信息流对外的事件联合 —— 连接生命周期与业务消息走同一个 `onEvent` 漏斗,
 * 消费方(RoomSession)一个 switch 接完,活跃度标记也只需在漏斗口做一次。
 */

/** 大航海等级。数值与 B 站原始 guard_level 一致。 */
export enum GuardLevel {
	None = 0,
	Governor = 1,
	Admiral = 2,
	Captain = 3,
}

/** 粉丝勋章(牌子)。各帧携带的字段不齐,缺的省略。 */
export interface FanBadge {
	level: number;
	name: string;
	/** 点亮状态(灰牌为 false)。 */
	active?: boolean;
	/** 牌子归属的主播 uid / 房号。 */
	anchorUid?: number;
	anchorRoomId?: number;
}

/**
 * 事件里的用户。基础字段恒有;`badge` / `guardLevel` / `isRoomAdmin` 仅在
 * 对应帧携带且有意义时出现(guardLevel 为 0、admin 为假时一律省略)。
 */
export interface LiveUser {
	uid: number;
	uname: string;
	badge?: FanBadge;
	guardLevel?: GuardLevel;
	isRoomAdmin?: boolean;
}

export type UserActionType = "enter" | "follow" | "share" | "unknown";

export type LiveEvent =
	// ── 连接生命周期(client 发出)──────────────────────────────
	| { kind: "open" }
	| { kind: "auth-ok" }
	| { kind: "auth-failed"; code: number }
	| { kind: "heartbeat"; popularity: number }
	| { kind: "closed"; code?: number; reason?: string }
	| { kind: "error"; error: Error }
	// ── 业务消息(parser 产出)────────────────────────────────
	| {
			kind: "danmu";
			content: string;
			user: LiveUser;
			/** 1/2/3 普通;4 底部;5 顶部。 */
			danmuType?: number;
			/** 发送时间,毫秒时间戳。 */
			timestamp?: number;
			/** 天选/抽奖口令弹幕。 */
			isLottery?: boolean;
			/** 表情弹幕(整条是一张表情图)。 */
			emoticon?: { id: string; url: string; width: number; height: number };
	  }
	| {
			kind: "superchat";
			content: string;
			/** 价格,RMB。 */
			price: number;
			user: LiveUser;
			id?: number;
			/** 展示持续时长,秒。 */
			durationSec?: number;
	  }
	| {
			kind: "guard-buy";
			guardLevel: GuardLevel;
			giftName: string;
			user: LiveUser;
			giftId?: number;
			/** 价格,金瓜子(/1000 为 RMB)。 */
			price?: number;
			num?: number;
			/** 等级生效/过期时间,秒级时间戳。 */
			startTime?: number;
			endTime?: number;
	  }
	/**
	 * 大航海 toast(USER_TOAST_MSG / _V2)。**独立 kind,绝不并入 guard-buy**:
	 * 2026-08-28 蹲守实测,续费(opType=2)时 GUARD_BUY + v1 + V2 **三帧同秒
	 * 齐发**,并流 = 一次上舰三连推(与 entry-effect≠user-action 同一条铁律)。
	 * 本 kind 的价值是语义增量:opType 区分开通/续费(文案不可靠,只信
	 * opType)、price 是实付折扣价(guard-buy 报原价)、toastMsg 带陪伴天数。
	 */
	| {
			kind: "guard-toast";
			/** B 站 op_type 原义:1=开通 2=续费 3=自动续费;新值原样透传。 */
			opType: number;
			guardLevel: GuardLevel;
			user: LiveUser;
			/** 头衔名,如「舰长」。 */
			roleName?: string;
			num?: number;
			/** num 的单位:「月」/「年」。 */
			unit?: string;
			/** 价格,金瓜子(/1000 为 RMB);续费价可低于新购价。 */
			price?: number;
			/** 等级生效/过期时间,秒级时间戳。 */
			startTime?: number;
			endTime?: number;
			/** 全文案,如「<%xx%> 开通了舰长,今天是TA陪伴主播的第1天」。 */
			toastMsg?: string;
	  }
	| {
			kind: "gift";
			user: LiveUser;
			giftId: number;
			giftName: string;
			/** gold 金瓜子(price/1000 为 RMB);silver 银瓜子(免费礼物)。 */
			coinType: "gold" | "silver";
			/** 单价,瓜子。 */
			price: number;
			num: number;
			/** 连击(batch_combo_id 存在时)。 */
			combo?: { batchId: string; comboNum: number; totalCoin: number };
	  }
	| { kind: "watched"; num: number; textSmall: string }
	| { kind: "liked"; count: number }
	| { kind: "live-start" }
	| { kind: "live-end" }
	| { kind: "user-action"; action: UserActionType; user: LiveUser }
	// ── 房间态 ────────────────────────────────────────────────
	| {
			kind: "room-change";
			title: string;
			areaName?: string;
			parentAreaName?: string;
			areaId?: number;
			parentAreaId?: number;
	  }
	| { kind: "rank-count"; count: number }
	// ── 抽奖组 ────────────────────────────────────────────────
	| {
			kind: "red-pocket-start";
			id: number;
			user: LiveUser;
			/** 参与口令弹幕。 */
			danmu: string;
			durationSec: number;
			/** 奖品总价值,金瓜子(/1000 为 RMB)。 */
			totalPrice: number;
			awards: { giftId: number; giftName: string; num: number }[];
	  }
	| {
			kind: "red-pocket-end";
			id: number;
			totalNum: number;
			winners: { uid: number; uname: string; awardName?: string }[];
	  }
	| {
			kind: "anchor-lottery-start";
			id: number;
			durationSec: number;
			awardName: string;
			awardNum: number;
			/** 虚拟礼物奖品(false = 实物)。 */
			virtualAward: boolean;
			/** 参与口令弹幕;无需弹幕时省略。 */
			requireDanmu?: string;
			/** 参与要求的人话描述(如「关注主播」);无要求时省略。 */
			requireText?: string;
	  }
	| {
			kind: "anchor-lottery-end";
			id: number;
			awardName: string;
			winners: { uid: number; uname: string; num: number }[];
	  }
	// ── 管理组 ────────────────────────────────────────────────
	| { kind: "room-warn"; warnType: "warning" | "cut"; msg: string }
	| {
			kind: "room-silent";
			/** 按用户等级 / 勋章等级 / 全员 / 解除。 */
			silentType: "level" | "medal" | "member" | "off";
			level: number;
			/** 结束时间,秒级时间戳;-1 为无限。 */
			second: number;
	  }
	| { kind: "room-admin"; adminType: "set" | "revoke"; uid: number }
	// ── 进场特效 / 点赞点击(独立 kind,**绝不**并入 user-action ——
	//    混流正是舰长进房重复推旧 bug 的病根)─────────────────────
	| { kind: "entry-effect"; user: LiveUser }
	| { kind: "like-click"; user: LiveUser }
	/**
	 * 未解析命令原样透传。`degraded: true` = 这本是已知命令,但形状/protobuf
	 * 解析失败降级而来 —— 是「B 站可能改了字段」的协议漂移信号,上游应观测;
	 * 不带 degraded 的 raw 只是刻意不解析的命令,属正常流量。
	 */
	| { kind: "raw"; cmd: string; payload: unknown; degraded?: true };
