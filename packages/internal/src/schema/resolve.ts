import {
	type ActivePersonaShape,
	type AIBuiltinPresetShape,
	presetsOf,
	resolveActivePersona,
} from "../ai";
import {
	type BuiltinTemplates,
	type EffectiveMembershipTemplate,
	type EffectiveTemplates,
	withMembershipDefaults,
	withTemplateDefaults,
} from "../builtin-texts";
import type { Identity } from "../identity";
import type {
	AISettings,
	CardsSettings,
	ContentFilters,
	FeatureFlags,
	FeatureFlagsPartial,
	ImageGroupSettings,
	LiveStartSettings,
	LiveStreamingSettings,
	MembershipSettings,
	ScheduleConfig,
	SuperchatSettings,
} from "./common";
import type { GlobalDefaults } from "./globals";
import { type MessageLayout, normalizeMessageLayout } from "./message-layout";
import type {
	AIOverride,
	SpecialViewer,
	Subscription,
	SubscriptionExtraTargets,
	SubscriptionRouting,
} from "./subscriptions";

/**
 * 折叠后的"实际生效"订阅。所有业务消费方（push / dynamic / live / AI / image）
 * 只接受 EffectiveSubscription，不再各自处理 inherit / fallback 分支。订的是谁读 `identity`。
 */
export interface EffectiveSubscription {
	id: string;
	/** 订的是谁(ADR-0021 决策 14)。 */
	identity: Identity;
	enabled: boolean;
	notes: string | undefined;
	routing: SubscriptionRouting;
	/** 附加项的 per-目标 三态表(原样带过来,没有可合并的上一层)。 */
	extraTargets: SubscriptionExtraTargets;
	/** 特别关注;来源不支持的(今天:拓展)一直是空的。 */
	specialViewers: SpecialViewer[];

