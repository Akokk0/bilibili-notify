import { i18n, useT } from "../../i18n";
/**
 * Rules page sections — bound to live GlobalConfig.defaults shapes. Each
 * section accepts the relevant slice + an `onPatch` that builds a deep-partial
 * delta for /api/settings.
 */

import { TEMPLATE_VARIABLES, type TemplateKey } from "@bilibili-notify/internal/template-variables";
import {
	type BuiltinTemplates,
	type EffectiveMembershipTemplate,
	withMembershipDefaults,
} from "@bilibili-notify/internal/texts/builtin";
import { CollapseBlock, GlassBox, Icon, Toggle } from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import {
	ArrayEditor,
	Field,
	Picker,
	QuietHoursEditor,
	TArea,
	TInput,
	TNum,
	TSelect,
} from "../../components/forms";
import { InheritNote } from "../../components/inherit-note";
import { type MembershipProgram, membershipTiersOf } from "../../config/membership-programs";
import { SECTION_ACCENT, sectionTitleColor } from "../../config/section-accents";
import type { FeatureKey, MessageKindLayoutFull, Subscription } from "../../types/domain";
import type {
	ContentFilters,
	GlobalConfigPatch,
	ImageGroupSettings,
	LiveStartSettings,
	LiveStreamingSettings,
	MembershipSettings,
	MembershipTemplateEntry,
	ScheduleConfig,
	SuperchatSettings,
	TemplateBundle,
} from "../../types/globals";
import { MessageLayoutEditor } from "./MessageLayoutEditor";

/**
 * 文字模板输入框的下发值(ADR-0037 决策 10):编辑到与当前语言的默认一字不差 = 回到「没存」(`null` 删键),
 * 否则存主人写的这句。草稿合并认 `null` 删键,`buildPatch` 据此下发 `null`。
 */
export function templateValueToStore(value: string, factoryText: string): string | null {
	return value === factoryText ? null : value;
}

export type SectionId =
	| "filter"
	| "live"
	// 拓展订阅那一节「推送时段」(免扰 + 直播的推送频率),见 perUpSectionsFor。
	| "schedule"
	| "summary"
	| "msg"
	| "dynamicMsg"
	| "messageLayout"
	| "guard"
	| "specialDanmaku"
	| "specialEnter"
	| "cardStyle"
	| "ai"
	| "imageGroup"
	| "core";

export interface SectionMeta {
	id: SectionId;
	label: string;
	icon: ReactNode;
	desc: string;
}

/**
 * 全局 5 个分类(对照设计稿:动态过滤 / 直播阈值 / 直播总结模板 / 直播消息模板 / 上舰提示)。
 * cardStyle 在 /cards,ai 主体在 /ai,app + master 由独立入口承载。
 *
 * desc 全部用纯中文短语,避开 `defaults.templates.{a,b,c}` 这种不可换行的长串。
 * 220px 侧栏文字列只有 ~140px,英文 code path 无法断词会撑出容器。
 */
export const globalSectionsOf = (): SectionMeta[] => [
	{
		id: "filter",
		label: i18n.t("sourceUi.pages.rules.sections.label.1"),
		icon: <Icon.filter size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.2"),
	},
	{
		id: "imageGroup",
		label: i18n.t("sourceUi.pages.rules.sections.label.3"),
		icon: <Icon.dyn size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.4"),
	},
	{
		id: "dynamicMsg",
		label: i18n.t("sourceUi.pages.rules.PerUpEditor.MessageLayoutOverrideBox.36"),
		icon: <Icon.chat size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.5"),
	},
	{
		id: "live",
		label: i18n.t("sourceUi.pages.rules.sections.label.6"),
		icon: <Icon.mic size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.7"),
	},
	{
		id: "summary",
		label: i18n.t("sourceUi.pages.rules.sections.label.8"),
		icon: <Icon.list size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.9"),
	},
	{
		id: "msg",
		label: i18n.t("sourceUi.pages.rules.PerUpEditor.MessageLayoutOverrideBox.37"),
		icon: <Icon.chat size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.10"),
	},
	{
		id: "guard",
		label: i18n.t("sourceUi.pages.rules.sections.label.11"),
		icon: <Icon.anchor size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.12"),
	},
];

/**
 * per-UP 9 个分类:全局 5 个 + 特别关注弹幕 / 进房 / 卡片样式 / AI 人格。
 * 每项独立 toggle 到「覆盖中」才会写入 Subscription.overrides;关闭即继承全局。
 */
export const perupSectionsOf = (): SectionMeta[] => [
	{
		id: "filter",
		label: i18n.t("sourceUi.pages.rules.sections.label.1"),
		icon: <Icon.filter size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.13"),
	},
	{
		id: "imageGroup",
		label: i18n.t("sourceUi.pages.rules.sections.label.3"),
		icon: <Icon.dyn size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.14"),
	},
	{
		id: "dynamicMsg",
		label: i18n.t("sourceUi.pages.rules.sections.label.15"),
		icon: <Icon.chat size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.16"),
	},
	{
		id: "messageLayout",
		label: i18n.t("sourceUi.pages.rules.sections.label.17"),
		icon: <Icon.list size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.18"),
	},
	{
		id: "live",
		label: i18n.t("sourceUi.pages.rules.sections.label.6"),
		icon: <Icon.mic size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.19"),
	},
	{
		id: "summary",
		label: i18n.t("sourceUi.pages.rules.sections.label.8"),
		icon: <Icon.list size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.20"),
	},
	{
		id: "msg",
		label: i18n.t("sourceUi.pages.rules.sections.label.21"),
		icon: <Icon.chat size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.22"),
	},
	{
		id: "guard",
		label: i18n.t("sourceUi.pages.rules.sections.label.11"),
		icon: <Icon.anchor size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.23"),
	},
	{
		id: "specialDanmaku",
		label: i18n.t("sourceUi.pages.rules.PerUpEditor.title.3"),
		icon: <Icon.star size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.24"),
	},
	{
		id: "specialEnter",
		label: i18n.t("sourceUi.pages.rules.PerUpEditor.title.5"),
		icon: <Icon.user size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.25"),
	},
	{
		id: "ai",
		label: i18n.t("sourceUi.pages.rules.PerUpEditor.title.51"),
		icon: <Icon.ai size={14} />,
		desc: i18n.t("sourceUi.pages.rules.sections.desc.26"),
	},
];

