import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import {
	DEFAULT_FEATURE_FLAGS,
	type FeatureFlags,
	type Subscription,
} from "@bilibili-notify/internal";
import type { SubItemView, SubscriptionsView } from "@bilibili-notify/live";
import type { BilibiliNotifyLiveConfig } from "./config";

/**
 * features:静态默认 ?? per-UP override。koishi 端没有「全局 features 配置」——
 * 默认值就是 internal 包的 DEFAULT_FEATURE_FLAGS,per-UP 来自 advanced-subscription /
 * subs 表的 `Schema.boolean().default(...)`。
 */
export function resolveFeatures(sub: Subscription): FeatureFlags {
	return { ...DEFAULT_FEATURE_FLAGS, ...sub.overrides.features };
}

/**
 * 把 per-UP AI 覆盖(`sub.overrides.ai`)翻译成 CommentaryGenerator 的 per-call
 * override。koishi 端 `ai` 不在 live 插件 config 里 —— 没有 per-UP 覆盖时返回
 * undefined,让 AI 引擎用它自己插件的 config(`CommentaryCallOverride` 缺省字段
 * 即回退引擎 config,见 commentary-generator.ts)。advanced-subscription 写入的
 * `overrides.ai` 恒为 `preset:"custom"` 且带完整 persona(见 convert.ts)。
 */
export function buildAiOverride(
	aiOv: Subscription["overrides"]["ai"],
): CommentaryCallOverride | undefined {
	if (!aiOv || aiOv.preset === "inherit") return undefined;
	const override: CommentaryCallOverride = {};
	if (aiOv.persona) {
		override.persona = {
			preset: "custom",
			name: aiOv.persona.name,
			addressUser: aiOv.persona.addressUser,
			addressSelf: aiOv.persona.addressSelf,
			traits: aiOv.persona.traits,
			catchphrase: aiOv.persona.catchphrase,
			customBase: aiOv.persona.baseRole,
			extraPrompt: aiOv.persona.extraSystemPrompt,
		};
	}
	if (aiOv.dynamicPrompt !== undefined) override.dynamicPrompt = aiOv.dynamicPrompt;
	if (aiOv.liveSummaryPrompt !== undefined) override.liveSummaryPrompt = aiOv.liveSummaryPrompt;
	if (aiOv.temperature !== undefined) override.temperature = aiOv.temperature;
	return override;
}

/**
 * 把单个 Subscription 折算成 LiveEngine 消费的 SubItemView。features 走静态默认
 * ?? per-UP;阈值 / 调度走 per-UP override ?? live 插件 config —— 两层,无第三层。
 * 引擎 / 监听层直接读 `SubItemView.X`,不再二次回退。
 */
export function storeToSubItemView(
	sub: Subscription,
	config: BilibiliNotifyLiveConfig,
): SubItemView {
	const features = resolveFeatures(sub);
	return {
		uid: sub.uid,
		uname: sub.uid,
		roomId: "", // live engine resolves roomId via API
		dynamic: features.dynamic,
		live: features.live,
		liveEnd: features.liveEnd,
		liveGuardBuy: features.liveGuardBuy,
		superchat: features.superchat,
		wordcloud: features.wordcloud,
		liveSummary: features.liveSummary,
		target: sub.routing,
		customCardStyle: sub.overrides.cardStyle
			? {
					enable: true,
					cardColorStart: sub.overrides.cardStyle.cardColorStart,
					cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
				}
			: { enable: false },
		customLiveMsg: sub.overrides.templates?.liveStart
			? {
					enable: true,
					customLiveStart: sub.overrides.templates.liveStart,
					customLive: sub.overrides.templates.liveOngoing,
					customLiveEnd: sub.overrides.templates.liveEnd,
				}
			: { enable: false },
		customGuardBuy: sub.overrides.templates?.guardBuy
			? {
					enable: true,
					captainImgUrl: sub.overrides.templates.guardBuy.captain.imageUrl,
					supervisorImgUrl: sub.overrides.templates.guardBuy.commander.imageUrl,
					governorImgUrl: sub.overrides.templates.guardBuy.governor.imageUrl,
				}
			: { enable: false },
		customLiveSummary: sub.overrides.templates?.liveSummary
			? { enable: true, liveSummary: sub.overrides.templates.liveSummary }
			: { enable: false },
		customSpecialDanmakuUsers: sub.specialUsers.some((u) => u.kinds.includes("danmaku"))
			? {
					enable: true,
					specialDanmakuUsers: sub.specialUsers
						.filter((u) => u.kinds.includes("danmaku"))
						.map((u) => u.uid),
					msgTemplate: sub.overrides.templates?.specialDanmaku ?? "",
				}
			: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: sub.specialUsers.some((u) => u.kinds.includes("enter"))
			? {
					enable: true,
					specialUsersEnterTheRoom: sub.specialUsers
						.filter((u) => u.kinds.includes("enter"))
						.map((u) => u.uid),
					msgTemplate: sub.overrides.templates?.specialUserEnter ?? "",
				}
			: { enable: false, msgTemplate: "" },
		// per-UP 阈值 / 调度:per-UP override ?? live 插件 config。
		minScPrice: sub.overrides.filters?.minScPrice ?? config.minScPrice,
		minGuardLevel: sub.overrides.filters?.minGuardLevel ?? config.minGuardLevel,
		pushTime: sub.overrides.schedule?.pushTime ?? config.pushTime,
		restartPush: sub.overrides.schedule?.restartPush ?? config.restartPush,
		liveEndGrace: sub.overrides.schedule?.liveEndGrace ?? config.liveEndGrace,
		liveEndGraceMinutes: sub.overrides.schedule?.liveEndGraceMinutes ?? config.liveEndGraceMinutes,
		aiOverride: buildAiOverride(sub.overrides.ai),
	};
}

/** 把整个 SubscriptionStore 折算成 LiveEngine 启动用的 SubscriptionsView。 */
export function storeToLiveView(
	store: { list(): Subscription[] },
	config: BilibiliNotifyLiveConfig,
): SubscriptionsView {
	const view: SubscriptionsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		view[sub.uid] = storeToSubItemView(sub, config);
	}
	return view;
}
