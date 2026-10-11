import {
	type AuthState,
	type Disposable,
	fail,
	type ImageRef,
	type Logger,
	type MessageBus,
	ok,
	type Result,
	type ServiceContext,
} from "@bilibili-notify/internal";
import QRCode from "qrcode";
import { errorMessageOf } from "../../util/error-message.js";
import type { Api } from "../api/api";
import type { BiliDataServer, MyselfResponse, UserCardInfo } from "../api/types";
import {
	authStateFromLoginState,
	type BiliLoginState,
	type LoginFailureKey,
	MESSAGES,
	snapshotFromLoginState,
} from "./login-state.js";

/** Snapshot of the current login state — alias of BiliDataServer for API consumers. */
export type LoginSnapshot = BiliDataServer;

export interface LoginFlowOptions {
	serviceCtx: ServiceContext;
	api: Api;
	bus: MessageBus;
	/** Periodic auth probe cadence in ms. 0 disables the heartbeat. */
	healthCheckMs: number;
	/**
	 * 把账号头像抓进图库,回引用;抓不到回 `undefined`、不抛。不给就不抓头像。
	 * 抓头像是登录状态之外的一条后台线:它失败、迟到都不碰登录状态。
	 */
	fetchAvatar?: (url: string) => Promise<ImageRef | undefined>;
}

/** QR has a 3-minute server-side validity window. */
const QR_TIMEOUT_MS = 3 * 60 * 1000;
/** Poll cadence while a QR is alive. */
const QR_POLL_MS = 1000;

/**
 * Platform-neutral login state machine + QR session driver. Owns:
 *
 * - The single-source `LoginSnapshot` (transitions emit `login-status-report` over the MessageBus).
 * - Periodic auth probe (`fetchMyselfInfo`) keyed on `healthCheckMs`.
 * - QR-code request → polling → cookie save handshake.
 *
 * Adapter-side concerns (sending master notifications) stay outside.
 */