/** 拓展订阅露得出的那几节(ADR-0019 决策 64):看内容、看文案、看时段的,不看 B 站的东西。 */
const EXTENSION_POST_SECTIONS = new Set<SectionId>(["filter", "dynamicMsg"]);
const EXTENSION_LIVE_SECTIONS = new Set<SectionId>(["msg"]);
const EXTENSION_ANY_SECTIONS = new Set<SectionId>(["messageLayout", "ai"]);

/**
 * 这条订阅在高级规则页上露哪几节。
 *
 * B 站订阅全露,一切照旧。拓展订阅只露通用的(ADR-0019 决策 64):
 * - 过滤(关键词 / 正则 / 白名单与四个类型开关,过滤吃 `Post`、对所有来源一视同仁,ADR-0021 决策 43)与动态消息 —— 源报作品才露;
 * - 直播消息 —— 源报开播或下播才露;
 * - 消息版式、AI 人格 —— 都露;
 * - 「直播阈值」换成「推送时段」:免扰时段对动态和直播一样生效(推送层那道闸不看是哪种推送),
 *   所以只报作品的源也要能设;SC / 上舰阈值是 B 站独有的(决策 5),不露。报直播时这一节再加上
 *   推送频率那几格(决策 57 / 58:周期推送、重启补推、断流接续对拓展订阅照样生效)。
 * - 动态图集(决策 72)、直播总结、上舰提示、特别关注弹幕 / 进房不露。
 *
 * `features` 是这个源报得出的那几把特性(`visibleFeaturesOf` 的结果);认不出是哪个源时,调用方按
 * 拓展订阅最多能有的那几种给,同配置弹层。
 */
export function perUpSectionsFor(
	_sub: Subscription,
	features: readonly FeatureKey[],
	platform?: {
		membershipPrograms?: readonly MembershipProgram[];
		supportedExtras: readonly string[];
	},
): SectionMeta[] {
	const post = features.includes("post");
	const live = features.includes("liveStart") || features.includes("liveEnd");
	const out: SectionMeta[] = [];
	for (const s of perupSectionsOf()) {
		if (s.id === "guard" && platform?.membershipPrograms?.length) {
			out.push(s);
		} else if (
			s.id === "summary" &&
			platform?.supportedExtras.some((key) => key === "liveSummary" || key === "wordcloud")
		) {
			out.push(s);
		} else if (
			(s.id === "specialDanmaku" && features.includes("viewerChat")) ||
			(s.id === "specialEnter" && features.includes("viewerEnter")) ||
			(s.id === "imageGroup" && post)
		) {
			out.push(s);
		} else if (s.id === "live") {
			if (features.includes("superchat") || features.includes("membership")) {
				out.push(s);
				continue;
			}
			out.push({
				id: "schedule",
				label: i18n.t("sourceUi.pages.rules.sections.label.27"),
				icon: <Icon.sliders size={14} />,
				desc: live
					? i18n.t("sourceUi.pages.rules.sections.desc.28")
					: i18n.t("sourceUi.pages.rules.sections.desc.29"),
			});
		} else if (
			EXTENSION_ANY_SECTIONS.has(s.id) ||
			(post && EXTENSION_POST_SECTIONS.has(s.id)) ||
			(live && EXTENSION_LIVE_SECTIONS.has(s.id))
		) {
			out.push(s);
		}
	}
	return out;
}

// ── 1. Filter section ────────────────────────────────────────────────────────

