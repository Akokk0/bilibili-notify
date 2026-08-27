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

export interface LiveUser {
	uid: number;
	uname: string;
}

export type UserActionType = "enter" | "follow" | "share" | "unknown";

export type LiveEvent =
	// ── 连接生命周期(client 发出)──────────────────────────────
	| { kind: "open" }
	| { kind: "auth-ok" }
	| { kind: "auth-failed"; code: number }
	| { kind: "heartbeat"; popularity: number }
	| { kind: "closed"; code?: number }
	| { kind: "error"; error: Error }
	// ── 业务消息(parser 产出)────────────────────────────────
	| { kind: "danmu"; content: string; user: LiveUser }
	| { kind: "superchat"; content: string; price: number; user: LiveUser }
	| { kind: "guard-buy"; guardLevel: GuardLevel; giftName: string; user: LiveUser }
	| { kind: "watched"; num: number; textSmall: string }
	| { kind: "liked"; count: number }
	| { kind: "live-start" }
	| { kind: "live-end" }
	| { kind: "user-action"; action: UserActionType; user: LiveUser }
	| { kind: "raw"; cmd: string; payload: unknown };