	features: FeatureFlags;
	filters: ContentFilters;
	schedule: ScheduleConfig;
	/** 启动补报(⑬d 起自成一段,原先在 `schedule` 里)。 */
	liveStart: LiveStartSettings;
	/** 周期「正在直播」的间隔(⑬d 起自成一段,原先在 `schedule` 里);开关在 `features.liveStreaming`。 */
	liveStreaming: LiveStreamingSettings;
	/** 醒目留言门槛:覆盖有就用覆盖(0 也算),否则全局;都没配 = 不设门槛。 */
	superchat: SuperchatSettings;
	/** 会员门槛:`minRank` 按体系逐键合并(订阅只改了 `guard`,别的体系的全局门槛照旧);某体系没有键 = 那个体系全推。 */
	membership: Required<MembershipSettings>;
	cards: CardsSettings;
	/** 生效的卡片皮肤 id(per-UP 指了就用它,否则全局)。 */
	cardSkin: string;
	messageLayout: MessageLayout;
	imageGroup: ImageGroupSettings;
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

/**
 * features 的合并比别的多一层:附加项是个小对象,per-UP 只关词云时不该把总结
 * 一起盖掉 —— 七把开关浅合并,`extras` 再往里合一层。
 */
function mergeFeatures(
	base: FeatureFlags,
	override: FeatureFlagsPartial | undefined,
): FeatureFlags {
	if (!override) return base;
	const { extras, ...flags } = override;
	return {
		...merge(base, flags),
		extras: merge(base.extras, extras),
	};
}

/** 这条订阅生效的文字模板:每格都有字;会员文案按体系 id 现取。 */
export type ResolvedTemplates = Omit<EffectiveTemplates, "membership"> & {
	/**
	 * 某个会员体系的文案:订阅覆盖里这个体系开着才整份换,没覆盖或覆盖了但关着的用全局那份;
	 * 缺 `default.template` 取出厂那一句;没有这个体系的条目 = 自定义关着。
	 */
	membership(programId: string): EffectiveMembershipTemplate;
};

/**
 * 这条订阅生效的文字模板:订阅覆盖 → 全局设置 → 出厂(`factory`,调用方按当前语言取)。
 *
 * 设置里只存主人改过的格(ADR-0037 决策 10),所以**读时填、不写盘**:换语言立即生效,盘上不动。
 * 文字一格一格浅合并;会员文案按体系,订阅覆盖里 `enabled` 为真的体系整份换成订阅的,没覆盖或覆盖了
 * 但关着的用全局那份 —— **关 = 继承全局**,与面板同一个意思。这条规矩住在折叠处,每个取文案的消费方
 * 拿到的都是同一种结果。
 */
export function resolveTemplates(
	sub: Pick<Subscription, "overrides">,
	defaults: Pick<GlobalDefaults, "templates">,
	factory: BuiltinTemplates,
): ResolvedTemplates {
	const own = sub.overrides.templates;
	const { membership: _stored, ...text } = defaults.templates;
	const { membership: _own, ...ownText } = own ?? {};
	// 关着的覆盖等于没覆盖:整份回落全局那份,别把全局的自定义文案吞掉。体系 id 来自盘上,
	// 用展开与 fromEntries 定义属性(不走赋值),`__proto__` 这样的键也只是一格普通数据。
	const enabledOwn = Object.entries(own?.membership ?? {}).filter(([, bundle]) => bundle.enabled);
	const membershipStored = { ...defaults.templates.membership, ...Object.fromEntries(enabledOwn) };
	const merged = withTemplateDefaults(
		{ ...merge(text, ownText), membership: membershipStored },
		factory,
	);
	const fallbackText = factory.membership;
	const { membership, ...rest } = merged;
	return {
		...rest,
		membership: (programId) =>
			Object.hasOwn(membership, programId)
				? (membership[programId] as EffectiveMembershipTemplate)
				: withMembershipDefaults(undefined, fallbackText),
	};
}

/**
 * 这条订阅生效的人格与两段提示词:订阅挑了一份就用它(缺的那段回落全局),没挑或挑的那份不在了就是全局此刻用的那份。
 * @param builtins 当前语言的内置人格(设置里不存它们的内容,每次按语言取)。
 */
export function resolveSubscriptionPersona(
	ai: AISettings,
	override: AIOverride | undefined,
	builtins: readonly AIBuiltinPresetShape[],
): ActivePersonaShape {
	// 全局此刻用的是哪份人格 —— 读法只有一处(`resolveActivePersona`),各端共用。
	// 这里曾经自己展开过那三行,于是别的消费方(常驻 generator、试一句、锐评、聊天窗
	// 抬头)照着 `ai.persona` 各写各的,换了人格全都不跟着变。
	const base = resolveActivePersona(ai, builtins);

	if (!override) return base;

	/*
	 * per-UP 只做一件事:**从人格清单(`presetsOf`)里挑一份**。挑不着就是全局那份。
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
	const namedPreset = presetsOf(ai, builtins).find((p) => p.id === override.preset);

	return {
		persona: namedPreset?.persona ?? base.persona,
		dynamicPrompt: namedPreset?.dynamicPrompt ?? base.dynamicPrompt,
		liveSummaryPrompt: namedPreset?.liveSummaryPrompt ?? base.liveSummaryPrompt,
	};
}

/** 把 (Subscription, GlobalDefaults) 折叠为业务可直接消费的 EffectiveSubscription。 */
export function resolve(sub: Subscription, defaults: GlobalDefaults): EffectiveSubscription {
	// P2:merge() 在 override 缺失时直接返回 base 引用,且 {...base} 仅浅拷贝 ——
	// routing/extraTargets/specialViewers 又是 sub 的直接引用,filters.blockKeywords
	// 等嵌套数组与 defaults 共享。任一消费方就地改 EffectiveSubscription 即污染
	// 全局默认 / 原始 sub。structuredClone 整体深隔离(schema 全为纯数据,无函数)。
	return structuredClone<EffectiveSubscription>({ id: sub.id, ...resolveCommon(sub, defaults) });
}

/** 除 `id` 以外的折叠。 */
function resolveCommon(
	sub: Subscription,
	defaults: GlobalDefaults,
): Omit<EffectiveSubscription, "id"> {
	const ov = sub.overrides;
	return {
		identity: { ...sub.identity },
		enabled: sub.enabled,
		notes: sub.notes,
		routing: sub.routing,
		extraTargets: sub.extraTargets,
		specialViewers: sub.specialViewers,

		features: mergeFeatures(defaults.features, ov.features),
		filters: merge(defaults.filters, ov.filters),
		schedule: merge(defaults.schedule, ov.schedule),
		liveStart: merge(defaults.liveStart, ov.liveStart),
		liveStreaming: merge(defaults.liveStreaming, ov.liveStreaming),
		superchat: merge(defaults.superchat, ov.superchat),
		membership: { minRank: { ...defaults.membership.minRank, ...ov.membership?.minRank } },
		cards: merge(defaults.cards, ov.cards),
		// 皮肤是整份引用,没有合并可言:指了就是它。旧的 `cardLayout` 不再折进来 ——
		// 出图只认皮肤,而那个键连同折它进来的开机迁移已一并删掉(ADR-0014 决策 17 的
		// 2026-09-18 🔗:没选过皮肤的一律用出厂默认)。
		cardSkin: ov.cardSkin ?? defaults.cardSkin,
		// 消息版式同 cardLayout:per-UP 整份覆盖(带 normalize 向前兼容),否则继承全局。
		messageLayout: ov.messageLayout
			? normalizeMessageLayout(ov.messageLayout, defaults.messageLayout)
			: defaults.messageLayout,
		imageGroup: merge(defaults.imageGroup, ov.imageGroup),
	};
}

/** 批量折叠。 */
export function resolveAll(
	subs: Subscription[],
	defaults: GlobalDefaults,
): EffectiveSubscription[] {
	return subs.map((s) => resolve(s, defaults));
}
