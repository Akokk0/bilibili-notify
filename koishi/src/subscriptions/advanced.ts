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
import { synthesizeKoishiBotAdapter } from "../push/target-synthesis";

// ---- Type shapes (kept in lock-step with core.ts schema) ----

type ChannelFeatureKey = FeatureKey;
type UpFeatureKey = Exclude<FeatureKey, "specialDanmaku" | "specialUserEnter">;

const UP_FEATURE_KEYS: readonly UpFeatureKey[] = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
] as const;

/**
 * `dynamicAtAll` / `liveAtAll` 不是 FeatureKey,而是 @全体 修饰符。在 advanced-sub Schema 里
 * 它们出现在两个地方:
 * - UP 级 (`raw.dynamicAtAll` / `raw.liveAtAll`):订阅级默认 → `Subscription.atAllDefaults`
 * - per-channel(`ch.dynamicAtAll` / `ch.liveAtAll`,**optional**):显式覆写 →
 *   `Subscription.atAll.X[targetId] = bool`;`undefined` 表示该 target inherit 订阅默认
 */
type ChannelConfig = Partial<Record<ChannelFeatureKey, boolean>> & {
	channelId: string;
	dynamicAtAll?: boolean;
	liveAtAll?: boolean;
};

interface TargetConfig {
	platform: string;
	/**
	 * 指定用哪个机器人账号发。留空 = 用该平台第一个**在线**的(历史行为)。
	 *
	 * 填了就只认它:那个号离线就不发,也不会改用同平台的别的号 —— 见 bot-resolve 的
	 * selfId-miss 分支。
	 */
	selfId?: string;
	channelArr: ChannelConfig[];
}

type MasterFlagMap = Partial<Record<FeatureKey, boolean>>;

