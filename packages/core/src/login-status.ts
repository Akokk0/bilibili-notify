import {
	type BiliDataServer,
	BiliLoginStatus,
	type MySelfInfoData,
	type UserCardInfoData,
} from "@bilibili-notify/api";
import type { Context, Logger } from "koishi";

export type LoginStatusMsgKey =
	| "loading"
	| "notLogin"
	| "keyReset"
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

const MESSAGES: Record<LoginStatusMsgKey, string> = {
	loading: "正在加载登录信息...",
	notLogin: "账号未登录，请点击「扫码登录」",
	keyReset: "密钥已重置，cookie 已清除，请重新扫码登录",
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

export interface LoginStatusOptions {
	/** Periodic health-check cadence in ms. 0 disables. */
	healthCheckMs: number;
	logger: Logger;
	/** Probe used by the heartbeat; typically `() => api.getMyselfInfo()`. */
	probe: () => Promise<MySelfInfoData>;
}

/** 类型守卫：snapshot.data 是否长得像 UserCardInfoData["data"]。 */
function looksLikeCardData(data: unknown): boolean {
	return typeof data === "object" && data !== null && "card" in data;
}

/**
 * 集中管理登录态：所有变更都经过这里，再以 `bilibili-notify/login-status-report`
 * 推到前端。心跳定时器在登录态下定期 probe，发现失效会同时广播
 * `bilibili-notify/auth-lost`，恢复时广播 `bilibili-notify/auth-restored`。
 */
export class LoginStatusController {
	private snapshot: BiliDataServer = {
		status: BiliLoginStatus.LOADING_LOGIN_INFO,
		msg: MESSAGES.loading,
	};
	private healthTimer?: () => void;
	/**
	 * 标记"曾从已登录态掉线"，下一次成功登录时翻转为已登录后才发 auth-restored。
	 * 之所以不再用"上一帧 status === NOT_LOGIN"判断：失效后用户走扫码流程，会经过
	 * LOGIN_QR / LOGGING_QR 等中间态，直接基于上一帧会漏掉这条恢复路径。
	 */
	private needsRestore = false;

	constructor(
		private readonly ctx: Context,
		private readonly options: LoginStatusOptions,
	) {}

	current(): BiliDataServer {
		return { ...this.snapshot };
	}

	attachHealthCheck(): void {
		this.detachHealthCheck();
		if (this.options.healthCheckMs <= 0) return;
		this.healthTimer = this.ctx.setInterval(
			() => void this.runHealthCheck(),
			this.options.healthCheckMs,
		);
	}

	detachHealthCheck(): void {
		this.healthTimer?.();
		this.healthTimer = undefined;
	}

	// ---- Reporters ----

	reportLoggedIn(card?: UserCardInfoData["data"], reasonKey: LoginStatusMsgKey = "loggedIn"): void {
		const wasLoggedIn = this.snapshot.status === BiliLoginStatus.LOGGED_IN;
		// 仅当 snapshot.data 看起来是 card 形态时才作为 fallback 沿用。否则
		// （如 LOGIN_QR 留下的 base64 字符串）就清空，避免给前端假数据。
		const fallback = looksLikeCardData(this.snapshot.data) ? this.snapshot.data : undefined;
		this.transition({
			status: BiliLoginStatus.LOGGED_IN,
			msg: MESSAGES[reasonKey],
			data: card ?? fallback,
		});
		if (!wasLoggedIn && this.needsRestore) {
			this.needsRestore = false;
			this.ctx.emit("bilibili-notify/auth-restored");
		}
	}

	reportLoggedOut(reasonKey: LoginStatusMsgKey = "notLogin"): void {
		const wasLoggedIn = this.snapshot.status === BiliLoginStatus.LOGGED_IN;
		this.transition({
			status: BiliLoginStatus.NOT_LOGIN,
			msg: MESSAGES[reasonKey],
		});
		if (wasLoggedIn) {
			this.needsRestore = true;
			this.ctx.emit("bilibili-notify/auth-lost");
		}
	}

	/** Dispatch on `getMyselfInfo` result code. */
	reportLoginCheck(code: number, card?: UserCardInfoData["data"]): void {
		if (code === 0) {
			this.reportLoggedIn(card);
		} else if (code === -101) {
			this.reportLoggedOut("authLost");
		} else {
			this.reportTransientFailure(`code=${code}`);
		}
	}

	/** Keep current status, only refresh msg. Logs at warn level. */
	reportTransientFailure(detail: unknown): void {
		this.options.logger.warn(`[auth] 瞬时失败：${detail}`);
		if (this.snapshot.status !== BiliLoginStatus.LOGGED_IN) return;
		this.transition({ ...this.snapshot, msg: MESSAGES.fetchAccountFailed });
	}

	reportQrReady(base64: string): void {
		this.transition({ status: BiliLoginStatus.LOGIN_QR, msg: "", data: base64 });
	}

	reportQrPending(reasonKey: "waitScan" | "waitConfirm"): void {
		this.transition({ status: BiliLoginStatus.LOGGING_QR, msg: MESSAGES[reasonKey] });
	}

	reportQrFailure(reasonKey: LoginStatusMsgKey): void {
		this.transition({ status: BiliLoginStatus.LOGIN_FAILED, msg: MESSAGES[reasonKey] });
	}

	// ---- Internal ----

	/** Emit only when (status, msg, data) changes. */
	private transition(next: BiliDataServer): void {
		if (
			this.snapshot.status === next.status &&
			this.snapshot.msg === next.msg &&
			this.snapshot.data === next.data
		) {
			return;
		}
		this.snapshot = next;
		this.ctx.emit("bilibili-notify/login-status-report", next);
	}

	private async runHealthCheck(): Promise<void> {
		const skip =
			this.snapshot.status === BiliLoginStatus.LOGIN_QR ||
			this.snapshot.status === BiliLoginStatus.LOGGING_QR ||
			this.snapshot.status === BiliLoginStatus.NOT_LOGIN;
		if (skip) return;

		try {
			const res = await this.options.probe();
			this.reportLoginCheck(res.code);
		} catch (e) {
			this.options.logger.warn(`[auth] 心跳异常（保持当前状态）：${e}`);
		}
	}
}
