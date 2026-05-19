import type { Disposable, Logger, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import type { BilibiliAPI } from "./bilibili-api";
import {
	type BiliDataServer,
	BiliLoginStatus,
	type MySelfInfoData,
	type UserCardInfo,
} from "./types";

/** Reason keys driving the user-facing message in a snapshot transition. */
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

/** Snapshot of the current login state — alias of BiliDataServer for API consumers. */
export type LoginSnapshot = BiliDataServer;

/** Outcome of a single QR poll tick. The bridge does not need to act on this directly. */
export type LoginPollResult =
	| { kind: "pending"; reason: "waitScan" | "waitConfirm" }
	| { kind: "success" }
	| { kind: "failed"; reason: LoginStatusMsgKey };

export interface LoginFlowOptions {
	serviceCtx: ServiceContext;
	api: BilibiliAPI;
	bus: MessageBus;
	/** Periodic auth probe cadence in ms. 0 disables the heartbeat. */
	healthCheckMs: number;
	/** Persist refreshed/just-issued cookies. Called by the post-login handshake. */
	saveCookies: (data: CookieData) => Promise<void>;
}

/** True if `data` is shaped like a UserCardInfo (vs. the base64 QR string left over from LOGIN_QR). */
function looksLikeCardData(data: unknown): boolean {
	return typeof data === "object" && data !== null && "card" in data;
}

/** QR has a 3-minute server-side validity window. */
const QR_TIMEOUT_MS = 3 * 60 * 1000;
/** Poll cadence while a QR is alive. */
const QR_POLL_MS = 1000;
/** Debounce for transient master notifications driven by `auth-lost`. */
const AUTH_LOST_NOTIFY_DEBOUNCE_MS = 60_000;

/**
 * Platform-neutral login state machine + QR session driver. Owns:
 *
 * - The single-source `LoginSnapshot` (transitions emit `login-status-report` over the MessageBus).
 * - Periodic auth probe (`getMyselfInfo`) keyed on `healthCheckMs`.
 * - QR-code request → polling → cookie save handshake.
 *
 * Adapter-side concerns (rendering the QR image, sending master notifications) stay outside.
 */
export class LoginFlow {
	private readonly serviceCtx: ServiceContext;
	private readonly api: BilibiliAPI;
	private readonly bus: MessageBus;
	private healthCheckMs: number;
	private readonly saveCookies: (data: CookieData) => Promise<void>;
	private readonly logger: Logger;

	private snapshot: LoginSnapshot = {
		status: BiliLoginStatus.LOADING_LOGIN_INFO,
		msg: MESSAGES.loading,
	};
	private healthTimer?: Disposable;
	private loginTimer?: Disposable;
	private loginExpiryTimer?: Disposable;
	/**
	 * Marks "we were once logged in but transitioned out". On the next successful login the flag
	 * is flipped and `auth-restored` fires. Avoids relying on the previous frame's status, which
	 * would miss the path NOT_LOGIN → LOGIN_QR → LOGGING_QR → LOGGED_IN.
	 */
	private needsRestore = false;

	constructor(opts: LoginFlowOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.api = opts.api;
		this.bus = opts.bus;
		this.healthCheckMs = opts.healthCheckMs;
		this.saveCookies = opts.saveCookies;
		this.logger = opts.serviceCtx.logger;
	}

	/** Lifecycle hook for adapter symmetry. No initial work required today. */
	async start(): Promise<void> {
		// no-op; cookies are loaded by the adapter; reportAccountInfo() is the actual entry.
	}

	/** Tear down all timers. Idempotent. */
	stop(): void {
		this.detachHealthCheck();
		this.clearLoginTimer();
		this.clearLoginExpiryTimer();
	}

	/** Read the current snapshot (cloned). */
	current(): LoginSnapshot {
		return { ...this.snapshot };
	}

	/**
	 * Probe `getMyselfInfo`, transition snapshot accordingly, and attach the periodic health check.
	 * Network failures keep the current status (transient) and are logged at warn.
	 */
	async reportAccountInfo(): Promise<void> {
		let personalInfo: MySelfInfoData;
		try {
			personalInfo = await this.api.getMyselfInfo();
		} catch (e) {
			this.logger.warn(`[account] 获取个人信息异常: ${e}`);
			this.reportTransientFailure(e);
			this.attachHealthCheck();
			return;
		}
		if (personalInfo.code !== 0) {
			this.reportLoginCheck(personalInfo.code);
			if (personalInfo.code !== -101) this.attachHealthCheck();
			return;
		}
		let card: UserCardInfo | undefined;
		try {
			const cardInfo = await this.api.getUserCardInfo(personalInfo.data.mid.toString(), true);
			card = cardInfo.data;
		} catch (e) {
			this.logger.warn(`[account] 获取用户卡片失败: ${e}`);
		}
		this.reportLoggedIn(card);
		this.attachHealthCheck();
	}

	/** Mark the session as logged-out due to upstream session invalidation. */
	async handleAuthLost(): Promise<void> {
		this.reportLoggedOut("authLost");
	}

	/** Mark the session as logged-out for a specific reason. */
	reportLoggedOut(reasonKey: LoginStatusMsgKey = "notLogin"): void {
		const wasLoggedIn = this.snapshot.status === BiliLoginStatus.LOGGED_IN;
		// P2:登出后心跳无意义(runHealthCheck 对 NOT_LOGIN 直接 return),
		// 此前不 detach,setInterval 空转到 stop()。重新登录路径会再 attach。
		this.detachHealthCheck();
		this.transition({
			status: BiliLoginStatus.NOT_LOGIN,
			msg: MESSAGES[reasonKey],
		});
		if (wasLoggedIn) {
			this.needsRestore = true;
			this.bus.emit("auth-lost");
		}
	}

	/**
	 * Begin a fresh QR-login session. Internally:
	 * 1. Fetches a QR url + qrcodeKey from the API.
	 * 2. Asks the caller to render the QR url to a base64 data URL (UI concern).
	 * 3. Drives polling at 1Hz; on success persists cookies and probes account info.
	 * 4. Auto-times-out after 3 minutes.
	 */
	async beginLogin(renderQr: (url: string) => Promise<string>): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let qrContent: any;
		try {
			qrContent = await this.api.getLoginQRCode();
		} catch (e) {
			this.logger.warn(`[login] 获取登录二维码失败：${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (qrContent.code !== 0) {
			this.reportQrFailure("qrFetchFailed");
			return;
		}

		try {
			const dataUrl = await renderQr(qrContent.data.url);
			this.reportQrReady(dataUrl);
		} catch (e) {
			this.logger.warn(`[login] 生成二维码失败：${e instanceof Error ? e.message : String(e)}`);
			this.reportQrFailure("qrRenderFailed");
			return;
		}

		this.clearLoginTimer();
		let polling = true;
		this.loginTimer = this.serviceCtx.setInterval(async () => {
			if (!polling) return;
			polling = false;
			try {
				await this.pollOnce(qrContent.data.qrcode_key);
			} finally {
				polling = true;
			}
		}, QR_POLL_MS);

		this.clearLoginExpiryTimer();
		this.loginExpiryTimer = this.serviceCtx.setTimeout(() => {
			if (!this.loginTimer) return;
			this.clearLoginTimer();
			this.reportQrFailure("qrExpired");
		}, QR_TIMEOUT_MS);
	}

	/**
	 * Run a single QR-status poll. On success, the cookie save handshake runs
	 * and `reportAccountInfo` is invoked, transitioning to LOGGED_IN.
	 */
	private async pollOnce(qrcodeKey: string): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let loginContent: any;
		try {
			loginContent = await this.api.getLoginStatus(qrcodeKey);
		} catch (e) {
			this.logger.warn(`[login] 获取登录状态失败：${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		const code: number = loginContent?.data?.code;

		if (code === 86101) {
			this.reportQrPending("waitScan");
			return;
		}
		if (code === 86090) {
			this.reportQrPending("waitConfirm");
			return;
		}
		if (code === 86038) {
			this.clearLoginTimers();
			this.reportQrFailure("qrInvalidated");
			return;
		}
		if (code === 0) {
			this.clearLoginTimers();
			const cookiesJson = this.api.getCookiesJson();
			if (!cookiesJson || cookiesJson === "[]") {
				this.logger.error("[login] 登录成功但未获取到任何 cookie，放弃保存");
				this.reportQrFailure("noCookieAfterLogin");
				return;
			}
			try {
				const refreshToken = (loginContent.data.refresh_token as string | undefined) ?? "";
				if (!refreshToken) {
					// P2:此前静默 `?? ""`,loadCookies 见空串跳过 refresh 链 →
					// 会话到期前无任何刷新、过期才靠心跳 -101 兜出 auth-lost。
					// 至少响亮告警让运维知道这次登录拿不到自动续期。
					this.logger.warn(
						"[login] 登录成功但响应未含 refresh_token —— cookie 自动刷新不可用,会话到期需手动重新登录",
					);
				}
				await this.saveCookies({ cookiesJson, refreshToken });
			} catch (e) {
				this.logger.error(`[login] 保存 cookie 失败：${e}`);
			}
			this.reportLoggedIn(undefined, "loginJustSucceeded");
			await this.reportAccountInfo();
			return;
		}
		if (loginContent?.code !== 0) {
			this.clearLoginTimers();
			this.reportQrFailure("genericLoginFail");
			return;
		}
		// P2:外层 code 0 但 data.code 不在已知集合(86101/86090/86038/0)。
		// 已知态都已 return,走到这:数值 = 稳定未知鉴权态 → 快速失败(此前
		// 静默每秒 no-op 直到 3min 过期);非数值 = data 缺失等瞬时 → 继续轮询
		// (容忍一次抖动,3min 过期兜底)。
		if (typeof code === "number") {
			this.logger.warn(`[login] QR 轮询返回未知 data.code=${code},判定登录失败`);
			this.clearLoginTimers();
			this.reportQrFailure("genericLoginFail");
		}
	}

	// ---- Internal reporters (drive snapshot transitions) ----

	private reportLoggedIn(card?: UserCardInfo, reasonKey: LoginStatusMsgKey = "loggedIn"): void {
		const wasLoggedIn = this.snapshot.status === BiliLoginStatus.LOGGED_IN;
		const fallback = looksLikeCardData(this.snapshot.data) ? this.snapshot.data : undefined;
		this.transition({
			status: BiliLoginStatus.LOGGED_IN,
			msg: MESSAGES[reasonKey],
			data: card ?? fallback,
		});
		if (!wasLoggedIn && this.needsRestore) {
			this.needsRestore = false;
			this.bus.emit("auth-restored");
		}
	}

	private reportLoginCheck(code: number, card?: UserCardInfo): void {
		if (code === 0) {
			this.reportLoggedIn(card);
		} else if (code === -101) {
			this.reportLoggedOut("authLost");
		} else {
			this.reportTransientFailure(`code=${code}`);
		}
	}

	private reportTransientFailure(detail: unknown): void {
		this.logger.warn(`[auth] 瞬时失败：${detail}`);
		if (this.snapshot.status !== BiliLoginStatus.LOGGED_IN) return;
		this.transition({ ...this.snapshot, msg: MESSAGES.fetchAccountFailed });
	}

	private reportQrReady(base64: string): void {
		this.transition({ status: BiliLoginStatus.LOGIN_QR, msg: "", data: base64 });
	}

	private reportQrPending(reasonKey: "waitScan" | "waitConfirm"): void {
		// Preserve `data` (the base64 QR image) across the LOGIN_QR → LOGGING_QR
		// transition. The QR remains useful to the user until they confirm on
		// phone — without this carry-over the dashboard shows "二维码加载中" the
		// instant polling kicks in.
		this.transition({
			status: BiliLoginStatus.LOGGING_QR,
			msg: MESSAGES[reasonKey],
			data: this.snapshot.data,
		});
	}

	private reportQrFailure(reasonKey: LoginStatusMsgKey): void {
		this.transition({ status: BiliLoginStatus.LOGIN_FAILED, msg: MESSAGES[reasonKey] });
	}

	/** Emit only when (status, msg, data) changes. */
	private transition(next: LoginSnapshot): void {
		if (
			this.snapshot.status === next.status &&
			this.snapshot.msg === next.msg &&
			this.snapshot.data === next.data
		) {
			return;
		}
		this.snapshot = next;
		this.bus.emit("login-status-report", next);
	}

	// ---- Health check ----

	/**
	 * 热替换登录健康检查间隔。adapter 在 dashboard 编辑 `app.healthCheckMinutes`
	 * 后调用,会 dispose 旧定时器并按新间隔重 arm。`<=0` 等价于关闭健康检查。
	 */
	setHealthCheckMs(ms: number): void {
		if (this.healthCheckMs === ms) return;
		this.healthCheckMs = ms;
		this.attachHealthCheck();
	}

	private attachHealthCheck(): void {
		this.detachHealthCheck();
		if (this.healthCheckMs <= 0) return;
		this.healthTimer = this.serviceCtx.setInterval(
			() => void this.runHealthCheck(),
			this.healthCheckMs,
		);
	}

	private detachHealthCheck(): void {
		this.healthTimer?.dispose();
		this.healthTimer = undefined;
	}

	private async runHealthCheck(): Promise<void> {
		const skip =
			this.snapshot.status === BiliLoginStatus.LOGIN_QR ||
			this.snapshot.status === BiliLoginStatus.LOGGING_QR ||
			this.snapshot.status === BiliLoginStatus.NOT_LOGIN;
		if (skip) return;
		try {
			const res = await this.api.getMyselfInfo();
			this.reportLoginCheck(res.code);
		} catch (e) {
			this.logger.warn(`[auth] 心跳异常（保持当前状态）：${e}`);
		}
	}

	// ---- Timer disposal helpers ----

	private clearLoginTimer(): void {
		this.loginTimer?.dispose();
		this.loginTimer = undefined;
	}

	/**
	 * P2:轮询终态(86038 失效 / code 0 成功 / genericLoginFail)应同时清掉
	 * 3min 过期 setTimeout。此前只 clearLoginTimer,过期定时器泄漏挂到 expiry
	 * 才空跑一次 no-op(`if (!this.loginTimer) return`),其间持有闭包。
	 */
	private clearLoginTimers(): void {
		this.clearLoginTimer();
		this.clearLoginExpiryTimer();
	}

	private clearLoginExpiryTimer(): void {
		this.loginExpiryTimer?.dispose();
		this.loginExpiryTimer = undefined;
	}
}

/** Re-exported constant for adapter-side rate limiting; matches the legacy core debounce. */
export const LOGIN_FLOW_AUTH_LOST_NOTIFY_DEBOUNCE_MS = AUTH_LOST_NOTIFY_DEBOUNCE_MS;
