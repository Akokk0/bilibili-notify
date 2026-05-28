/**
 * Rules page sections — bound to live GlobalConfig.defaults shapes. Each
 * section accepts the relevant slice + an `onPatch` that builds a deep-partial
 * delta for /api/globals.
 */

import { type ReactNode, useState } from "react";
import { Toggle } from "../../components/atoms";
import {
	ArrayEditor,
	Field,
	type FieldProps,
	Picker,
	QuietHoursEditor,
	TArea,
	TColor,
	TInput,
	TNum,
	TSelect,
} from "../../components/forms";
import { CollapseBlock, GlassBox } from "../../components/glass-box";
import { Icon } from "../../components/icons";
import type { PushTarget } from "../../types/domain";
import type {
	AppConfig,
	CardStyle,
	ContentFilters,
	GlobalConfigPatch,
	GuardBundle,
	ImageGroupSettings,
	LogLevel,
	MasterConfig,
	ModuleLogLevels,
	ModuleName,
	ScheduleConfig,
	TemplateBundle,
} from "../../types/globals";

export type SectionId =
	| "filter"
	| "live"
	| "summary"
	| "msg"
	| "dynamicMsg"
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
		label: "动态消息模板",
		icon: <Icon.chat size={14} />,
		desc: "动态 / 视频投稿文案",
	},
	{
		id: "live",
		label: "直播阈值",
		icon: <Icon.mic size={14} />,
		desc: "SC 金额 / 上舰等级 / 推送频率",
	},
	{
		id: "summary",
		label: "直播总结模板",
		icon: <Icon.list size={14} />,
		desc: "弹幕变量 / 总结正文",
	},
	{
		id: "msg",
		label: "直播消息模板",
		icon: <Icon.chat size={14} />,
		desc: "开播 / 直播中 / 下播文案",
	},
	{
		id: "guard",
		label: "上舰提示",
		icon: <Icon.anchor size={14} />,
		desc: "舰长 / 提督 / 总督文案与图片",
	},
];

/**
 * per-UP 9 个分类:全局 5 个 + 特别关注弹幕 / 进房 / 卡片样式 / AI 人格塑造。
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
		id: "live",
		label: "直播阈值",
		icon: <Icon.mic size={14} />,
		desc: "覆盖 SC / 上舰 / 频率",
	},
	{
		id: "summary",
		label: "直播总结",
		icon: <Icon.list size={14} />,
		desc: "覆盖总结模板",
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
		id: "cardStyle",
		label: "卡片样式",
		icon: <Icon.sparkle size={14} />,
		desc: "覆盖卡片渐变 / 底板",
	},
	{
		id: "ai",
		label: "AI 人格塑造",
		icon: <Icon.ai size={14} />,
		desc: "覆盖人设 / 口吻 / prompt",
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
			accent="#FB7299"
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
				accent="#FB7299"
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
			accent="#FB7299"
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
			accent="#00AEEC"
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
			title="直播总结模板"
			subtitle="templates.liveSummary · 弹幕情报站文案"
			accent="#a29bfe"
			icon={<Icon.list size={14} />}
			badge="liveSummary"
		>
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

const SUMMARY_VARS: { code: string; desc: string }[] = [
	{ code: "-dmc", desc: "弹幕人数" },
	{ code: "-mdn", desc: "勋章名" },
	{ code: "-dca", desc: "弹幕数" },
	{ code: "-un1~5", desc: "用户名" },
	{ code: "-dc1~5", desc: "弹幕数" },
];

interface VarSpec {
	code: string;
	desc: string;
}

const LIVE_MSG_VARS: VarSpec[] = [
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{link}", desc: "直播间链接(开播 / 直播中)" },
	{ code: "{follower}", desc: "当前粉丝数(开播)" },
	{ code: "{follower_change}", desc: "粉丝变化(下播)" },
	{ code: "{time}", desc: "开播时长 / 已直播时长(直播中、下播)" },
	{ code: "{watched}", desc: "累计观看人数(直播中)" },
];

const DYNAMIC_MSG_VARS: VarSpec[] = [
	{ code: "{name}", desc: "UP 主名字" },
	{ code: "{url}", desc: "动态 / 视频链接(关闭附带 URL 时为空)" },
];

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
 * Single visual style for variable cheat-sheet panels above a template
 * editor. `accent` controls the chip color; defaults to the 紫 used by
 * the original SummaryVariableHints for backward compatibility.
 */
function VariableHints({
	vars,
	accent = "#a29bfe",
	titleColor = "#5b4fcc",
}: {
	vars: ReadonlyArray<VarSpec>;
	accent?: string;
	titleColor?: string;
}) {
	const accentBorder = `${accent}66`;
	const accentBg = `${accent}1a`;
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
					<code className="mx-0.5 rounded bg-white/70 px-1.5 py-px font-mono text-[11px]">
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
	return <VariableHints vars={LIVE_MSG_VARS} accent="#FB7299" titleColor="#b8425d" />;
}

