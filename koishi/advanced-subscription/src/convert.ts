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
	type PushTarget,
	type Subscription,
	type SubscriptionRouting,
} from "@bilibili-notify/internal";

// ---- Type shapes (kept in lock-step with core.ts schema) ----

type ChannelFeatureKey = FeatureKey;

export type ChannelConfig = Partial<Record<ChannelFeatureKey, boolean>> & { channelId: string };

export interface TargetConfig {
	platform: string;
	channelArr: ChannelConfig[];
}

export type MasterFlagMap = Partial<Record<FeatureKey, boolean>>;

export type SubItemRawConfig = MasterFlagMap & {
	uid: string;
	roomId: string;
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
	const toHex = (n: number, len: number) =>
		((n >>> 0) & 0xffffffff).toString(16).padStart(len, "0").slice(-len);
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

	// Collect synthesized targets for the channels referenced in routing.
	// Without this the targetIds put into routing would point at no PushTarget
	// in the registry → push routing silently drops the message.
	const targets: PushTarget[] = [];
	const seenTargetIds = new Set<string>();

	for (const entry of raw.target ?? []) {
		const { platform, channelArr } = entry;
		if (!channelArr?.length) continue;
		const koishiPlatform = `koishi-${platform}`;

		for (const ch of channelArr) {
			// Synthesize a target id for this channel (deterministic by platform+channelId)
			const targetId = deterministicUuid(`target:${koishiPlatform}:${ch.channelId}`);

			// Register a PushTarget for this channel exactly once per (platform, channelId).
			if (!seenTargetIds.has(targetId)) {
				seenTargetIds.add(targetId);
				targets.push({
					id: targetId,
					name: `${platform}:${ch.channelId}`,
					platform: koishiPlatform,
					// Channel ids in advanced-sub are conventionally group ids; the dashboard
					// will let users override scope later. Keep it simple.
					scope: "group",
					config: {
						botPlatform: platform,
						channelId: ch.channelId,
					},
					enabled: true,
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
		}
	}

	sub.routing = routing;

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

	return { sub, targets };
}

export interface BuildResult {
	subs: Subscription[];
	targets: PushTarget[];
}

/**
 * Pure (koishi-free) translation of the rich advanced-subscription Schema into
 * `Subscription[]` + their referenced `PushTarget[]`. Exported for unit testing.
 */
export function buildAdvancedSubAndTargets(config: AdvancedSubRawConfigShape): BuildResult {
	const subs: Subscription[] = [];
	const targetMap = new Map<string, PushTarget>();
	for (const [name, raw] of Object.entries(config.subs)) {
		const { sub, targets } = rawConfigToSubscription(name, raw);
		subs.push(sub);
		// Dedup across subs: multiple UPs targeting the same channel share the targetId.
		for (const t of targets) {
			if (!targetMap.has(t.id)) targetMap.set(t.id, t);
		}
	}
	return { subs, targets: [...targetMap.values()] };
}
