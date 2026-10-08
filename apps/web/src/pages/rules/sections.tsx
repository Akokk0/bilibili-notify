/**
 * Rules page sections — bound to live GlobalConfig.defaults shapes. Each
 * section accepts the relevant slice + an `onPatch` that builds a deep-partial
 * delta for /api/settings.
 */

import { DEFAULT_TEMPLATES } from "@bilibili-notify/internal/constants";
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
} from "../../components/forms";
import { InheritNote } from "../../components/inherit-note";
import { GUARD_PROGRAM_ID, membershipTiersOf } from "../../config/membership-programs";
import { SECTION_ACCENT, sectionTitleColor } from "../../config/section-accents";
import {
	BILIBILI_SOURCE_KEY,
	type FeatureKey,
	type MessageKindLayoutFull,
	type Subscription,
	subscriptionIdentityOf,
} from "../../types/domain";
import type {
	ContentFilters,
	GlobalConfigPatch,
	ImageGroupSettings,
	LiveStartSettings,
	LiveStreamingSettings,
	MembershipSettings,
	MembershipTemplateBundle,
	MembershipTemplateEntry,
	ScheduleConfig,
	SuperchatSettings,
	TemplateBundle,
} from "../../types/globals";
import { MessageLayoutEditor } from "./MessageLayoutEditor";

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
export const GLOBAL_SECTIONS: SectionMeta[] = [
	{
		id: "filter",
		label: "动态过滤",
		icon: <Icon.filter size={14} />,
		desc: "关键词 / 正则 / 白名单",
	},
	{
		id: "imageGroup",
		label: "动态图集",
		icon: <Icon.dyn size={14} />,
		desc: "是否推图 / 合并转发",
	},
	{
		id: "dynamicMsg",
		label: "动态消息版式",
		icon: <Icon.chat size={14} />,
		desc: "部件排列 / 分条 / 文案",
	},
	{
		id: "live",
		label: "直播阈值",
		icon: <Icon.mic size={14} />,
		desc: "SC 金额 / 上舰等级 / 推送频率",
	},
	{
		id: "summary",
		label: "直播总结",
		icon: <Icon.list size={14} />,
		desc: "词云停用词 / 总结正文",
	},
	{
		id: "msg",
		label: "直播消息版式",
		icon: <Icon.chat size={14} />,
		desc: "部件排列 / 分条 / 三段文案",
	},
	{
		id: "guard",
		label: "上舰提示",
		icon: <Icon.anchor size={14} />,
		desc: "舰长 / 提督 / 总督文案与图片",
	},
];

/**
 * per-UP 9 个分类:全局 5 个 + 特别关注弹幕 / 进房 / 卡片样式 / AI 人格。
 * 每项独立 toggle 到「覆盖中」才会写入 Subscription.overrides;关闭即继承全局。
 */
