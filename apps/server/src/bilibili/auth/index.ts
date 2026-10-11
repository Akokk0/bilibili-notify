import {
	fail,
	type IntegrationContext,
	type MessageBus,
	ok,
	type Result,
	type ServiceContext,
	type SourceAuth,
} from "@bilibili-notify/internal";
import type { ConfigStore } from "../../config/store.js";
import { createImageFetcher } from "../../images/image-fetcher.js";
import type { ImageWriter } from "../../images/image-store.js";
import type { IntegrationStore } from "../../integration-store/store.js";
import { errorMessageOf } from "../../util/error-message.js";
import { Api } from "../api/index.js";
import { createBiliContext } from "../context.js";
import { fetchAvatar } from "../images.js";
import { settingsOf, watchSettings } from "../settings.js";
import { LoginFlow } from "./login-flow.js";

/**
 * Auth subsystem. Boot order: open the integration's stores → Api → LoginFlow → resume stored login → health probe.
 *
 * Construction order (must remain stable for resume → api.start → flow.reportAccountInfo):
 *   1. Integration context (opens the stores, builds the request client with the saved cookie jar and identity).
 *      Cookies + refresh token live in the integration's stores (`http.cookies` / `refreshToken`); commits go through
 *      `api.commitLogin` — the one exit that writes the jar and the token in a single atomic write.
 *   2. Api(callbacks: onCookiesRefreshed → log line, onAuthLost → flow.handleAuthLost)
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
	/**
	 * B 站集成的上下文(登录这一套建好的那个),按公共五格的类型交出去:核心在类型上拿不到 `http` 与 `cookies`。
	 * 入口递给 `compose.ts`,来源的上下文建在它之上。
	 */
	readonly integration: IntegrationContext;
	/**
	 * 登录口(`Source.auth`):发起扫码、退出登录(状态总会进未登录;存着的登录状态清不掉时回失败,
	 * 话里写着原因与「重启后可能还是登录着」)、读状态与账号、订阅变化。
	 */
	readonly auth: Required<SourceAuth>;
	/** 把健康检查提前到现在(开发场景「登录心跳」);没登录 / 扫码中跳过、回 false。 */
	healthCheckNow(): Promise<boolean>;
	/** Stop the flow and the api, save the cookie jar one last time, close the stores. Idempotent. */
	dispose(): Promise<void>;
}

export interface CreateAuthSystemOptions {
	serviceCtx: ServiceContext;
	bus: MessageBus;
	/** 集成存储宿主(`AppRuntime.integrationStore`):登录的 cookie 与令牌住在这个集成自己的存储里。 */
	integrationStore: Pick<IntegrationStore, "open">;
	/** 配置仓的读口:开机读健康检查间隔,之后的变化自己听(`watchSettings`)。 */
	configStore: Pick<ConfigStore, "getIntegrationSettings" | "onChange">;
	/** 账号头像往图库存图的口(`AppRuntime.accountImages`)。 */
	accountImages: ImageWriter;
}

export async function createAuthSystem(opts: CreateAuthSystemOptions): Promise<AuthSystem> {
	const log = opts.serviceCtx.logger;
	const healthCheckMs = settingsOf(opts.configStore).healthCheckMinutes * 60_000;

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
				// 续期提交落盘成功之后叫一声:只记一行 info(没有任何读者要这个事件了,cookie 本身是密钥,不进日志)。
				onCookiesRefreshed: () => {
					log.info("[auth] 登录续期已落盘");
				},
				// handleAuthLost() 是 Promise:此前 void 丢弃 → reject 成 unhandled
				// 且 auth-lost 状态迁移静默失败。改 .catch 经 logger;flow 仍为
				// undefined 时(构造期)?. 双重短路不调用 .catch。
				onAuthLost: () => {
					flow?.handleAuthLost()?.catch((e) => {
						log.error(`[auth] auth-lost 处理失败: ${errorMessageOf(e)}`);
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
		// 账号头像走 B 站的请求客户端抓进图库(同一套缩放档与请求头,不新增出站原语)。
		const avatarImages = createImageFetcher({ http: api.http, images: opts.accountImages });
		flow = new LoginFlow({
			serviceCtx: opts.serviceCtx,
			api,
			bus: opts.bus,
			healthCheckMs,
			fetchAvatar: (url) => fetchAvatar(url, { images: avatarImages, logger: log }),
		});
		await flow.start();

		const flowFinal = flow;

		// 健康检查间隔在设置里改了就热换到心跳定时器(从前由引擎装配听、转给 LoginFlow)。
		const settingsSubscription = watchSettings(opts.configStore, (prev, next) => {
			if (prev.healthCheckMinutes !== next.healthCheckMinutes) {
				flowFinal.setHealthCheckMs(next.healthCheckMinutes * 60_000);
			}
		});
		ctx.onDispose(() => settingsSubscription.dispose());

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

		const beginLogin = (): Promise<Result> => flowFinal.beginLogin();

		const logout = async (): Promise<Result> => {
			// P0-2:不清内存 jar 则 api 仍以 stale 已认证 cookie 发请求至进程重启。
			await api.clearCookies();
			// 罐子已空:`http.cookies` 与令牌在同一次写里一起删。失败记 error、照样报未登录,并把失败交给调用方。
			const saved = await api.commitLogin(undefined);
			if (!saved.ok) log.error(`[auth] 登出后清不掉存着的登录状态: ${saved.message}`);
			flowFinal.reportLoggedOut("notLogin");
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

		return {
			api,
			integration: ctx,
			auth,
			healthCheckNow: () => flowFinal.healthCheckNow(),
			dispose: () => context.dispose(),
		};
	} catch (err) {
		// 建到一半失败:停掉已起的、关上存储把手,不然下次 `open` 同一个键会抛「已经开着」。
		await context.dispose();
		throw err;
	}
}
