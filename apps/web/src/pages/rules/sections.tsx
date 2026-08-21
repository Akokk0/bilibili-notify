/**
 * Rules page sections — bound to live GlobalConfig.defaults shapes. Each
 * section accepts the relevant slice + an `onPatch` that builds a deep-partial
 * delta for /api/globals.
 */

import { CollapseBlock, GlassBox, Icon, Toggle } from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import {
	ArrayEditor,
	Field,
	type FieldProps,
	Picker,
	QuietHoursEditor,
	TArea,
	TInput,
	TNum,
} from "../../components/forms";
import { SECTION_ACCENT, sectionTitleColor } from "../../config/section-accents";
import type { MessageKindLayoutFull } from "../../types/domain";
import type {
	ContentFilters,
	GlobalConfigPatch,
	GuardBundle,
	ImageGroupSettings,
	ScheduleConfig,
	TemplateBundle,
} from "../../types/globals";
import { MessageLayoutEditor } from "./MessageLayoutEditor";

export type SectionId =
	| "filter"
	| "live"
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

const FieldRow = (props: FieldProps) => <Field {...props} />;

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
		forceOpenWhitelist || value.whitelistKeywords.length > 0 || value.whitelistRegex.length > 0;
	function toggleWhitelist(on: boolean): void {
		if (on) {
			setForceOpenWhitelist(true);
		} else {
			setForceOpenWhitelist(false);
			onPatch({ defaults: { filters: { whitelistKeywords: [], whitelistRegex: [] } } });
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
			<FieldRow code="blockKeywords" full>
				<ArrayEditor
					value={value.blockKeywords}
					onChange={(n) => set("blockKeywords", n)}
					placeholder="关键词"
				/>
			</FieldRow>
			<FieldRow code="blockRegex" full>
				<ArrayEditor
					value={value.blockRegex}
					onChange={(n) => set("blockRegex", n)}
					placeholder="例如:^广告.*"
				/>
			</FieldRow>
			<div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
				<FieldRow code="blockForward">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockForward} onChange={(v) => set("blockForward", v)} size="sm" />
					</div>
				</FieldRow>
				<FieldRow code="blockArticle">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockArticle} onChange={(v) => set("blockArticle", v)} size="sm" />
					</div>
				</FieldRow>
				<FieldRow code="blockDraw">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockDraw} onChange={(v) => set("blockDraw", v)} size="sm" />
					</div>
				</FieldRow>
				<FieldRow code="blockAv">
					<div className="flex h-7.5 items-center">
						<Toggle value={value.blockAv} onChange={(v) => set("blockAv", v)} size="sm" />
					</div>
				</FieldRow>
			</div>
			<CollapseBlock
				label="启用白名单 · 仅推送命中条目"
				enabled={whitelistEnabled}
				onToggle={toggleWhitelist}
				accent="var(--color-bn-pink)"
			>
				<FieldRow code="whitelistKeywords" full>
					<ArrayEditor
						value={value.whitelistKeywords}
						onChange={(n) => set("whitelistKeywords", n)}
					/>
				</FieldRow>
				<FieldRow code="whitelistRegex" full>
					<ArrayEditor value={value.whitelistRegex} onChange={(n) => set("whitelistRegex", n)} />
				</FieldRow>
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
			<FieldRow code="enable">
				<Toggle value={value.enable} onChange={(v) => set("enable", v)} />
			</FieldRow>
			<FieldRow code="forward">
				<Toggle
					value={value.forward}
					onChange={(v) => set("forward", v)}
					disabled={!value.enable}
				/>
			</FieldRow>
		</GlassBox>
	);
}

// ── 2. Live thresholds (SC / guard / schedule) ───────────────────────────────

