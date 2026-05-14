import { randomUUID } from "node:crypto";
import type { SubManagement } from "@bilibili-notify/ai";
import { FEATURE_KEYS, makeEmptySubscription, type PushTarget } from "@bilibili-notify/internal";

/**
 * Pure (koishi-free) factory for the SubManagement façade the AI engine consumes
 * for its tool calls. Pulled out of `ai-service.ts` so it can be unit-tested
 * without booting koishi (the koishi import resolves a Service base class that
 * throws when loaded outside an active koishi runtime).
 */

/** Minimal store surface the AI subMgmt builder needs. */
export interface SubMgmtStoreLike {
	upsert(sub: ReturnType<typeof makeEmptySubscription>): void;
	findByUid(uid: string): ReturnType<typeof makeEmptySubscription> | undefined;
	removeById(id: string): void;
}

/** Minimal registry surface the AI subMgmt builder needs. */
export interface SubMgmtRegistryLike {
	all(): PushTarget[];
}

/**
 * Build the SubManagement façade.
 *
 * Resolves the default targetId via the registry rather than inventing a fresh
 * UUID that points at no PushTarget (Fix 7). Strategy:
 *   1. Prefer the master target (scope === "private") if present.
 *   2. Otherwise fall back to the first registered target.
 *   3. If the registry is empty, leave routing empty and report it so the
 *      operator knows to configure a PushTarget in the dashboard.
 */
export function buildSubManagement(deps: {
	store: SubMgmtStoreLike;
	registry: SubMgmtRegistryLike;
}): SubManagement {
	const { store, registry } = deps;
	return {
		addSub: async (params) => {
			const {
				uid,
				name,
				dynamic = true,
				dynamicAtAll = false,
				live = true,
				liveAtAll = true,
				liveGuardBuy = false,
				superchat = false,
				wordcloud = true,
				liveSummary = true,
			} = params;

			const knownTargets: PushTarget[] = registry.all();
			const masterTarget = knownTargets.find((t) => t.scope === "private");
			const defaultTarget = masterTarget ?? knownTargets[0];
			const targetIds: string[] = defaultTarget ? [defaultTarget.id] : [];

			const sub = makeEmptySubscription({ id: randomUUID(), uid });
			const routing = Object.fromEntries(FEATURE_KEYS.map((k) => [k, [] as string[]]));
			if (targetIds.length > 0) {
				if (dynamic) routing.dynamic = [...targetIds];
				if (live) routing.live = [...targetIds];
				if (liveGuardBuy) routing.liveGuardBuy = [...targetIds];
				if (superchat) routing.superchat = [...targetIds];
				if (wordcloud) routing.wordcloud = [...targetIds];
				if (liveSummary) routing.liveSummary = [...targetIds];
			}
			sub.routing = routing as typeof sub.routing;
			// AI tool 写「订阅级默认」(atAllDefaults),不动 per-target Map(留给用户在 dashboard 改)。
			sub.atAllDefaults = {
				dynamic: dynamic ? dynamicAtAll : false,
				live: live ? liveAtAll : false,
			};
			store.upsert(sub);
			if (targetIds.length === 0) {
				return `已订阅 ${name}（UID: ${uid}），但当前无 PushTarget 可路由，请到 dashboard 配置推送目标后再使用`;
			}
			return `已成功订阅 ${name}（UID: ${uid}）`;
		},
		removeSub: (uid) => {
			const sub = store.findByUid(uid);
			if (!sub) return `UID: ${uid} 不在订阅列表中`;
			store.removeById(sub.id);
			return `已成功取消订阅（UID: ${uid}）`;
		},
		updateSub: async (params) => {
			const sub = store.findByUid(params.uid);
			if (!sub) return `UID: ${params.uid} 不在订阅列表中`;
			const updated = { ...sub };
			const targetIds = Object.values(sub.routing)
				.flat()
				.filter((id, i, arr) => arr.indexOf(id) === i);
			const routing = { ...sub.routing };
			if (params.dynamic !== undefined) routing.dynamic = params.dynamic ? targetIds : [];
			if (params.live !== undefined) routing.live = params.live ? targetIds : [];
			if (params.liveGuardBuy !== undefined)
				routing.liveGuardBuy = params.liveGuardBuy ? targetIds : [];
			if (params.superchat !== undefined) routing.superchat = params.superchat ? targetIds : [];
			if (params.wordcloud !== undefined) routing.wordcloud = params.wordcloud ? targetIds : [];
			if (params.liveSummary !== undefined)
				routing.liveSummary = params.liveSummary ? targetIds : [];
			updated.routing = routing;
			// AI tool 写「订阅级默认」(atAllDefaults),不动 per-target Map。
			// 关闭父 feature 时强制把对应 default 拉回 false(打开 atAll 没意义)。
			const atAllDefaults = { ...sub.atAllDefaults };
			if (params.dynamic === false) atAllDefaults.dynamic = false;
			else if (params.dynamicAtAll !== undefined) atAllDefaults.dynamic = params.dynamicAtAll;
			if (params.live === false) atAllDefaults.live = false;
			else if (params.liveAtAll !== undefined) atAllDefaults.live = params.liveAtAll;
			updated.atAllDefaults = atAllDefaults;
			store.upsert(updated);
			return `已成功更新（UID: ${params.uid}）的订阅设置`;
		},
	};
}
