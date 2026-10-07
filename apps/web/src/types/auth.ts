/**
 * `BiliLoginStatus` / `LoginSnapshot` 住在契约包(服务端发给面板的线上形状),这里只是面板内部的转口。
 * 取值表与服务端实际发出去的 `BiliLoginStatus` enum 对得上,由服务端在编译期钉住
 * (`apps/server/src/auth/login-status-wire.ts`)。
 */
export {
	BiliLoginStatus,
	type BiliLoginStatusValue,
	type LoginSnapshot,
} from "@bilibili-notify/contract";