export function FilterSection({
	value,
	onPatch,
}: {
	value: ContentFilters;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const set = <K extends keyof ContentFilters>(key: K, v: ContentFilters[K]) => {
		onPatch({ defaults: { filters: { [key]: v } as Partial<ContentFilters> } });
	};
	// schema 里没有独立的 whitelistEnabled 字段,所以本地 forceOpen 状态 + 数组非空双取 OR。
	// toggle on → forceOpen=true 立即展开;关闭 → 清空两数组 + 复位 forceOpen。
	const [forceOpenWhitelist, setForceOpenWhitelist] = useState(false);
	const whitelistEnabled =
		forceOpenWhitelist || value.allowKeywords.length > 0 || value.allowRegex.length > 0;
	function toggleWhitelist(on: boolean): void {
		if (on) {
			setForceOpenWhitelist(true);
		} else {
			setForceOpenWhitelist(false);
			onPatch({ defaults: { filters: { allowKeywords: [], allowRegex: [] } } });
		}
	}
	return (
		<GlassBox
			title={tx("sourceUi.pages.Rules.pageLabel.2")}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.30")}
			accent="var(--color-bn-pink)"
			icon={<Icon.filter size={14} />}
			badge="filters"
		>
			<Field code="blockKeywords" full>
				<ArrayEditor
					value={value.blockKeywords}
					onChange={(n) => set("blockKeywords", n)}
					placeholder={tx("sourceUi.pages.rules.sections.placeholder.31")}
				/>
			</Field>
			<Field code="blockRegex" full>
				<ArrayEditor
					value={value.blockRegex}
					onChange={(n) => set("blockRegex", n)}
					placeholder={tx("sourceUi.pages.rules.sections.placeholder.32")}
				/>
			</Field>
			<div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
				<Field code="blockReposts">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockReposts} onChange={(v) => set("blockReposts", v)} size="sm" />
					</div>
				</Field>
				<Field code="blockArticles">
					<div className="flex h-7.5 items-center">
						<Toggle
							value={value.blockArticles}
							onChange={(v) => set("blockArticles", v)}
							size="sm"
						/>
					</div>
				</Field>
				<Field code="blockImages">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockImages} onChange={(v) => set("blockImages", v)} size="sm" />
					</div>
				</Field>
				<Field code="blockVideos">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockVideos} onChange={(v) => set("blockVideos", v)} size="sm" />
					</div>
				</Field>
			</div>
			<CollapseBlock
				label={tx("sourceUi.pages.rules.sections.label.33")}
				enabled={whitelistEnabled}
				onToggle={toggleWhitelist}
				accent="var(--color-bn-pink)"
			>
				<Field code="allowKeywords" full>
					<ArrayEditor value={value.allowKeywords} onChange={(n) => set("allowKeywords", n)} />
				</Field>
				<Field code="allowRegex" full>
					<ArrayEditor value={value.allowRegex} onChange={(n) => set("allowRegex", n)} />
				</Field>
			</CollapseBlock>
		</GlassBox>
	);
}

// ── 1b. Dynamic image-group(全局图集推送形态)──────────────────────────────

