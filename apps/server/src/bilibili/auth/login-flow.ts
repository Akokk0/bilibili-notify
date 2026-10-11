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
	type SourceAccount,
} from "@bilibili-notify/internal";
import QRCode from "qrcode";
import { errorMessageOf } from "../../util/error-message.js";
import type { Api } from "../api/api";
import type { MyselfResponse } from "../api/types";
import {
	authStateFromLoginState,
	type BiliAccount,
	type BiliLoginState,
	LOGIN_FAILURE_MESSAGES,
	type LoginFailureKey,
} from "./login-state.js";

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
 * B 站登录状态机 + 扫码会话驱动。管:
 *
 * - 登录状态的内部原形(`BiliLoginState`;对外的 `AuthState` 与账号都由它算出来,变了经 `onChange` 通知)。
 * - 周期性的登录探活(`fetchMyselfInfo`),间隔 `healthCheckMs`。
 * - 取二维码 → 轮询 → 存 cookie 的握手;每次扫码有自己的会话记号(`scanSession`),旧的一次不会盖新的一次。
 *
 * 给主人发私信这类适配器那头的事不在这里。
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

	/** 内部原形;对外的 `AuthState` 与账号都由它算出来。 */
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
	 * 扫码会话的记号:每次发起、每次扫码会话终结(超时 / 失效 / 失败 / 成功 / 登出)都递增。轮询与超时回调
	 * 在入口捕获自己那一次,落地前比对 —— 不是当前这一次的整份丢弃(旧码迟到的「已扫」「失效」不得盖新码)。
	 * 唯一例外:旧码回「确认成功」且其间没登出过,登录已经成立,照样落地(登录成立优先,新发起的那次作废)。
	 */
	private scanSession = 0;
	/**
	 * 扫码期间罐子不自动存的闸:登录回应的 Set-Cookie 在响应头到的那一刻就进了罐子,令牌却要等响应体,
	 * 这中间自动存到点的话盘上就是「新会话的 cookie + 上一个会话的令牌」。随轮询一起收(`clearLoginTimer`);
	 * 成功那一支把它摘出来、提交之后才放。
	 */
	private loginHold?: Disposable;
	/**
	 * 「确认成功」已落地、登录正在落盘(到进入已登录为止)。这一段里进来的发起直接回 `conflict`:
	 * 登录已成立,不能被新码盖成等待扫码;落盘成败都会放开,失败后能正常再发起。
	 */
	private committingLogin = false;
	/**
	 * Marks "we are unauthenticated, so something downstream may be parked waiting". On the next
	 * successful login the flag is flipped and `auth-restored` fires. Avoids relying on the
	 * previous frame's status, which would miss the path logged-out → qr (ready, waiting) → logged-in.
	 *
	 * Deliberately NOT gated on having been logged in first. Engines park themselves the moment
	 * they hit -101 on their own — the dynamic detector stops its cron and waits for
	 * `auth-restored` — and that happens on a cold start with stale cookies, where this flow goes
	 * checking → logged-out without ever emitting `auth-lost`. Gating the flag on a prior
	 * logged-in left those engines parked forever after the user re-scanned the QR.
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
	 * 已登录」+「needsRestore」,于是把状态推回已登录并发一条 `auth-restored`。
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
	/**
	 * 此刻有没有一个**可丢的登录会话**:登录着;开机存着登录、还在确认(初值,`reportAccountInfo` 入口也置真);
	 * 已登录时重扫、会话其实还在的那几种状态(`qr` / `failed`)也算有 —— 所以它不是状态的函数,
	 * 而是「最近一次 `reportLoggedIn` / `reportLoggedOut` / 探活入口」的结论。
	 *
	 * 没有会话可丢时,请求客户端报来的 `-101` 只是「还没登录」的另一种说法:不得把「没登录」改写成「失效」
	 * (对外的 `expired` 只指已经登着的登录失效了;从没登录过 / 主动退出只进问题表、不私聊),
	 * 也不得打断进行中的扫码。
	 */
	private hasSession = true;

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

	/** 此刻对外的中立状态,同步、不出网。 */
	authState(): AuthState {
		return authStateFromLoginState(this.state);
	}

	/** 登录着的账号;没登录或还没取到卡片是 null。头像抓进图库之后才有 `avatar`。 */
	account(): SourceAccount | null {
		const s = this.state;
		if (s.status !== "logged-in" || !s.account) return null;
		const avatar =
			this.avatar && this.avatar.url === s.account.avatarUrl ? this.avatar.ref : undefined;
		return avatar === undefined ? { name: s.account.name } : { name: s.account.name, avatar };
	}

	/** 状态或账号可能变了就叫一声(两样都没变不叫);要做事自己再读 `authState()` / `account()`。 */
	onChange(fn: () => void): Disposable {
		this.changeListeners.add(fn);
		return { dispose: () => void this.changeListeners.delete(fn) };
	}

	private changeKey(): string {
		return JSON.stringify([this.authState(), this.account()]);
	}

	/**
	 * 算对外的变化并通知订阅方。**这一步的任何抛错(算账号、订阅方的回调)都在这里接住、记 error,
	 * 不许传回状态机**:各个 reporter 在边事件、`needsRestore`、代数、心跳的挂摘都做完之后才调它。
	 */
	private notifyIfChanged(): void {
		try {
			const key = this.changeKey();
			if (key === this.lastNotified) return;
			this.lastNotified = key;
			for (const fn of [...this.changeListeners]) {
				try {
					fn();
				} catch (e) {
					this.logger.error(`[auth] 状态变化的订阅方抛错: ${errorMessageOf(e)}`);
				}
			}
		} catch (e) {
			this.logger.error(`[auth] 通知登录状态变化失败: ${errorMessageOf(e)}`);
		}
	}

	/**
	 * Probe `fetchMyselfInfo`, transition the state accordingly, and attach the periodic health check.
	 * Network failures keep the current status (transient) and are logged at warn.
	 */
	async reportAccountInfo(): Promise<void> {
		// 来这里探活的都是手里有登录凭据的(开机存着的、恢复备份换进来的、扫码刚成功的):有会话可丢。
		this.hasSession = true;
		const gen = this.authGeneration;
		let personalInfo: MyselfResponse;
		try {
			personalInfo = await this.api.fetchMyselfInfo();
		} catch (e) {
			if (this.supersededSince(gen)) return;
			this.logger.warn(`[account] 获取个人信息异常: ${errorMessageOf(e)}`);
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
		const account = await this.fetchAccount(personalInfo.data?.mid);
		// 取卡片是第二次网络往返,窗口和探活那次一样宽 —— 必须再比一次。
		if (this.supersededSince(gen)) return;
		// 取卡片的途中主人发起了重扫(调用处:开机确认时状态是 checking,扫码成功后是 logged-in,都不会合法地是 qr):
		// 这份成功问的是上一帧,不得把等待扫码的二维码盖成已登录,账号也不写。
		if (this.state.status === "qr") {
			this.logger.debug("[auth] 取账号回来时已在扫码，丢弃这份成功");
			return;
		}
		this.reportLoggedIn(account);
		this.attachHealthCheck();
		// 头像在登录状态确定之后另起一条后台线,不等它。
		this.maybeFetchAvatar();
	}

	/**
	 * 按用户 id 取一次用户卡片,收成我们用得到的那几格。取不到(请求抛了、非 0 码、形状不对)回 `undefined`、
	 * 记一行 warn(只带上游的码,不带整个回应),**不碰登录状态**:账号信息缺着不影响「已登录」。
	 */
	private async fetchAccount(mid: unknown): Promise<BiliAccount | undefined> {
		if (typeof mid !== "number") {
			this.logger.warn("[account] 个人信息里没有用户 id,取不了用户卡片");
			return undefined;
		}
		try {
			return this.accountFromCardResponse(await this.api.fetchUserCard(String(mid), true));
		} catch (e) {
			this.logger.warn(`[account] 获取用户卡片失败: ${errorMessageOf(e)}`);
			return undefined;
		}
	}

	/** B 站用户卡片回应 → 我们的账号。原字段名(`card.name` / `card.face`)只留在这一处。 */
	private accountFromCardResponse(res: unknown): BiliAccount | undefined {
		const r = res as {
			code?: unknown;
			data?: { card?: { name?: unknown; face?: unknown } | null } | null;
		} | null;
		if (r?.code !== 0) {
			this.logger.warn(`[account] 用户卡片没取到: code=${String(r?.code)}`);
			return undefined;
		}
		const card = r.data?.card;
		if (typeof card?.name !== "string" || card.name === "") {
			this.logger.warn("[account] 用户卡片缺名字,当作没取到");
			return undefined;
		}
		return { name: card.name, avatarUrl: typeof card.face === "string" ? card.face : "" };
	}

	/**
	 * 登录着且有账号、而头像还没抓成(或网址变了)时,另起一条后台活把头像抓进图库。
	 * 抓不到:账号照常、头像缺着,**不碰登录状态**(这条路上没有任何一处会走到 `reportLoggedOut` /
	 * `reportTransientFailure`)。回来时核「还是不是当初那段登录、那个头像网址」,不是就整份丢掉。
	 */
	private maybeFetchAvatar(): void {
		const fetchAvatar = this.fetchAvatar;
		const s = this.state;
		if (!fetchAvatar || s.status !== "logged-in" || !s.account) return;
		const url = s.account.avatarUrl;
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
				if (now.status !== "logged-in" || now.account?.avatarUrl !== url) return;
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
	 * 既不动状态,也**不重挂心跳**(`reportLoggedOut` 是刻意把心跳摘掉的)。
	 */
	private supersededSince(gen: number): boolean {
		if (gen === this.authGeneration) return false;
		this.logger.debug("[auth] 探活结果已被一次登出取代，丢弃本轮");
		return true;
	}

	/**
	 * 请求客户端报上来一个 `-101`(任何请求、续期链都可能)。**没有会话可丢时什么都不改**
	 * (见 `hasSession`):不改状态、不结束进行中的扫码,只记一行 debug。
	 */
	async handleAuthLost(): Promise<void> {
		if (!this.hasSession) {
			this.logger.debug("[auth] 没有可丢的登录会话，忽略请求报来的 -101");
			return;
		}
		this.reportLoggedOut("authLost");
	}

	/** Mark the session as logged-out for a specific reason. */
	reportLoggedOut(reasonKey: "notLogin" | "authLost" = "notLogin"): void {
		const wasLoggedIn = this.state.status === "logged-in";
		this.hasSession = false;
		// 登出一并结束扫码会话:在途的旧码回应迟到时不得把登出的结果盖掉。
		this.endScanSession();
		// P2:登出后心跳无意义(runHealthCheck 对 logged-out 直接 return),
		// 此前不 detach,setInterval 空转到 stop()。重新登录路径会再 attach。
		this.detachHealthCheck();
		this.transition({ status: "logged-out", reason: reasonKey });
		// 进了 logged-out 就要记账,与之前是不是已登录无关 —— 冷启动时 cookie
		// 已过期的话这里是 checking → logged-out,而引擎照样会自己撞上
		// -101 并停下等 auth-restored。
		this.needsRestore = true;
		// 作废任何在途探活 —— 它们问的是刚死掉的那个会话,迟到的 code 0 不得
		// 把状态推回已登录(更不得由此发出一条假的 auth-restored)。
		this.authGeneration++;
		// auth-lost 仍只在真的丢掉一个好会话时发:它的消费方是 teardown,
		// 拆一个从没建起来的引擎没有意义。
		try {
			if (wasLoggedIn) {
				this.bus.emit("auth-lost");
			}
		} finally {
			// 边事件的监听者同步抛错也要通知订阅方;抛错本身照旧往外传。
			this.notifyIfChanged();
		}
	}

	/**
	 * Begin a fresh QR-login session. Internally:
	 * 0. Ends the previous scan session (its timers and save gate) before anything else.
	 * 1. Fetches a QR url + qrcodeKey from the API.
	 * 2. Asks the caller to render the QR url to a base64 data URL (UI concern).
	 * 3. Drives polling at 1Hz; on success persists cookies and probes account info.
	 * 4. Auto-times-out after 3 minutes.
	 */
	async beginLogin(renderQr: (url: string) => Promise<string> = defaultRenderQr): Promise<Result> {
		// 登录已成立、正在落盘:不动任何东西(旧会话已在 `pollOnce` 里结束),让它落完进已登录。
		if (this.committingLogin) {
			return fail("conflict", "登录已经成立，正在完成，请稍候再看状态");
		}
		const session = this.endScanSession();
		const startedGen = this.authGeneration;
		// 两种作废各说各的:其间登出过(退出登录 / 登录失效)与被新的一次(或已成立的登录)取代。
		const superseded = () =>
			this.authGeneration !== startedGen
				? fail("conflict", "这一次扫码已因退出登录或登录失效而作废，请重新发起")
				: fail("conflict", "这一次扫码已被新的一次(或已成立的登录)取代，请以最新的状态为准");
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let qrContent: any;
		try {
			qrContent = await this.api.fetchLoginQrCode();
		} catch (e) {
			this.logger.warn(`[login] 获取登录二维码失败：${errorMessageOf(e)}`);
			if (session !== this.scanSession) return superseded();
			// 取码请求没到 B 站:一次网络抖动不该把一个好会话在面板上盖成出错,状态不动;
			// 唯独上一次的二维码已被我们作废、状态还停在扫码上时,不能留着一个没人轮询的码。
			if (this.state.status === "qr") this.reportQrFailure("qrFetchFailed");
			return fail("unavailable", LOGIN_FAILURE_MESSAGES.qrFetchFailed);
		}
		if (session !== this.scanSession) return superseded();
		if (qrContent.code !== 0) {
			this.reportQrFailure("qrFetchFailed");
			const upstreamCode: number = qrContent.code;
			// -352 / -403 是 B 站的风控:稍后再来,与「接口坏了」分开。
			const code = upstreamCode === -352 || upstreamCode === -403 ? "rate_limited" : "unavailable";
			return fail(code, LOGIN_FAILURE_MESSAGES.qrFetchFailed, { upstreamCode });
		}

		let dataUrl: string;
		try {
			dataUrl = await renderQr(qrContent.data.url);
		} catch (e) {
			this.logger.warn(`[login] 生成二维码失败：${errorMessageOf(e)}`);
			if (session !== this.scanSession) return superseded();
			this.reportQrFailure("qrRenderFailed");
			return fail("unavailable", LOGIN_FAILURE_MESSAGES.qrRenderFailed);
		}
		if (session !== this.scanSession) return superseded();
		this.reportQrReady(dataUrl);

		this.loginHold = this.api.holdLoginSaves();
		const gen = this.authGeneration;
		let polling = true;
		this.loginTimer = this.serviceCtx.setInterval(async () => {
			if (!polling) return;
			polling = false;
			// 登记进 track:扫码成功的那一拍会把 cookie 与令牌提交进集成的密钥存储,关停得等它落完再让各写道
			// 关门。失败在交进去之前接住(以前这里是裸的 async 回调,抛错就是一次 unhandledRejection)。
			const poll = this.pollOnce(qrContent.data.qrcode_key, session, gen)
				.catch((e) => {
					this.logger.warn(`[login] 二维码轮询出错：${errorMessageOf(e)}`);
				})
				.finally(() => {
					polling = true;
				});
			this.serviceCtx.track(poll);
			await poll;
		}, QR_POLL_MS);

		this.clearLoginExpiryTimer();
		this.loginExpiryTimer = this.serviceCtx.setTimeout(() => {
			if (session !== this.scanSession) return;
			this.endScanSession();
			this.reportQrFailure("qrExpired");
		}, QR_TIMEOUT_MS);
		return ok();
	}

	/**
	 * Run a single QR-status poll. On success, the cookie save handshake runs
	 * and `reportAccountInfo` is invoked, transitioning to logged-in.
	 *
	 * `session` 是这条轮询属于哪一次扫码,`gen` 是发起时的登出代数。不是当前这一次扫码的回应整份丢弃,
	 * 只有一种例外:回「确认成功」而其间没登出过 —— 登录已经成立,不能被新发起的一次盖掉。
	 */
	private async pollOnce(qrcodeKey: string, session: number, gen: number): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let loginContent: any;
		try {
			loginContent = await this.api.fetchLoginStatus(qrcodeKey);
		} catch (e) {
			this.logger.warn(`[login] 获取登录状态失败：${errorMessageOf(e)}`);
			return;
		}

		const code: number = loginContent?.data?.code;
		if (session !== this.scanSession && !(code === 0 && gen === this.authGeneration)) return;

		if (code === 86101) {
			this.reportQrPending("waitScan");
			return;
		}
		if (code === 86090) {
			this.reportQrPending("waitConfirm");
			return;
		}
		if (code === 86038) {
			this.endScanSession();
			this.reportQrFailure("qrInvalidated");
			return;
		}
		if (code === 0) {
			// 扫码那道闸摘出来:收轮询定时器时不放它,提交(不论成败)之后才放。
			const hold = this.loginHold;
			this.loginHold = undefined;
			this.endScanSession();
			// 登录成立优先:从这里到进入已登录之前,新进来的发起一律不受理(见 `beginLogin`)。成败都放开。
			this.committingLogin = true;
			try {
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
			} finally {
				this.committingLogin = false;
			}
			await this.reportAccountInfo();
			return;
		}
		if (loginContent?.code !== 0) {
			this.endScanSession();
			this.reportQrFailure("genericLoginFail");
			return;
		}
		// P2:外层 code 0 但 data.code 不在已知集合(86101/86090/86038/0)。
		// 已知态都已 return,走到这:数值 = 稳定未知鉴权态 → 快速失败(此前
		// 静默每秒 no-op 直到 3min 过期);非数值 = data 缺失等瞬时 → 继续轮询
		// (容忍一次抖动,3min 过期兜底)。
		if (typeof code === "number") {
			this.logger.warn(`[login] QR 轮询返回未知 data.code=${code},判定登录失败`);
			this.endScanSession();
			this.reportQrFailure("genericLoginFail");
		}
	}

	// ---- Internal reporters (drive state transitions) ----
	// 每个 reporter 在边事件、记账都做完之后,最后一步才 `notifyIfChanged()`。

	private reportLoggedIn(
		account?: BiliAccount,
		reasonKey: "loggedIn" | "loginJustSucceeded" = "loggedIn",
	): void {
		const prev = this.state;
		const wasLoggedIn = prev.status === "logged-in";
		this.hasSession = true;
		const fallback = prev.status === "logged-in" ? prev.account : undefined;
		this.transition({
			status: "logged-in",
			reason: reasonKey,
			// 同一段登录里再进已登录不换时刻(账号补到、瞬时失败后恢复都不算新登录)。
			loggedInAt: prev.status === "logged-in" ? prev.loggedInAt : new Date().toISOString(),
			account: account ?? fallback,
		});
		try {
			if (!wasLoggedIn && this.needsRestore) {
				this.needsRestore = false;
				this.bus.emit("auth-restored");
			}
		} finally {
			// 边事件的监听者同步抛错也要通知订阅方;抛错本身照旧往外传。
			this.notifyIfChanged();
		}
	}

	private reportLoginCheck(code: number): void {
		if (code === 0) {
			this.reportLoggedIn();
		} else if (code === -101) {
			// 探活回 -101:登着的登录失效了。没有会话可丢(只有宿主 devtools 在「没登录」的 failed 上手动探活才走到)就还是「没登录」。
			if (!this.hasSession) {
				this.logger.debug("[auth] 没有可丢的登录会话，探活回 -101 不算失效");
				return;
			}
			this.reportLoggedOut("authLost");
		} else {
			this.reportTransientFailure(`code=${code}`);
		}
	}

	private reportTransientFailure(detail: unknown): void {
		this.logger.warn(`[auth] 瞬时失败：${errorMessageOf(detail)}`);
		if (this.state.status !== "logged-in") return;
		this.transition({ ...this.state, reason: "fetchAccountFailed" });
		this.notifyIfChanged();
	}

	private reportQrReady(dataUrl: string): void {
		this.transition({
			status: "qr",
			phase: "ready",
			dataUrl,
			expiresAt: new Date(Date.now() + QR_TIMEOUT_MS).toISOString(),
		});
		this.notifyIfChanged();
	}

	private reportQrPending(reasonKey: "waitScan" | "waitConfirm"): void {
		// Preserve the QR image (and its expiry) across the ready → waiting transition. The QR remains
		// useful to the user until they confirm on phone — without this carry-over the dashboard shows
		// "二维码加载中" the instant polling kicks in.
		const prev = this.state;
		// 扫码会话的记号保证走到这里时状态一定还是这一次的 `qr`;不是就不动(防御,不造一个没有图的 qr)。
		if (prev.status !== "qr") return;
		this.transition({
			status: "qr",
			phase: reasonKey === "waitScan" ? "waiting-scan" : "waiting-confirm",
			dataUrl: prev.dataUrl,
			expiresAt: prev.expiresAt,
		});
		this.notifyIfChanged();
	}

	private reportQrFailure(reasonKey: LoginFailureKey): void {
		this.transition({ status: "failed", reason: reasonKey });
		this.notifyIfChanged();
	}

	/** 换原形(不通知:通知是 reporter 的最后一步)。 */
	private transition(next: BiliLoginState): void {
		this.state = next;
		// 离开已登录就忘掉抓到的头像:登出之后那张图不再有人引用,重新登录时要重新抓。
		if (next.status !== "logged-in") this.avatar = undefined;
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
			// 探活在途时主人发起了重扫:成功的结果问的是登录那一帧,不得把等待扫码的二维码盖成已登录。
			if (res.code === 0 && this.state.status === "qr") {
				this.logger.debug("[auth] 探活回来时已在扫码，丢弃这份成功");
				return;
			}
			this.reportLoginCheck(res.code);
			if (res.code === 0) {
				// 已登录而账号信息缺着(取卡片失败过、或扫码失败回来时没带上)就补取一次;每次心跳至多一次,
				// 本来就有间隔,不另设退避。失败不影响登录状态。
				await this.fillMissingAccount(gen, res.data?.mid);
				// 头像之前没抓成的话心跳顺手补一次(不等它,心跳的判定到此为止)。
				this.maybeFetchAvatar();
			}
		} catch (e) {
			this.logger.warn(`[auth] 心跳异常（保持当前状态）：${errorMessageOf(e)}`);
		}
	}

	private async fillMissingAccount(gen: number, mid: unknown): Promise<void> {
		const s = this.state;
		if (s.status !== "logged-in" || s.account) return;
		const account = await this.fetchAccount(mid);
		if (this.supersededSince(gen) || !account) return;
		// 补取的途中发起了重扫(状态已不是已登录):账号只补给登录着的那一帧,不得把二维码盖成已登录。
		if (this.state.status !== "logged-in") {
			this.logger.debug("[auth] 补取账号回来时已不在已登录，丢弃");
			return;
		}
		this.reportLoggedIn(account);
	}

	// ---- Timer disposal helpers ----

	/** 结束当前的扫码会话:作废在途的轮询与超时回调、收定时器与存盘闸。回新的会话记号(发起时用)。 */
	private endScanSession(): number {
		this.scanSession++;
		this.clearLoginTimers();
		return this.scanSession;
	}

	private clearLoginTimer(): void {
		this.loginTimer?.dispose();
		this.loginTimer = undefined;
		this.loginHold?.dispose();
		this.loginHold = undefined;
	}

	/**
	 * P2:轮询终态(86038 失效 / code 0 成功 / genericLoginFail)应同时清掉
	 * 3min 过期 setTimeout,免得它挂到 expiry 才空跑一次,其间持有闭包。
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
