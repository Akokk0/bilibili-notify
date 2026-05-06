import type { BilibiliAPI } from "@bilibili-notify/api";
import type { BilibiliPush, SubItem, Subscriptions } from "@bilibili-notify/push";
import { SubscriptionManager } from "@bilibili-notify/subscription";
import type { Notifier } from "@koishijs/plugin-notifier";
import { type Context, h, type Logger } from "koishi";
import type { BilibiliNotifyConfig } from "./config";
import { diffSubManagers } from "./sub-diff";
import {
	addSubViaCrud,
	type CrudDeps,
	removeSubViaCrud,
	type SubFlagOverrides,
	updateSubViaCrud,
} from "./subscription-crud";
import type { SubscriptionOp } from "./types";

export interface SubscriptionLoaderHooks {
	getConfig(): BilibiliNotifyConfig;
	setConfig(next: BilibiliNotifyConfig): void;
	subList(): string;
}

/**
 * Owns the koishi-side runtime subscription state: builds the initial map from
 * `config.subs` / `config.advancedSub`, performs add/remove/update CRUD via the
 * helpers in subscription-crud.ts, emits `bilibili-notify/subscription-changed`,
 * and refreshes the console subscription Notifier widget.
 */
export class SubscriptionLoader {
	private readonly ctx: Context;
	private readonly logger: Logger;
	private readonly hooks: SubscriptionLoaderHooks;
	subMgr: SubscriptionManager | null = null;
	private subNotifier?: Notifier;
	currentSubs: Subscriptions | null = null;

	constructor(ctx: Context, logger: Logger, hooks: SubscriptionLoaderHooks) {
		this.ctx = ctx;
		this.logger = logger;
		this.hooks = hooks;
	}

	bootstrap(api: BilibiliAPI, push: BilibiliPush): void {
		this.subMgr = new SubscriptionManager(api, push, this.ctx);
	}

	dispose(): void {
		this.subNotifier?.dispose();
		this.subNotifier = undefined;
		this.subMgr = null;
		this.currentSubs = null;
	}

	get subManager() {
		return this.subMgr?.subManager ?? new Map<string, SubItem>();
	}

	/** Initial load after a successful login. Mirrors the legacy `loadInitialSubscriptions`. */
	async loadInitialSubscriptions(): Promise<void> {
		const config = this.hooks.getConfig();
		if (config.advancedSub) {
			this.logger.info("[sub] 开启高级订阅，等待接收订阅配置...");
			this.ctx.emit("bilibili-notify/ready-to-receive");
			return;
		}
		if (!config.subs?.length) {
			this.logger.info("[sub] 初始化完毕，但未添加任何订阅");
			return;
		}
		this.logger.debug(`[sub] 从配置加载 ${config.subs.length} 个订阅项`);
		const subs = SubscriptionManager.fromFlatConfig(config.subs);
		if (!this.subMgr) return;
		await this.subMgr.loadSubscriptions(subs, { isReload: false });
		this.syncCurrentSubs();
		this.updateSubNotifier();
		const ops: SubscriptionOp[] = [...this.subMgr.subManager.values()].map((sub) => ({
			type: "add" as const,
			sub,
		}));
		if (ops.length) this.ctx.emit("bilibili-notify/subscription-changed", ops);
	}

	/** Wire the optional advanced-sub event listener. No-op outside advanced-sub mode. */
	registerAdvancedSubListener(): void {
		if (!this.hooks.getConfig().advancedSub) return;
		this.ctx.on("bilibili-notify/advanced-sub", async (subs: Subscriptions) => {
			if (!Object.keys(subs).length) {
				this.logger.info("[sub] 订阅加载完毕，但未添加任何订阅");
				return;
			}
			if (!this.subMgr) return;
			const prevSubManager = new Map(this.subMgr.subManager);
			await this.subMgr.loadSubscriptions(subs, { isReload: prevSubManager.size > 0 });
			this.syncCurrentSubs();
			this.updateSubNotifier();
			const ops = diffSubManagers(prevSubManager, this.subMgr.subManager);
			if (ops.length) this.ctx.emit("bilibili-notify/subscription-changed", ops);
		});
	}

	addSub(
		params: { uid: string; name: string; platform: string; target: string } & SubFlagOverrides,
	): Promise<string> {
		return addSubViaCrud(this.crudDeps(), params);
	}

	updateSub(params: { uid: string } & SubFlagOverrides): Promise<string> {
		return updateSubViaCrud(this.crudDeps(), params);
	}

	removeSub(uid: string): string {
		return removeSubViaCrud(this.crudDeps(), uid);
	}

	syncCurrentSubs(): void {
		if (!this.subMgr?.subManager.size) {
			this.currentSubs = null;
			return;
		}
		const result: Subscriptions = {};
		for (const [uid, sub] of this.subMgr.subManager) result[uid] = sub;
		this.currentSubs = result;
	}

	/** Refresh the koishi console subscription Notifier widget. */
	updateSubNotifier(): void {
		if (!this.subMgr) return;
		this.subNotifier?.dispose();
		const subInfo = this.hooks.subList();
		if (subInfo === "没有订阅任何UP") {
			this.subNotifier = this.ctx.notifier.create(subInfo);
			return;
		}
		const lines = subInfo.split("\n").filter(Boolean);
		const content = h(h.Fragment, [
			h("p", "当前订阅对象："),
			h(
				"ul",
				lines.map((str: string) => h("li", str)),
			),
		]);
		this.subNotifier = this.ctx.notifier.create(content);
	}

	private commitConfig(next: BilibiliNotifyConfig): void {
		this.hooks.setConfig(next);
		this.ctx.emit("bilibili-notify/update-config", next);
		this.syncCurrentSubs();
		this.updateSubNotifier();
	}

	private crudDeps(): CrudDeps {
		return {
			ctx: this.ctx,
			logger: this.logger,
			getConfig: () => this.hooks.getConfig(),
			commitConfig: (next) => this.commitConfig(next),
			getSubMgr: () => this.subMgr,
		};
	}
}

export type { SubFlagOverrides };