export function DynamicMsgVariableHints() {
	return <VariableHints vars={DYNAMIC_MSG_VARS} accent="#9b6dff" titleColor="#6b46c1" />;
}

export function GuardVariableHints() {
	return <VariableHints vars={GUARD_VARS} accent="#f2a053" titleColor="#a86120" />;
}

export function SpecialDanmakuVariableHints() {
	return <VariableHints vars={SPECIAL_DANMAKU_VARS} accent="#fdcb6e" titleColor="#946800" />;
}

export function SpecialEnterVariableHints() {
	return <VariableHints vars={SPECIAL_ENTER_VARS} accent="#00AEEC" titleColor="#076e94" />;
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
			subtitle="开播 / 直播中 / 下播 三段提醒(改了直接生效)"
			accent="#FB7299"
			icon={<Icon.chat size={14} />}
		>
			<LiveMsgVariableHints />
			<FieldRow code="templates.liveStart" full>
				<TArea value={templates.liveStart} onChange={(v) => setT("liveStart", v)} rows={3} mono />
			</FieldRow>
			<FieldRow code="templates.liveOngoing" full>
				<TArea
					value={templates.liveOngoing}
					onChange={(v) => setT("liveOngoing", v)}
					rows={3}
					mono
				/>
			</FieldRow>
			<FieldRow code="templates.liveEnd" full>
				<TArea value={templates.liveEnd} onChange={(v) => setT("liveEnd", v)} rows={2} mono />
			</FieldRow>
		</GlassBox>
	);
}

// ── 4b. Dynamic message templates ────────────────────────────────────────────

export function DynamicMsgSection({
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
			title="动态消息模板"
			subtitle="动态 / 视频投稿推送文案(无 AI 点评时使用)"
			accent="#9b6dff"
			icon={<Icon.chat size={14} />}
		>
			<DynamicMsgVariableHints />
			<FieldRow code="templates.dynamic" full>
				<TArea value={templates.dynamic} onChange={(v) => setT("dynamic", v)} rows={2} mono />
			</FieldRow>
			<FieldRow code="templates.dynamicVideo" full>
				<TArea
					value={templates.dynamicVideo}
					onChange={(v) => setT("dynamicVideo", v)}
					rows={2}
					mono
				/>
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
			accent="#f2a053"
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
								style={{ background: `${tone}0a`, borderColor: `${tone}33` }}
							>
								<div className="mb-2 flex items-center gap-2">
									<span className="block h-2 w-2 rounded-sm" style={{ background: tone }} />
									<span className="text-[12.5px] font-bold text-bn-text-primary">{label}</span>
									<code className="ml-1 rounded bg-black/5 px-1.5 py-px font-mono text-[10.5px] text-bn-text-tertiary">
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
			<FieldRow code="cardColorStart">
				<TColor value={cardStyle.cardColorStart} onChange={(v) => set("cardColorStart", v)} />
			</FieldRow>
			<FieldRow code="cardColorEnd">
				<TColor value={cardStyle.cardColorEnd} onChange={(v) => set("cardColorEnd", v)} />
			</FieldRow>
			<div className="mt-2 rounded border border-dashed bg-[#a29bfe14] p-2 text-[11px] text-bn-text-secondary">
				per-UP 卡片样式覆盖 → 切换右上 scope 选择 UP 主 → 卡片样式
			</div>
		</GlassBox>
	);
}

// ── 7. Core / App section ────────────────────────────────────────────────────

const LOG_LEVELS: { value: AppConfig["logLevel"]; label: string }[] = [
	{ value: "error", label: "ERROR · 仅错误" },
	{ value: "info", label: "INFO · 推荐" },
	{ value: "debug", label: "DEBUG · 排查" },
];

