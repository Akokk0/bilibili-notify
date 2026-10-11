import type { IntegrationContext, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { Api, LoginFlow, type LoginSnapshot } from "../bilibili/api/index.js";
import { createBiliContext, REFRESH_TOKEN_KEY } from "../bilibili/context.js";
import type { IntegrationStore } from "../integration-store/store.js";

/** Default health-probe cadence: 30 minutes. */
const DEFAULT_HEALTH_CHECK_MS = 30 * 60 * 1000;

/**
 * Auth subsystem. Boot order: open the integration's stores → Api → LoginFlow → resume stored login → health probe.
 *
 * Construction order (must remain stable for resume → api.start → flow.reportAccountInfo):
 *   1. Integration context (opens the stores, builds the request client with the saved cookie jar and identity).
 *      Cookies + refresh token live in the integration's stores (`http.cookies` / `refreshToken`); commits go through
 *      `api.commitLogin` — the one exit that writes the jar and the token in a single atomic write.
 *   2. Api(callbacks: onCookiesRefreshed → bus event, onAuthLost → flow.handleAuthLost)
 *      — `flow` is captured by reference; constructed in step 4, so the callback closes over `let flow`.
 *   3. api.start()
 *   4. LoginFlow + flow.start() (no-op today; symmetric)
 *   5. Resume the stored login via api.resumeStoredLogin.
 *   6. flow.reportAccountInfo() if a login cookie was found, else flow.reportLoggedOut("notLogin").
 *
 * Teardown (`dispose`): stop the flow and the api first (this voids an in-flight refresh), then the last cookie save,
 * then close the store handle. Every failing path after step 1 closes the handle too.
 */
export interface AuthSystem {
	readonly api: Api;
	readonly flow: LoginFlow;
	/**
	 * B 站集成的上下文(登录这一套建好的那个),按公共五格的类型交出去:核心在类型上拿不到 `http` 与 `cookies`。
	 * 入口递给 `compose.ts`,来源的上下文建在它之上。
	 */
	readonly integration: IntegrationContext;
	/** Trigger a fresh QR login session. Renders the QR PNG using the `qrcode` npm dep. */
	beginLogin(): Promise<void>;
	/** Force a cookie refresh check against bilibili. */
	refreshCookies(): Promise<void>;
	/**
	 * Forget the login: clear the live jar and delete the refresh token in one commit, report logged-out.
	 * Safe when not logged in. Never touches master.key — it also encrypts the config secrets.
	 */
	logout(): Promise<void>;
	/** Current snapshot — proxy to `flow.current()`. */
	status(): LoginSnapshot;
	/** Stop the flow and the api, save the cookie jar one last time, close the stores. Idempotent. */
	dispose(): Promise<void>;
}

export interface CreateAuthSystemOptions {
	serviceCtx: ServiceContext;
	bus: MessageBus;
	/** 集成存储宿主(`AppRuntime.integrationStore`):登录的 cookie 与令牌住在这个集成自己的存储里。 */
	integrationStore: Pick<IntegrationStore, "open">;
	/** Optional override for the QR poll/health check interval (ms). Tests use this. */
	healthCheckMs?: number;
}

export async function createAuthSystem(opts: CreateAuthSystemOptions): Promise<AuthSystem> {
	const log = opts.serviceCtx.logger;
	const healthCheckMs = opts.healthCheckMs ?? DEFAULT_HEALTH_CHECK_MS;

	// 1. 开存储、读两份文件、建罐子与身份 —— 都在 `new Api` 之前。
	const context = await createBiliContext({
		stores: opts.integrationStore,
		serviceCtx: opts.serviceCtx,
	});
	const { ctx } = context;

	try {
		// 2. Api. The `onAuthLost` callback closes over `flow` — built in step 4.
		let flow: LoginFlow | undefined;
		const api = new Api({
			serviceCtx: opts.serviceCtx,
			ctx,
			callbacks: {
				// 总线上只报「刷新过了」:cookie 本身是密钥,不经总线。事件在提交落盘成功之后才发。
				onCookiesRefreshed: () => {
					opts.bus.emit("cookies-refreshed", { refreshedAt: new Date().toISOString() });
				},
				// handleAuthLost() 是 Promise:此前 void 丢弃 → reject 成 unhandled
				// 且 auth-lost 状态迁移静默失败。改 .catch 经 logger;flow 仍为
				// undefined 时(构造期)?. 双重短路不调用 .catch。
				onAuthLost: () => {
					flow?.handleAuthLost()?.catch((e) => {
						log.error(`[auth] auth-lost 处理失败: ${(e as Error).message ?? e}`);
					});
				},
			},
		});
		// 先停 Api 与扫码流程(作废在途的续期),再由宿主做最后一次存盘:后登记的先跑,所以这一条排在存盘之前。
		ctx.onDispose(() => {
			flow?.stop();
			api.stop();
		});

		// 3. api.start() — initialise HTTP client + ticket cron.
		await api.start();
		log.debug("[auth] Api started");

		// 4. LoginFlow.
		flow = new LoginFlow({
			serviceCtx: opts.serviceCtx,
			api,
			bus: opts.bus,
			healthCheckMs,
		});
		await flow.start();

		const flowFinal = flow;

		// Resume the stored login (the host already loaded the jar), then probe account info.
		// Extracted (steps 5-6) so a backup restore can re-run the exact boot sequence and
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

		// 恢复备份后由宿主叫:罐子已经换成新内容,这里重起续期、重探账号。
		const restoredSubscription = ctx.cookies.onRestored(resumeLogin);
		ctx.onDispose(() => restoredSubscription.dispose());

		// 5-6. Initial resume + account probe at boot.
		await resumeLogin();

		const beginLogin = async (): Promise<void> => {
			await flowFinal.beginLogin();
		};

		const refreshCookies = async (): Promise<void> => {
			// 手动刷新:有存着的令牌就直接走一遍续期链(探测 → 需要才换新;换成功由 `commitLogin` 把 cookie 与
			// 新令牌同一次写盘、之后才发 `cookies-refreshed`),然后重探账号信息。没有令牌就只重探。
			const refreshToken = ctx.secrets.get<string>(REFRESH_TOKEN_KEY);
			if (refreshToken) {
				const csrf = ctx.cookies.jar.getValue("bili_jct") ?? "";
				await api.checkIfTokenNeedRefresh(refreshToken, csrf);
			}
			await flowFinal.reportAccountInfo();
		};

		const logout = async (): Promise<void> => {
			// P0-2:不清内存 jar 则 api 仍以 stale 已认证 cookie 发请求至进程重启。
			await api.clearCookies();
			// 罐子已空:`http.cookies` 与令牌在同一次写里一起删。失败记 error、照样报未登录。
			const saved = await api.commitLogin(undefined);
			if (!saved.ok) log.error(`[auth] 登出后清不掉存着的登录状态: ${saved.message}`);
			flowFinal.reportLoggedOut("notLogin");
		};

		const status = (): LoginSnapshot => flowFinal.current();

		return {
			api,
			flow: flowFinal,
			integration: ctx,
			beginLogin,
			refreshCookies,
			logout,
			status,
			dispose: () => context.dispose(),
		};
	} catch (err) {
		// 建到一半失败:停掉已起的、关上存储把手,不然下次 `open` 同一个键会抛「已经开着」。
		await context.dispose();
		throw err;
	}
}
