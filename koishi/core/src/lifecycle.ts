import { BilibiliAPI, BiliLoginStatus } from "@bilibili-notify/api";
import {
	BILIBILI_NOTIFY_TOKEN,
	type GlobalDefaults,
	type LoginSnapshot,
	makeDefaultGlobalConfig,
} from "@bilibili-notify/internal";
import { makeKoishiMessageBus, makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import { BilibiliPush } from "@bilibili-notify/push";
import type { StorageManager } from "@bilibili-notify/storage";
import { createSubscriptionStore, type SubscriptionStore } from "@bilibili-notify/subscription";
import type { Context, Logger } from "koishi";
import { hasLoginCookie, loadInitialCookies, warnMissingPlugins } from "./bootstrap-helpers";
import type { BilibiliNotifyConfig } from "./config";
import { LoginFlowBridge } from "./login-flow-bridge";
import { createKoishiSink } from "./sink";
import { SubscriptionLoader } from "./subscription-loader";
import { TargetRegistry } from "./target-registry";
import { synthesizeKoishiBotAdapter, synthesizeMasterTarget } from "./target-synthesis";

/** Mutable runtime state on the manager that lifecycle helpers read/write. */
export interface ManagerSlots {
	api: BilibiliAPI | null;
	push: BilibiliPush | null;
	loginBridge: LoginFlowBridge | null;
	store: SubscriptionStore | null;
	registry: TargetRegistry | null;
	subLoader: SubscriptionLoader | null;
}

export interface LifecycleDeps {
	ctx: Context;
	logger: Logger;
	getConfig(): BilibiliNotifyConfig;
	storageMgr: StorageManager;
	/** Run after api/push are up — caller registers koishi commands here. */
	registerCommands(): void;
	slots: ManagerSlots;
	subList(): string;
}

/**
 * Bring the api / push / login bridge online and run the post-login handshake.
 * Returns true on success. Caller flips `running` based on the result.
 */
export async function bringUp(deps: LifecycleDeps): Promise<boolean> {
	const config = deps.getConfig();
	const apiServiceCtx = makeKoishiServiceContext(deps.ctx, "bilibili-notify-api", config.logLevel);
	const bus = makeKoishiMessageBus(deps.ctx);

	const api = new BilibiliAPI({
		serviceCtx: apiServiceCtx,
		config: { userAgent: config.userAgent },
		callbacks: {
			onCookiesRefreshed: (data) => deps.ctx.emit("bilibili-notify/cookies-refreshed", data),
			onAuthLost: () => void deps.slots.loginBridge?.flow.handleAuthLost(),
		},
	});

	// --- Target registry + SubscriptionStore ---
	const registry = new TargetRegistry();
	const store = createSubscriptionStore(bus);

	// --- Master target synthesis (with its own koishi-bot adapter) ---
	let masterTarget = null;
	if (config.master.enable && config.master.platform && config.master.masterAccount) {
		let masterAdapter = registry.findKoishiBotAdapter(config.master.platform);
		if (!masterAdapter) {
			masterAdapter = synthesizeKoishiBotAdapter(config.master.platform);
			registry.setAdapter(masterAdapter);
		}
		masterTarget = synthesizeMasterTarget(
			masterAdapter,
			config.master.masterAccount,
			config.master.masterAccountGuildId,
		);
		registry.set(masterTarget);
	}

	// --- Koishi NotificationSink ---
	const sink = createKoishiSink({
		ctx: deps.ctx,
		resolveTarget: (id) => registry.get(id),
		resolveAdapter: (id) => registry.getAdapter(id),
	});

	// --- BilibiliPush (new platform-neutral form) ---
	const pushServiceCtx = makeKoishiServiceContext(
		deps.ctx,
		"bilibili-notify-push",
		config.logLevel,
	);
	const push = new BilibiliPush({
		sink,
		store,
		master: masterTarget,
		logger: pushServiceCtx.logger,
		// PR3 #4 给 koishi config 接入 defaults 段后,这里改为读 koishi config。
		// 当前用 schema 默认值——features 全 true / quietHours 空,等价于无 gate。
		defaults: () => KOISHI_DEFAULTS,
	});

	await api.start();
	deps.logger.debug("[module] BilibiliAPI 启动完成");
	push.start();
	deps.logger.debug("[module] BilibiliPush 启动完成");

	const loginBridge = new LoginFlowBridge({
		ctx: deps.ctx,
		bus,
		serviceCtx: apiServiceCtx,
		api,
		logger: deps.logger,
		healthCheckMs: config.loginHealthCheckMinutes * 60_000,
		saveCookies: (data) => deps.storageMgr.cookieStore.save(data),
		resetCookieKey: () => deps.storageMgr.cookieStore.resetKey(),
	});
	loginBridge.install();
	await loginBridge.flow.start();

	const subLoader = new SubscriptionLoader({
		ctx: deps.ctx,
		logger: deps.logger,
		hooks: {
			getConfig: deps.getConfig,
			setConfig: () => {
				/* config is managed by app-bootstrap */
			},
			subList: deps.subList,
		},
		store,
		registry,
		api,
	});

	deps.slots.api = api;
	deps.slots.push = push;
	deps.slots.loginBridge = loginBridge;
	deps.slots.store = store;
	deps.slots.registry = registry;
	deps.slots.subLoader = subLoader;

	subLoader.registerAdvancedSubListener();

	deps.ctx.on("bilibili-notify/subscription-changed", async () => {
		await deps.ctx.sleep(5000);
		const subs = store.list();
		await warnMissingPlugins(deps.ctx, push, deps.logger, subs);
	});

	deps.registerCommands();

	await loadInitialCookies(api, deps.storageMgr, deps.logger);
	const loggedIn = hasLoginCookie(api);
	deps.logger.debug(`[cookie] Cookie 加载完成，登录状态：${loggedIn ? "已登录" : "未登录"}`);

	if (!loggedIn) {
		deps.logger.info("[login] 账号未登录，请在控制台扫码登录");
		loginBridge.flow.reportLoggedOut("notLogin");
		// 冷启动未登录路径：挂一个一次性 listener，在用户首次扫码登录成功后
		// 触发 loadInitialSubscriptions。LoginFlow 在 reportLoggedIn 时只在
		// `needsRestore=true` 的前提下 emit `auth-restored`（用于已登录态恢复），
		// 全新冷启动这条路径走不到，因此这里订阅 `login-status-report` 并按
		// 状态码过滤首次 LOGGED_IN 转换。
		let subsLoaded = false;
		const release = bus.on("login-status-report", (snap: LoginSnapshot) => {
			if (subsLoaded) return;
			if (snap.status !== BiliLoginStatus.LOGGED_IN) return;
			subsLoaded = true;
			release.dispose();
			void subLoader.loadInitialSubscriptions().catch((e) => {
				deps.logger.error(`[sub] 登录后加载订阅失败：${e}`);
			});
		});
		return true;
	}
	await loginBridge.flow.reportAccountInfo();
	await subLoader.loadInitialSubscriptions();
	return true;
}

/** Tear down the api / push / login bridge and reset slots. */
export function tearDown(deps: { logger: Logger; slots: ManagerSlots }): void {
	deps.slots.loginBridge?.stop();
	deps.slots.subLoader?.dispose();
	deps.slots.push?.stop();
	deps.slots.api?.stop();
	deps.slots.push = null;
	deps.slots.api = null;
	deps.slots.loginBridge = null;
	deps.slots.store = null;
	deps.slots.registry = null;
	deps.slots.subLoader = null;
	deps.logger.debug("[stop] 插件资源清理完成");
}

/**
 * Module-level GlobalDefaults snapshot for the Koishi side.
 *
 * PR3 #4 will replace this with a value derived from `BilibiliNotifyConfig`
 * (once koishi config exposes a `defaults` section). Until then it stays at
 * schema defaults — features all true, quietHours empty — which is behavior-
 * equivalent to "no gate", matching how Koishi worked pre-PR2.
 */
export const KOISHI_DEFAULTS: GlobalDefaults = makeDefaultGlobalConfig().defaults;

/** Shape returned by `BilibiliNotifyServerManager.getInternals(BILIBILI_NOTIFY_TOKEN)`. */
export interface InternalsShape {
	api: BilibiliAPI;
	push: BilibiliPush;
	store: SubscriptionStore;
	/**
	 * Koishi-side PushTarget registry. Friendly plugins (e.g. AI tools that
	 * create subscriptions on the user's behalf) need this to resolve a real
	 * targetId to wire into `Subscription.routing` instead of inventing a
	 * random UUID that points at no target.
	 */
	registry: TargetRegistry;
	/**
	 * GlobalDefaults snapshot — sub-plugins (dynamic / live) use this with
	 * `resolve(sub, defaults)` to get features-aware derived views.
	 */
	defaults: GlobalDefaults;
}

/** Build the internals object exposed to friendly plugins; null-guarded for the 4 prereqs. */
export function buildInternals(args: {
	token: symbol;
	api: BilibiliAPI | null;
	push: BilibiliPush | null;
	store: SubscriptionStore | null;
	registry: TargetRegistry | null;
}): InternalsShape | null {
	if (
		args.token !== BILIBILI_NOTIFY_TOKEN ||
		!args.api ||
		!args.push ||
		!args.store ||
		!args.registry
	)
		return null;
	return {
		api: args.api,
		push: args.push,
		store: args.store,
		registry: args.registry,
		defaults: KOISHI_DEFAULTS,
	};
}