export function CoreAppSection({
	app,
	master,
	targets,
	onPatch,
}: {
	app: AppConfig;
	master: MasterConfig;
	targets: PushTarget[];
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const setApp = <K extends keyof AppConfig>(key: K, v: AppConfig[K]) => {
		onPatch({ app: { [key]: v } as Partial<AppConfig> });
	};

	const masterTarget = master.targetId ? targets.find((t) => t.id === master.targetId) : undefined;
	const masterStatus = !master.targetId
		? "未配置 · 出错时不会私聊提醒"
		: masterTarget
			? `→ ${masterTarget.name}`
			: "目标已删除,请重新选择";

	return (
		<GlassBox
			title="Core · 应用"
			subtitle="后端运行参数 + Master 主人账号 · 仅这一段在 globals.app / globals.master 下"
			accent="#FB7299"
			icon={<Icon.sparkle size={14} />}
			badge="app + master"
		>
			<FieldRow code="app.dynamicCron">
				<TInput
					value={app.dynamicCron}
					onChange={(v) => setApp("dynamicCron", v)}
					mono
					full={false}
				/>
			</FieldRow>

			<FieldRow code="app.logLevel">
				<TSelect
					value={app.logLevel}
					onChange={(v) => setApp("logLevel", v as AppConfig["logLevel"])}
					options={LOG_LEVELS}
				/>
			</FieldRow>

			<ModuleLogLevelsRow
				levels={app.logLevels}
				fallback={app.logLevel}
				onChange={(next) => setApp("logLevels", next)}
			/>

			<FieldRow code="app.userAgent" full>
				<TInput
					value={app.userAgent ?? ""}
					onChange={(v) => setApp("userAgent", v || undefined)}
					placeholder="留空 = 默认"
					mono
				/>
			</FieldRow>

			<FieldRow code="app.healthCheckMinutes">
				<TNum
					value={app.healthCheckMinutes}
					onChange={(v) => setApp("healthCheckMinutes", v)}
					min={1}
					max={1440}
					suffix="min"
				/>
			</FieldRow>

			<FieldRow code="app.historyRetentionDays">
				<TNum
					value={app.historyRetentionDays}
					onChange={(v) => setApp("historyRetentionDays", v)}
					min={1}
					max={365}
					suffix="天"
				/>
			</FieldRow>

			<div className="mt-3 rounded-lg border border-bn-pink/20 bg-linear-to-br from-bn-pink/8 to-transparent p-3">
				<div className="mb-1.5 flex items-center justify-between">
					<span className="text-[12.5px] font-bold text-bn-text-primary">主人账号 · master</span>
					<span className="text-[10.5px] text-bn-text-tertiary">
						插件遇错误会私聊报告给这个目标
					</span>
				</div>
				<FieldRow code="master.targetId">
					<TSelect
						value={master.targetId ?? ""}
						onChange={(v) => onPatch({ master: { targetId: v || undefined } })}
						options={[
							{ value: "", label: "未配置" },
							...targets.map((t) => ({ value: t.id, label: t.name })),
						]}
					/>
				</FieldRow>
				<div className="mt-1.5 text-[11px] text-bn-text-secondary">{masterStatus}</div>
			</div>
		</GlassBox>
	);
}

// ── ModuleLogLevelsRow — per-engine log level overrides under Core ───────────

const MODULES: ReadonlyArray<{ id: ModuleName; label: string; tone: string }> = [
	{ id: "core", label: "core 核心", tone: "#FB7299" },
	{ id: "dynamic", label: "dynamic 动态", tone: "#00AEEC" },
	{ id: "live", label: "live 直播", tone: "#FF6699" },
	{ id: "image", label: "image 卡片", tone: "#a29bfe" },
	{ id: "ai", label: "ai 智能", tone: "#fdcb6e" },
];

const MODULE_OPTIONS: { value: string; label: string }[] = [
	{ value: "", label: "（跟随全局）" },
	{ value: "error", label: "ERROR" },
	{ value: "info", label: "INFO" },
	{ value: "debug", label: "DEBUG" },
];

function ModuleLogLevelsRow({
	levels,
	fallback,
	onChange,
}: {
	levels: ModuleLogLevels | undefined;
	fallback: LogLevel;
	onChange: (next: ModuleLogLevels | undefined) => void;
}) {
	function setOne(id: ModuleName, value: string): void {
		const current = levels ?? {};
		const next: ModuleLogLevels = { ...current };
		if (!value) delete next[id];
		else next[id] = value as LogLevel;
		onChange(Object.keys(next).length === 0 ? undefined : next);
	}
	return (
		<FieldRow code="app.logLevels" full>
			<div className="grid w-full grid-cols-1 gap-1.5 sm:grid-cols-2">
				{MODULES.map((m) => {
					const current = levels?.[m.id] ?? "";
					return (
						<div
							key={m.id}
							className="flex items-center justify-between gap-2 rounded-md border border-black/5 bg-white/60 px-2.5 py-1.5"
						>
							<span className="flex items-center gap-1.5 text-[12px] font-bold text-bn-text-primary">
								<span
									className="inline-block h-1.5 w-1.5 rounded-full"
									style={{ background: m.tone }}
								/>
								{m.label}
							</span>
							<TSelect value={current} onChange={(v) => setOne(m.id, v)} options={MODULE_OPTIONS} />
						</div>
					);
				})}
			</div>
			<input type="hidden" value={fallback} readOnly />
		</FieldRow>
	);
}