export type SubItemRawConfig = MasterFlagMap & {
	uid: string;
	roomId: string;
	dynamicAtAll?: boolean;
	liveAtAll?: boolean;
	target: TargetConfig[];
	/** per-UP 内容过滤(覆盖 globals.defaults.filters)。enable=false → 整组不生效,纯继承全局。 */
	customFilters?: {
		enable: boolean;
		blockForward?: boolean;
		blockArticle?: boolean;
		blockDraw?: boolean;
		blockAv?: boolean;
		blockKeywords?: string[];
		blockRegex?: string[];
		whitelistKeywords?: string[];
		whitelistRegex?: string[];
		minScPrice?: number;
		minGuardLevel?: 1 | 2 | 3;
	};
	/** per-UP 调度(覆盖 globals.defaults.schedule)。enable=false → 整组不生效,纯继承全局。 */
	customSchedule?: {
		enable: boolean;
		quietHours?: Array<{ start: number; end: number }>;
		pushTime?: number;
		restartPush?: boolean;
	};
	customLiveSummary: { enable: boolean; liveSummary?: string[] };
	customLiveMsg: {
		enable: boolean;
		customLiveStart?: string;
		customLive?: string;
		customLiveEnd?: string;
	};
	customDynamicMsg?: {
		enable: boolean;
		dynamicText?: string;
		videoText?: string;
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
	/**
	 * per-UP 图集推送行为(覆盖 koishi/dynamic plugin 配置的 imageGroup.{enable,forward})。
	 * customImageGroup.enable=false → 整组不生效,继承 plugin 全局。
	 * customImageGroup.enable=true 时 imgEnable / forward 字段写入 `Subscription.overrides.imageGroup`。
	 * 注意字段命名:外层 `enable` 是「是否启用此 custom 模板」(meta);内层 `imgEnable` 才是
	 * 实际「是否推图集」(behavior),避免与外层重名歧义。
	 */
	customImageGroup?: {
		enable: boolean;
		imgEnable?: boolean;
		forward?: boolean;
	};
};

export interface AdvancedSubRawConfigShape {
	subs: Record<string, SubItemRawConfig>;
}

// ---- Conversion logic ----

interface ConversionResult {
	sub: Subscription;
	adapters: PushAdapter[];
	targets: PushTarget[];
	/** 这个订阅里发现的可疑配置(目前只有「同一个群配了多个账号」)。 */
	warnings: string[];
}

function rawConfigToSubscription(name: string, raw: SubItemRawConfig): ConversionResult {
	const uid = raw.uid;
	const subId = deterministicUuid(`sub:${uid}`);
	const sub = makeEmptySubscription({ id: subId, uid });
	const displayName = name.trim();
	if (displayName && displayName !== uid) sub.name = displayName;

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
	/**
	 * channelId → 这个群被配到了哪些账号下。
	 *
	 * 加 selfId 之前,同一个群写两遍会算出同一个 target id 而被 seenTargetIds 自动
	 * 去重;现在账号一分开,adapter id 就不同,去重不再发生 —— 一个事件会让那个群
	 * 收到两条。不擅自吞掉主人写下的配置(确实可能是想双号播报),但必须报出来。
	 */
	const channelAccounts = new Map<string, string[]>();

	for (const entry of raw.target ?? []) {
		const { platform, channelArr, selfId } = entry;
		if (!channelArr?.length) continue;
		// 走 synthesizeKoishiBotAdapter 而不是就地拼种子:种子模板原本在这里手抄了
		// 一份,加 selfId 时改一处忘一处,普通订阅与高级订阅算出的 adapter id 就会分家。
		const adapter = synthesizeKoishiBotAdapter(platform, selfId);
		const adapterId = adapter.id;
		if (!seenAdapterIds.has(adapterId)) {
			seenAdapterIds.add(adapterId);
			adapters.push(adapter);
		}

		for (const ch of channelArr) {
			// Synthesize a target id for this channel (deterministic by adapterId + channelId)
			const targetId = deterministicUuid(`target:${adapterId}:${ch.channelId}`);

			const account = selfId?.trim() || "(自动选择)";
			const accounts = channelAccounts.get(ch.channelId) ?? [];
			if (!accounts.includes(account)) accounts.push(account);
			channelAccounts.set(ch.channelId, accounts);

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

				// Master-level gating only exists for UP-level feature switches. specialDanmaku /
				// specialUserEnter are channel-level routing toggles backed by customSpecial* user
				// lists, not UP-level features; do not let stray raw.special* booleans gate them.
				if ((UP_FEATURE_KEYS as readonly FeatureKey[]).includes(featureKey)) {
					const masterEnabled = raw[featureKey as keyof SubItemRawConfig] as boolean | undefined;
					if (masterEnabled === false) continue;
				}

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
	// Koishi 配置里的 feature 是显式二态开关,必须写入 canonical overrides;
	// 否则 internal 默认关闭的 superchat/liveGuardBuy 即使 UI 勾选 true,也会在
	// koishi/live 的 resolveFeatures() 中继续回退为 false,导致 RoomSession 监听前短路。
	const featureOverrides: Partial<Record<FeatureKey, boolean>> = {};
	for (const k of UP_FEATURE_KEYS) {
		const enabled = raw[k as keyof SubItemRawConfig];
		if (typeof enabled === "boolean") featureOverrides[k] = enabled;
	}
	if (Object.keys(featureOverrides).length > 0) {
		sub.overrides.features = featureOverrides;
	}

	// ---- per-UP filters override(收口在 customFilters.enable 门后) ----
	// enable=false → 整组跳过不写 → resolve 时纯继承 globals.defaults.filters。
	// 这修掉旧版 blockForward 等 .default(false) 致 `!== undefined` 恒真、每个 UP
	// 无条件写满 overrides.filters 的潜伏过度覆盖。enable=true 时沿用既有 per-field
	// 策略:数组类 length>0 才写(空 = 该项继承全局);boolean/number 显式写。
	const cf = raw.customFilters;
	if (cf?.enable) {
		const filterOverrides: Partial<{
			blockForward: boolean;
			blockArticle: boolean;
			blockDraw: boolean;
			blockAv: boolean;
			blockKeywords: string[];
			blockRegex: string[];
			whitelistKeywords: string[];
			whitelistRegex: string[];
			minScPrice: number;
			minGuardLevel: 1 | 2 | 3;
		}> = {};
		if (cf.blockForward !== undefined) filterOverrides.blockForward = cf.blockForward;
		if (cf.blockArticle !== undefined) filterOverrides.blockArticle = cf.blockArticle;
		if (cf.blockDraw !== undefined) filterOverrides.blockDraw = cf.blockDraw;
		if (cf.blockAv !== undefined) filterOverrides.blockAv = cf.blockAv;
		if (cf.blockKeywords && cf.blockKeywords.length > 0)
			filterOverrides.blockKeywords = cf.blockKeywords;
		if (cf.blockRegex && cf.blockRegex.length > 0) filterOverrides.blockRegex = cf.blockRegex;
		if (cf.whitelistKeywords && cf.whitelistKeywords.length > 0)
			filterOverrides.whitelistKeywords = cf.whitelistKeywords;
		if (cf.whitelistRegex && cf.whitelistRegex.length > 0)
			filterOverrides.whitelistRegex = cf.whitelistRegex;
		if (cf.minScPrice !== undefined) filterOverrides.minScPrice = cf.minScPrice;
		if (cf.minGuardLevel !== undefined) filterOverrides.minGuardLevel = cf.minGuardLevel;
		if (Object.keys(filterOverrides).length > 0) {
			sub.overrides.filters = filterOverrides;
		}
	}

	// ---- per-UP schedule override(quietHours / pushTime / restartPush,
	// 收口在 customSchedule.enable 门后) ----
	// enable=false → 不写 overrides.schedule → resolve 时纯继承 globals.defaults
	// .schedule(含全局 quietHours)。enable=true 时:quietHours length>0 才写;
	// pushTime / restartPush 走 koishi schema default,显式写。
	const cs = raw.customSchedule;
	if (cs?.enable) {
		if (cs.quietHours && cs.quietHours.length > 0) {
			sub.overrides.schedule = {
				...(sub.overrides.schedule ?? {}),
				quietHours: cs.quietHours,
			};
		}
		if (cs.pushTime !== undefined) {
			sub.overrides.schedule = {
				...(sub.overrides.schedule ?? {}),
				pushTime: cs.pushTime,
			};
		}
		if (cs.restartPush !== undefined) {
			sub.overrides.schedule = {
				...(sub.overrides.schedule ?? {}),
				restartPush: cs.restartPush,
			};
		}
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
			...(liveMsg.customLiveStart !== undefined ? { liveStart: liveMsg.customLiveStart } : {}),
			...(liveMsg.customLive !== undefined ? { liveOngoing: liveMsg.customLive } : {}),
			...(liveMsg.customLiveEnd !== undefined ? { liveEnd: liveMsg.customLiveEnd } : {}),
		};
	}

	const dynamicMsg = raw.customDynamicMsg;
	if (dynamicMsg?.enable) {
		sub.overrides.templates = {
			...(sub.overrides.templates ?? {}),
			...(dynamicMsg.dynamicText !== undefined ? { dynamic: dynamicMsg.dynamicText } : {}),
			...(dynamicMsg.videoText !== undefined ? { dynamicVideo: dynamicMsg.videoText } : {}),
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
					template: guardBuy.guardBuyMsg ?? "{uname} 成为了 {mname} 的舰长！",
				},
				commander: {
					imageUrl: guardBuy.supervisorImgUrl ?? defaultUrl("supervisor-u43ElIjU.png"),
					template: guardBuy.guardBuyMsg ?? "{uname} 成为了 {mname} 的提督！",
				},
				governor: {
					imageUrl: guardBuy.governorImgUrl ?? defaultUrl("governor-DpDXKEdA.png"),
					template: guardBuy.guardBuyMsg ?? "{uname} 成为了 {mname} 的总督！",
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

	// ---- per-UP imageGroup override ----
	// customImageGroup.enable=false 整组不写,继承 plugin 全局 imageGroup.{enable,forward}。
	// enable=true 时把内层 imgEnable / forward 写入 sub.overrides.imageGroup。
	const igCfg = raw.customImageGroup;
	if (igCfg?.enable) {
		const imageGroup: NonNullable<Subscription["overrides"]["imageGroup"]> = {};
		if (igCfg.imgEnable !== undefined) imageGroup.enable = igCfg.imgEnable;
		if (igCfg.forward !== undefined) imageGroup.forward = igCfg.forward;
		if (Object.keys(imageGroup).length > 0) sub.overrides.imageGroup = imageGroup;
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

	// 同一个群被配到多个账号下 → 一个事件会从每个号各发一次。照发,但报出来。
	//
	// 只在**单个订阅内**查:跨订阅撞同一个群是常态(两个 UP 推同一个群),那是各自
	// 独立的事件,不是重复推送。
	const warnings: string[] = [];
	for (const [channelId, accounts] of channelAccounts) {
		if (accounts.length < 2) continue;
		warnings.push(
			`[高级订阅 ${name}] 群/频道 "${channelId}" 同时配在了账号 ${accounts.join("、")} 下,` +
				`同一条推送会分别从这些号各发一次(共 ${accounts.length} 条)。如果不是有意的,请删掉多余的那一项。`,
		);
	}

	return { sub, adapters, targets, warnings };
}

export interface BuildResult {
	subs: Subscription[];
	adapters: PushAdapter[];
	targets: PushTarget[];
	/**
	 * 可疑配置的告警文案,由调用方去打日志。
	 *
	 * 这里**返回**而不是就地 log:这个函数是纯的(没有 logger,也正因如此才能脱离
	 * koishi 运行时做单测),把日志塞进来就得给它注入一个 logger,连带把测试也拖进
	 * 桩的泥潭。
	 */
	warnings: string[];
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
	const warnings: string[] = [];
	for (const [name, raw] of Object.entries(config.subs)) {
		const { sub, adapters, targets, warnings: subWarnings } = rawConfigToSubscription(name, raw);
		subs.push(sub);
		warnings.push(...subWarnings);
		// Dedup across subs: multiple UPs reusing the same adapter / channel collapse.
		for (const a of adapters) if (!adapterMap.has(a.id)) adapterMap.set(a.id, a);
		for (const t of targets) if (!targetMap.has(t.id)) targetMap.set(t.id, t);
	}
	return {
		subs,
		adapters: [...adapterMap.values()],
		targets: [...targetMap.values()],
		warnings,
	};
}
