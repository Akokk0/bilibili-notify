import { type CardLayout, normalizeCardLayout } from "./card-layout";
import type {
	AIPersona,
	AISettings,
	CardKind,
	CardStyle,
	ContentFilters,
	FeatureFlags,
	ImageGroupSettings,
	ScheduleConfig,
	TemplateBundle,
} from "./common";
import type { GlobalDefaults } from "./globals";
import type {
	AIOverride,
	Subscription,
	SubscriptionAtAll,
	SubscriptionAtAllDefaults,
	SubscriptionOverrides,
	SubscriptionRouting,
} from "./subscriptions";

/**
 * 折叠后的"实际生效"订阅。所有业务消费方（push / dynamic / live / AI / image）
 * 只接受 EffectiveSubscription，不再各自处理 inherit / fallback 分支。
 */
export interface EffectiveSubscription {
	id: string;
	uid: string;
	name: string | undefined;
	enabled: boolean;
	groups: string[];
	notes: string | undefined;
	routing: SubscriptionRouting;
	atAllDefaults: SubscriptionAtAllDefaults;
	atAll: SubscriptionAtAll;
	specialUsers: Subscription["specialUsers"];

	features: FeatureFlags;
	filters: ContentFilters;
	schedule: ScheduleConfig;
	templates: TemplateBundle;
	ai: ResolvedAI;
	cardStyle: CardStyle;
	cardLayout: CardLayout;
	imageGroup: ImageGroupSettings;
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
	/** per-UP AstrBot 人格 id 直通(AstrBot 端消费;其它端忽略)。 */
	personaId?: string;
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

	// personaId 是 per-UP 直通,与 preset 无关 —— 即便 preset=inherit 也要带出去。
	const personaId = override?.personaId;

	if (!override || override.preset === "inherit") return { ...base, personaId };

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

	return { ...base, persona, dynamicPrompt, liveSummaryPrompt, temperature, personaId };
}

/**
 * 解析某卡片类型的生效样式。字段级 merge,优先级由低到高依次叠加:
 * 全局基准 → 全局·该类型 → UP·基准 → UP·该类型。`overrides` 传 null = 全局作用域。
 * 缺各层即跳过(merge 对 undefined 是 no-op),故老数据(无 cardStyleByKind)恒回退基准。
 */
export function resolveCardStyleForKind(
	defaults: GlobalDefaults,
	overrides: SubscriptionOverrides | null,
	kind: CardKind,
): CardStyle {
	let style: CardStyle = merge(defaults.cardStyle, defaults.cardStyleByKind?.[kind]);
	style = merge(style, overrides?.cardStyle);
	style = merge(style, overrides?.cardStyleByKind?.[kind]);
	return style;
}

/** 把 (Subscription, GlobalDefaults) 折叠为业务可直接消费的 EffectiveSubscription。 */
export function resolve(sub: Subscription, defaults: GlobalDefaults): EffectiveSubscription {
	const ov = sub.overrides;
	// P2:merge() 在 override 缺失时直接返回 base 引用,且 {...base} 仅浅拷贝 ——
	// routing/atAll/specialUsers 又是 sub 的直接引用,filters.blockKeywords
	// 等嵌套数组与 defaults 共享。任一消费方就地改 EffectiveSubscription 即污染
	// 全局默认 / 原始 sub。structuredClone 整体深隔离(schema 全为纯数据,无函数)。
	return structuredClone<EffectiveSubscription>({
		id: sub.id,
		uid: sub.uid,
		name: sub.name,
		enabled: sub.enabled,
		groups: sub.groups,
		notes: sub.notes,
		routing: sub.routing,
		atAllDefaults: sub.atAllDefaults,
		atAll: sub.atAll,
		specialUsers: sub.specialUsers,

		features: merge(defaults.features, ov.features),
		filters: merge(defaults.filters, ov.filters),
		schedule: merge(defaults.schedule, ov.schedule),
		templates: merge(defaults.templates, ov.templates),
		ai: resolveAI(defaults.ai, ov.ai),
		cardStyle: merge(defaults.cardStyle, ov.cardStyle),
		// 卡片版式整份覆盖:有 per-UP override 则用它(并 normalize 做向前兼容),
		// 否则继承全局。数组型描述符不走 merge() 的浅合并。
		cardLayout: ov.cardLayout
			? normalizeCardLayout(ov.cardLayout, defaults.cardLayout)
			: defaults.cardLayout,
		imageGroup: merge(defaults.imageGroup, ov.imageGroup),
	});
}

/** 批量折叠。 */
export function resolveAll(
	subs: Subscription[],
	defaults: GlobalDefaults,
): EffectiveSubscription[] {
	return subs.map((s) => resolve(s, defaults));
}
