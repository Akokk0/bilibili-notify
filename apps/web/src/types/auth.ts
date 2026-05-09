/**
 * Local mirror of `BiliLoginStatus` / `LoginSnapshot` from `@bilibili-notify/api`.
 * web/ is an isolated pnpm sub-workspace and intentionally does not depend on
 * the business core directly — these types travel only over JSON, so a
 * structural copy keeps the dep graph clean.
 *
 * Keep numeric values in sync with packages/api/src/types.ts.
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

export function isLoggedIn(snap: LoginSnapshot | null | undefined): boolean {
	return snap?.status === BiliLoginStatus.LOGGED_IN;
}
