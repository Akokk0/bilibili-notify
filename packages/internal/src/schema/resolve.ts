import { resolveActivePersona, resolveAIProfile } from "../constants";
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
import { type MessageLayout, normalizeMessageLayout } from "./message-layout";
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
	messageLayout: MessageLayout;
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
	// 连接与生成参数按家分桶存,先取出当前生效的那一套。per-UP override 覆盖的是
	// **解析后**的值(它只动 temperature 与人格),不关心图来自哪个桶。
	const profile = resolveAIProfile(globals);
	// 全局此刻用的是哪份人格 —— 读法只有一处(`resolveActivePersona`),各端共用。
	// 这里曾经自己展开过那三行,于是别的消费方(常驻 generator、试一句、锐评、聊天窗
	// 抬头)照着 `ai.persona` 各写各的,换了人格全都不跟着变。
	const active = resolveActivePersona(globals);
	const base: ResolvedAI = {
		enabled: globals.enabled,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		model: profile.model,
		temperature: profile.temperature,
		persona: active.persona,
		dynamicPrompt: active.dynamicPrompt,
		liveSummaryPrompt: active.liveSummaryPrompt,
	};

	if (!override) return base;

	/*
	 * per-UP 只做一件事:**从 `globals.presets` 里挑一份**。挑不着就是全局那份。
	 *
	 * 设置页曾经给过一档「完全自定义」能就地写死一套人设(`persona` / `dynamicPrompt` /
	 * `liveSummaryPrompt`),那一档撤掉了(人格一律在「智能女仆」页里写),那三个字段也已
	 * 从 schema 里删掉 —— 盘上残留的值在解析时就被丢弃,不会成为界面上看不见、实际仍在
	 * 生效的鬼配置。
	 *
	 * 于是三种取值在这里殊途同归、都落到全局:老的 `'inherit'`(当年那档「继承全局」)、
	 * 老的 `'custom'`、以及指向一份已被删掉的人格。三者的实际行为本来就都是「继承
	 * 全局」,设置页据此把开关显示成「关」,界面与行为对得上。
	 */
	const namedPreset = globals.presets.find((p) => p.id === override.preset);

	const persona = namedPreset?.persona ?? base.persona;
	const dynamicPrompt = namedPreset?.dynamicPrompt ?? base.dynamicPrompt;
	const liveSummaryPrompt = namedPreset?.liveSummaryPrompt ?? base.liveSummaryPrompt;
	// temperature 不在撤掉之列 —— 它本来就是独立一格,与挑哪份人格无关。
	const temperature = override.temperature ?? base.temperature;

	return { ...base, persona, dynamicPrompt, liveSummaryPrompt, temperature };
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
		// 消息版式同 cardLayout:per-UP 整份覆盖(带 normalize 向前兼容),否则继承全局。
		messageLayout: ov.messageLayout
			? normalizeMessageLayout(ov.messageLayout, defaults.messageLayout)
			: defaults.messageLayout,
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