export function ImageGroupSection({
	value,
	onPatch,
}: {
	value: ImageGroupSettings;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const set = <K extends keyof ImageGroupSettings>(key: K, v: ImageGroupSettings[K]) => {
		onPatch({ defaults: { imageGroup: { [key]: v } as Partial<ImageGroupSettings> } });
	};
	return (
		<GlassBox
			title={tx("sourceUi.pages.rules.sections.label.3")}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.34")}
			accent="var(--color-bn-pink)"
			icon={<Icon.dyn size={14} />}
			badge="imageGroup"
		>
			<Field code="imageGroup.enabled">
				<Toggle value={value.enabled} onChange={(v) => set("enabled", v)} />
			</Field>
			<Field code="imageGroup.mergeForward">
				<Toggle
					value={value.mergeForward}
					onChange={(v) => set("mergeForward", v)}
					disabled={!value.enabled}
				/>
			</Field>
		</GlassBox>
	);
}

// ── 2. Live thresholds (SC / guard / schedule) ───────────────────────────────

export function LiveThresholdsSection({
	superchat,
	membership,
	schedule,
	liveStart,
	liveStreaming,
	liveStreamingOn,
	programs = [],
	onPatch,
}: {
	/** 醒目留言门槛(㉓d,原先是 `filters.minScPrice`)。 */
	superchat: SuperchatSettings;
	/** 会员门槛(㉓d,原先是 `filters.minGuardLevel`):按体系存,B 站的体系是 `guard`。 */
	membership: MembershipSettings;
	schedule: ScheduleConfig;
	/** 启动补报(⑬d 起自成一段,原先在 `schedule` 里)。 */
	liveStart: LiveStartSettings;
	/** 周期「正在直播」的间隔(⑬d 起自成一段,原先在 `schedule` 里),整数小时 1–24。 */
	liveStreaming: LiveStreamingSettings;
	/** 周期「正在直播」的全局开关(`features.liveStreaming`):出厂关,各订阅可在订阅弹框里单独覆盖。 */
	liveStreamingOn: boolean;
	programs?: readonly MembershipProgram[];
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const setS = <K extends keyof ScheduleConfig>(k: K, v: ScheduleConfig[K]) =>
		onPatch({ defaults: { schedule: { [k]: v } as Partial<ScheduleConfig> } });
	return (
		<GlassBox
			title={tx("sourceUi.pages.rules.sections.title.35")}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.36")}
			accent="var(--color-bn-blue)"
			icon={<Icon.mic size={14} />}
			badge="live"
		>
			<div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
				<Field code="superchat.minAmount">
					<TNum
						value={superchat.minAmount ?? 0}
						onChange={(v) => onPatch({ defaults: { superchat: { minAmount: v } } })}
						min={0}
						max={9999}
						suffix={tx("sourceUi.pages.rules.PerUpEditor.suffix.13")}
					/>
				</Field>
				{programs.map((program) => {
					const tiers = membershipTiersOf(programs, program.id);
					return tiers.length ? (
						<Field key={program.id} code={`membership.minRank.${program.id}`} label={program.name}>
							<TSelect
								value={String(membership.minRank?.[program.id] ?? tiers[0]!.rank)}
								onChange={(rank) =>
									onPatch({ defaults: { membership: { minRank: { [program.id]: Number(rank) } } } })
								}
								options={tiers.map((tier) => ({ value: String(tier.rank), label: tier.name }))}
							/>
						</Field>
					) : null;
				})}
				<Field code="features.liveStreaming">
					<div className="flex h-7.5 items-center">
						<Toggle
							value={liveStreamingOn}
							onChange={(v) => onPatch({ defaults: { features: { liveStreaming: v } } })}
							size="sm"
						/>
					</div>
				</Field>
				<Field code="liveStreaming.streamingIntervalHours">
					<TNum
						value={liveStreaming.streamingIntervalHours}
						onChange={(v) =>
							onPatch({ defaults: { liveStreaming: { streamingIntervalHours: v } } })
						}
						min={1}
						max={24}
						suffix={tx("sourceUi.pages.rules.PerUpEditor.suffix.14")}
					/>
				</Field>
				<Field code="liveStart.catchUpOnBoot">
					<div className="flex h-7.5 items-center">
						<Toggle
							value={liveStart.catchUpOnBoot}
							onChange={(v) => onPatch({ defaults: { liveStart: { catchUpOnBoot: v } } })}
							size="sm"
						/>
					</div>
				</Field>
				<Field code="schedule.liveEndGrace" hint={tx("sourceUi.pages.rules.sections.hint.37")}>
					<div className="flex h-7.5 items-center">
						<Toggle
							value={schedule.liveEndGrace}
							onChange={(v) => setS("liveEndGrace", v)}
							size="sm"
						/>
					</div>
				</Field>
				{schedule.liveEndGrace ? (
					<Field
						code="schedule.liveEndGraceMinutes"
						hint={tx("sourceUi.pages.rules.sections.hint.38")}
					>
						<TNum
							value={schedule.liveEndGraceMinutes}
							onChange={(v) => setS("liveEndGraceMinutes", v)}
							min={1}
							max={10}
							suffix={tx("sourceUi.pages.rules.PerUpEditor.suffix.16")}
						/>
					</Field>
				) : null}
				<Field code="schedule.quietHours" full>
					<QuietHoursEditor value={schedule.quietHours} onChange={(v) => setS("quietHours", v)} />
				</Field>
			</div>
		</GlassBox>
	);
}

// ── 3. Live summary template ─────────────────────────────────────────────────

export function SummarySection({
	templates,
	factory,
	onPatch,
}: {
	templates: TemplateBundle;
	/** 当前语言的出厂文字:没存的格显示它,编辑到与它一字不差就回到没存。 */
	factory: BuiltinTemplates;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const setT = <K extends keyof TemplateBundle>(k: K, v: TemplateBundle[K]) =>
		onPatch({ defaults: { templates: { [k]: v } as Partial<TemplateBundle> } });
	const setText = (k: "liveSummary", v: string) =>
		onPatch({ defaults: { templates: { [k]: templateValueToStore(v, factory[k]) } } });
	return (
		<GlassBox
			title={tx("sourceUi.pages.rules.sections.label.8")}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.39")}
			accent="var(--color-bn-purple)"
			icon={<Icon.list size={14} />}
			badge="liveSummary"
		>
			<StopWordsHint />
			<Field code="templates.wordcloudStopWords" full>
				<TArea
					value={templates.wordcloudStopWords}
					onChange={(v) => setT("wordcloudStopWords", v)}
					rows={2}
					mono
					placeholder={tx("sourceUi.pages.rules.sections.placeholder.40")}
				/>
			</Field>
			<div className="my-3 border-t border-bn-border-subtle" />
			<SummaryVariableHints />
			<Field code="templates.liveSummary" full>
				<TArea
					value={templates.liveSummary ?? factory.liveSummary}
					onChange={(v) => setText("liveSummary", v)}
					rows={8}
					mono
				/>
			</Field>
		</GlassBox>
	);
}

/**
 * 弹幕词云停用词字段上方的说明条 —— 强调「英文逗号分隔」「追加到内置词表」「仅影响
 * 词云,不影响弹幕计数」,与变量提示条同一视觉语言(青色调,区别于紫色变量提示)。
 */
export function StopWordsHint() {
	const tx = useT();
	return (
		<HintBar
			accent="var(--color-bn-blue)"
			title={tx("sourceUi.pages.rules.sections.title.41")}
			leading="leading-6"
		>
			{tx("sourceUi.pages.rules.sections.StopWordsHint.42")}
			<b>{tx("sourceUi.pages.rules.sections.StopWordsHint.43")}</b>
			{tx("sourceUi.pages.rules.sections.StopWordsHint.44")}
			<b>{tx("sourceUi.pages.rules.sections.StopWordsHint.45")}</b>
			{tx("sourceUi.pages.rules.sections.StopWordsHint.46")}
		</HintBar>
	);
}

interface VarSpec {
	code: string;
	desc: string;
}

/** 表里某条文案能用的变量名。 */
type VariableNameOf<K extends TemplateKey> = keyof (typeof TEMPLATE_VARIABLES)[K];

/** 面板给表里某条文案的每个变量各写一句说明;少一个键编译不过。 */
type VariableDescriptions<K extends TemplateKey> = Record<VariableNameOf<K>, string>;

/** 几条文案合看时能用的变量名(直播开播 / 直播中 / 下播共用一个提示条)。 */
type UnionVariableName<K extends readonly TemplateKey[]> = {
	[P in K[number]]: VariableNameOf<P>;
}[K[number]];
type UnionDescriptions<K extends readonly TemplateKey[]> = Record<UnionVariableName<K>, string>;

/** 表里的变量名,顺序跟表一致;`{}` 由这里统一补。 */
function variableNamesOf<K extends TemplateKey>(key: K): VariableNameOf<K>[] {
	return Object.keys(TEMPLATE_VARIABLES[key]) as VariableNameOf<K>[];
}

/**
 * 表里一条文案的变量 → 提示条的一行行。`key` 只用来把说明表钉到表里那条文案的变量名上;
 * 展示次序照说明表(沿用改造前),不跟着表的字段顺序漂。
 */
function varsOf<K extends TemplateKey>(_key: K, desc: VariableDescriptions<K>): VarSpec[] {
	return Object.keys(desc).map((name) => ({
		code: `{${name}}`,
		desc: desc[name as VariableNameOf<K>],
	}));
}

/**
 * 几条文案共用一条提示时把变量并起来。`keys` 只用来把说明表钉到这几条文案的变量名上;
 * 提示条的展示次序照说明表(沿用改造前),不跟着表的字段顺序漂。
 */
function mergedVars<K extends readonly TemplateKey[]>(
	_keys: K,
	desc: UnionDescriptions<K>,
): VarSpec[] {
	return Object.keys(desc).map((name) => ({
		code: `{${name}}`,
		desc: desc[name as UnionVariableName<K>],
	}));
}

/**
 * 表里 `un1` … `un5` / `dc1` … `dc5` 是逐格登记的;提示条照旧折成 `{un1..5}` / `{dc1..5}`。
 * 只折连续、同前缀、编号递增的那一段,别的变量名原样一个个列。
 */
function foldedVars(names: readonly string[], desc: Record<string, string>): VarSpec[] {
	const out: VarSpec[] = [];
	for (let i = 0; i < names.length; ) {
		const first = names[i] as string;
		const numbered = /^([A-Za-z_]+)(\d+)$/.exec(first);
		let last = i;
		let end = i;
		if (numbered) {
			const stem = numbered[1] as string;
			const start = Number(numbered[2]);
			while (last + 1 < names.length) {
				const next = /^([A-Za-z_]+)(\d+)$/.exec(names[last + 1] as string);
				if (next === null || next[1] !== stem || Number(next[2]) !== start + (last + 1 - i)) {
					break;
				}
				last += 1;
			}
			end = start + (last - i);
		}
		out.push({
			code: last > i ? `{${first}..${end}}` : `{${first}}`,
			desc: desc[first] as string,
		});
		i = last + 1;
	}
	return out;
}

const summaryUnDescOf = () => i18n.t("sourceUi.pages.rules.sections.text.47");
const summaryDcDescOf = () => i18n.t("sourceUi.pages.rules.sections.text.48");
const summaryDescOf = () =>
	({
		dmc: i18n.t("sourceUi.pages.rules.sections.dmc.49"),
		fanclub: i18n.t("sourceUi.pages.rules.sections.fanclub.50"),
		dca: i18n.t("sourceUi.pages.rules.sections.dca.51"),
		un1: summaryUnDescOf(),
		un2: summaryUnDescOf(),
		un3: summaryUnDescOf(),
		un4: summaryUnDescOf(),
		un5: summaryUnDescOf(),
		dc1: summaryDcDescOf(),
		dc2: summaryDcDescOf(),
		dc3: summaryDcDescOf(),
		dc4: summaryDcDescOf(),
		dc5: summaryDcDescOf(),
	}) satisfies VariableDescriptions<"liveSummary">;
const summaryVarsOf = () => foldedVars(variableNamesOf("liveSummary"), summaryDescOf());

/** 开播 / 直播中 / 下播三格的时长说明同一句,抽出来免得三处漂开。 */
const liveTimeDescOf = () => i18n.t("sourceUi.pages.rules.sections.text.52");

/**
 * 直播三段模板的变量表(链接不再是模板变量:开播链接由消息版式的「链接」部件
 * 提供;直播中 / 下播不带链接)。per-UP 覆盖框合用 LIVE_MSG_VARS(三段并列)。
 */
const liveStartDescOf = () =>
	({
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		follower: i18n.t("sourceUi.pages.rules.sections.follower.54"),
		time: liveTimeDescOf(),
	}) satisfies VariableDescriptions<"liveStart">;
const liveStartVarsOf = () => varsOf("liveStart", liveStartDescOf());

const liveStreamingDescOf = () =>
	({
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		time: liveTimeDescOf(),
		watched: i18n.t("sourceUi.pages.rules.sections.watched.55"),
	}) satisfies VariableDescriptions<"liveStreaming">;
const liveStreamingVarsOf = () => varsOf("liveStreaming", liveStreamingDescOf());

const liveEndDescOf = () =>
	({
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		time: liveTimeDescOf(),
		follower_change: i18n.t("sourceUi.pages.rules.sections.followerchange.56"),
	}) satisfies VariableDescriptions<"liveEnd">;
const liveEndVarsOf = () => varsOf("liveEnd", liveEndDescOf());

const liveMsgDescOf = () =>
	({
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		follower: i18n.t("sourceUi.pages.rules.sections.follower.57"),
		follower_change: i18n.t("sourceUi.pages.rules.sections.followerchange.58"),
		time: i18n.t("sourceUi.pages.rules.sections.time.59"),
		watched: i18n.t("sourceUi.pages.rules.sections.watched.60"),
	}) satisfies UnionDescriptions<readonly ["liveStart", "liveStreaming", "liveEnd"]>;
const liveMsgVarsOf = () =>
	mergedVars(["liveStart", "liveStreaming", "liveEnd"] as const, liveMsgDescOf());

/** 动态模板已进消息版式:链接是独立部件,不是模板变量。 */
const dynamicDescOf = () =>
	({
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		postNoun: i18n.t("sourceUi.pages.rules.sections.postNoun.61"),
	}) satisfies VariableDescriptions<"post">;
const dynamicMsgVarsOf = () => varsOf("post", dynamicDescOf());

const guardDescOf = () =>
	({
		viewer: i18n.t("sourceUi.pages.rules.sections.viewer.62"),
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		tier: i18n.t("sourceUi.pages.rules.sections.tier.63"),
	}) satisfies VariableDescriptions<"membership">;
const guardVarsOf = () => varsOf("membership", guardDescOf());

const specialDanmakuDescOf = () =>
	({
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
		viewer: i18n.t("sourceUi.pages.rules.sections.viewer.64"),
		msg: i18n.t("sourceUi.pages.rules.sections.msg.65"),
	}) satisfies VariableDescriptions<"viewerChat">;
const specialDanmakuVarsOf = () => varsOf("viewerChat", specialDanmakuDescOf());

const specialEnterDescOf = () =>
	({
		viewer: i18n.t("sourceUi.pages.rules.sections.viewer.66"),
		name: i18n.t("sourceUi.pages.rules.sections.name.53"),
	}) satisfies VariableDescriptions<"viewerEnter">;
const specialEnterVarsOf = () => varsOf("viewerEnter", specialEnterDescOf());

/**
 * 模板编辑器上方那条「可用变量」提示。`accent` 决定描边、底色与标题字的色相;
 * 缺省是 `SummaryVariableHints` 当年那抹紫,现在走 token,跟皮肤换装。
 *
 * **标题字不再单独传** —— 它从 `accent` 现算(见 `sectionTitleColor`)。此前是手调
 * 死的第二个字面量,强调色一跟皮肤走它就脱节,而且那几个值在暗色主题下压在同样
 * 深的底上几乎看不见。
 */
/**
 * 字段上方那条「浅色染底 + 粗体前缀 + 一段说明」的提示条。
 *
 * **三处颜色全从 `accent` 派生**,一个都不许手挑:边 40%、底 10%、标题走
 * `sectionTitleColor()` 往正文色里调 70%。最后那步是暗色模式的命门 —— 底是半透明的,
 * 暗色下挡不住黑页面,写死的深色标题会直接糊进背景(`#076e94` 与 `#946800` 都栽过)。
 * 派生式亮色往黑里调、暗色往白里调,accent 换成什么都跟得住。
 *
 * `leading` 是唯一开的口子:变量速查条里嵌着 `<code>` 芯片要 7,纯文字条 6 就够。
 */
function HintBar({
	accent,
	title,
	leading = "leading-7",
	children,
}: {
	accent: string;
	title: string;
	leading?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={`mb-2 rounded-lg border px-3 py-2 text-bn-xs ${leading} text-bn-text-secondary`}
			style={{
				borderColor: `color-mix(in srgb, ${accent} 40%, transparent)`,
				background: `color-mix(in srgb, ${accent} 10%, transparent)`,
			}}
		>
			<span className="font-bold" style={{ color: sectionTitleColor(accent) }}>
				{title}
			</span>{" "}
			{children}
		</div>
	);
}

function VariableHints({
	vars,
	accent = "var(--color-bn-purple)",
}: {
	vars: ReadonlyArray<VarSpec>;
	accent?: string;
}) {
	const tx = useT();
	return (
		<HintBar accent={accent} title={tx("sourceUi.pages.rules.sections.title.67")}>
			{vars.map((v, i) => (
				<span key={v.code}>
					<code className="mx-0.5 rounded-sm bg-bn-surface/70 px-1.5 py-px font-mono text-bn-xs">
						{v.code}
					</code>{" "}
					{v.desc}
					{i < vars.length - 1 ? " · " : ""}
				</span>
			))}
		</HintBar>
	);
}

export function SummaryVariableHints() {
	return <VariableHints vars={summaryVarsOf()} />;
}

export function LiveMsgVariableHints() {
	return <VariableHints vars={liveMsgVarsOf()} accent="var(--color-bn-pink)" />;
}

export function DynamicMsgVariableHints() {
	return <VariableHints vars={dynamicMsgVarsOf()} accent={SECTION_ACCENT.message} />;
}

export function GuardVariableHints() {
	return <VariableHints vars={guardVarsOf()} accent={SECTION_ACCENT.guard} />;
}

export function SpecialDanmakuVariableHints() {
	return <VariableHints vars={specialDanmakuVarsOf()} accent={SECTION_ACCENT.persona} />;
}

export function SpecialEnterVariableHints() {
	return <VariableHints vars={specialEnterVarsOf()} accent="var(--color-bn-blue)" />;
}

// ── 4. Live message templates ────────────────────────────────────────────────

/** 直播文本 Picker 的三段定义:模板字段 / Field code / 变量表(开播 / 直播中 / 下播共用同一套版式)。 */
const liveTemplateTabsOf = () =>
	[
		{
			key: "liveStart",
			label: i18n.t("sourceUi.pages.Stats.label.31"),
			code: "templates.liveStart",
			vars: liveStartVarsOf(),
		},
		{
			key: "liveStreaming",
			label: i18n.t("sourceUi.pages.rules.sections.label.68"),
			code: "templates.liveStreaming",
			vars: liveStreamingVarsOf(),
		},
		{
			key: "liveEnd",
			label: i18n.t("sourceUi.pages.rules.sections.label.69"),
			code: "templates.liveEnd",
			vars: liveEndVarsOf(),
		},
	] as const;

export function LiveMsgSection({
	templates,
	factory,
	layout,
	onPatch,
}: {
	templates: TemplateBundle;
	factory: BuiltinTemplates;
	layout: MessageKindLayoutFull;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const setText = (k: ReturnType<typeof liveTemplateTabsOf>[number]["key"], v: string) =>
		onPatch({ defaults: { templates: { [k]: templateValueToStore(v, factory[k]) } } });
	const [tab, setTab] = useState<ReturnType<typeof liveTemplateTabsOf>[number]["key"]>("liveStart");
	const active = liveTemplateTabsOf().find((t) => t.key === tab) ?? liveTemplateTabsOf()[0];
	return (
		<GlassBox
			title={tx("sourceUi.pages.rules.PerUpEditor.MessageLayoutOverrideBox.37")}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.70")}
			accent="var(--color-bn-pink)"
			icon={<Icon.chat size={14} />}
		>
			<MessageLayoutEditor
				value={layout}
				onChange={(next) => onPatch({ defaults: { messageLayout: { live: next } } })}
				separatorCode="messageLayout.live.separator"
				accent="var(--color-bn-pink)"
				textSlot={
					<>
						<div className="mb-2">
							<Picker
								value={tab}
								onChange={(v) => setTab(v)}
								options={liveTemplateTabsOf().map((t) => ({ value: t.key, label: t.label }))}
							/>
						</div>
						<VariableHints vars={active.vars} accent="var(--color-bn-pink)" />
						<Field code={active.code} full>
							<TArea
								key={active.key}
								value={templates[active.key] ?? factory[active.key]}
								onChange={(v) => setText(active.key, v)}
								rows={3}
								mono
							/>
						</Field>
					</>
				}
			/>
		</GlassBox>
	);
}

// ── 4b. Dynamic message templates ────────────────────────────────────────────

/** 动态文本 Picker 的两段定义:动态 / 视频投稿共用版式,仅模板文案不同。 */
const dynamicTemplateTabsOf = () =>
	[
		{ key: "post", label: i18n.t("sourceUi.pages.Dashboard.TrendPanel.3"), code: "templates.post" },
		{
			key: "postVideo",
			label: i18n.t("sourceUi.pages.rules.sections.label.71"),
			code: "templates.postVideo",
		},
	] as const;

export function DynamicMsgSection({
	templates,
	factory,
	layout,
	onPatch,
}: {
	templates: TemplateBundle;
	factory: BuiltinTemplates;
	layout: MessageKindLayoutFull;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const setText = (k: ReturnType<typeof dynamicTemplateTabsOf>[number]["key"], v: string) =>
		onPatch({ defaults: { templates: { [k]: templateValueToStore(v, factory[k]) } } });
	const [tab, setTab] = useState<ReturnType<typeof dynamicTemplateTabsOf>[number]["key"]>("post");
	const active = dynamicTemplateTabsOf().find((t) => t.key === tab) ?? dynamicTemplateTabsOf()[0];
	return (
		<GlassBox
			title={tx("sourceUi.pages.rules.PerUpEditor.MessageLayoutOverrideBox.36")}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.72")}
			accent={SECTION_ACCENT.message}
			icon={<Icon.chat size={14} />}
		>
			<MessageLayoutEditor
				value={layout}
				onChange={(next) => onPatch({ defaults: { messageLayout: { post: next } } })}
				separatorCode="messageLayout.post.separator"
				accent={SECTION_ACCENT.message}
				textSlot={
					<>
						<div className="mb-2">
							<Picker
								value={tab}
								onChange={(v) => setTab(v)}
								options={dynamicTemplateTabsOf().map((t) => ({ value: t.key, label: t.label }))}
							/>
						</div>
						<DynamicMsgVariableHints />
						<Field code={active.code} full>
							<TArea
								key={active.key}
								value={templates[active.key] ?? factory[active.key]}
								onChange={(v) => setText(active.key, v)}
								rows={2}
								mono
							/>
						</Field>
					</>
				}
			/>
		</GlassBox>
	);
}

// ── 5. Guard (上舰提示) ──────────────────────────────────────────────────────

/** 这一屏的每一档,由低到高,每档一块。 */

/** 一个体系文案里一格的补丁:`null` = 清掉这一格(JSON Merge Patch 语义,下发时由 buildPatch 编成显式 null)。 */
type TierFieldPatch = Partial<Record<"template" | "imageUrl", string | null>>;

/** 对 B 站体系文案(`templates.membership.guard`)的补丁。 */
interface GuardBundlePatch {
	enabled?: boolean;
	default?: Partial<Record<keyof MembershipTemplateEntry, string | null>>;
	/** 按档 key:`null` = 整档拿掉。 */
	tiers?: Record<string, TierFieldPatch | null>;
}

/**
 * 画 B 站体系文案用的整份:配置里没有这个体系(新装、或手改删掉了)就是出厂那一份 —— 自定义关着,体系默认是当前语言的出厂文案;
 * 体系默认的文字没存(没改过)也取出厂那一句。
 */
export function guardBundleOf(
	templates: Pick<TemplateBundle, "membership">,
	factory: BuiltinTemplates,
	programId: string,
): EffectiveMembershipTemplate {
	return withMembershipDefaults(templates.membership[programId], factory.membership);
}

/**
 * 体系默认 + 每档,三块文案与图片输入框(上舰提示的全局一节与逐订阅覆盖共用,两边只差「怎么落字」)。
 * 最上面一块是体系默认(文案 + 图片),下面每档一块;某档某一格没填(空串)时,输入框的占位显示跟随的默认 ——
 * 文案跟随体系默认的文案,图片跟随体系默认的图片,默认也没填就是该档的官方徽章图。
 * 清空一格 = 这一档不再覆盖它(`onTier` 收到空串,由调用方决定怎么删)。
 */
export function GuardTemplateFields({
	program,
	bundle,
	onDefault,
	onTier,
	tiersClassName = "space-y-2.5",
}: {
	program: MembershipProgram;
	bundle: EffectiveMembershipTemplate;
	onDefault: (field: "template" | "imageUrl", value: string) => void;
	onTier: (key: string, field: "template" | "imageUrl", value: string) => void;
	/** 三档那一块外面的排版(逐订阅覆盖里排成三列)。 */
	tiersClassName?: string;
}) {
	const tx = useT();
	const accent = SECTION_ACCENT.guard;
	return (
		<>
			<div
				className="mb-2.5 rounded-lg border p-3"
				style={{
					background: `color-mix(in srgb, ${accent} 4%, transparent)`,
					borderColor: `color-mix(in srgb, ${accent} 20%, transparent)`,
				}}
			>
				<div className="mb-2 flex items-center gap-2">
					<span className="text-bn-sm font-bold text-bn-text-primary">
						{tx("sourceUi.pages.rules.sections.GuardTemplateFields.73")}
					</span>
					<span className="text-bn-2xs text-bn-text-tertiary">
						{program.tiers === "custom"
							? tx("sources.membership.customHint")
							: tx("sourceUi.pages.rules.sections.GuardTemplateFields.74")}
					</span>
				</div>
				{/* 体系默认这两格用完整路径当 code:「默认文案有更新」的提示与「恢复默认」按路径认领(同别的文案),
				    逐订阅覆盖里没有 Provider,不受影响。 */}
				<Field
					code={`templates.membership.${program.id}.default.template`}
					label={tx("sourceUi.config.field.labels.label.134")}
					full
				>
					<TInput value={bundle.default.template} onChange={(v) => onDefault("template", v)} mono />
				</Field>
				<Field
					code={`templates.membership.${program.id}.default.imageUrl`}
					label={tx("sourceUi.config.field.labels.label.135")}
					full
				>
					<TInput
						value={bundle.default.imageUrl}
						onChange={(v) => onDefault("imageUrl", v)}
						mono
						placeholder="https://..."
					/>
				</Field>
			</div>
			<div className={tiersClassName}>
				{membershipTiersOf([program], program.id).map(({ key, name, color = accent }) => {
					const tier = bundle.tiers[key] ?? {};
					return (
						<div
							key={key}
							className="rounded-lg border p-3"
							style={{
								background: `color-mix(in srgb, ${color} 4%, transparent)`,
								borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
							}}
						>
							<div className="mb-2 flex items-center gap-2">
								<span className="block h-2 w-2 rounded-sm" style={{ background: color }} />
								<span className="text-bn-sm font-bold text-bn-text-primary">{name}</span>
								<code className="ml-1 rounded-sm bg-bn-code-bg px-1.5 py-px font-mono text-bn-2xs text-bn-text-tertiary">
									{key}
								</code>
							</div>
							<Field
								code={`templates.membership.${program.id}.tiers.${key}.template`}
								label={tx("sourceUi.config.field.labels.getFieldLabel.183")}
								full
							>
								<TInput
									value={tier.template ?? ""}
									onChange={(v) => onTier(key, "template", v)}
									mono
									placeholder={
										bundle.default.template || tx("sourceUi.pages.rules.sections.placeholder.75")
									}
								/>
							</Field>
							<Field
								code={`templates.membership.${program.id}.tiers.${key}.imageUrl`}
								label={tx("sourceUi.config.field.labels.getFieldLabel.184")}
								full
							>
								<TInput
									value={tier.imageUrl ?? ""}
									onChange={(v) => onTier(key, "imageUrl", v)}
									mono
									placeholder={
										bundle.default.imageUrl || tx("sourceUi.pages.rules.sections.placeholder.76")
									}
								/>
							</Field>
						</div>
					);
				})}
			</div>
		</>
	);
}

function MembershipProgramSection({
	program,
	templates,
	factory,
	onPatch,
}: {
	program: MembershipProgram;
	templates: TemplateBundle;
	factory: BuiltinTemplates;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const guard = guardBundleOf(templates, factory, program.id);
	const patchGuard = (delta: GuardBundlePatch) =>
		onPatch({ defaults: { templates: { membership: { [program.id]: delta } } } });
	/** 改一档的一格;清空 = 这一格不再覆盖,一档两格都空了就把这一档拿掉(盘上不留空壳)。 */
	const setTier = (key: string, field: "template" | "imageUrl", value: string): void => {
		const left = { ...guard.tiers[key], [field]: value === "" ? undefined : value };
		const emptied = !left.template && !left.imageUrl;
		patchGuard({
			tiers: { [key]: emptied ? null : { [field]: value === "" ? null : value } },
		});
	};
	const enabled = guard.enabled;
	return (
		<GlassBox
			title={program.name}
			subtitle={tx("sourceUi.pages.rules.sections.subtitle.77")}
			accent={SECTION_ACCENT.guard}
			icon={<Icon.anchor size={14} />}
			badge={
				enabled ? tx("subs.filter.enabled") : tx("sourceUi.pages.Dashboard.SystemHealthCard.33")
			}
			right={<Toggle value={enabled} onChange={(v) => patchGuard({ enabled: v })} />}
		>
			{enabled ? (
				<>
					<GuardVariableHints />
					<GuardTemplateFields
						program={program}
						bundle={guard}
						onDefault={(field, v) =>
							patchGuard({
								default: {
									[field]: field === "template" ? templateValueToStore(v, factory.membership) : v,
								},
							})
						}
						onTier={setTier}
					/>
				</>
			) : (
				<InheritNote>{tx("sourceUi.pages.rules.sections.MembershipProgramSection.78")}</InheritNote>
			)}
		</GlassBox>
	);
}

export function GuardSection({
	programs = [],
	...props
}: {
	programs?: readonly MembershipProgram[];
	templates: TemplateBundle;
	factory: BuiltinTemplates;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	return (
		<>
			{programs.map((program) => (
				<MembershipProgramSection key={program.id} program={program} {...props} />
			))}
		</>
	);
}
