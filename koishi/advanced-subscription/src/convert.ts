/**
 * Pure (koishi-free) translation logic for the advanced-subscription adapter.
 *
 * Lives separately from `core.ts` because `core.ts` imports `koishi` (for
 * Schema and Context), which can't be loaded in unit tests outside an active
 * koishi runtime. The koishi-side `applyAdvancedSub()` re-exports/uses the
 * functions defined here.
 */

import {
	FEATURE_KEYS,
	type FeatureKey,
	makeEmptySubscription,
	type PushAdapter,
	type PushTarget,
	type Subscription,
	type SubscriptionRouting,
} from "@bilibili-notify/internal";

// ---- Type shapes (kept in lock-step with core.ts schema) ----

type ChannelFeatureKey = FeatureKey;

/**
 * `dynamicAtAll` / `liveAtAll` 不是 FeatureKey,而是 @全体 修饰符。在 advanced-sub Schema 里
 * 它们出现在两个地方:
 * - UP 级 (`raw.dynamicAtAll` / `raw.liveAtAll`):订阅级默认 → `Subscription.atAllDefaults`
 * - per-channel(`ch.dynamicAtAll` / `ch.liveAtAll`,**optional**):显式覆写 →
 *   `Subscription.atAll.X[targetId] = bool`;`undefined` 表示该 target inherit 订阅默认
 */
export type ChannelConfig = Partial<Record<ChannelFeatureKey, boolean>> & {
	channelId: string;
	dynamicAtAll?: boolean;
	liveAtAll?: boolean;
};

export interface TargetConfig {
	platform: string;
	channelArr: ChannelConfig[];
}

export type MasterFlagMap = Partial<Record<FeatureKey, boolean>>;

export type SubItemRawConfig = MasterFlagMap & {
	uid: string;
	roomId: string;
	dynamicAtAll?: boolean;
	liveAtAll?: boolean;
	target: TargetConfig[];
	customLiveSummary: { enable: boolean; liveSummary?: string[] };
	customLiveMsg: {
		enable: boolean;
		customLiveStart?: string;
		customLive?: string;
		customLiveEnd?: string;
	};
	customCardStyle: {
		enable: boolean;
		cardColorStart?: string;
		cardColorEnd?: string;
	};
	customGuardBuy: {
		enable: boolean;
		guardBuyMsg?: string;
		captainImgUrl?: string;
		supervisorImgUrl?: string;
		governorImgUrl?: string;
	};
	customSpecialDanmakuUsers: {
		enable: boolean;
		specialDanmakuUsers?: string[];
		msgTemplate?: string;
	};
	customSpecialUsersEnterTheRoom: {
		enable: boolean;
		specialUsersEnterTheRoom?: string[];
		msgTemplate?: string;
	};
};

export interface AdvancedSubRawConfigShape {
	subs: Record<string, SubItemRawConfig>;
}

// ---- Conversion logic ----

/**
 * Deterministic UUID from a string (same algorithm as subscription-loader.ts).
 * Must stay in sync if changed.
 *
 * NB: every intermediate is forced through `>>> 0` so JS bitwise ops can't
 * deliver a signed-negative number to `Number.prototype.toString(16)` (which
 * would emit a leading `-` and break the UUID shape — see Fix 6 / 8).
 */
export function deterministicUuid(input: string): string {
	let h1 = 5381;
	let h2 = 52711;
	let h3 = 0xdeadbeef;
	let h4 = 0xbaddcafe;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = (Math.imul(h1, 33) ^ c) >>> 0;
		h2 = (Math.imul(h2, 37) ^ c) >>> 0;
		h3 = (Math.imul(h3, 31) ^ c) >>> 0;
		h4 = (Math.imul(h4, 29) ^ c) >>> 0;
	}
	const toHex = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, "0").slice(-len);
	const seg1 = toHex(h1, 8);
	const seg2 = toHex((h2 >>> 0) & 0xffff, 4);
	const seg3 = `4${toHex(((h3 >>> 0) >>> 4) & 0x0fff, 3)}`; // version 4
	const seg4 = toHex((((h4 >>> 0) >>> 4) & 0x3fff) | 0x8000, 4); // RFC 4122 variant
	const seg5a = toHex((h1 ^ h2) >>> 0, 8);
	const seg5b = toHex(((h3 ^ h4) >>> 0) & 0xffff, 4);
	return `${seg1}-${seg2}-${seg3}-${seg4}-${seg5a}${seg5b}`;
}

