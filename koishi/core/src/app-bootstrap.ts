import type { BilibiliAPI } from "@bilibili-notify/api";
import { makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import type { BilibiliPush } from "@bilibili-notify/push";
import { StorageManager } from "@bilibili-notify/storage";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
// biome-ignore lint/correctness/noUnusedImports: module augmentation for koishi help commands
import {} from "@koishijs/plugin-help";
import { type Awaitable, type Context, type Logger, Service } from "koishi";
import { biliCommands, statusCommands, sysCommands } from "./commands";
import type { BilibiliNotifyConfig } from "./config";
import { HealthCheck } from "./health-check";
import {
	bringUp,
	buildInternals,
	type InternalsShape,
	type ManagerSlots,
	tearDown,
} from "./lifecycle";
import type { LoginFlowBridge } from "./login-flow-bridge";
import { MasterNotifier } from "./master-notifier";

const SERVICE_NAME = "bilibili-notify";

/**
 * Koishi `Service` shell. Owns the controllers (auth, subscriptions, health,
 * master-notifier) and the runtime singletons (api / push / storage). The
 * external surface (`getInternals(token)`, `subList()`, `getAuthSnapshot()`)
 * preserves what commands, data-server, and downstream sub-plugins consume.
 */
class BilibiliNotifyServerManager extends Service<BilibiliNotifyConfig> {
	static readonly [Service.provide] = SERVICE_NAME;

	private readonly serverLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private readonly selfCtx: Context;
	private readonly slots: ManagerSlots = {
		api: null,
		push: null,
		loginBridge: null,
		store: null,
		registry: null,
		subLoader: null,
		cleanups: [],
	};
	private running = false;
	storageMgr!: StorageManager;
	private healthCheck!: HealthCheck;
	private masterNotifier!: MasterNotifier;

	constructor(ctx: Context, config: BilibiliNotifyConfig) {
		super(ctx, SERVICE_NAME);
		this.selfCtx = ctx;
		this.config = config;
		this.serverLogger.level = config.logLevel;
	}

	private get api(): BilibiliAPI | null {
		return this.slots.api;
	}
	private get push(): BilibiliPush | null {
		return this.slots.push;
	}
	private get loginBridge(): LoginFlowBridge | null {
		return this.slots.loginBridge;
	}

	get store(): SubscriptionStore | null {
		return this.slots.store;
	}

	getAuthSnapshot() {
		if (!this.loginBridge) throw new Error("login bridge not initialized");
		return this.loginBridge.flow.current();
	}

	subList(): string {
		const subs = this.slots.store?.list() ?? [];
		if (!subs.length) return "没有订阅任何UP";
		return subs
			.map((sub) => {
				const hasDyn = (sub.routing.dynamic?.length ?? 0) > 0;
				const hasLive = (sub.routing.live?.length ?? 0) > 0;
				const name = sub.uid;
				const flags = [hasDyn ? "已订阅动态" : "", hasLive ? "已订阅直播" : ""]
					.filter(Boolean)
					.join(" ");
				return `[UID:${sub.uid}] 「${name}」 ${flags}`;
			})
			.join("\n")
			.trim();
	}

	protected async start(): Promise<void> {
		this.serverLogger.info("[start] 正在启动中...");
		await this.initStorage();
		this.initControllers();
		this.wireCookiePersistence();
		sysCommands.call(this);
		if (!(await this.registerPlugin())) {
			this.serverLogger.error("[module] 启动模块失败，请检查配置后重试");
		}
	}

	protected stop(): Awaitable<void> {
		this.disposePlugin();
	}

	/**
	 * 向持有 BILIBILI_NOTIFY_TOKEN 的友好插件暴露 api / push / store 实例。
	 * 第三方插件无法获取此令牌，因此无法访问内部实例。
	 */
	getInternals(token: symbol): InternalsShape | null {
		return buildInternals({
			token,
			api: this.api,
			push: this.push,
			store: this.slots.store,
			registry: this.slots.registry,
		});
	}

	async registerPlugin(): Promise<boolean> {
		if (this.running) return false;
		try {
			await bringUp({
				ctx: this.selfCtx,
				logger: this.serverLogger,
				getConfig: () => this.config,
				storageMgr: this.storageMgr,
				registerCommands: () => {
					biliCommands.call(this);
					statusCommands.call(this);
				},
				slots: this.slots,
				subList: () => this.subList(),
			});
			this.running = true;
		} catch (e) {
			this.serverLogger.error(`[module] 注册模块失败：${e}`);
			return false;
		}
		return true;
	}

	disposePlugin(): boolean {
		if (!this.running && !this.api && !this.push) return false;
		this.serverLogger.debug("[stop] 正在清理插件资源...");
		this.running = false;
		tearDown({ logger: this.serverLogger, slots: this.slots });
		return true;
	}

	async restartPlugin(): Promise<boolean> {
		if (!this.running) {
			this.serverLogger.warn("[restart] 插件目前没有运行，请使用 bn start 启动插件");
			return false;
		}
		this.disposePlugin();
		return new Promise((resolve) => {
			this.selfCtx.setTimeout(() => {
				this.registerPlugin()
					.then(resolve)
					.catch((e) => {
						this.serverLogger.error(`[restart] 重启插件失败：${e}`);
						resolve(false);
					});
			}, 1000);
		});
	}

	private async initStorage(): Promise<void> {
		this.storageMgr = new StorageManager({
			serviceCtx: makeKoishiServiceContext(this.ctx, "bilibili-notify-storage"),
			dataDir: this.ctx.baseDir,
		});
		await this.storageMgr.init();
	}

	private initControllers(): void {
		this.healthCheck = new HealthCheck({
			ctx: this.selfCtx,
			logger: this.serverLogger,
			getPush: () => this.push,
		});
		this.healthCheck.install();
		this.masterNotifier = new MasterNotifier({ ctx: this.selfCtx, logger: this.serverLogger });
		this.masterNotifier.install();
	}

	private wireCookiePersistence(): void {
		this.ctx.on("bilibili-notify/cookies-refreshed", async (data) => {
			try {
				await this.storageMgr.cookieStore.save(data);
				this.serverLogger.debug("[cookie] Cookie 已自动刷新并保存");
			} catch (e) {
				this.serverLogger.error(`[cookie] 保存刷新后的 cookie 失败：${e}`);
			}
		});
	}
}

export default BilibiliNotifyServerManager;
