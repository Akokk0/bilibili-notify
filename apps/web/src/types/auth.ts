/**
 * `BiliLoginStatus` / `LoginSnapshot` 的浏览器侧形状。规范是
 * `@bilibili-notify/api` 的同名 enum —— 那是个带运行时依赖的包,web 不能
 * import 它的值,所以这里保留 const 对象,但用下方 `satisfies` 钉住键集与
 * 值域:api 侧增删改成员名、或值落到 enum 值域之外,这里编译期即红。
 * (数值 enum 的成员**互换**仍测不出 —— TS 只校验值在成员值集内。)
 */

import type { BiliLoginStatus as ApiBiliLoginStatus } from "@bilibili-notify/api";

export const BiliLoginStatus = {
	NOT_LOGIN: 0,
	LOADING_LOGIN_INFO: 1,
	LOGIN_QR: 2,
	LOGGING_QR: 3,
	LOGGED_IN: 5,
	LOGIN_FAILED: 7,
} as const satisfies Record<keyof typeof ApiBiliLoginStatus, ApiBiliLoginStatus>;

export type BiliLoginStatusValue = (typeof BiliLoginStatus)[keyof typeof BiliLoginStatus];

export interface LoginSnapshot {
	status: BiliLoginStatusValue;
	msg: string;
	data?: unknown;
}
