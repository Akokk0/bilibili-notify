import type { AuthState } from "@bilibili-notify/internal";
import { t as serverText } from "../i18n.js";

/** 二维码登录失败的原因键(`failed` 状态里带的那几种)。 */
export type LoginFailureKey =
	| "qrFetchFailed"
	| "qrRenderFailed"
	| "qrExpired"
	| "qrInvalidated"
	| "noCookieAfterLogin"
	| "genericLoginFail";

/** 每种失败原因给主人看的那句话(进 `AuthState` 的 `error.message` 与发起扫码失败的结果)。 */
export const LOGIN_FAILURE_MESSAGES: Record<LoginFailureKey, string> = {
	get qrFetchFailed() {
		return serverText("bilibili.auth.login-state.text.1");
	},
	get qrRenderFailed() {
		return serverText("bilibili.auth.login-state.text.2");
	},
	get qrExpired() {
		return serverText("bilibili.auth.login-state.text.3");
	},
	get qrInvalidated() {
		return serverText("bilibili.auth.login-state.text.4");
	},
	get noCookieAfterLogin() {
		return serverText("bilibili.auth.login-state.text.5");
	},
	get genericLoginFail() {
		return serverText("bilibili.auth.login-state.text.6");
	},
};

/**
 * 登录着的账号里我们用得到的那几格(从用户卡片的回应里收出来;B 站的原字段名只留在收的那一处)。
 * `avatarUrl` 可能是空串:没有头像地址就不抓头像。
 */
export interface BiliAccount {
	name: string;
	avatarUrl: string;
}

/**
 * B 站登录状态机的内部原形。以前靠 `msg` 分的几种事在这里都是带类型的格:
 * 「没登录」与「登录失效」、「还没扫」与「已扫等确认」、六种失败原因。
 * 对外只交由它算出来的 {@link AuthState}(`authStateFromLoginState`)。
 */
export type BiliLoginState =
	/** 开机探活还没回,或探活遇到网络异常停在这里等心跳。 */
	| { status: "checking" }
	/** 没登录(`authLost` = 已登着的登录失效了)。 */
	| { status: "logged-out"; reason: "notLogin" | "authLost" }
	/** 扫码中。`expiresAt` 是取码时刻加 180 秒。 */
	| {
			status: "qr";
			phase: "ready" | "waiting-scan" | "waiting-confirm";
			dataUrl: string;
			expiresAt: string;
	  }
	/** 已登录(含扫码刚成功、账号信息还没取到的那一小段:`account` 缺着)。 */
	| {
			status: "logged-in";
			reason: "loggedIn" | "loginJustSucceeded" | "fetchAccountFailed";
			loggedInAt: string;
			account?: BiliAccount;
	  }
	/** 这一次扫码登录没办成。 */
	| { status: "failed"; reason: LoginFailureKey };

/** 开机没确认的这句话(`confirming` 的两种情况之一)。 */
const checkingMessage = () => serverText("bilibili.auth.login-state.text.7");
/** 已扫码、等手机上点确认(`confirming` 的另一种情况)。 */
const waitConfirmMessage = () => serverText("bilibili.auth.login-state.text.8");
/** 已登录的会话失效了。 */
const authLostMessage = () => serverText("bilibili.auth.login-state.text.9");

/** 内部原形 → 对外的中立状态。纯函数。 */
export function authStateFromLoginState(state: BiliLoginState): AuthState {
	switch (state.status) {
		case "checking":
			return { status: "confirming", message: checkingMessage() };
		case "logged-out":
			return state.reason === "authLost"
				? { status: "expired", message: authLostMessage() }
				: { status: "logged-out" };
		case "qr":
			if (state.phase === "waiting-confirm") {
				return { status: "confirming", message: waitConfirmMessage() };
			}
			return {
				status: "awaiting-scan",
				qr: { dataUrl: state.dataUrl, expiresAt: state.expiresAt },
			};
		case "logged-in":
			return { status: "logged-in", loggedInAt: state.loggedInAt };
		case "failed":
			return { status: "error", message: LOGIN_FAILURE_MESSAGES[state.reason] };
	}
}
