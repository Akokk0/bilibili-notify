import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	deterministicUuid,
	FEATURE_KEYS,
	type FeatureKey,
	makeEmptySubscription,
	type Subscription,
	type SubscriptionRouting,
} from "@bilibili-notify/internal";
import type { FlatSubConfigItem, SubscriptionStore } from "@bilibili-notify/subscription";
import type { Notifier } from "@koishijs/plugin-notifier";
import { type Context, h, type Logger } from "koishi";
import type { BilibiliNotifyConfig } from "../config";
import type { TargetRegistry } from "../push/target-registry";
import { synthesizeKoishiBotAdapter, synthesizeTargetsForFlatSub } from "../push/target-synthesis";
import { buildAdvancedSubAndTargets } from "./advanced";

export interface SubscriptionLoaderHooks {
	getConfig(): BilibiliNotifyConfig;
	setConfig(next: BilibiliNotifyConfig): void;
	subList(): string;
}

/**
 * Maps the legacy master feature booleans to FeatureKeys.
 * These are the features that have per-sub toggles.
 *
 * NB:`dynamicAtAll` / `liveAtAll` 不在这张表里 —— 它们是 @全体 修饰符,不是独立的
 * routing feature。flatSubToSubscription 把它们写到 `Subscription.atAllDefaults`
 * (订阅级默认),per-target 覆写需要 advanced-subscription / Web Dashboard 来编辑。
 */
const LEGACY_FEATURE_MAP: ReadonlyArray<{ legacy: keyof FlatSubConfigItem; feature: FeatureKey }> =
	[
		{ legacy: "dynamic", feature: "dynamic" },
		{ legacy: "live", feature: "live" },
		{ legacy: "liveEnd", feature: "liveEnd" },
		{ legacy: "liveGuardBuy", feature: "liveGuardBuy" },
		{ legacy: "superchat", feature: "superchat" },
		{ legacy: "wordcloud", feature: "wordcloud" },
		{ legacy: "liveSummary", feature: "liveSummary" },
	] as const;

/**
 * Translate a FlatSubConfigItem into a Subscription + synthesize PushTargets.
 * The channel ids in the legacy `target` field become real PushTarget rows.
 * Returns [subscription, targets[]].
 *
 * Target synthesis strategy:
 * - The legacy `target: "channel1,channel2"` string gets split by comma.
 * - Each channel becomes a PushTarget with:
 *     id        = stable deterministic uuid based on platform+channelId
 *     platform  = "koishi-<item.platform>"
 *     scope     = "group"
 *     config    = { botPlatform: item.platform, channelId }
 * - De-duplication: if the registry already has a target with the same
 *   platform+channelId, reuse its id.
 * - Every enabled feature on the sub gets that target's id in routing[feature].
 */
export function flatSubToSubscription(
	item: FlatSubConfigItem,
	registry: TargetRegistry,
): Subscription {
	const uid = item.uid.split(",")[0].trim();
	// Use a deterministic id based on uid so re-loading is stable.
	const subId = deterministicUuid(`sub:${uid}`);
	const sub = makeEmptySubscription({ id: subId, uid });
	const name = item.name?.trim();
	if (name && name !== uid) sub.name = name;
	sub.overrides = {};

	// Synthesize adapter (one per botPlatform) + targets and wire routing.
	const channelIds = item.target
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	// Reuse or create a single koishi-bot adapter for this botPlatform.
	let adapter = registry.findKoishiBotAdapter(item.platform);
	if (!adapter) {
		adapter = synthesizeKoishiBotAdapter(item.platform);
		registry.setAdapter(adapter);
	}

	const targetIds: string[] = [];
	for (const channelId of channelIds) {
		const existing = registry.findTargetByChannel(adapter.id, channelId);
		if (existing) {
			targetIds.push(existing.id);
		} else {
			const t = synthesizeTargetsForFlatSub(adapter, channelId);
			registry.set(t);
			targetIds.push(t.id);
		}
	}

	// Wire routing: each enabled legacy feature → all targetIds
	const routing: SubscriptionRouting = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as SubscriptionRouting;

	const featureOverrides: Partial<Record<FeatureKey, boolean>> = {};
	for (const { legacy, feature } of LEGACY_FEATURE_MAP) {
		const enabled = item[legacy as keyof FlatSubConfigItem];
		if (typeof enabled === "boolean") featureOverrides[feature] = enabled;
		if (enabled) {
			routing[feature] = [...targetIds];
		}
	}
	// specialDanmaku / specialUserEnter get no legacy mapping (not in flat config)
	// but keep empty arrays as initialized.

	if (Object.keys(featureOverrides).length > 0) sub.overrides.features = featureOverrides;
	sub.routing = routing;
	sub.atAllDefaults = {
		dynamic: item.dynamicAtAll ?? false,
		live: item.liveAtAll ?? true,
	};
	return sub;
}

