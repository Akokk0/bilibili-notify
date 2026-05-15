/**
 * Pure (koishi-free) translation logic for the advanced-subscription adapter.
 *
 * Lives separately from `core.ts` because `core.ts` imports `koishi` (for
 * Schema and Context), which can't be loaded in unit tests outside an active
 * koishi runtime. The koishi-side `applyAdvancedSub()` re-exports/uses the
 * functions defined here.
 */

import {
	deterministicUuid,
	FEATURE_KEYS,
	type FeatureKey,
	makeEmptySubscription,
	type PushAdapter,
	type PushTarget,
	type Subscription,
	type SubscriptionRouting,
} from "@bilibili-notify/internal";

export { deterministicUuid };

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
	/** per-UP 免打扰时段;覆盖全局 quietHours。留空/undefined = 继承全局。 */
	quietHours?: Array<{ start: number; end: number }>;
	// ---- per-UP filters/schedule overrides ----
	blockForward?: boolean;
	blockArticle?: boolean;
	blockKeywords?: string[];
	blockRegex?: string[];
	whitelistKeywords?: string[];
	whitelistRegex?: string[];
	minScPrice?: number;
	minGuardLevel?: 1 | 2 | 3;
	pushTime?: number;
	restartPush?: boolean;
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
	customAi?: {
		enable: boolean;
		personaName?: string;
		addressUser?: string;
		addressSelf?: string;
		personaTraits?: string;
		catchphrase?: string;
		baseRole?: string;
		extraSystemPrompt?: string;
		dynamicPrompt?: string;
		liveSummaryPrompt?: string;
		temperature?: number;
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

	// UP 级 features 总开关 → sub.overrides.features。
	// 之前 convert.ts 只用 raw.X=false 来 gate routing 计算(routing.X 跳过该 channel),
	// 但没写到 overrides.features——导致 resolve 后 eff.features.X 仍等于全局默认(全 true),
	// LiveEngine `needsLiveMonitor` 仍开 WS、payload 仍 build,只是 broadcastToFeature 内
	// routing 空兜底不发。这跟「features 决定监听」mental model 矛盾。
	//
	// 现在显式写 overrides.features:仅在 raw.X === false 时写(true 留空 = 继承全局
	// 默认 = schema 默认 true)。这样 PR2 接通的 features-only 监听层在 koishi 端真生效。
	const featureOverrides: Partial<Record<FeatureKey, boolean>> = {};
	for (const k of FEATURE_KEYS) {
		if (raw[k as keyof SubItemRawConfig] === false) featureOverrides[k] = false;
	}
	if (Object.keys(featureOverrides).length > 0) {
		sub.overrides.features = featureOverrides;
	}

	// UP 级 quietHours → sub.overrides.schedule.quietHours。
	// 用户在 advanced-subscription 配 per-UP quietHours 即可覆盖全局;留空 / undefined
	// 则不写 override → resolve 时 fallback 到 globals.schedule.quietHours(koishi config
	// 顶层 quietHours)。
	if (raw.quietHours && raw.quietHours.length > 0) {
		sub.overrides.schedule = {
			...(sub.overrides.schedule ?? {}),
			quietHours: raw.quietHours,
		};
	}

	// ---- per-UP filters override ----
	// 策略:数组类(blockKeywords/...)length>0 才写(空 = 继承全局);
	// boolean / number 类总是写(显式值 — 包括 false / 0 都是有意义的选择)。
	// 用 partial 模式,只写真正出现在 raw 上的字段(undefined 跳过,不污染未配置项)。
	const filterOverrides: Partial<{
		blockForward: boolean;
		blockArticle: boolean;
		blockKeywords: string[];
		blockRegex: string[];
		whitelistKeywords: string[];
		whitelistRegex: string[];
		minScPrice: number;
		minGuardLevel: 1 | 2 | 3;
	}> = {};
	if (raw.blockForward !== undefined) filterOverrides.blockForward = raw.blockForward;
	if (raw.blockArticle !== undefined) filterOverrides.blockArticle = raw.blockArticle;
	if (raw.blockKeywords && raw.blockKeywords.length > 0)
		filterOverrides.blockKeywords = raw.blockKeywords;
	if (raw.blockRegex && raw.blockRegex.length > 0) filterOverrides.blockRegex = raw.blockRegex;
	if (raw.whitelistKeywords && raw.whitelistKeywords.length > 0)
		filterOverrides.whitelistKeywords = raw.whitelistKeywords;
	if (raw.whitelistRegex && raw.whitelistRegex.length > 0)
		filterOverrides.whitelistRegex = raw.whitelistRegex;
	if (raw.minScPrice !== undefined) filterOverrides.minScPrice = raw.minScPrice;
	if (raw.minGuardLevel !== undefined) filterOverrides.minGuardLevel = raw.minGuardLevel;
	if (Object.keys(filterOverrides).length > 0) {
		sub.overrides.filters = filterOverrides;
	}

	// ---- per-UP schedule override (pushTime / restartPush) ----
	if (raw.pushTime !== undefined) {
		sub.overrides.schedule = {
			...(sub.overrides.schedule ?? {}),
			pushTime: raw.pushTime,
		};
	}
	if (raw.restartPush !== undefined) {
		sub.overrides.schedule = {
			...(sub.overrides.schedule ?? {}),
			restartPush: raw.restartPush,
		};
	}

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

	// ---- per-UP AI override ----
	// enable=true 时写完整 persona(5 个 required string 走 koishi schema default
	// 兜底)+ 按需补 prompts/temperature。preset 固定为 "custom"——koishi 端不暴露
	// preset 选择(dashboard 用户才能选内置 preset),enable 即「我自己填」。
	// dynamicPrompt / liveSummaryPrompt 留空字符串时不写,让 resolve 时 fallback
	// 到 globals.ai 对应字段。baseRole / extraSystemPrompt 留空字符串时仍写——
	// AIPersonaSchema 把它们 default(""),不会破坏 zod parse。
	const aiCfg = raw.customAi;
	if (aiCfg?.enable) {
		const ai: NonNullable<Subscription["overrides"]["ai"]> = {
			preset: "custom",
			persona: {
				name: aiCfg.personaName ?? "",
				addressUser: aiCfg.addressUser ?? "",
				addressSelf: aiCfg.addressSelf ?? "",
				traits: aiCfg.personaTraits ?? "",
				catchphrase: aiCfg.catchphrase ?? "",
				baseRole: aiCfg.baseRole ?? "",
				extraSystemPrompt: aiCfg.extraSystemPrompt ?? "",
			},
		};
		if (aiCfg.dynamicPrompt) ai.dynamicPrompt = aiCfg.dynamicPrompt;
		if (aiCfg.liveSummaryPrompt) ai.liveSummaryPrompt = aiCfg.liveSummaryPrompt;
		if (aiCfg.temperature !== undefined) ai.temperature = aiCfg.temperature;
		sub.overrides.ai = ai;
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
