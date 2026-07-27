import { resolveAIProfile } from "../constants";
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
	// 连接与生成参数按家分桶存,先取出当前生效的那一套。per-UP override 覆盖的是
	// **解析后**的值(它只动 temperature 与人格),不关心图来自哪个桶。
	const profile = resolveAIProfile(globals);
	// 全局此刻用的是哪份人格。`activePreset` 不填 = 用 `ai.persona`(老配置一字不变);
	// 填了就用那份预设 —— 且**不改写** `ai.persona`,切回「默认」时主人手写的那份
	// 原封不动地回来。指向一份已不存在的预设(刚删掉 / 备份换了一批)时静静回落。
	const active = globals.activePreset
		? globals.presets.find((p) => p.id === globals.activePreset)
		: undefined;
	const base: ResolvedAI = {
		enabled: globals.enabled,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		model: profile.model,
		temperature: profile.temperature,
		persona: active?.persona ?? globals.persona,
		dynamicPrompt: active?.dynamicPrompt ?? globals.dynamicPrompt,
		liveSummaryPrompt: active?.liveSummaryPrompt ?? globals.liveSummaryPrompt,
	};

	// personaId 是 per-UP 直通,与 preset 无关 —— 即便 preset=inherit 也要带出去。
	const personaId = override?.personaId;

	if (!override) return { ...base, personaId };

	/*
	 * per-UP 只做一件事:**从 `globals.presets` 里挑一份**。挑不着就是全局那份。
	 *
	 * `override` 上的 `persona` / `dynamicPrompt` / `liveSummaryPrompt` **一概不读**
	 * —— 设置页曾经给过一档「完全自定义」能就地写死一套人设,那一档撤掉了(人格一律
	 * 在「智能女仆」页里写),但盘上还留着当年写下的字段。继续读它们就成了界面上
	 * 看不见、实际仍在生效的鬼配置。字段本身留在 schema 里没删 —— **koishi 端在用**:
	 * 那一侧压根不暴露 preset 选择,`enable` 即「我自己填」,恒写 `preset:"custom"`
	 * 外加整份 persona,并且走自己的 `buildAiOverride` 读回去,不经过这里。
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