export interface SubscriptionLoaderOptions {
	ctx: Context;
	logger: Logger;
	hooks: SubscriptionLoaderHooks;
	store: SubscriptionStore;
	registry: TargetRegistry;
	api: BilibiliAPI;
}

/**
 * Owns the koishi-side runtime subscription state. Translates whichever mode
 * is enabled — `config.subscriptions.list` (FlatSubConfigItem[]) or
 * `config.advancedSub.subs` (the rich per-UP dict) — into Subscription[] +
 * PushTarget[], and seeds the SubscriptionStore.
 */
export class SubscriptionLoader {
	private readonly ctx: Context;
	private readonly logger: Logger;
	private readonly hooks: SubscriptionLoaderHooks;
	private readonly store: SubscriptionStore;
	private readonly registry: TargetRegistry;
	private readonly api: BilibiliAPI;
	private subNotifier?: Notifier;
	constructor(opts: SubscriptionLoaderOptions) {
		this.ctx = opts.ctx;
		this.logger = opts.logger;
		this.hooks = opts.hooks;
		this.store = opts.store;
		this.registry = opts.registry;
		this.api = opts.api;
	}

	dispose(): void {
		this.subNotifier?.dispose();
		this.subNotifier = undefined;
		this.store.replaceAll([]);
		this.registry.clear();
	}

	/** Initial load after a successful login. */
	async loadInitialSubscriptions(): Promise<void> {
		const config = this.hooks.getConfig();
		if (config.advancedSub.enabled) {
			// Adapters + targets registered first so routing (which references
			// their ids) resolves once subs land in the store.
			const { subs, adapters, targets, warnings } = buildAdvancedSubAndTargets(config.advancedSub);
			for (const a of adapters) this.registry.setAdapter(a);
			for (const t of targets) this.registry.set(t);
			// 转换是纯函数,自己不打日志 —— 可疑配置在这里落地。加载期一次性,不是热路径。
			for (const w of warnings) this.logger.warn(w);
			if (!subs.length) {
				this.logger.info("[sub] 高级订阅已加载，但未添加任何订阅");
				return;
			}
			this.store.replaceAll(subs);
			this.updateSubNotifier();
			return;
		}
		if (!config.subscriptions.list?.length) {
			this.logger.info("[sub] 初始化完毕，但未添加任何订阅");
			return;
		}
		this.logger.debug(`[sub] 从配置加载 ${config.subscriptions.list.length} 个订阅项`);
		const subs = await this.translateFlatSubs(config.subscriptions.list);
		this.store.replaceAll(subs);
		this.updateSubNotifier();
	}

	/** Translate a flat config array into Subscription[], registering PushTargets. */
	private async translateFlatSubs(items: FlatSubConfigItem[]): Promise<Subscription[]> {
		const subs: Subscription[] = [];
		for (const item of items) {
			const sub = flatSubToSubscription(item, this.registry);
			// Perform follow + roomId resolution via API
			const uid = sub.uid;
			const followResult = await this.followUser(uid);
			if (followResult.code !== 0) {
				this.logger.error(`[sub] 关注 UID：${uid} 失败：${followResult.message}，跳过`);
				continue;
			}
			subs.push(sub);
		}
		return subs;
	}

	private async followUser(uid: string): Promise<{ code: number; message: string }> {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const res = (await this.api.follow(uid)) as any;
			const code: number = res.code ?? -1;
			const message: string = res.message ?? "";
			if (code === 22001 || code === 22014 || code === 0) {
				return { code: 0, message: "OK" };
			}
			return { code, message };
		} catch (e) {
			const msg = e instanceof Error ? (e.message ?? e.toString()) : String(e);
			return { code: -1, message: msg };
		}
	}

	/** Refresh the koishi console subscription Notifier widget. */
	updateSubNotifier(): void {
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
}

export type { FlatSubConfigItem };
