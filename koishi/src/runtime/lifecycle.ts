import { BilibiliAPI, BiliLoginStatus } from "@bilibili-notify/api";
import {
	DEFAULT_SCHEDULE,
	type GlobalDefaults,
	type LoginSnapshot,
	makeDefaultGlobalConfig,
} from "@bilibili-notify/internal";
import { BilibiliPush } from "@bilibili-notify/push";
import type { StorageManager } from "@bilibili-notify/storage";
import { createSubscriptionStore, type SubscriptionStore } from "@bilibili-notify/subscription";
import type { Context, Logger } from "koishi";
import { LoginFlowBridge } from "../bridges/login-flow-bridge";
import type { BilibiliNotifyConfig } from "../config";
import { createKoishiSink } from "../push/sink";
import { TargetRegistry } from "../push/target-registry";
import { synthesizeKoishiBotAdapter, synthesizeMasterTarget } from "../push/target-synthesis";
import { SubscriptionLoader } from "../subscriptions/subscription-loader";
import { hasLoginCookie, loadInitialCookies } from "./bootstrap-helpers";
import { buildEngines, disposeEngines, type Engines } from "./engines";
import { makeKoishiMessageBus, makeKoishiServiceContext } from "./service-context";

/** Mutable runtime state on the manager that lifecycle helpers read/write. */
export interface ManagerSlots {
	api: BilibiliAPI | null;
	push: BilibiliPush | null;
	loginBridge: LoginFlowBridge | null;
	store: SubscriptionStore | null;
	registry: TargetRegistry | null;
	subLoader: SubscriptionLoader | null;
	/** render/ai/dynamic/live 引擎,与 api/push 同生命周期(切片9)。 */
	engines: Engines | null;
	/**
	 * Listener release 数组。bringUp 内通过 `deps.ctx.on(...)` 注册的事件 handler
	 * 必须把返回的 release 函数 push 到这里;tearDown 时统一调用,避免 `bn restart`
	 * 后 listener 累积(每次重启多挂一份导致 subscription-changed 重复 warn / 私聊)。
	 */
	cleanups: Array<() => void>;
}

export interface LifecycleDeps {
	ctx: Context;
	logger: Logger;
	getConfig(): BilibiliNotifyConfig;
	storageMgr: StorageManager;
	slots: ManagerSlots;
	subList(): string;
}

/**
 * Bring the api / push / login bridge online and run the post-login handshake.
 * Returns true on success. Caller flips `running` based on the result.
 */
