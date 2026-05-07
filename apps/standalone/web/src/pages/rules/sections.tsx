/**
 * Rules page sections — bound to live GlobalConfig.defaults shapes. Each
 * section accepts the relevant slice + an `onPatch` that builds a deep-partial
 * delta for /api/globals.
 */

import type { ReactNode } from "react";
import {
	ArrayEditor,
	Field,
	type FieldProps,
	TArea,
	TColor,
	TInput,
	TNum,
	TSelect,
} from "../../components/forms";
import { GlassBox } from "../../components/glass-box";
import { Icon } from "../../components/icons";
import type {
	CardStyle,
	ContentFilters,
	GlobalConfigPatch,
	GuardBundle,
	ScheduleConfig,
	TemplateBundle,
} from "../../types/globals";

export type SectionId =
	| "filter"
	| "live"
	| "summary"
	| "msg"
	| "guard"
	| "cardStyle"
	| "specialDanmaku"
	| "specialEnter";

export interface SectionMeta {
	id: SectionId;
	label: string;
	icon: ReactNode;
	desc: string;
}

export const GLOBAL_SECTIONS: SectionMeta[] = [
	{
		id: "filter",
		label: "动态过滤",
		icon: <Icon.filter size={14} />,
		desc: "关键词 / 正则 / 白名单 · defaults.filters",
	},
	{
		id: "live",
		label: "直播阈值",
		icon: <Icon.mic size={14} />,
		desc: "SC / 上舰 / 推送时段 · defaults.{filters,schedule}",
	},
	{
		id: "summary",
		label: "直播总结模板",
		icon: <Icon.list size={14} />,
		desc: "弹幕变量 -dmc / -un1~5 · defaults.templates.liveSummary",
	},
	{
		id: "msg",
		label: "直播消息模板",
		icon: <Icon.chat size={14} />,
		desc: "开播 / 直播中 / 下播 · defaults.templates.live{Start,Ongoing,End}",
	},
	{
		id: "guard",
		label: "上舰提示",
		icon: <Icon.anchor size={14} />,
		desc: "舰长 / 提督 / 总督 · defaults.templates.guardBuy",
	},
	{
		id: "cardStyle",
		label: "卡片样式",
		icon: <Icon.sparkle size={14} />,
		desc: "渐变 / 底板 / 边框 · defaults.cardStyle",
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
	return (
		<GlassBox
			title="动态过滤"
			subtitle="命中黑名单的内容会被静默；白名单内容必发。两者均空 = 不过滤。"
			accent="#FB7299"
			icon={<Icon.filter size={14} />}
			badge="filters"
		>
			<FieldRow label="关键词黑名单" code="blockKeywords" hint="任一命中即过滤；不区分大小写" full>
				<ArrayEditor
					value={value.blockKeywords}
					onChange={(n) => set("blockKeywords", n)}
					placeholder="如：抽奖"
				/>
			</FieldRow>
			<FieldRow label="正则黑名单" code="blockRegex" hint="JavaScript RegExp 字面值" full>
				<ArrayEditor
					value={value.blockRegex}
					onChange={(n) => set("blockRegex", n)}
					placeholder="如：^广告.*"
				/>
			</FieldRow>
			<FieldRow label="关键词白名单" code="whitelistKeywords" hint="非空时仅命中条目会被推送" full>
				<ArrayEditor
					value={value.whitelistKeywords}
					onChange={(n) => set("whitelistKeywords", n)}
					placeholder="如：开播"
				/>
			</FieldRow>
			<FieldRow label="正则白名单" code="whitelistRegex" full>
				<ArrayEditor value={value.whitelistRegex} onChange={(n) => set("whitelistRegex", n)} />
			</FieldRow>
			<FieldRow label="屏蔽转发动态" code="blockForward">
				<TSelect
					value={value.blockForward ? "true" : "false"}
					onChange={(v) => set("blockForward", v === "true")}
					options={[
						{ value: "false", label: "不屏蔽" },
						{ value: "true", label: "屏蔽" },
					]}
				/>
			</FieldRow>
			<FieldRow label="屏蔽专栏" code="blockArticle">
				<TSelect
					value={value.blockArticle ? "true" : "false"}
					onChange={(v) => set("blockArticle", v === "true")}
					options={[
						{ value: "false", label: "不屏蔽" },
						{ value: "true", label: "屏蔽" },
					]}
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
			title="直播阈值与调度"
			subtitle="SC / 上舰阈值，启动时是否补推，每日推送窗口"
			accent="#00AEEC"
			icon={<Icon.mic size={14} />}
			badge="live"
		>
			<FieldRow label="SC 最小金额" code="minScPrice" hint="低于该价位的 SC 不推送（元）">
				<TNum
					value={filters.minScPrice}
					onChange={(v) => setF("minScPrice", v)}
					min={0}
					max={9999}
					suffix="¥"
				/>
			</FieldRow>
			<FieldRow label="上舰最低等级" code="minGuardLevel" hint="1=总督 / 2=提督 / 3=舰长">
				<TSelect
					value={String(filters.minGuardLevel) as "1" | "2" | "3"}
					onChange={(v) => setF("minGuardLevel", Number(v) as 1 | 2 | 3)}
					options={[
						{ value: "3", label: "舰长（含以上）" },
						{ value: "2", label: "提督（含以上）" },
						{ value: "1", label: "仅总督" },
					]}
				/>
			</FieldRow>
			<FieldRow label="启动补推" code="restartPush" hint="开启后会回放重启期间错过的开播事件">
				<TSelect
					value={schedule.restartPush ? "true" : "false"}
					onChange={(v) => setS("restartPush", v === "true")}
					options={[
						{ value: "false", label: "关" },
						{ value: "true", label: "开" },
					]}
				/>
			</FieldRow>
			<FieldRow label="推送时段开始" code="schedule.pushTime" hint="0 = 全天">
				<TNum
					value={schedule.pushTime}
					onChange={(v) => setS("pushTime", v)}
					min={0}
					max={23}
					suffix="时"
				/>
			</FieldRow>
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
			title="直播总结模板"
			subtitle="支持变量：{summary} {duration} {watched} {follower}"
			accent="#a29bfe"
			icon={<Icon.list size={14} />}
			badge="liveSummary"
		>
			<FieldRow label="总结正文" code="templates.liveSummary" hint="按行展开；保留换行" full>
				<TArea
					value={templates.liveSummary}
					onChange={(v) => setT("liveSummary", v)}
					rows={6}
					mono
				/>
			</FieldRow>
			<FieldRow label="特别关注弹幕" code="templates.specialDanmaku" full>
				<TInput value={templates.specialDanmaku} onChange={(v) => setT("specialDanmaku", v)} mono />
			</FieldRow>
			<FieldRow label="特别关注进房" code="templates.specialUserEnter" full>
				<TInput
					value={templates.specialUserEnter}
					onChange={(v) => setT("specialUserEnter", v)}
					mono
				/>
			</FieldRow>
		</GlassBox>
	);
}

// ── 4. Live message templates ────────────────────────────────────────────────

export function LiveMsgSection({
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
			title="直播消息模板"
			subtitle="开播 / 直播中 / 下播 · 变量：{name} {title} {link} {duration} {watched}"
			accent="#FB7299"
			icon={<Icon.chat size={14} />}
			badge="templates"
		>
			<FieldRow label="开播" code="templates.liveStart" full>
				<TArea value={templates.liveStart} onChange={(v) => setT("liveStart", v)} rows={3} mono />
			</FieldRow>
			<FieldRow label="直播中" code="templates.liveOngoing" full>
				<TArea
					value={templates.liveOngoing}
					onChange={(v) => setT("liveOngoing", v)}
					rows={3}
					mono
				/>
			</FieldRow>
			<FieldRow label="下播" code="templates.liveEnd" full>
				<TArea value={templates.liveEnd} onChange={(v) => setT("liveEnd", v)} rows={2} mono />
			</FieldRow>
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
	const ROLES: { key: keyof GuardBundle; label: string; tone: string }[] = [
		{ key: "captain", label: "舰长", tone: "#4ebcec" },
		{ key: "commander", label: "提督", tone: "#d8a0e6" },
		{ key: "governor", label: "总督", tone: "#f2a053" },
	];
	return (
		<GlassBox
			title="上舰提示"
			subtitle="变量：{user} {mastername}"
			accent="#f2a053"
			icon={<Icon.anchor size={14} />}
			badge="guardBuy"
		>
			{ROLES.map(({ key, label, tone }) => {
				const entry = templates.guardBuy[key];
				return (
					<div
						key={key}
						className="mt-2.5 rounded-lg border p-3 first:mt-0"
						style={{ background: `${tone}0a`, borderColor: `${tone}33` }}
					>
						<div className="mb-2 flex items-center gap-2">
							<span className="block h-2 w-2 rounded-sm" style={{ background: tone }} />
							<span className="text-[12.5px] font-bold text-bn-text-primary">{label}</span>
							<code className="ml-1 rounded bg-black/5 px-1.5 py-px font-mono text-[10.5px] text-bn-text-tertiary">
								{key}
							</code>
						</div>
						<FieldRow label="文案" code="template" full>
							<TInput
								value={entry.template}
								onChange={(v) => setG(key, { ...entry, template: v })}
								mono
							/>
						</FieldRow>
						<FieldRow label="图片 URL" code="imageUrl" full>
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
		</GlassBox>
	);
}

// ── 6. Card style (also rendered on /cards but reused here for parity) ──────

export function CardStyleSection({
	cardStyle,
	onPatch,
}: {
	cardStyle: CardStyle;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const set = <K extends keyof CardStyle>(k: K, v: CardStyle[K]) =>
		onPatch({ defaults: { cardStyle: { [k]: v } as Partial<CardStyle> } });
	return (
		<GlassBox
			title="卡片样式"
			subtitle="image 渲染卡片的渐变 / 底板"
			accent="#a29bfe"
			icon={<Icon.sparkle size={14} />}
			badge="cardStyle"
		>
			<FieldRow label="渐变起始" code="cardColorStart">
				<TColor value={cardStyle.cardColorStart} onChange={(v) => set("cardColorStart", v)} />
			</FieldRow>
			<FieldRow label="渐变结束" code="cardColorEnd">
				<TColor value={cardStyle.cardColorEnd} onChange={(v) => set("cardColorEnd", v)} />
			</FieldRow>
			<FieldRow label="底板颜色" code="cardBasePlateColor">
				<TColor
					value={cardStyle.cardBasePlateColor}
					onChange={(v) => set("cardBasePlateColor", v)}
				/>
			</FieldRow>
			<FieldRow label="底板边框" code="cardBasePlateBorder">
				<TColor
					value={cardStyle.cardBasePlateBorder}
					onChange={(v) => set("cardBasePlateBorder", v)}
				/>
			</FieldRow>
			<div className="mt-2 rounded border border-dashed bg-[#a29bfe14] p-2 text-[11px] text-bn-text-secondary">
				per-UP 卡片样式覆盖 → 切换右上 scope 选择 UP 主 → 卡片样式
			</div>
		</GlassBox>
	);
}