export interface ConversionResult {
	sub: Subscription;
	adapters: PushAdapter[];
	targets: PushTarget[];
}

export function rawConfigToSubscription(_name: string, raw: SubItemRawConfig): ConversionResult {
	const uid = raw.uid;
	const subId = deterministicUuid(`sub:${uid}`);
	const sub = makeEmptySubscription({ id: subId, uid });

	// Build routing from the per-channel config
	const routing: SubscriptionRouting = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as SubscriptionRouting;

	// Collect synthesized adapters + targets for the channels referenced in
	// routing. Adapter ids are deterministic by botPlatform; target ids by
	// (adapterId, channelId). One adapter per botPlatform so a single config
	// reload doesn't multiply NapCat / Lagrange / etc entries.
	const adapters: PushAdapter[] = [];
	const targets: PushTarget[] = [];
	const seenAdapterIds = new Set<string>();
	const seenTargetIds = new Set<string>();

	for (const entry of raw.target ?? []) {
		const { platform, channelArr } = entry;
		if (!channelArr?.length) continue;
		const adapterId = deterministicUuid(`adapter:koishi-bot:${platform}`);
		if (!seenAdapterIds.has(adapterId)) {
			seenAdapterIds.add(adapterId);
			adapters.push({
				id: adapterId,
				name: platform,
				enabled: true,
				platform: "koishi-bot",
				config: { botPlatform: platform },
			});
		}

		for (const ch of channelArr) {
			// Synthesize a target id for this channel (deterministic by adapterId + channelId)
			const targetId = deterministicUuid(`target:${adapterId}:${ch.channelId}`);

			// Register a PushTarget for this channel exactly once per (adapterId, channelId).
			if (!seenTargetIds.has(targetId)) {
				seenTargetIds.add(targetId);
				targets.push({
					id: targetId,
					name: `${platform}:${ch.channelId}`,
					adapterId,
					platform: "koishi-bot",
					// Channel ids in advanced-sub are conventionally group ids; the dashboard
					// will let users override scope later. Keep it simple.
					scope: "group",
					enabled: true,
					session: { channelId: ch.channelId },
				});
			}

			for (const featureKey of FEATURE_KEYS) {
				// Channel-level enable: check ch[featureKey]
				const chEnabled = ch[featureKey as keyof typeof ch] as boolean | undefined;
				if (chEnabled === false) continue;

				// Master-level gating: if the master switch is explicitly false, skip
				const masterEnabled = raw[featureKey as keyof SubItemRawConfig] as boolean | undefined;
				if (masterEnabled === false) continue;

				if (!routing[featureKey]) routing[featureKey] = [];
				if (!routing[featureKey].includes(targetId)) {
					routing[featureKey].push(targetId);
				}
			}

			// @全体 per-target 覆写。Optional → undefined 表示「按订阅默认走」(不写 Map)。
			// `refine(keys(atAll.X) ⊆ routing.X)` 强制:写 Map 前必须 routing 已包含 targetId,
			// 否则 schema parse 会报错。
			if (ch.dynamicAtAll !== undefined && routing.dynamic?.includes(targetId)) {
				sub.atAll.dynamic[targetId] = ch.dynamicAtAll;
			}
			if (ch.liveAtAll !== undefined && routing.live?.includes(targetId)) {
				sub.atAll.live[targetId] = ch.liveAtAll;
			}
		}
	}

	sub.routing = routing;

	// UP 级 @全体 默认。Schema 给了 default(false / true),所以 raw.X 不会是 undefined,
	// 但为安全起见仍走 fallback。
	sub.atAllDefaults = {
		dynamic: raw.dynamicAtAll ?? false,
		live: raw.liveAtAll ?? true,
	};

	// Map custom overrides to the new overrides schema
	const cardStyle = raw.customCardStyle;
	if (cardStyle?.enable) {
		sub.overrides.cardStyle = {
			cardColorStart: cardStyle.cardColorStart,
			cardColorEnd: cardStyle.cardColorEnd,
		};
	}

	const liveMsg = raw.customLiveMsg;
	if (liveMsg?.enable) {
		sub.overrides.templates = {
			...(sub.overrides.templates ?? {}),
			liveMsgEnabled: true,
			...(liveMsg.customLiveStart !== undefined ? { liveStart: liveMsg.customLiveStart } : {}),
			...(liveMsg.customLive !== undefined ? { liveOngoing: liveMsg.customLive } : {}),
			...(liveMsg.customLiveEnd !== undefined ? { liveEnd: liveMsg.customLiveEnd } : {}),
		};
	}

	const guardBuy = raw.customGuardBuy;
	if (guardBuy?.enable) {
		const defaultUrl = (label: string) =>
			`https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/${label}`;
		sub.overrides.templates = {
			...(sub.overrides.templates ?? {}),
			guardBuy: {
				enable: true,
				captain: {
					imageUrl: guardBuy.captainImgUrl ?? defaultUrl("captain-Bjw5Byb5.png"),
					template: guardBuy.guardBuyMsg ?? "{user} 成为了 {mastername} 的舰长！",
				},
				commander: {
					imageUrl: guardBuy.supervisorImgUrl ?? defaultUrl("supervisor-u43ElIjU.png"),
					template: guardBuy.guardBuyMsg ?? "{user} 成为了 {mastername} 的提督！",
				},
				governor: {
					imageUrl: guardBuy.governorImgUrl ?? defaultUrl("governor-DpDXKEdA.png"),
					template: guardBuy.guardBuyMsg ?? "{user} 成为了 {mastername} 的总督！",
				},
			},
		};
	}

	const liveSummary = raw.customLiveSummary;
	if (liveSummary?.enable && liveSummary.liveSummary?.length) {
		sub.overrides.templates = {
			...(sub.overrides.templates ?? {}),
			liveSummary: liveSummary.liveSummary.join("\n"),
		};
	}

	// Special users
	if (raw.customSpecialDanmakuUsers?.enable) {
		const users = raw.customSpecialDanmakuUsers.specialDanmakuUsers ?? [];
		const tmpl = raw.customSpecialDanmakuUsers.msgTemplate ?? "";
		sub.specialUsers = [
			...sub.specialUsers,
			...users.map((uid) => ({ uid, kinds: ["danmaku" as const], template: tmpl })),
		];
		if (tmpl) {
			sub.overrides.templates = {
				...(sub.overrides.templates ?? {}),
				specialDanmaku: tmpl,
			};
		}
	}

	if (raw.customSpecialUsersEnterTheRoom?.enable) {
		const users = raw.customSpecialUsersEnterTheRoom.specialUsersEnterTheRoom ?? [];
		const tmpl = raw.customSpecialUsersEnterTheRoom.msgTemplate ?? "";
		sub.specialUsers = [
			...sub.specialUsers,
			...users.map((uid) => ({ uid, kinds: ["enter" as const], template: tmpl })),
		];
		if (tmpl) {
			sub.overrides.templates = {
				...(sub.overrides.templates ?? {}),
				specialUserEnter: tmpl,
			};
		}
	}

	return { sub, adapters, targets };
}

export interface BuildResult {
	subs: Subscription[];
	adapters: PushAdapter[];
	targets: PushTarget[];
}

/**
 * Pure (koishi-free) translation of the rich advanced-subscription Schema into
 * `Subscription[]` + their referenced `PushAdapter[]` + `PushTarget[]`.
 * Exported for unit testing.
 */
export function buildAdvancedSubAndTargets(config: AdvancedSubRawConfigShape): BuildResult {
	const subs: Subscription[] = [];
	const adapterMap = new Map<string, PushAdapter>();
	const targetMap = new Map<string, PushTarget>();
	for (const [name, raw] of Object.entries(config.subs)) {
		const { sub, adapters, targets } = rawConfigToSubscription(name, raw);
		subs.push(sub);
		// Dedup across subs: multiple UPs reusing the same adapter / channel collapse.
		for (const a of adapters) if (!adapterMap.has(a.id)) adapterMap.set(a.id, a);
		for (const t of targets) if (!targetMap.has(t.id)) targetMap.set(t.id, t);
	}
	return {
		subs,
		adapters: [...adapterMap.values()],
		targets: [...targetMap.values()],
	};
}
