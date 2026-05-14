import type { FlatSubConfigItem, SubscriptionStore } from "@bilibili-notify/subscription";
import type { Logger } from "koishi";
import type { BilibiliNotifyConfig } from "./config";
import { flatSubToSubscription } from "./subscription-loader";
import type { TargetRegistry } from "./target-registry";

/** Subset of optional flags accepted by add/update — mirrors the AI command surface. */
export interface SubFlagOverrides {
	dynamic?: boolean;
	dynamicAtAll?: boolean;
	live?: boolean;
	liveAtAll?: boolean;
	liveEnd?: boolean;
	liveGuardBuy?: boolean;
	superchat?: boolean;
	wordcloud?: boolean;
	liveSummary?: boolean;
}

const FLAG_KEYS: ReadonlyArray<keyof SubFlagOverrides> = [
	"dynamic",
	"dynamicAtAll",
	"live",
	"liveAtAll",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
];

const ADD_DEFAULTS: Required<SubFlagOverrides> = {
	dynamic: true,
	dynamicAtAll: false,
	live: true,
	liveAtAll: true,
	liveEnd: true,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: true,
	liveSummary: true,
};

export interface CrudDeps {
	logger: Logger;
	getConfig(): BilibiliNotifyConfig;
	commitConfig(next: BilibiliNotifyConfig): void;
	getStore(): SubscriptionStore | null;
	getRegistry(): TargetRegistry | null;
}

export async function addSubViaCrud(
	deps: CrudDeps,
	params: { uid: string; name: string; platform: string; target: string } & SubFlagOverrides,
): Promise<string> {
	const config = deps.getConfig();
	if (config.advancedSub) return "订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
	const store = deps.getStore();
	const registry = deps.getRegistry();
	if (!store || !registry) return "订阅失败：插件未就绪，操作未执行";

	const existing = store.findByUid(params.uid);
	if (existing) return `订阅失败：UID ${params.uid} 已在订阅列表中`;

	const flags = mergeFlags(ADD_DEFAULTS, params);
	const item: FlatSubConfigItem = {
		name: params.name,
		uid: params.uid,
		platform: params.platform,
		target: params.target,
		...flags,
	};

	const sub = flatSubToSubscription(item, registry);
	store.upsert(sub);

	deps.commitConfig({ ...config, subs: [...(config.subs ?? []), item] });
	deps.logger.info(`[subscribe] 已添加订阅：${params.name}（UID: ${params.uid}）`);
	return `已成功订阅 ${params.name}（UID: ${params.uid}）`;
}

export async function updateSubViaCrud(
	deps: CrudDeps,
	params: { uid: string } & SubFlagOverrides,
): Promise<string> {
	const config = deps.getConfig();
	if (config.advancedSub) return "更新订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
	const store = deps.getStore();
	const registry = deps.getRegistry();
	if (!store || !registry) return "更新订阅失败：插件未就绪，操作未执行";

	const existing = store.findByUid(params.uid);
	if (!existing) return `更新订阅失败：未找到 UID 为 ${params.uid} 的订阅，操作未执行`;

	// Find in flat config
	const flatSubs = config.subs ?? [];
	const idx = flatSubs.findIndex((s) => s.uid.split(",")[0].trim() === params.uid);
	if (idx === -1) return `更新订阅失败：未找到 UID 为 ${params.uid} 的配置项，操作未执行`;

	const flatItem = flatSubs[idx];
	const updatedItem: FlatSubConfigItem = { ...flatItem, ...mergeFlags(flatItem, params) };

	// Re-synthesize the subscription to get updated routing
	const updatedSub = flatSubToSubscription(updatedItem, registry);
	// Preserve the stable id and state from the existing sub
	updatedSub.id = existing.id;
	updatedSub.state = existing.state;
	updatedSub.cachedProfile = existing.cachedProfile;
	store.upsert(updatedSub);

	const newFlatSubs = [...flatSubs];
	newFlatSubs[idx] = updatedItem;
	deps.commitConfig({ ...config, subs: newFlatSubs });
	deps.logger.info(`[update] 已更新订阅：${flatItem.name}（UID: ${params.uid}）`);
	return `已成功更新 ${flatItem.name}（UID: ${params.uid}）的订阅设置`;
}

export function removeSubViaCrud(deps: CrudDeps, uid: string): string {
	const config = deps.getConfig();
	if (config.advancedSub) return "取消订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
	const store = deps.getStore();
	if (!store) return "取消订阅失败：插件未就绪，操作未执行";

	const sub = store.findByUid(uid);
	if (!sub) return `取消订阅失败：未找到 UID 为 ${uid} 的订阅，操作未执行`;

	store.removeById(sub.id);

	deps.commitConfig({
		...config,
		subs: (config.subs ?? []).filter((s) => s.uid.split(",")[0].trim() !== uid),
	});
	const name = sub.cachedProfile?.name ?? uid;
	deps.logger.info(`[unsubscribe] 已移除订阅：${name}（UID: ${uid}）`);
	return `已成功取消订阅 ${name}（UID: ${uid}）`;
}

/** Apply only the flag keys present in `overrides` on top of `base`. */
function mergeFlags<T extends SubFlagOverrides>(base: T, overrides: SubFlagOverrides): T {
	const out = { ...base } as T;
	for (const key of FLAG_KEYS) {
		if (overrides[key] !== undefined) (out as SubFlagOverrides)[key] = overrides[key];
	}
	return out;
}

// SubFlagOverrides is already exported above as 'export interface SubFlagOverrides'
