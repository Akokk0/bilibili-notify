import type {
	AIPersona,
	AISettings,
	CardStyle,
	ContentFilters,
	FeatureFlags,
	ScheduleConfig,
	TemplateBundle,
} from "./common";
import type { GlobalDefaults } from "./globals";
import type {
	AIOverride,
	Subscription,
	SubscriptionAtAll,
	SubscriptionAtAllDefaults,
	SubscriptionRouting,
} from "./subscriptions";

/**
 * 折叠后的"实际生效"订阅。所有业务消费方（push / dynamic / live / AI / image）
 * 只接受 EffectiveSubscription，不再各自处理 inherit / fallback 分支。
 */
export interface EffectiveSubscription {
	id: string;
	uid: string;
	enabled: boolean;
	groups: string[];
	notes: string | undefined;
	cachedProfile: Subscription["cachedProfile"];
	routing: SubscriptionRouting;
	atAllDefaults: SubscriptionAtAllDefaults;
	atAll: SubscriptionAtAll;
	specialUsers: Subscription["specialUsers"];
	state: Subscription["state"];

	features: FeatureFlags;
	filters: ContentFilters;
	schedule: ScheduleConfig;
	templates: TemplateBundle;
	ai: ResolvedAI;
	cardStyle: CardStyle;
}

export interface ResolvedAI {
	enabled: boolean;
	baseUrl?: string;
	apiKey?: string;
	model: string;
	temperature: number;
	persona: AIPersona;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
}

/** 浅合并：override 中存在的字段覆盖 base，undefined / 缺失则保留 base。 */
function merge<T extends object>(base: T, override: Partial<T> | undefined): T {
	if (!override) return base;
	const out = { ...base };
	for (const key of Object.keys(override) as (keyof T)[]) {
		const v = override[key];
		if (v !== undefined) (out as Record<keyof T, unknown>)[key] = v;
	}
	return out;
}

function resolveAI(globals: AISettings, override: AIOverride | undefined): ResolvedAI {
	const base: ResolvedAI = {
		enabled: globals.enabled,
		baseUrl: globals.baseUrl,
		apiKey: globals.apiKey,
		model: globals.model,
		temperature: globals.temperature,
		persona: globals.persona,
		dynamicPrompt: globals.dynamicPrompt,
		liveSummaryPrompt: globals.liveSummaryPrompt,
	};

	if (!override || override.preset === "inherit") return base;

	// override 形如 { preset: 'custom' | <preset.id>; persona?; dynamicPrompt?; liveSummaryPrompt?; temperature? }
	const namedPreset =
		override.preset === "custom"
			? undefined
			: globals.presets.find((p) => p.id === override.preset);

	// R1:与 dynamicPrompt / liveSummaryPrompt 同序 —— 显式 per-UP override 最高,
	// 其次具名 preset,最后全局 base。此前 persona 反着写(namedPreset 先于
	// override),用户选了 preset 又自定义 persona 时其自定义被静默丢弃。
	const persona = override.persona ?? namedPreset?.persona ?? base.persona;
	const dynamicPrompt = override.dynamicPrompt ?? namedPreset?.dynamicPrompt ?? base.dynamicPrompt;
	const liveSummaryPrompt =
		override.liveSummaryPrompt ?? namedPreset?.liveSummaryPrompt ?? base.liveSummaryPrompt;
	const temperature = override.temperature ?? base.temperature;

	return { ...base, persona, dynamicPrompt, liveSummaryPrompt, temperature };
}

/** 把 (Subscription, GlobalDefaults) 折叠为业务可直接消费的 EffectiveSubscription。 */
export function resolve(sub: Subscription, defaults: GlobalDefaults): EffectiveSubscription {
	const ov = sub.overrides;
	return {
		id: sub.id,
		uid: sub.uid,
		enabled: sub.enabled,
		groups: sub.groups,
		notes: sub.notes,
		cachedProfile: sub.cachedProfile,
		routing: sub.routing,
		atAllDefaults: sub.atAllDefaults,
		atAll: sub.atAll,
		specialUsers: sub.specialUsers,
		state: sub.state,

		features: merge(defaults.features, ov.features),
		filters: merge(defaults.filters, ov.filters),
		schedule: merge(defaults.schedule, ov.schedule),
		templates: merge(defaults.templates, ov.templates),
		ai: resolveAI(defaults.ai, ov.ai),
		cardStyle: merge(defaults.cardStyle, ov.cardStyle),
	};
}

/** 批量折叠。 */
export function resolveAll(
	subs: Subscription[],
	defaults: GlobalDefaults,
): EffectiveSubscription[] {
	return subs.map((s) => resolve(s, defaults));
}