async function defaultRenderQr(url: string): Promise<string> {
	const buffer = await QRCode.toBuffer(url, {
		errorCorrectionLevel: "H",
		type: "png",
		margin: 1,
		color: { dark: "#000000", light: "#FFFFFF" },
	});
	return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

export class LoginFlow {
	private readonly serviceCtx: ServiceContext;
	private readonly api: Api;
	private readonly bus: MessageBus;
	private healthCheckMs: number;
	private readonly logger: Logger;

	/** 内部原形;对外的 `AuthState` 与旧快照都由它算出来。 */
	private state: BiliLoginState = { status: "checking" };
	private readonly fetchAvatar?: (url: string) => Promise<ImageRef | undefined>;
	/** 抓成功的头像:`url` 是那张图的来源地址,`ref` 是图库引用。只在内存。 */
	private avatar?: { url: string; ref: ImageRef };
	/** 正在抓的那一次(按登出代数 + 地址认),同一次不重复发。 */
	private avatarFetching?: { gen: number; url: string };
	private readonly changeListeners = new Set<() => void>();
	/** 上一次叫 `onChange` 时的(状态,账号);两样都没变就不叫。 */
	private lastNotified: string;
	private healthTimer?: Disposable;
	private loginTimer?: Disposable;
	private loginExpiryTimer?: Disposable;
	/**
	 * 扫码期间罐子不自动存的闸:登录回应的 Set-Cookie 在响应头到的那一刻就进了罐子,令牌却要等响应体,
	 * 这中间自动存到点的话盘上就是「新会话的 cookie + 上一个会话的令牌」。随轮询一起收(`clearLoginTimer`);
	 * 成功那一支把它摘出来、提交之后才放。
	 */
	private loginHold?: Disposable;
	/**
	 * Marks "we are unauthenticated, so something downstream may be parked waiting". On the next
	 * successful login the flag is flipped and `auth-restored` fires. Avoids relying on the
	 * previous frame's status, which would miss the path NOT_LOGIN → LOGIN_QR → LOGGING_QR →
	 * LOGGED_IN.
	 *
	 * Deliberately NOT gated on having been LOGGED_IN first. Engines park themselves the moment
	 * they hit -101 on their own — the dynamic detector stops its cron and waits for
	 * `auth-restored` — and that happens on a cold start with stale cookies, where this flow goes
	 * LOADING_LOGIN_INFO → NOT_LOGIN without ever emitting `auth-lost`. Gating the flag on a prior
	 * LOGGED_IN left those engines parked forever after the user re-scanned the QR.
	 *
	 * The cost is one redundant `auth-restored` after a first-ever login. Every consumer reseeds
	 * from the current subscription set (restart detection / rebuildFromSubs / follow-sync), so a
	 * spurious one is wasted work, never corruption.
	 */
	private needsRestore = false;
	/**
	 * 每次 `reportLoggedOut` 递增。在途探活在入口捕获它,落地前比对 —— 不一致说明
	 * 这份结果问的是一个已经作废的会话,整份丢掉。
	 *
	 * 没有它会怎样(2026-07-27 线上实况):cookie 刷新链拿到 `-101`,拦截器同步发
	 * `auth-lost`,动态检测暂停、直播间连接全关;**33 毫秒后**,一次在会话被判死
	 * **之前**就发出去的探活带着 `code 0` 回来,`reportLoggedIn` 只看「上一帧不是
	 * LOGGED_IN」+「needsRestore」,于是把快照推回 LOGGED_IN 并发一条 `auth-restored`。
	 * 下游照单全收:重建直播监听、重启动态检测、补关注 —— 全部再撞一遍 `-101`,
	 * 主人的私聊被刷屏,「账号登录已失效」还连发两条。
	 *
	 * 这个窗口不是理论上的:健康检查默认 30 分钟、cookie 刷新固定 60 分钟,两者
	 * 每小时对齐一次,而刷新是四次网络往返的长链,探活很容易正卡在里面。
	 *
	 * `Api.refreshGeneration` 对 cookie 刷新做的是同一件事,这里补的是
	 * 登录流那一半。
	 */
	private authGeneration = 0;

	constructor(opts: LoginFlowOptions) {
		this.serviceCtx = opts.serviceCtx;
		this.api = opts.api;
		this.bus = opts.bus;
		this.healthCheckMs = opts.healthCheckMs;
		this.logger = opts.serviceCtx.logger;
		this.fetchAvatar = opts.fetchAvatar;
		this.lastNotified = this.changeKey();
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
		return snapshotFromLoginState(this.state);
	}

	/** 此刻对外的中立状态,同步、不出网。 */
	authState(): AuthState {
		return authStateFromLoginState(this.state);
	}

	/** 登录着的账号;没登录或还没取到卡片是 null。头像抓进图库之后才有 `avatar`。 */
	account(): { name: string; avatar?: ImageRef } | null {
		const s = this.state;
		if (s.status !== "logged-in" || !s.card) return null;
		const avatar =
			this.avatar && this.avatar.url === s.card.card.face ? this.avatar.ref : undefined;
		return avatar === undefined ? { name: s.card.card.name } : { name: s.card.card.name, avatar };
	}

	/** 状态或账号可能变了就叫一声(两样都没变不叫);要做事自己再读 `authState()` / `account()`。 */
	onChange(fn: () => void): Disposable {
		this.changeListeners.add(fn);
		return { dispose: () => void this.changeListeners.delete(fn) };
	}

	private changeKey(): string {
		return JSON.stringify([this.authState(), this.account()]);
	}

	private notifyIfChanged(): void {
		const key = this.changeKey();
		if (key === this.lastNotified) return;
		this.lastNotified = key;
		for (const fn of [...this.changeListeners]) {
			try {
				fn();
			} catch (e) {
				this.logger.warn(`[auth] 状态变化的订阅方抛错: ${errorMessageOf(e)}`);
			}
		}
	}

	/**
	 * Probe `fetchMyselfInfo`, transition snapshot accordingly, and attach the periodic health check.
	 * Network failures keep the current status (transient) and are logged at warn.
	 */
	async reportAccountInfo(): Promise<void> {
		const gen = this.authGeneration;
		let personalInfo: MyselfResponse;
		try {
			personalInfo = await this.api.fetchMyselfInfo();
		} catch (e) {
			if (this.supersededSince(gen)) return;
			this.logger.warn(`[account] 获取个人信息异常: ${e}`);
			this.reportTransientFailure(e);
			this.attachHealthCheck();
			return;
		}
		if (this.supersededSince(gen)) return;
		if (personalInfo.code !== 0) {
			this.reportLoginCheck(personalInfo.code);
			if (personalInfo.code !== -101) this.attachHealthCheck();
			return;
		}
		let card: UserCardInfo | undefined;
		try {
			const cardInfo = await this.api.fetchUserCard(personalInfo.data.mid.toString(), true);
			card = cardInfo.data;
		} catch (e) {
			this.logger.warn(`[account] 获取用户卡片失败: ${e}`);
		}
		// 取卡片是第二次网络往返,窗口和探活那次一样宽 —— 必须再比一次。
		if (this.supersededSince(gen)) return;
		this.reportLoggedIn(card);
		this.attachHealthCheck();
		// 头像在登录状态确定之后另起一条后台线,不等它。
		this.maybeFetchAvatar();
	}

	/**
	 * 登录着且有卡片、而头像还没抓成(或网址变了)时,另起一条后台活把头像抓进图库。
	 * 抓不到:账号照常、头像缺着,**不碰登录状态**(这条路上没有任何一处会走到 `reportLoggedOut` /
	 * `reportTransientFailure`)。回来时核「还是不是当初那段登录、那个头像网址」,不是就整份丢掉。
	 */
	private maybeFetchAvatar(): void {
		const fetchAvatar = this.fetchAvatar;
		const s = this.state;
		if (!fetchAvatar || s.status !== "logged-in" || !s.card) return;
		const url = s.card.card.face;
		if (!url || this.avatar?.url === url) return;
		const gen = this.authGeneration;
		if (this.avatarFetching?.gen === gen && this.avatarFetching.url === url) return;
		const mine = { gen, url };
		this.avatarFetching = mine;
		const task = (async () => {
			try {
				const ref = await fetchAvatar(url);
				if (this.avatarFetching === mine) this.avatarFetching = undefined;
				if (ref === undefined || gen !== this.authGeneration) return;
				const now = this.state;
				if (now.status !== "logged-in" || now.card?.card.face !== url) return;
				this.avatar = { url, ref };
				this.notifyIfChanged();
			} catch (e) {
				if (this.avatarFetching === mine) this.avatarFetching = undefined;
				this.logger.warn(`[account] 头像抓取出错，这一轮没有头像: ${errorMessageOf(e)}`);
			}
		})();
		this.serviceCtx.track(task);
	}

	/**
	 * 本轮探活是否已被一次登出作废。`true` = 结果不作数,调用方原样返回:
	 * 既不动快照,也**不重挂心跳**(`reportLoggedOut` 是刻意把心跳摘掉的)。
	 */
	private supersededSince(gen: number): boolean {
		if (gen === this.authGeneration) return false;
		this.logger.debug("[auth] 探活结果已被一次登出取代，丢弃本轮");
		return true;
	}

	/** Mark the session as logged-out due to upstream session invalidation. */
	async handleAuthLost(): Promise<void> {
		this.reportLoggedOut("authLost");
	}

	/** Mark the session as logged-out for a specific reason. */
	reportLoggedOut(reasonKey: "notLogin" | "authLost" = "notLogin"): void {
		const wasLoggedIn = this.state.status === "logged-in";
		// P2:登出后心跳无意义(runHealthCheck 对 NOT_LOGIN 直接 return),
		// 此前不 detach,setInterval 空转到 stop()。重新登录路径会再 attach。
		this.detachHealthCheck();
		this.transition({ status: "logged-out", reason: reasonKey });
		// 进了 NOT_LOGIN 就要记账,与之前是不是 LOGGED_IN 无关 —— 冷启动时 cookie
		// 已过期的话这里是 LOADING_LOGIN_INFO → NOT_LOGIN,而引擎照样会自己撞上
		// -101 并停下等 auth-restored。
		this.needsRestore = true;
		// 作废任何在途探活 —— 它们问的是刚死掉的那个会话,迟到的 code 0 不得
		// 把快照推回 LOGGED_IN(更不得由此发出一条假的 auth-restored)。
		this.authGeneration++;
		// auth-lost 仍只在真的丢掉一个好会话时发:它的消费方是 teardown,
		// 拆一个从没建起来的引擎没有意义。
		if (wasLoggedIn) {
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
	async beginLogin(renderQr: (url: string) => Promise<string> = defaultRenderQr): Promise<Result> {
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let qrContent: any;
		try {
			qrContent = await this.api.fetchLoginQrCode();
		} catch (e) {
			// 取码请求没到 B 站:状态不动(一次网络抖动不该把一个好会话在面板上盖成出错),只让调用方知道。
			this.logger.warn(`[login] 获取登录二维码失败：${errorMessageOf(e)}`);
			return fail("unavailable", MESSAGES.qrFetchFailed);
		}
		if (qrContent.code !== 0) {
			this.reportQrFailure("qrFetchFailed");
			const upstreamCode: number = qrContent.code;
			// -352 / -403 是 B 站的风控:稍后再来,与「接口坏了」分开。
			const code = upstreamCode === -352 || upstreamCode === -403 ? "rate_limited" : "unavailable";
			return fail(code, MESSAGES.qrFetchFailed, { upstreamCode });
		}

		try {
			const dataUrl = await renderQr(qrContent.data.url);
			this.reportQrReady(dataUrl);
		} catch (e) {
			this.logger.warn(`[login] 生成二维码失败：${errorMessageOf(e)}`);
			this.reportQrFailure("qrRenderFailed");
			return fail("unavailable", MESSAGES.qrRenderFailed);
		}

		this.clearLoginTimer();
		this.loginHold = this.api.holdLoginSaves();
		let polling = true;
		this.loginTimer = this.serviceCtx.setInterval(async () => {
			if (!polling) return;
			polling = false;
			// 登记进 track:扫码成功的那一拍会把 cookie 与令牌提交进集成的密钥存储,关停得等它落完再让各写道
			// 关门。失败在交进去之前接住(以前这里是裸的 async 回调,抛错就是一次 unhandledRejection)。
			const poll = this.pollOnce(qrContent.data.qrcode_key)
				.catch((e) => {
					this.logger.warn(`[login] 二维码轮询出错：${e instanceof Error ? e.message : String(e)}`);
				})
				.finally(() => {
					polling = true;
				});
			this.serviceCtx.track(poll);
			await poll;
		}, QR_POLL_MS);

		this.clearLoginExpiryTimer();
		this.loginExpiryTimer = this.serviceCtx.setTimeout(() => {
			if (!this.loginTimer) return;
			this.clearLoginTimer();
			this.reportQrFailure("qrExpired");
		}, QR_TIMEOUT_MS);
		return ok();
	}

	/**
	 * Run a single QR-status poll. On success, the cookie save handshake runs
	 * and `reportAccountInfo` is invoked, transitioning to LOGGED_IN.
	 */
	private async pollOnce(qrcodeKey: string): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let loginContent: any;
		try {
			loginContent = await this.api.fetchLoginStatus(qrcodeKey);
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
			// 扫码那道闸摘出来:收轮询定时器时不放它,提交(不论成败)之后才放。
			const hold = this.loginHold;
			this.loginHold = undefined;
			this.clearLoginTimers();
			try {
				const cookiesJson = this.api.getCookiesJson();
				if (!cookiesJson || cookiesJson === "[]") {
					this.logger.error("[login] 登录成功但未获取到任何 cookie，放弃保存");
					this.reportQrFailure("noCookieAfterLogin");
					return;
				}
				const refreshToken = (loginContent.data.refresh_token as string | undefined) ?? "";
				if (!refreshToken) {
					// P2:此前静默 `?? ""`,会话到期前无任何刷新、过期才靠心跳 -101 兜出 auth-lost。
					// 至少响亮告警让运维知道这次登录拿不到自动续期。
					this.logger.warn(
						"[login] 登录成功但响应未含 refresh_token —— cookie 自动刷新不可用,会话到期需手动重新登录",
					);
				}
				const saved = await this.api.commitLogin(refreshToken || undefined);
				if (!saved.ok) this.logger.error(`[login] 保存登录状态失败：${saved.message}`);
			} finally {
				hold?.dispose();
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

	private reportLoggedIn(
		card?: UserCardInfo,
		reasonKey: "loggedIn" | "loginJustSucceeded" = "loggedIn",
	): void {
		const prev = this.state;
		const wasLoggedIn = prev.status === "logged-in";
		const fallback = prev.status === "logged-in" ? prev.card : undefined;
		this.transition({
			status: "logged-in",
			reason: reasonKey,
			// 同一段登录里再进已登录不换时刻(卡片补到、瞬时失败后恢复都不算新登录)。
			loggedInAt: prev.status === "logged-in" ? prev.loggedInAt : new Date().toISOString(),
			card: card ?? fallback,
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
		if (this.state.status !== "logged-in") return;
		this.transition({ ...this.state, reason: "fetchAccountFailed" });
	}

	private reportQrReady(base64: string): void {
		this.transition({
			status: "qr",
			phase: "ready",
			dataUrl: base64,
			expiresAt: new Date(Date.now() + QR_TIMEOUT_MS).toISOString(),
		});
	}

	private reportQrPending(reasonKey: "waitScan" | "waitConfirm"): void {
		// Preserve the QR image (and its expiry) across the LOGIN_QR → LOGGING_QR
		// transition. The QR remains useful to the user until they confirm on
		// phone — without this carry-over the dashboard shows "二维码加载中" the
		// instant polling kicks in.
		const prev = this.state;
		this.transition({
			status: "qr",
			phase: reasonKey === "waitScan" ? "waiting-scan" : "waiting-confirm",
			dataUrl: prev.status === "qr" ? prev.dataUrl : undefined,
			expiresAt:
				prev.status === "qr" ? prev.expiresAt : new Date(Date.now() + QR_TIMEOUT_MS).toISOString(),
		});
	}

	private reportQrFailure(reasonKey: LoginFailureKey): void {
		this.transition({ status: "failed", reason: reasonKey });
	}

	/**
	 * 旧线上形状的去重判据:旧快照的(数值状态, 话, data)三格有变才发 `login-status-report`(⑤ 随旧快照一起删)。
	 * 新判据(对外状态与账号结构相等就不叫)在 {@link notifyIfChanged},两套各管各的。
	 */
	private transition(next: BiliLoginState): void {
		const before = snapshotFromLoginState(this.state);
		const after = snapshotFromLoginState(next);
		if (before.status === after.status && before.msg === after.msg && before.data === after.data) {
			return;
		}
		this.state = next;
		// 离开已登录就忘掉抓到的头像:登出之后那张图不再有人引用,重新登录时要重新抓。
		if (next.status !== "logged-in") this.avatar = undefined;
		this.bus.emit("login-status-report", after);
		this.notifyIfChanged();
	}

	// ---- Health check ----

	/**
	 * 热替换登录健康检查间隔。adapter 在 dashboard 编辑 B 站设置的 `healthCheckMinutes`
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

	/**
	 * 把心跳提前到现在(宿主 devtools「现在就跑」)。走的就是定时器到点跑的那次;登录着才查,
	 * 没登录 / 扫码中跳过、回 false。定时器本身不动,下一次到点照旧。
	 */
	async healthCheckNow(): Promise<boolean> {
		if (this.shouldSkipHealthCheck()) return false;
		await this.runHealthCheck();
		return true;
	}

	private shouldSkipHealthCheck(): boolean {
		return this.state.status === "qr" || this.state.status === "logged-out";
	}

	private async runHealthCheck(): Promise<void> {
		if (this.shouldSkipHealthCheck()) return;
		// skip 判据取的是**发请求之前**那一帧,答复回来时状态可能早就变了。
		const gen = this.authGeneration;
		try {
			const res = await this.api.fetchMyselfInfo();
			if (this.supersededSince(gen)) return;
			this.reportLoginCheck(res.code);
			// 头像之前没抓成的话心跳顺手补一次(不等它,心跳的判定到此为止)。
			if (res.code === 0) this.maybeFetchAvatar();
		} catch (e) {
			this.logger.warn(`[auth] 心跳异常（保持当前状态）：${e}`);
		}
	}

	// ---- Timer disposal helpers ----

	private clearLoginTimer(): void {
		this.loginTimer?.dispose();
		this.loginTimer = undefined;
		this.loginHold?.dispose();
		this.loginHold = undefined;
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