export function LiveThresholdsSection({
	filters,
	schedule,
	onPatch,
}: {
	filters: ContentFilters;
	schedule: ScheduleConfig;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setF = <K extends keyof ContentFilters>(k: K, v: ContentFilters[K]) =>
		onPatch({ defaults: { filters: { [k]: v } as Partial<ContentFilters> } });
	const setS = <K extends keyof ScheduleConfig>(k: K, v: ScheduleConfig[K]) =>
		onPatch({ defaults: { schedule: { [k]: v } as Partial<ScheduleConfig> } });
	return (
		<GlassBox
			title="直播推送阈值"
			subtitle="filters / schedule · 控制 SC 金额 / 上舰等级 / 推送频率"
			accent="var(--color-bn-blue)"
			icon={<Icon.mic size={14} />}
			badge="live"
		>
			<div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
				<FieldRow code="minScPrice">
					<TNum
						value={filters.minScPrice}
						onChange={(v) => setF("minScPrice", v)}
						min={0}
						max={9999}
						suffix="元"
					/>
				</FieldRow>
				<FieldRow code="minGuardLevel">
					<Picker<1 | 2 | 3>
						value={filters.minGuardLevel}
						onChange={(v) => setF("minGuardLevel", v)}
						options={[
							{ value: 3, label: "舰长" },
							{ value: 2, label: "提督" },
							{ value: 1, label: "总督" },
						]}
					/>
				</FieldRow>
				<FieldRow code="schedule.pushTime">
					<TNum
						value={schedule.pushTime}
						onChange={(v) => setS("pushTime", v)}
						min={0}
						max={23}
						suffix="小时"
					/>
				</FieldRow>
				<FieldRow code="restartPush">
					<div className="flex h-7.5 items-center">
						<Toggle
							value={schedule.restartPush}
							onChange={(v) => setS("restartPush", v)}
							size="sm"
						/>
					</div>
				</FieldRow>
				<FieldRow
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
				</FieldRow>
				{schedule.liveEndGrace ? (
					<FieldRow code="schedule.liveEndGraceMinutes" hint="下播到重开超过此时长才判定真下播">
						<TNum
							value={schedule.liveEndGraceMinutes}
							onChange={(v) => setS("liveEndGraceMinutes", v)}
							min={1}
							max={10}
							suffix="分钟"
						/>
					</FieldRow>
				) : null}
				<FieldRow code="schedule.quietHours" full>
					<QuietHoursEditor value={schedule.quietHours} onChange={(v) => setS("quietHours", v)} />
				</FieldRow>
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
			<FieldRow code="templates.wordcloudStopWords" full>
				<TArea
					value={templates.wordcloudStopWords}
					onChange={(v) => setT("wordcloudStopWords", v)}
					rows={2}
					mono
					placeholder="例如：哈哈,2333,前面的,主播"
				/>
			</FieldRow>
			<div className="my-3 border-t border-bn-border-subtle" />
			<SummaryVariableHints />
			<FieldRow code="templates.liveSummary" full>
				<TArea
					value={templates.liveSummary}
					onChange={(v) => setT("liveSummary", v)}
					rows={8}
					mono
				/>
			</FieldRow>
		</GlassBox>
	);
}

/**
 * 弹幕词云停用词字段上方的说明条 —— 强调「英文逗号分隔」「追加到内置词表」「仅影响
 * 词云,不影响弹幕计数」,与变量提示条同一视觉语言(青色调,区别于紫色变量提示)。
 */
export function StopWordsHint() {
	return (
		<div
			className="mb-2 rounded-lg border px-3 py-2 text-[11.5px] leading-6 text-bn-text-secondary"
			style={{ borderColor: "#00AEEC66", background: "#00AEEC1a" }}
		>
			<span className="font-bold" style={{ color: "#076e94" }}>
				弹幕词云停用词:
			</span>{" "}
			用<b>英文逗号</b>分隔,这些词会在生成词云时被过滤掉。
			<b>追加</b>到内置中文停用词表之上,不影响弹幕条数 / 发言人数等统计。
		</div>
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
const LIVE_ONGOING_VARS: VarSpec[] = [
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

/** 动态模板已进消息版式:链接是独立部件,{url} 不再出现在变量表(旧模板残留会被剥离)。 */
const DYNAMIC_MSG_VARS: VarSpec[] = [{ code: "{name}", desc: "UP 主名字" }];

const GUARD_VARS: VarSpec[] = [
	{ code: "{uname}", desc: "上舰用户名" },
	{ code: "{mname}", desc: "UP 主名字" },
	{ code: "{guard}", desc: "舰长类别(舰长 / 提督 / 总督)" },
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
function VariableHints({
	vars,
	accent = "var(--color-bn-purple)",
}: {
	vars: ReadonlyArray<VarSpec>;
	accent?: string;
}) {
	const accentBorder = `color-mix(in srgb, ${accent} 40%, transparent)`;
	const accentBg = `color-mix(in srgb, ${accent} 10%, transparent)`;
	const titleColor = sectionTitleColor(accent);
	return (
		<div
			className="mb-2 rounded-lg border px-3 py-2 text-[11.5px] leading-7 text-bn-text-secondary"
			style={{ borderColor: accentBorder, background: accentBg }}
		>
			<span className="font-bold" style={{ color: titleColor }}>
				可用变量:
			</span>{" "}
			{vars.map((v, i) => (
				<span key={v.code}>
					<code className="mx-0.5 rounded-sm bg-bn-surface/70 px-1.5 py-px font-mono text-[11px]">
						{v.code}
					</code>{" "}
					{v.desc}
					{i < vars.length - 1 ? " · " : ""}
				</span>
			))}
		</div>
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
	{ key: "liveOngoing", label: "直播中", code: "templates.liveOngoing", vars: LIVE_ONGOING_VARS },
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
						<FieldRow code={active.code} full>
							<TArea
								key={active.key}
								value={templates[active.key]}
								onChange={(v) => setT(active.key, v)}
								rows={3}
								mono
							/>
						</FieldRow>
					</>
				}
			/>
		</GlassBox>
	);
}

// ── 4b. Dynamic message templates ────────────────────────────────────────────

/** 动态文本 Picker 的两段定义:动态 / 视频投稿共用版式,仅模板文案不同。 */
const DYNAMIC_TEMPLATE_TABS = [
	{ key: "dynamic", label: "动态", code: "templates.dynamic" },
	{ key: "dynamicVideo", label: "视频投稿", code: "templates.dynamicVideo" },
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
	const [tab, setTab] = useState<(typeof DYNAMIC_TEMPLATE_TABS)[number]["key"]>("dynamic");
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
				onChange={(next) => onPatch({ defaults: { messageLayout: { dynamic: next } } })}
				separatorCode="messageLayout.dynamic.separator"
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
						<FieldRow code={active.code} full>
							<TArea
								key={active.key}
								value={templates[active.key]}
								onChange={(v) => setT(active.key, v)}
								rows={2}
								mono
							/>
						</FieldRow>
					</>
				}
			/>
		</GlassBox>
	);
}

// ── 5. Guard (上舰提示) ──────────────────────────────────────────────────────

export function GuardSection({
	templates,
	onPatch,
}: {
	templates: TemplateBundle;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setG = <K extends keyof GuardBundle>(role: K, v: GuardBundle[K]) =>
		onPatch({
			defaults: { templates: { guardBuy: { [role]: v } as Partial<GuardBundle> } },
		});
	const enabled = templates.guardBuy.enable;
	type GuardRoleKey = "captain" | "commander" | "governor";
	const ROLES: { key: GuardRoleKey; label: string; tone: string }[] = [
		{ key: "captain", label: "舰长", tone: "#4ebcec" },
		{ key: "commander", label: "提督", tone: "#d8a0e6" },
		{ key: "governor", label: "总督", tone: "#f2a053" },
	];
	return (
		<GlassBox
			title="上舰提示"
			subtitle="默认走 B 站官方上舰图;启用后改用自定义文案与图片"
			accent={SECTION_ACCENT.guard}
			icon={<Icon.anchor size={14} />}
			badge={enabled ? "已启用" : "未启用"}
			right={<Toggle value={enabled} onChange={(v) => setG("enable", v)} />}
		>
			{enabled ? (
				<>
					<GuardVariableHints />
					{ROLES.map(({ key, label, tone }) => {
						const entry = templates.guardBuy[key];
						return (
							<div
								key={key}
								className="mt-2.5 rounded-lg border p-3 first:mt-0"
								style={{
									background: `color-mix(in srgb, ${tone} 4%, transparent)`,
									borderColor: `color-mix(in srgb, ${tone} 20%, transparent)`,
								}}
							>
								<div className="mb-2 flex items-center gap-2">
									<span className="block h-2 w-2 rounded-sm" style={{ background: tone }} />
									<span className="text-[12.5px] font-bold text-bn-text-primary">{label}</span>
									<code className="ml-1 rounded-sm bg-bn-code-bg px-1.5 py-px font-mono text-[10.5px] text-bn-text-tertiary">
										{key}
									</code>
								</div>
								<FieldRow code="template" full>
									<TInput
										value={entry.template}
										onChange={(v) => setG(key, { ...entry, template: v })}
										mono
									/>
								</FieldRow>
								<FieldRow code="imageUrl" full>
									<TInput
										value={entry.imageUrl}
										onChange={(v) => setG(key, { ...entry, imageUrl: v })}
										mono
										placeholder="https://..."
									/>
								</FieldRow>
							</div>
						);
					})}
				</>
			) : (
				<div className="py-5 text-center text-[12px] text-bn-text-tertiary">
					未启用 · 引擎将默认推送 B 站官方上舰图(舰长 / 提督 / 总督)
				</div>
			)}
		</GlassBox>
	);
}
