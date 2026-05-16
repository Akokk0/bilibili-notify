import { join } from "node:path";
import { BilibiliAPI, LoginFlow, type LoginSnapshot } from "@bilibili-notify/api";
import type { Disposable, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { type CookieData, type KeyProvider, StorageManager } from "@bilibili-notify/storage";
import QRCode from "qrcode";
import type { BootstrapConfig } from "../config/schema.js";

/** Default health-probe cadence — matches the koishi shell's "30 minutes" default. */
const DEFAULT_HEALTH_CHECK_MS = 30 * 60 * 1000;

/**
 * Standalone auth subsystem. Mirrors the koishi side's
 * `koishi/core/src/lifecycle.ts#bringUp` boot order, minus the koishi adapter.
 *
 * Construction order (must remain stable for cookie-load → api.start → flow.reportAccountInfo):
 *   1. StorageManager (with `paths` under <dataDir>/secrets/) → init() loads-or-creates master.key
 *   2. BilibiliAPI(callbacks: onCookiesRefreshed → cookieStore.save, onAuthLost → flow.handleAuthLost)
 *      — `flow` is captured by reference; constructed in step 4, so the callback closes over `let flow`.
 *   3. api.start()
 *   4. LoginFlow + flow.start() (no-op today; symmetric)
 *   5. Load existing cookies from disk via api.loadCookies; or markLoginInfoLoaded if none.
 *   6. flow.reportAccountInfo() if a login cookie was found, else flow.reportLoggedOut("notLogin").
 */
export interface AuthSystem extends Disposable {
	readonly api: BilibiliAPI;
	readonly storage: StorageManager;
	readonly flow: LoginFlow;
	/** Trigger a fresh QR login session. Renders the QR PNG using the `qrcode` npm dep. */
	beginLogin(): Promise<void>;
	/** Force a cookie refresh check against bilibili. */
	refreshCookies(): Promise<void>;
	/** Wipe secrets (cookies + master.key); caller must initiate a fresh login. */
	resetCookies(): Promise<void>;
	/** Mark the session logged-out client-side. */
	logout(): Promise<void>;
	/** Current snapshot — proxy to `flow.current()`. */
	status(): LoginSnapshot;
}

export interface CreateAuthSystemOptions {
	serviceCtx: ServiceContext;
	bus: MessageBus;
	bootstrap: BootstrapConfig;
	/** Optional override for the QR poll/health check interval (ms). Tests use this. */
	healthCheckMs?: number;
	/**
	 * Shared KeyProvider from AppRuntime. When given, cookie encryption uses the
	 * same key as the config SecretStore (one BN_COOKIE_KEY, one salt). Omitted
	 * in unit tests → StorageManager builds its own legacy key file.
	 */
	keyProvider?: KeyProvider;
}

/** Render a bilibili QR url into a base64 PNG data URL. Used as `LoginFlow.beginLogin`'s renderQr callback. */
async function renderQrDataUrl(url: string): Promise<string> {
	const buffer = await QRCode.toBuffer(url, {
		errorCorrectionLevel: "H",
		type: "png",
		margin: 1,
		color: { dark: "#000000", light: "#FFFFFF" },
	});
	return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

export async function createAuthSystem(opts: CreateAuthSystemOptions): Promise<AuthSystem> {
	const log = opts.serviceCtx.logger;
	const healthCheckMs = opts.healthCheckMs ?? DEFAULT_HEALTH_CHECK_MS;

	// 1. StorageManager → secrets layout. Must initialise before any cookie I/O.
	const storage = new StorageManager({
		serviceCtx: opts.serviceCtx,
		dataDir: opts.bootstrap.dataDir,
		// Reuse the runtime's shared provider so cookie + config secrets share
		// one key/salt. Fallback (tests) builds its own legacy key file.
		keyProvider: opts.keyProvider,
		encryptionKey: opts.keyProvider ? undefined : opts.bootstrap.cookieEncryptionKey,
		paths: {
			keyPath: join(opts.bootstrap.dataDir, "secrets", "master.key"),
			cookiePath: join(opts.bootstrap.dataDir, "secrets", "cookies.json"),
			saltPath: join(opts.bootstrap.dataDir, "secrets", "kdf.salt"),
		},
	});
	await storage.init();
	log.debug("[auth] StorageManager initialised");

	// 2. BilibiliAPI. The `onAuthLost` callback closes over `flow` — built in step 4.
	let flow: LoginFlow | undefined;
	const api = new BilibiliAPI({
		serviceCtx: opts.serviceCtx,
		config: {},
		callbacks: {
			onCookiesRefreshed: (data) => {
				// Forward to the bus so dashboards see the refresh, AND persist to disk.
				opts.bus.emit("cookies-refreshed", data);
				storage.cookieStore.save(data).catch((e) => {
					log.error(`[auth] 保存刷新后的 cookie 失败: ${e}`);
				});
			},
			onAuthLost: () => {
				void flow?.handleAuthLost();
			},
		},
	});

	// 3. api.start() — initialise HTTP client + ticket cron.
	await api.start();
	log.debug("[auth] BilibiliAPI started");

	// 4. LoginFlow.
	flow = new LoginFlow({
		serviceCtx: opts.serviceCtx,
		api,
		bus: opts.bus,
		healthCheckMs,
		saveCookies: (data: CookieData) => storage.cookieStore.save(data),
	});
	await flow.start();

	// 5. Load existing cookies into the api jar (mirrors koishi/core/src/bootstrap-helpers.ts#loadInitialCookies).
	let cookieData: CookieData | null = null;
	try {
		cookieData = await storage.cookieStore.load();
	} catch (e) {
		log.warn(`[auth] 读取 cookie 文件失败: ${e}`);
	}
	if (cookieData) {
		log.debug("[auth] 找到 Cookie 文件，正在写入 jar...");
		await api.loadCookies(cookieData);
	} else {
		log.debug("[auth] 未找到 Cookie 文件，标记为待登录状态");
		api.markLoginInfoLoaded();
	}

	// 6. Probe account info. If no bili_jct cookie, report NOT_LOGIN.
	const loggedIn = hasLoginCookie(api);
	if (loggedIn) {
		await flow.reportAccountInfo();
	} else {
		log.info("[auth] 账号未登录，等待扫码登录");
		flow.reportLoggedOut("notLogin");
	}

	const flowFinal = flow;

	const beginLogin = async (): Promise<void> => {
		await flowFinal.beginLogin(renderQrDataUrl);
	};

	const refreshCookies = async (): Promise<void> => {
		// Re-probe account info; this triggers the api's cookie-refresh path on -101
		// and a logged-in re-confirm otherwise. Use the loaded refreshToken if present
		// to nudge the proactive refresh check.
		const data = await storage.cookieStore.load();
		if (data?.refreshToken) {
			const csrf = (() => {
				try {
					const cookies = JSON.parse(data.cookiesJson) as Array<{ key: string; value: string }>;
					return cookies.find((c) => c.key === "bili_jct")?.value ?? "";
				} catch {
					return "";
				}
			})();
			await api.checkIfTokenNeedRefresh(data.refreshToken, csrf);
		}
		await flowFinal.reportAccountInfo();
	};

	const resetCookies = async (): Promise<void> => {
		await storage.cookieStore.resetKey();
		// P0-2:不清内存 jar 则 api 仍以 stale 已认证 cookie 发请求至进程重启。
		await api.clearCookies();
		flowFinal.reportLoggedOut("keyReset");
	};

	const logout = async (): Promise<void> => {
		await storage.cookieStore.clear();
		await api.clearCookies();
		flowFinal.reportLoggedOut("notLogin");
	};

	const status = (): LoginSnapshot => flowFinal.current();

	const dispose = (): void => {
		flowFinal.stop();
		api.stop();
	};

	return {
		api,
		storage,
		flow: flowFinal,
		beginLogin,
		refreshCookies,
		resetCookies,
		logout,
		status,
		dispose,
	};
}

/** Mirror of `koishi/core/src/bootstrap-helpers.ts#hasLoginCookie`. */
function hasLoginCookie(api: BilibiliAPI): boolean {
	const cookiesJson = api.getCookiesJson();
	if (!cookiesJson || cookiesJson === "[]") return false;
	try {
		const cookies: Array<{ key: string }> = JSON.parse(cookiesJson);
		return cookies.some((c) => c.key === "bili_jct");
	} catch {
		return false;
	}
}
