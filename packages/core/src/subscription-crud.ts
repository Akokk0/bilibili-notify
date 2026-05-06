import type { FlatSubConfigItem, SubscriptionManager } from "@bilibili-notify/subscription";
import type { Context, Logger } from "koishi";
import type { BilibiliNotifyConfig } from "./config";
import { diffSubItems } from "./sub-diff";

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
	liveAtAll: false,
	liveEnd: true,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: true,
	liveSummary: true,
};

export interface CrudDeps {
	ctx: Context;
	logger: Logger;
	getConfig(): BilibiliNotifyConfig;
	commitConfig(next: BilibiliNotifyConfig): void;
	getSubMgr(): SubscriptionManager | null;
}

export async function addSubViaCrud(
	deps: CrudDeps,
	params: { uid: string; name: string; platform: string; target: string } & SubFlagOverrides,
): Promise<string> {
	const config = deps.getConfig();
	if (config.advancedSub) return "订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
	const subMgr = deps.getSubMgr();
	if (!subMgr) return "订阅失败：插件未就绪，操作未执行";

	const existing = config.subs?.find((s) => s.uid.split(",")[0].trim() === params.uid);
	if (existing) return `订阅失败：UID ${params.uid} 已在订阅列表中（昵称：${existing.name}）`;

	const item: FlatSubConfigItem = {
		name: params.name,
		uid: params.uid,
		platform: params.platform,
		target: params.target,
		...mergeFlags(ADD_DEFAULTS, params),
	};

	const addedSub = await subMgr.addEntry(item);
	if (!addedSub) return `订阅失败：${params.name}（UID: ${params.uid}）操作未执行，请查看日志`;

	deps.commitConfig({ ...config, subs: [...(config.subs ?? []), item] });
	deps.ctx.emit("bilibili-notify/subscription-changed", [{ type: "add", sub: addedSub }]);
	deps.logger.info(`[subscribe] 已添加订阅：${params.name}（UID: ${params.uid}）`);
	return `已成功订阅 ${params.name}（UID: ${params.uid}）`;
}

export async function updateSubViaCrud(
	deps: CrudDeps,
	params: { uid: string } & SubFlagOverrides,
): Promise<string> {
	const config = deps.getConfig();
	if (config.advancedSub) return "更新订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
	const subMgr = deps.getSubMgr();
	if (!subMgr) return "更新订阅失败：插件未就绪，操作未执行";

	const flatSubs = config.subs ?? [];
	const idx = flatSubs.findIndex((s) => s.uid.split(",")[0].trim() === params.uid);
	if (idx === -1) return `更新订阅失败：未找到 UID 为 ${params.uid} 的订阅，操作未执行`;

	const existing = flatSubs[idx];
	const rawPrev = subMgr.subManager.get(params.uid);
	const prevSub = rawPrev ? structuredClone(rawPrev) : null;
	const updatedItem: FlatSubConfigItem = { ...existing, ...mergeFlags(existing, params) };

	const nextSub = subMgr.updateEntry(updatedItem);
	if (!nextSub) return `更新订阅失败：UID ${params.uid} 不在运行中的订阅管理器内，操作未执行`;

	const newFlatSubs = [...flatSubs];
	newFlatSubs[idx] = updatedItem;
	deps.commitConfig({ ...config, subs: newFlatSubs });
	if (prevSub) {
		const changes = diffSubItems(prevSub, nextSub);
		if (changes.length) {
			deps.ctx.emit("bilibili-notify/subscription-changed", [
				{ type: "update", uid: params.uid, changes },
			]);
		}
	}
	deps.logger.info(`[update] 已更新订阅：${existing.name}（UID: ${params.uid}）`);
	return `已成功更新 ${existing.name}（UID: ${params.uid}）的订阅设置`;
}

export function removeSubViaCrud(deps: CrudDeps, uid: string): string {
	const config = deps.getConfig();
	if (config.advancedSub) return "取消订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
	const subMgr = deps.getSubMgr();
	if (!subMgr) return "取消订阅失败：插件未就绪，操作未执行";

	const flatItem = config.subs?.find((s) => s.uid.split(",")[0].trim() === uid);
	if (!flatItem) return `取消订阅失败：未找到 UID 为 ${uid} 的订阅，操作未执行`;

	const removedSub = subMgr.removeEntry(uid);
	if (!removedSub) return `取消订阅失败：UID ${uid} 不在运行中的订阅管理器内，操作未执行`;

	deps.commitConfig({ ...config, subs: (config.subs ?? []).filter((s) => s !== flatItem) });
	deps.ctx.emit("bilibili-notify/subscription-changed", [{ type: "delete", uid }]);
	deps.logger.info(`[unsubscribe] 已移除订阅：${removedSub.uname}（UID: ${uid}）`);
	return `已成功取消订阅 ${removedSub.uname}（UID: ${uid}）`;
}

/** Apply only the flag keys present in `overrides` on top of `base`. */
function mergeFlags<T extends SubFlagOverrides>(base: T, overrides: SubFlagOverrides): T {
	const out = { ...base } as T;
	for (const key of FLAG_KEYS) {
		if (overrides[key] !== undefined) (out as SubFlagOverrides)[key] = overrides[key];
	}
	return out;
}