export async function bringUp(deps: LifecycleDeps): Promise<boolean> {
	const config = deps.getConfig();
	const apiServiceCtx = makeKoishiServiceContext(
		deps.ctx,
		"bilibili-notify-api",
		config.account.logLevel,
	);
	const bus = makeKoishiMessageBus(deps.ctx);

	const api = new BilibiliAPI({
		serviceCtx: apiServiceCtx,
		config: { userAgent: config.account.userAgent },
		callbacks: {
			// block body → 显式返回 void(契合 onCookiesRefreshed 的 Promise<void>|void
			// 类型;ctx.emit 的 boolean 返回值不再泄漏)。
			onCookiesRefreshed: (data) => {
				deps.ctx.emit("bilibili-notify/cookies-refreshed", data);
			},
			// 与 standalone A1 同款:handleAuthLost() 是 Promise,此前 void 丢弃 →
			// reject 成 unhandled + auth-lost 迁移静默失败。改 .catch 经 logger。
			onAuthLost: () => {
				deps.slots.loginBridge?.flow.handleAuthLost()?.catch((e) => {
					apiServiceCtx.logger.error(`[auth] auth-lost 处理失败: ${(e as Error).message ?? e}`);
				});
			},
		},
	});

	// --- Target registry + SubscriptionStore ---
	const registry = new TargetRegistry();
	const store = createSubscriptionStore(bus);

	// --- Master target synthesis (with its own koishi-bot adapter) ---
	let masterTarget = null;
	if (
		config.push.master.enable &&
		config.push.master.platform &&
		config.push.master.masterAccount
	) {
		let masterAdapter = registry.findKoishiBotAdapter(config.push.master.platform);
		if (!masterAdapter) {
			masterAdapter = synthesizeKoishiBotAdapter(config.push.master.platform);
			registry.setAdapter(masterAdapter);
		}
		masterTarget = synthesizeMasterTarget(
			masterAdapter,
			config.push.master.masterAccount,
			config.push.master.masterAccountGuildId,
		);
		registry.set(masterTarget);
	}

	// --- Koishi NotificationSink ---
	const sink = createKoishiSink({
		ctx: deps.ctx,
		resolveTarget: (id) => registry.get(id),
		resolveAdapter: (id) => registry.getAdapter(id),
		logger: deps.logger,
	});

	// --- BilibiliPush (new platform-neutral form) ---
	const pushServiceCtx = makeKoishiServiceContext(
		deps.ctx,
		"bilibili-notify-push",
		config.account.logLevel,
	);
	// koishi 端只把 core.config.push.quietHours 注入 schedule;其余字段(features /
	// filters / templates / ai / cardStyle)由 makeDefaultGlobalConfig 兜底,sub
	// 折叠在各子插件 sub-view 里就地完成(per-UP override ?? plugin config)。
	// koishi 不做运行时配置热更,bringUp 一次性算好 defaults 出热路径(否则
	// 每次 broadcastToFeature 都跑一次 GlobalConfigSchema.parse)。reload 触发新
	// 一轮 bringUp,常量自动重建。
	const pushDefaults: GlobalDefaults = {
		...makeDefaultGlobalConfig().defaults,
		schedule: {
			...DEFAULT_SCHEDULE,
			quietHours: config.push.quietHours ?? [],
		},
	};
	const push = new BilibiliPush({
		sink,
		store,
		master: masterTarget,
		logger: pushServiceCtx.logger,
		serviceCtx: pushServiceCtx,
		defaults: () => pushDefaults,
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
		healthCheckMs: config.account.loginHealthCheckMinutes * 60_000,
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

	// render/ai/dynamic/live 引擎与 api/push/store/registry 同生命周期,在此一次性
	// 构造(见 runtime/engines.ts)。构造顺序 render → ai → dynamic → live,后两者
	// 直接持有前两者的 engine 引用,不再需要 ctx.inject 后置晚注入(切片9)。
	deps.slots.engines = buildEngines(deps.ctx, config, { api, push, store, registry });

	// bot 上线(login-added/updated)时复检 master 可达性。refreshMasterReachability 只在
	// push.start()(常早于 onebot 适配器连上)与 sendToMaster() 触发,缺这一步则启动期那条
	// 「master 目标不可达」虚警在 bot 后来上线后无人收尾。release 入 cleanups,tearDown 统一卸。
	const recheckMaster = (): void => push.recheckMasterReachability();
	deps.slots.cleanups.push(deps.ctx.on("login-added", recheckMaster));
	deps.slots.cleanups.push(deps.ctx.on("login-updated", recheckMaster));

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
		//
		// 同时把 release 推入 slots.cleanups,tearDown 时一并清。否则未登录状态
		// 下 `bn restart` 会让旧 listener 永远挂着,下次登录成功触发已经 tearDown
		// 的 subLoader.loadInitialSubscriptions → null deref。
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
		deps.slots.cleanups.push(() => release.dispose());
		return true;
	}
	await loginBridge.flow.reportAccountInfo();
	await subLoader.loadInitialSubscriptions();
	return true;
}

/** Tear down the api / push / login bridge and reset slots. */
export function tearDown(deps: { logger: Logger; slots: ManagerSlots }): void {
	// 先卸 ctx.on listener,避免 dispose 期间还接到事件触发已释放的 push/store。
	for (const release of deps.slots.cleanups) {
		try {
			release();
		} catch (e) {
			deps.logger.warn(`[stop] cleanup 释放失败:${(e as Error).message}`);
		}
	}
	deps.slots.cleanups.length = 0;
	// render/ai/dynamic/live 是 api/push 的消费方,先于两者析构(逆序对应 buildEngines
	// 的 render→ai→dynamic→live 构造顺序:live→dynamic→ai→render)。
	if (deps.slots.engines) disposeEngines(deps.slots.engines);
	deps.slots.engines = null;
	deps.slots.loginBridge?.stop();
	// P2:subLoader.dispose() 可能 emit subscription-changed;先停 push/api 再
	// dispose,杜绝事件落到仍在线的 push(listener 已先卸本就缓解,此处把次序
	// 也理顺,彻底消除理论窗口)。
	deps.slots.push?.stop();
	deps.slots.api?.stop();
	deps.slots.subLoader?.dispose();
	deps.slots.push = null;
	deps.slots.api = null;
	deps.slots.loginBridge = null;
	deps.slots.store = null;
	deps.slots.registry = null;
	deps.slots.subLoader = null;
	deps.logger.debug("[stop] 插件资源清理完成");
}
