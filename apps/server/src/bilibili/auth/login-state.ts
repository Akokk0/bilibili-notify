import type { AuthState } from "@bilibili-notify/internal";
import type { UserCardInfo } from "../api/types.js";

/** 二维码登录失败的原因键(`failed` 状态里带的那几种)。 */
export type LoginFailureKey =
	| "qrFetchFailed"
	| "qrRenderFailed"
	| "qrExpired"
	| "qrInvalidated"
	| "noCookieAfterLogin"
	| "genericLoginFail";

/** 每种失败原因给主人看的那句话(进 `AuthState` 的 `error.message` 与发起扫码失败的结果)。 */
export const MESSAGES: Record<LoginFailureKey, string> = {
	qrFetchFailed: "获取二维码失败，请重试",
	qrRenderFailed: "生成二维码失败",
	qrExpired: "二维码已超时（3分钟），请重新登录",
	qrInvalidated: "二维码已失效，请重新登录",
	noCookieAfterLogin: "登录成功但未获取到 cookie，请重试",
	genericLoginFail: "登录失败，请重试",
};

/**
 * B 站登录状态机的内部原形。以前靠 `msg` 分的几种事在这里都是带类型的格:
 * 「没登录」与「登录失效」、「还没扫」与「已扫等确认」、六种失败原因。
 * 对外只交由它算出来的 {@link AuthState}(`authStateFromLoginState`)。
 */
export type BiliLoginState =
	/** 原 LOADING_LOGIN_INFO:开机探活还没回,或探活遇到网络异常停在这里等心跳。 */
	| { status: "checking" }
	/** 原 NOT_LOGIN。 */
	| { status: "logged-out"; reason: "notLogin" | "authLost" }
	/** 原 LOGIN_QR / LOGGING_QR。`expiresAt` 是取码时刻加 180 秒;`dataUrl` 极端竞态下可能没有。 */
	| {
			status: "qr";
			phase: "ready" | "waiting-scan" | "waiting-confirm";
			dataUrl: string | undefined;
			expiresAt: string;
	  }
	/** 原 LOGGED_IN(含扫码刚成功、账号信息还没取到的那一小段)。 */
	| {
			status: "logged-in";
			reason: "loggedIn" | "loginJustSucceeded" | "fetchAccountFailed";
			loggedInAt: string;
			card?: UserCardInfo;
	  }
	/** 原 LOGIN_FAILED。 */
	| { status: "failed"; reason: LoginFailureKey };

/** 开机没确认的这句话(`confirming` 的两种情况之一)。 */
export const CHECKING_MESSAGE = "正在向 B 站确认登录状态，暂时连不上的话会自动重试";
/** 已扫码、等手机上点确认(`confirming` 的另一种情况)。 */
export const WAIT_CONFIRM_MESSAGE = "已扫码，请在手机上确认";
/** 已登录的会话失效了。 */
export const AUTH_LOST_MESSAGE = "账号登录已失效，请重新扫码登录";

/** 内部原形 → 对外的中立状态。纯函数。 */
export function authStateFromLoginState(state: BiliLoginState): AuthState {
	switch (state.status) {
		case "checking":
			return { status: "confirming", message: CHECKING_MESSAGE };
		case "logged-out":
			return state.reason === "authLost"
				? { status: "expired", message: AUTH_LOST_MESSAGE }
				: { status: "logged-out" };
		case "qr":
			if (state.phase === "waiting-confirm") {
				return { status: "confirming", message: WAIT_CONFIRM_MESSAGE };
			}
			// 没有图就没有东西可扫(只会出现在登出之后迟到的一拍轮询里)。
			if (state.dataUrl === undefined) return { status: "logged-out" };
			return {
				status: "awaiting-scan",
				qr: { dataUrl: state.dataUrl, expiresAt: state.expiresAt },
			};
		case "logged-in":
			return { status: "logged-in", loggedInAt: state.loggedInAt };
		case "failed":
			return { status: "error", message: MESSAGES[state.reason] };
	}
}