export const PERUP_SECTIONS: SectionMeta[] = [
	{
		id: "filter",
		label: "动态过滤",
		icon: <Icon.filter size={14} />,
		desc: "覆盖关键词 / 白名单",
	},
	{
		id: "imageGroup",
		label: "动态图集",
		icon: <Icon.dyn size={14} />,
		desc: "覆盖图集推送 / 合并转发",
	},
	{
		id: "dynamicMsg",
		label: "动态消息",
		icon: <Icon.chat size={14} />,
		desc: "覆盖动态 / 视频文案",
	},
	{
		id: "messageLayout",
		label: "消息版式",
		icon: <Icon.list size={14} />,
		desc: "覆盖部件排列 / 分条",
	},
	{
		id: "live",
		label: "直播阈值",
		icon: <Icon.mic size={14} />,
		desc: "覆盖 SC / 上舰 / 频率",
	},
	{
		id: "summary",
		label: "直播总结",
		icon: <Icon.list size={14} />,
		desc: "覆盖词云停用词 / 总结模板",
	},
	{
		id: "msg",
		label: "直播消息",
		icon: <Icon.chat size={14} />,
		desc: "覆盖开播 / 下播文案",
	},
	{
		id: "guard",
		label: "上舰提示",
		icon: <Icon.anchor size={14} />,
		desc: "覆盖上舰图片与文案",
	},
	{
		id: "specialDanmaku",
		label: "特别关注弹幕",
		icon: <Icon.star size={14} />,
		desc: "UID 高亮 + 弹幕模板",
	},
	{
		id: "specialEnter",
		label: "特别关注进房",
		icon: <Icon.user size={14} />,
		desc: "UID 进入提醒",
	},
	{
		id: "ai",
		label: "AI 人格",
		icon: <Icon.ai size={14} />,
		desc: "挑一份人格给这个 UP",
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
	sub: Subscription,
	features: readonly FeatureKey[],
): SectionMeta[] {
	if (subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY) return PERUP_SECTIONS;
	const post = features.includes("post");
	const live = features.includes("liveStart") || features.includes("liveEnd");
	const out: SectionMeta[] = [];
	for (const s of PERUP_SECTIONS) {
		if (s.id === "live") {
			out.push({
				id: "schedule",
				label: "推送时段",
				icon: <Icon.sliders size={14} />,
				desc: live ? "覆盖免扰时段 / 直播推送频率" : "覆盖免扰时段",
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
			title="动态过滤规则"
			subtitle="filters · 屏蔽不想推送的动态"
			accent="var(--color-bn-pink)"
			icon={<Icon.filter size={14} />}
			badge="filters"
		>
			<Field code="blockKeywords" full>
				<ArrayEditor
					value={value.blockKeywords}
					onChange={(n) => set("blockKeywords", n)}
					placeholder="关键词"
				/>
			</Field>
			<Field code="blockRegex" full>
				<ArrayEditor
					value={value.blockRegex}
					onChange={(n) => set("blockRegex", n)}
					placeholder="例如:^广告.*"
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
				label="启用白名单 · 仅推送命中条目"
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
	const set = <K extends keyof ImageGroupSettings>(key: K, v: ImageGroupSettings[K]) => {
		onPatch({ defaults: { imageGroup: { [key]: v } as Partial<ImageGroupSettings> } });
	};
	return (
		<GlassBox
			title="动态图集"
			subtitle="imageGroup · 图集类动态附图与推送形态"
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
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setS = <K extends keyof ScheduleConfig>(k: K, v: ScheduleConfig[K]) =>
		onPatch({ defaults: { schedule: { [k]: v } as Partial<ScheduleConfig> } });
	return (
		<GlassBox
			title="直播推送阈值"
			subtitle="superchat / membership / schedule · 控制 SC 金额 / 上舰等级 / 推送频率"
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
						suffix="元"
					/>
				</Field>
				<Field code="membership.minRank.guard">
					<Picker<number>
						// 没配 = 全推 = 最低一档(舰长,rank 1)。
						value={membership.minRank?.[GUARD_PROGRAM_ID] ?? 1}
						onChange={(rank) =>
							onPatch({ defaults: { membership: { minRank: { [GUARD_PROGRAM_ID]: rank } } } })
						}
						// 由低到高(档位表本身就是 rank 升序),与这一屏别处同序。
						options={membershipTiersOf(GUARD_PROGRAM_ID).map((t) => ({
							value: t.rank,
							label: t.name,
						}))}
					/>
				</Field>
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
						suffix="小时"
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
				<Field
					code="schedule.liveEndGrace"
					hint="开启后下播先等待,期间重新开播即接续为同一场(防网络抖动 / 超管掐流误报)"
				>
					<div className="flex h-7.5 items-center">
						<Toggle
							value={schedule.liveEndGrace}
							onChange={(v) => setS("liveEndGrace", v)}
							size="sm"
						/>
					</div>
				</Field>
				{schedule.liveEndGrace ? (
					<Field code="schedule.liveEndGraceMinutes" hint="下播到重开超过此时长才判定真下播">
						<TNum
							value={schedule.liveEndGraceMinutes}
							onChange={(v) => setS("liveEndGraceMinutes", v)}
							min={1}
							max={10}
							suffix="分钟"
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
	onPatch,
}: {
	templates: TemplateBundle;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setT = <K extends keyof TemplateBundle>(k: K, v: TemplateBundle[K]) =>
		onPatch({ defaults: { templates: { [k]: v } as Partial<TemplateBundle> } });
	return (
		<GlassBox
			title="直播总结"
			subtitle="弹幕词云停用词 + 直播总结模板"
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
					placeholder="例如：哈哈,2333,前面的,主播"
				/>
			</Field>
			<div className="my-3 border-t border-bn-border-subtle" />
			<SummaryVariableHints />
			<Field code="templates.liveSummary" full>
				<TArea
					value={templates.liveSummary}
					onChange={(v) => setT("liveSummary", v)}
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
	return (
		<HintBar accent="var(--color-bn-blue)" title="弹幕词云停用词:" leading="leading-6">
			用<b>英文逗号</b>分隔,这些词会在生成词云时被过滤掉。
			<b>追加</b>到内置中文停用词表之上,不影响弹幕条数 / 发言人数等统计。
		</HintBar>
	);
}

const SUMMARY_VARS: { code: string; desc: string }[] = [
	{ code: "{dmc}", desc: "弹幕发言人数" },
	{ code: "{mdn}", desc: "粉丝牌名" },
	{ code: "{dca}", desc: "弹幕总数" },
	{ code: "{un1..5}", desc: "弹幕排行用户名" },
	{ code: "{dc1..5}", desc: "对应弹幕数" },
];

interface VarSpec {
	code: string;
	desc: string;
}

/**
 * 直播三段模板的变量表(链接不再是模板变量:开播链接由消息版式的「链接」部件
 * 提供;直播中 / 下播不带链接)。per-UP 覆盖框合用 LIVE_MSG_VARS(三段并列)。
 */
const LIVE_START_VARS: VarSpec[] = [
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{follower}", desc: "当前粉丝数" },
];
const LIVE_STREAMING_VARS: VarSpec[] = [
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{time}", desc: "已直播时长" },
	{ code: "{watched}", desc: "累计观看人数" },
];
const LIVE_END_VARS: VarSpec[] = [
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{time}", desc: "已直播时长" },
	{ code: "{follower_change}", desc: "粉丝变化" },
];
const LIVE_MSG_VARS: VarSpec[] = [
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{follower}", desc: "当前粉丝数(开播)" },
	{ code: "{follower_change}", desc: "粉丝变化(下播)" },
	{ code: "{time}", desc: "已直播时长(直播中、下播)" },
	{ code: "{watched}", desc: "累计观看人数(直播中)" },
];

/** 动态模板已进消息版式:链接是独立部件,不是模板变量。 */
const DYNAMIC_MSG_VARS: VarSpec[] = [{ code: "{name}", desc: "UP 主名字" }];

const GUARD_VARS: VarSpec[] = [
	{ code: "{viewer}", desc: "上舰用户名" },
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{tier}", desc: "档名(舰长 / 提督 / 总督)" },
];

const SPECIAL_DANMAKU_VARS: VarSpec[] = [
	{ code: "{mastername}", desc: "UP 主名字" },
	{ code: "{uname}", desc: "发送弹幕的用户名" },
	{ code: "{msg}", desc: "弹幕内容" },
];

const SPECIAL_ENTER_VARS: VarSpec[] = [
	{ code: "{uname}", desc: "进入直播间的用户名" },
	{ code: "{mastername}", desc: "UP 主名字" },
];

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
	return (
		<HintBar accent={accent} title="可用变量:">
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
	return <VariableHints vars={SUMMARY_VARS} />;
}

export function LiveMsgVariableHints() {
	return <VariableHints vars={LIVE_MSG_VARS} accent="var(--color-bn-pink)" />;
}

export function DynamicMsgVariableHints() {
	return <VariableHints vars={DYNAMIC_MSG_VARS} accent={SECTION_ACCENT.message} />;
}

export function GuardVariableHints() {
	return <VariableHints vars={GUARD_VARS} accent={SECTION_ACCENT.guard} />;
}

export function SpecialDanmakuVariableHints() {
	return <VariableHints vars={SPECIAL_DANMAKU_VARS} accent={SECTION_ACCENT.persona} />;
}

export function SpecialEnterVariableHints() {
	return <VariableHints vars={SPECIAL_ENTER_VARS} accent="var(--color-bn-blue)" />;
}

// ── 4. Live message templates ────────────────────────────────────────────────

/** 直播文本 Picker 的三段定义:模板字段 / Field code / 变量表(开播 / 直播中 / 下播共用同一套版式)。 */
const LIVE_TEMPLATE_TABS = [
	{ key: "liveStart", label: "开播", code: "templates.liveStart", vars: LIVE_START_VARS },
	{
		key: "liveStreaming",
		label: "直播中",
		code: "templates.liveStreaming",
		vars: LIVE_STREAMING_VARS,
	},
	{ key: "liveEnd", label: "下播", code: "templates.liveEnd", vars: LIVE_END_VARS },
] as const;

export function LiveMsgSection({
	templates,
	layout,
	onPatch,
}: {
	templates: TemplateBundle;
	layout: MessageKindLayoutFull;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setT = <K extends keyof TemplateBundle>(k: K, v: TemplateBundle[K]) =>
		onPatch({ defaults: { templates: { [k]: v } as Partial<TemplateBundle> } });
	const [tab, setTab] = useState<(typeof LIVE_TEMPLATE_TABS)[number]["key"]>("liveStart");
	const active = LIVE_TEMPLATE_TABS.find((t) => t.key === tab) ?? LIVE_TEMPLATE_TABS[0];
	return (
		<GlassBox
			title="直播消息版式"
			subtitle="开播 / 直播中 / 下播共用的部件排列 / 分条;文本内容按 开播 / 直播中 / 下播 切换编辑"
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
								options={LIVE_TEMPLATE_TABS.map((t) => ({ value: t.key, label: t.label }))}
							/>
						</div>
						<VariableHints vars={active.vars} accent="var(--color-bn-pink)" />
						<Field code={active.code} full>
							<TArea
								key={active.key}
								value={templates[active.key]}
								onChange={(v) => setT(active.key, v)}
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
const DYNAMIC_TEMPLATE_TABS = [
	{ key: "post", label: "动态", code: "templates.post" },
	{ key: "postVideo", label: "视频投稿", code: "templates.postVideo" },
] as const;

export function DynamicMsgSection({
	templates,
	layout,
	onPatch,
}: {
	templates: TemplateBundle;
	layout: MessageKindLayoutFull;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setT = <K extends keyof TemplateBundle>(k: K, v: TemplateBundle[K]) =>
		onPatch({ defaults: { templates: { [k]: v } as Partial<TemplateBundle> } });
	const [tab, setTab] = useState<(typeof DYNAMIC_TEMPLATE_TABS)[number]["key"]>("post");
	const active = DYNAMIC_TEMPLATE_TABS.find((t) => t.key === tab) ?? DYNAMIC_TEMPLATE_TABS[0];
	return (
		<GlassBox
			title="动态消息版式"
			subtitle="动态推送的部件排列 / 分条;文本内容按 动态 / 视频投稿 切换编辑"
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
								options={DYNAMIC_TEMPLATE_TABS.map((t) => ({ value: t.key, label: t.label }))}
							/>
						</div>
						<DynamicMsgVariableHints />
						<Field code={active.code} full>
							<TArea
								key={active.key}
								value={templates[active.key]}
								onChange={(v) => setT(active.key, v)}
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
const GUARD_TIER_ROWS = membershipTiersOf(GUARD_PROGRAM_ID);

/** 一个体系文案里一格的补丁:`null` = 清掉这一格(JSON Merge Patch 语义,下发时由 buildPatch 编成显式 null)。 */
type TierFieldPatch = Partial<Record<"template" | "imageUrl", string | null>>;

/** 对 B 站体系文案(`templates.membership.guard`)的补丁。 */
interface GuardBundlePatch {
	enabled?: boolean;
	default?: Partial<MembershipTemplateEntry>;
	/** 按档 key:`null` = 整档拿掉。 */
	tiers?: Record<string, TierFieldPatch | null>;
}

/** 配置里没有 B 站这一个体系(手改删掉了)时画出厂那一份:自定义关着,体系默认是出厂文案。 */
export function guardBundleOf(
	templates: Pick<TemplateBundle, "membership">,
): MembershipTemplateBundle {
	return (
		templates.membership[GUARD_PROGRAM_ID] ?? {
			enabled: false,
			default: { ...DEFAULT_TEMPLATES.membership.guard.default },
			tiers: {},
		}
	);
}

/**
 * 体系默认 + 每档,三块文案与图片输入框(上舰提示的全局一节与逐订阅覆盖共用,两边只差「怎么落字」)。
 * 最上面一块是体系默认(文案 + 图片),下面每档一块;某档某一格没填(空串)时,输入框的占位显示跟随的默认 ——
 * 文案跟随体系默认的文案,图片跟随体系默认的图片,默认也没填就是该档的官方徽章图。
 * 清空一格 = 这一档不再覆盖它(`onTier` 收到空串,由调用方决定怎么删)。
 */
export function GuardTemplateFields({
	bundle,
	onDefault,
	onTier,
	tiersClassName = "space-y-2.5",
}: {
	bundle: MembershipTemplateBundle;
	onDefault: (field: "template" | "imageUrl", value: string) => void;
	onTier: (key: string, field: "template" | "imageUrl", value: string) => void;
	/** 三档那一块外面的排版(逐订阅覆盖里排成三列)。 */
	tiersClassName?: string;
}) {
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
					<span className="text-bn-sm font-bold text-bn-text-primary">体系默认</span>
					<span className="text-bn-2xs text-bn-text-tertiary">
						没单独配的档都用它;图片留空 = 该档的官方徽章图
					</span>
				</div>
				{/* 体系默认这两格用完整路径当 code:「默认文案有更新」的提示与「恢复默认」按路径认领(同别的文案),
				    逐订阅覆盖里没有 Provider,不受影响。 */}
				<Field code="templates.membership.guard.default.template" full>
					<TInput value={bundle.default.template} onChange={(v) => onDefault("template", v)} mono />
				</Field>
				<Field code="templates.membership.guard.default.imageUrl" full>
					<TInput
						value={bundle.default.imageUrl}
						onChange={(v) => onDefault("imageUrl", v)}
						mono
						placeholder="https://..."
					/>
				</Field>
			</div>
			<div className={tiersClassName}>
				{GUARD_TIER_ROWS.map(({ key, name, color = accent }) => {
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
							<Field code="template" full>
								<TInput
									value={tier.template ?? ""}
									onChange={(v) => onTier(key, "template", v)}
									mono
									placeholder={bundle.default.template || "跟随体系默认"}
								/>
							</Field>
							<Field code="imageUrl" full>
								<TInput
									value={tier.imageUrl ?? ""}
									onChange={(v) => onTier(key, "imageUrl", v)}
									mono
									placeholder={bundle.default.imageUrl || "留空 = 官方徽章图"}
								/>
							</Field>
						</div>
					);
				})}
			</div>
		</>
	);
}

export function GuardSection({
	templates,
	onPatch,
}: {
	templates: TemplateBundle;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const guard = guardBundleOf(templates);
	const patchGuard = (delta: GuardBundlePatch) =>
		onPatch({ defaults: { templates: { membership: { [GUARD_PROGRAM_ID]: delta } } } });
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
			title="上舰提示"
			subtitle="默认走 B 站官方上舰图;启用后改用自定义文案与图片"
			accent={SECTION_ACCENT.guard}
			icon={<Icon.anchor size={14} />}
			badge={enabled ? "已启用" : "未启用"}
			right={<Toggle value={enabled} onChange={(v) => patchGuard({ enabled: v })} />}
		>
			{enabled ? (
				<>
					<GuardVariableHints />
					<GuardTemplateFields
						bundle={guard}
						onDefault={(field, v) => patchGuard({ default: { [field]: v } })}
						onTier={setTier}
					/>
				</>
			) : (
				<InheritNote>引擎将默认推送 B 站官方上舰图(舰长 / 提督 / 总督)</InheritNote>
			)}
		</GlassBox>
	);
}
