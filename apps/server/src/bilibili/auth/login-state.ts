import type { AuthState } from "@bilibili-notify/internal";
import { type BiliDataServer, BiliLoginStatus, type UserCardInfo } from "../api/types.js";

/** 登录快照里每句人话的原因键。 */
export type LoginStatusMsgKey =
	| "loading"
	| "notLogin"
	| "authLost"
	| "loggedIn"
	| "loginJustSucceeded"
	| "fetchAccountFailed"
	| "waitScan"
	| "waitConfirm"
	| "qrFetchFailed"
	| "qrRenderFailed"
	| "qrExpired"
	| "qrInvalidated"
	| "noCookieAfterLogin"
	| "genericLoginFail";

export const MESSAGES: Record<LoginStatusMsgKey, string> = {
	loading: "正在加载登录信息...",
	notLogin: "账号未登录，请点击「扫码登录」",
	authLost: "账号登录已失效，请在控制台重新扫码登录",
	loggedIn: "已登录",
	loginJustSucceeded: "登录成功，正在加载订阅...",
	fetchAccountFailed: "账号已登录，但获取个人信息失败，请检查",
	waitScan: "尚未扫码，请扫码",
	waitConfirm: "已扫码，但尚未确认，请确认",
	qrFetchFailed: "获取二维码失败，请重试",
	qrRenderFailed: "生成二维码失败",
	qrExpired: "二维码已超时（3分钟），请重新登录",
	qrInvalidated: "二维码已失效，请重新登录",
	noCookieAfterLogin: "登录成功但未获取到 cookie，请重试",
	genericLoginFail: "登录失败，请重试",
};

/** 二维码登录失败的原因键(`failed` 状态里带的那几种)。 */
export type LoginFailureKey =
	| "qrFetchFailed"
	| "qrRenderFailed"
	| "qrExpired"
	| "qrInvalidated"
	| "noCookieAfterLogin"
	| "genericLoginFail";

/**
 * B 站登录状态机的内部原形。今天靠 `msg` 分的几种事在这里都是带类型的格:
 * 「没登录」与「登录失效」、「还没扫」与「已扫等确认」、六种失败原因。
 * 对外只交由它算出来的 {@link AuthState}(`authStateFromLoginState`);旧线上形状的快照由
 * `snapshotFromLoginState` 现算(临时,提交 ⑤ 删)。
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

/**
 * 内部原形 → 旧线上形状的快照(数值状态 + 今天那句 `msg` + `data`)。临时:面板与旧路由改读新口之后(提交 ⑤)删。
 * 从原形算、不从 `AuthState` 算,所以逐帧复刻今天的内容。
 */
export function snapshotFromLoginState(state: BiliLoginState): BiliDataServer {
	switch (state.status) {
		case "checking":
			return { status: BiliLoginStatus.LOADING_LOGIN_INFO, msg: MESSAGES.loading };
		case "logged-out":
			return { status: BiliLoginStatus.NOT_LOGIN, msg: MESSAGES[state.reason] };
		case "qr":
			if (state.phase === "ready") {
				return { status: BiliLoginStatus.LOGIN_QR, msg: "", data: state.dataUrl };
			}
			return {
				status: BiliLoginStatus.LOGGING_QR,
				msg: state.phase === "waiting-scan" ? MESSAGES.waitScan : MESSAGES.waitConfirm,
				data: state.dataUrl,
			};
		case "logged-in":
			return {
				status: BiliLoginStatus.LOGGED_IN,
				msg: MESSAGES[state.reason],
				data: state.card,
			};
		case "failed":
			return { status: BiliLoginStatus.LOGIN_FAILED, msg: MESSAGES[state.reason] };
	}
}
