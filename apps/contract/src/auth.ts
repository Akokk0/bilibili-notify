/**
 * 登录状态的 wire 形状 —— `GET /api/auth/status` 的回应与 WS `auth` 频道 `login-status-report` 帧的载荷。
 *
 * 取值表要和服务端实际发出去的 `BiliLoginStatus` enum(`@bilibili-notify/api`)对得上:这边是 const 对象
 * (面板不能 import api 包的值),对得上由 `apps/server/src/auth/login-status-wire.ts` 在编译期钉住。
 */

export const BiliLoginStatus = {
	NOT_LOGIN: 0,
	LOADING_LOGIN_INFO: 1,
	LOGIN_QR: 2,
	LOGGING_QR: 3,
	LOGGED_IN: 5,
	LOGIN_FAILED: 7,
} as const;

export type BiliLoginStatusValue = (typeof BiliLoginStatus)[keyof typeof BiliLoginStatus];

export interface LoginSnapshot {
	status: BiliLoginStatusValue;
	msg: string;
	data?: unknown;
}
