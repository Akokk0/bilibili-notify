import {
	fail,
	ok,
	type Result,
	type ServiceContext,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { createImageFetcher } from "../../images/image-fetcher.js";
import type { ImageWriter } from "../../images/image-store.js";
import { errorMessageOf } from "../../util/error-message.js";
import { Api } from "../api/index.js";
import type { BiliContext } from "../context.js";
import { fetchAvatar } from "../images.js";
import { LoginFlow } from "./login-flow.js";

/**
 * Auth subsystem. 造(同步、不出网、不开存储)与起、停分开:B 站来源造一次,`start()` 里起,`stop()` 里停。
 *
 * Construction (`createAuthSystem`, synchronous — the integration's stores are already open in the `BiliContext`):
 *   1. `Api(callbacks: onCookiesRefreshed → log line, onAuthLost → flow.handleAuthLost)`
 *      — `flow` is captured by reference; constructed in step 2, so the callback closes over `let flow`.
 *   2. `LoginFlow` (账号头像走 B 站自己的请求客户端).
 *      Cookies + refresh token live in the integration's stores (`http.cookies` / `refreshToken`); commits go through
 *      `api.commitLogin` — the one exit that writes the jar and the token in a single atomic write.
 *
 * Start (`start()`, 来源 `start` 的第一步): `api.start()` → `flow.start()` (no-op today; symmetric) → 订罐子的 `onRestored`
 * → resume the stored login via `api.resumeStoredLogin` → `flow.reportAccountInfo()` if a login cookie was found, else
 * `flow.reportLoggedOut("notLogin")`. 中途抛了就把已起的停掉再抛。
 *
 * Stop (`stop()`, 同步): stop the flow and the api first (this voids an in-flight refresh), drop the `onRestored`
 * subscription. 最后一次存盘与关存储把手不在这里:那是收 B 站上下文的事(`compose.ts` 在关停的 `stop` 段登记,
 * 晚于引擎跑,所以这一步总排在存盘之前)。
 */
export interface AuthSystem {
	readonly api: Api;
	/**
	 * 登录口(`Source.auth`):发起扫码、退出登录(状态总会进未登录;存着的登录状态清不掉时回失败,
	 * 话里写着原因与「重启后可能还是登录着」)、读状态与账号、订阅变化。
	 */
	readonly auth: Required<SourceAuth>;
	/** 起 Api 与扫码流程,恢复存着的登录(落定时状态已经是已登录 / 未登录,或开机探活连不上时停在确认中)。只调一次;抛了就是没起来(已起的已停)。 */
	start(): Promise<void>;
	/** 停扫码流程与 Api(作废在途的续期)、摘掉恢复备份的订阅。同步、幂等;没起过也能调。 */
	stop(): void;
	/** 把健康检查提前到现在(开发场景「登录心跳」);没登录 / 扫码中跳过、回 false。 */
	healthCheckNow(): Promise<boolean>;
	/** 把当前会话判为失效(开发场景「登录失效」);不清 cookie 罐,没有会话时什么都不做。 */
	handleAuthLost(): Promise<void>;
	/** 拿罐里现成的 cookie 再探一次账号(开发场景「重新确认登录」);有效就回到已登录。 */
	reportAccountInfo(): Promise<void>;
	/**
	 * 定时的登录检查(心跳)的间隔,毫秒;`<= 0` 是停掉、之后任何登录路径(扫码成功、恢复备份、登录恢复)都不会再把它挂起来。
	 * 登录系统自己不读设置:B 站来源 `start` 里读了 B 站设置、经这一口挂上或停下。起步是停着的。
	 */
	setHealthCheckMs(ms: number): void;
}

export interface CreateAuthSystemOptions {
	/** B 站那一格的宿主上下文(日志器与等级跟 B 站;与开 `context` 用的是同一个)。 */
	serviceCtx: ServiceContext;
	/** B 站的上下文(存储已开、罐子与请求客户端已建好);登录的 cookie 与令牌住在它的存储里。它的收尾归调用方。 */
	context: BiliContext;
	/** 账号头像往图库存图的口(`AppRuntime.accountImages`)。 */
	accountImages: ImageWriter;
}

export function createAuthSystem(opts: CreateAuthSystemOptions): AuthSystem {
	const { serviceCtx, context: ctx } = opts;
	const log = serviceCtx.logger;

	// 1. Api. The `onAuthLost` callback closes over `flow` — built in step 2.
	let flow: LoginFlow | undefined;
	const api = new Api({
		serviceCtx,
		ctx,
		callbacks: {
			// 续期提交落盘成功之后叫一声:只记一行 info(没有任何读者要这个事件了,cookie 本身是密钥,不进日志)。
			onCookiesRefreshed: () => {
				log.info("[auth] 登录续期已落盘");
			},
			// handleAuthLost() 是 Promise:此前 void 丢弃 → reject 成 unhandled
			// 且登录失效处理静默失败。改 .catch 经 logger;flow 仍为
			// undefined 时(构造期)?. 双重短路不调用 .catch。
			onAuthLost: () => {
				flow?.handleAuthLost()?.catch((e) => {
					log.error(`[auth] 登录失效处理失败: ${errorMessageOf(e)}`);
				});
			},
		},
	});

	// 2. LoginFlow.
	// 账号头像走 B 站的请求客户端抓进图库(同一套缩放档与请求头,不新增出站原语)。
	const avatarImages = createImageFetcher({ http: api.http, images: opts.accountImages });
	const flowFinal = new LoginFlow({
		serviceCtx,
		api,
		// 心跳起步是关着的:间隔住在 B 站设置里,由来源 `start` 读了设置、经 `setHealthCheckMs` 挂上(读不懂就一直关着)。
		healthCheckMs: 0,
		fetchAvatar: (url) => fetchAvatar(url, { images: avatarImages, logger: log }),
	});
	flow = flowFinal;

	// Resume the stored login (the host already loaded the jar), then probe account info.
	// Extracted so a backup restore can re-run the exact boot sequence and
	// live-swap the login without a process restart.
	const resumeLogin = async (): Promise<void> => {
		await api.resumeStoredLogin();
		// 已有登录 cookie:罐里有 bili_jct。
		if (ctx.cookies.jar.getValue("bili_jct") !== undefined) {
			await flowFinal.reportAccountInfo();
		} else {
			log.info("[auth] 账号未登录，等待扫码登录");
			flowFinal.reportLoggedOut("notLogin");
		}
	};

	const beginLogin = (): Promise<Result> => flowFinal.beginLogin();

	const logout = async (): Promise<Result> => {
		// 退出的第一步就报未登录:从这一刻起没有「会话可丢」。放在清罐、落盘之后的话,那两个 `await` 里回来的 `-101`
		// (带着旧 cookie 发出去的请求、或清罐之后不带 cookie 发出去的)会被当成登录失效 —— 主人自己点的退出,
		// 却先收到一句「登录失效了」。落盘成不成状态都是未登录(与从前一样),失败经返回值交给调用方。
		let saved: Result;
		try {
			flowFinal.reportLoggedOut("notLogin");
		} finally {
			// 放在 finally 里:状态已经说了未登录,后面哪一步抛错都不能把罐里、盘上的登录留着。
			// P0-2:不清内存 jar 则 api 仍以 stale 已认证 cookie 发请求至进程重启。
			await api.clearCookies();
			// 罐子已空:`http.cookies` 与令牌在同一次写里一起删。失败记 error,并把失败交给调用方。
			saved = await api.commitLogin(undefined);
			if (!saved.ok) log.error(`[auth] 登出后清不掉存着的登录状态: ${saved.message}`);
		}
		return saved.ok
			? ok()
			: fail(
					"unavailable",
					`已退出，但存着的登录状态没清掉：${saved.message}，重启后可能还是登录着`,
				);
	};

	const auth: Required<SourceAuth> = {
		beginLogin,
		logout,
		state: () => flowFinal.authState(),
		account: () => flowFinal.account(),
		onChange: (fn) => flowFinal.onChange(fn),
	};

	let restoredSubscription: { dispose(): void } | undefined;
	const stop = (): void => {
		// 先停 Api 与扫码流程(作废在途的续期),最后一次存盘由宿主收上下文时做:那一步一定排在这之后。
		flowFinal.stop();
		api.stop();
		restoredSubscription?.dispose();
		restoredSubscription = undefined;
	};

	return {
		api,
		auth,
		async start() {
			try {
				// api.start() — initialise HTTP client + ticket cron.
				await api.start();
				log.debug("[auth] Api started");
				await flowFinal.start();
				// 恢复备份后由宿主叫:罐子已经换成新内容,这里重起续期、重探账号。
				restoredSubscription = ctx.cookies.onRestored(resumeLogin);
				// Initial resume + account probe at boot.
				await resumeLogin();
			} catch (err) {
				// 起到一半失败:停掉已起的(来源那头不会替登录系统停)。
				stop();
				throw err;
			}
		},
		stop,
		healthCheckNow: () => flowFinal.healthCheckNow(),
		handleAuthLost: () => flowFinal.handleAuthLost(),
		reportAccountInfo: () => flowFinal.reportAccountInfo(),
		setHealthCheckMs: (ms) => flowFinal.setHealthCheckMs(ms),
	};
}
