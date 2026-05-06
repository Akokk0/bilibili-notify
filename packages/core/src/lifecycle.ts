import { BilibiliAPI } from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { makeKoishiMessageBus, makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import { BilibiliPush, type Subscriptions } from "@bilibili-notify/push";
import type { StorageManager } from "@bilibili-notify/storage";
import type { Context, Logger } from "koishi";
import { hasLoginCookie, loadInitialCookies, warnMissingPlugins } from "./bootstrap-helpers";
import type { BilibiliNotifyConfig } from "./config";
import { LoginFlowBridge } from "./login-flow-bridge";
import type { SubFlagOverrides, SubscriptionLoader } from "./subscription-loader";

/** Mutable runtime state on the manager that lifecycle helpers read/write. */
export interface ManagerSlots {
	api: BilibiliAPI | null;
	push: BilibiliPush | null;
	loginBridge: LoginFlowBridge | null;
}

export interface LifecycleDeps {
	ctx: Context;
	logger: Logger;
	getConfig(): BilibiliNotifyConfig;
	storageMgr: StorageManager;
	subLoader: SubscriptionLoader;
	/** Run after api/push are up — caller registers koishi commands here. */
	registerCommands(): void;
	slots: ManagerSlots;
}

/**
 * Bring the api / push / login bridge online and run the post-login handshake.
 * Returns true on success. Caller flips `running` based on the result.
 */
export async function bringUp(deps: LifecycleDeps): Promise<boolean> {
	const config = deps.getConfig();
	const apiServiceCtx = makeKoishiServiceContext(deps.ctx, "bilibili-notify-api", config.logLevel);
	const api = new BilibiliAPI({
		serviceCtx: apiServiceCtx,
		config: { userAgent: config.userAgent },
		callbacks: {
			onCookiesRefreshed: (data) => deps.ctx.emit("bilibili-notify/cookies-refreshed", data),
			onAuthLost: () => void deps.slots.loginBridge?.flow.handleAuthLost(),
		},
	});
	const push = new BilibiliPush(deps.ctx, { logLevel: config.logLevel, master: config.master });
	await api.start();
	deps.logger.debug("[module] BilibiliAPI 启动完成");
	push.start();
	deps.logger.debug("[module] BilibiliPush 启动完成");

	const loginBridge = new LoginFlowBridge({
		ctx: deps.ctx,
		bus: makeKoishiMessageBus(deps.ctx),
		serviceCtx: apiServiceCtx,
		api,
		logger: deps.logger,
		healthCheckMs: config.loginHealthCheckMinutes * 60_000,
		saveCookies: (data) => deps.storageMgr.cookieStore.save(data),
		resetCookieKey: () => deps.storageMgr.cookieStore.resetKey(),
	});
	loginBridge.install();
	await loginBridge.flow.start();

	deps.slots.api = api;
	deps.slots.push = push;
	deps.slots.loginBridge = loginBridge;

	deps.subLoader.bootstrap(api, push);
	deps.subLoader.registerAdvancedSubListener();

	deps.ctx.on("bilibili-notify/subscription-changed", async () => {
		await deps.ctx.sleep(5000);
		if (deps.subLoader.currentSubs) {
			await warnMissingPlugins(deps.ctx, deps.slots.push, deps.logger, deps.subLoader.currentSubs);
		}
	});

	deps.registerCommands();

	await loadInitialCookies(api, deps.storageMgr, deps.logger);
	const loggedIn = hasLoginCookie(api);
	deps.logger.debug(`[cookie] Cookie 加载完成，登录状态：${loggedIn ? "已登录" : "未登录"}`);

	if (!loggedIn) {
		deps.logger.info("[login] 账号未登录，请在控制台扫码登录");
		loginBridge.flow.reportLoggedOut("notLogin");
		return true;
	}
	await loginBridge.flow.reportAccountInfo();
	await deps.subLoader.loadInitialSubscriptions();
	return true;
}

/** Tear down the api / push / login bridge and reset slots. */
export function tearDown(deps: {
	logger: Logger;
	subLoader: SubscriptionLoader;
	slots: ManagerSlots;
}): void {
	deps.slots.loginBridge?.stop();
	deps.subLoader.dispose();
	deps.slots.push?.stop();
	deps.slots.api?.stop();
	deps.slots.push = null;
	deps.slots.api = null;
	deps.slots.loginBridge = null;
	deps.logger.debug("[stop] 插件资源清理完成");
}

/** Shape returned by `BilibiliNotifyServerManager.getInternals(BILIBILI_NOTIFY_TOKEN)`. */
export interface InternalsShape {
	api: BilibiliAPI;
	push: BilibiliPush;
	subs: Subscriptions | null;
	addSub: (
		params: { uid: string; name: string; platform: string; target: string } & SubFlagOverrides,
	) => Promise<string>;
	removeSub: (uid: string) => string;
	updateSub: (params: { uid: string } & SubFlagOverrides) => Promise<string>;
}

/** Build the internals object exposed to friendly plugins; null-guarded for the 4 prereqs. */
export function buildInternals(args: {
	token: symbol;
	api: BilibiliAPI | null;
	push: BilibiliPush | null;
	subLoader: SubscriptionLoader;
}): InternalsShape | null {
	if (args.token !== BILIBILI_NOTIFY_TOKEN || !args.api || !args.push) return null;
	return {
		api: args.api,
		push: args.push,
		subs: args.subLoader.currentSubs,
		addSub: (p) => args.subLoader.addSub(p),
		removeSub: (uid) => args.subLoader.removeSub(uid),
		updateSub: (p) => args.subLoader.updateSub(p),
	};
}
