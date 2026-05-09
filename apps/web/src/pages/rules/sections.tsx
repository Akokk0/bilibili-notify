/**
 * Rules page sections — bound to live GlobalConfig.defaults shapes. Each
 * section accepts the relevant slice + an `onPatch` that builds a deep-partial
 * delta for /api/globals.
 */

import type { ReactNode } from "react";
import { Toggle } from "../../components/atoms";
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
import type { PushTarget } from "../../types/domain";
import type {
	AppConfig,
	CardStyle,
	ContentFilters,
	GlobalConfigPatch,
	GuardBundle,
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
	| "guard"
	| "specialDanmaku"
	| "specialEnter"
	| "cardStyle"
	| "ai"
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
	const enabled = templates.liveMsgEnabled;
	return (
		<GlassBox
			title="直播消息模板"
			subtitle="开播 / 直播中 / 下播 · 变量：{name} {title} {link} {duration} {watched}"
			accent="#FB7299"
			icon={<Icon.chat size={14} />}
			badge={enabled ? "已启用" : "未启用"}
			right={<Toggle value={enabled} onChange={(v) => setT("liveMsgEnabled", v)} />}
		>
			{enabled ? (
				<>
					<FieldRow label="开播" code="templates.liveStart" full>
						<TArea
							value={templates.liveStart}
							onChange={(v) => setT("liveStart", v)}
							rows={3}
							mono
						/>
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
				</>
			) : (
				<div className="py-5 text-center text-[12px] text-bn-text-tertiary">
					未启用 · 引擎将使用内置直播提示文案
				</div>
			)}
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
			subtitle="默认走 B 站官方上舰图;启用后改用自定义文案与图片 · 变量:{user} {mastername}"
			accent="#f2a053"
			icon={<Icon.anchor size={14} />}
			badge={enabled ? "已启用" : "未启用"}
			right={<Toggle value={enabled} onChange={(v) => setG("enable", v)} />}
		>
			{enabled ? (
				ROLES.map(({ key, label, tone }) => {
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
				})
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
			<FieldRow
				label="动态检查频率"
				code="app.dynamicCron"
				hint="cron 表达式 · 默认 */2 * * * * (每 2 分钟)"
			>
				<TInput
					value={app.dynamicCron}
					onChange={(v) => setApp("dynamicCron", v)}
					mono
					full={false}
				/>
			</FieldRow>

			<FieldRow label="日志等级（全局）" code="app.logLevel" hint="未在下方按模块覆盖时的兜底">
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

			<FieldRow label="User-Agent" code="app.userAgent" hint="留空使用默认;遇 -352 风控可换" full>
				<TInput
					value={app.userAgent ?? ""}
					onChange={(v) => setApp("userAgent", v || undefined)}
					placeholder="留空 = 默认"
					mono
				/>
			</FieldRow>

			<FieldRow
				label="健康检查间隔"
				code="app.healthCheckMinutes"
				hint="rate-limited master 通知的节流窗口"
			>
				<TNum
					value={app.healthCheckMinutes}
					onChange={(v) => setApp("healthCheckMinutes", v)}
					min={1}
					max={1440}
					suffix="min"
				/>
			</FieldRow>

			<FieldRow
				label="历史保留天数"
				code="app.historyRetentionDays"
				hint="到期的 jsonl 日志会被清理"
			>
				<TNum
					value={app.historyRetentionDays}
					onChange={(v) => setApp("historyRetentionDays", v)}
					min={1}
					max={365}
					suffix="天"
				/>
			</FieldRow>

			<div className="mt-3 rounded-lg border border-bn-pink/20 bg-gradient-to-br from-bn-pink/8 to-transparent p-3">
				<div className="mb-1.5 flex items-center justify-between">
					<span className="text-[12.5px] font-bold text-bn-text-primary">主人账号 · master</span>
					<span className="text-[10.5px] text-bn-text-tertiary">
						插件遇错误会私聊报告给这个目标
					</span>
				</div>
				<FieldRow label="Master 推送目标" code="master.targetId">
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
		<FieldRow
			label="按模块覆盖"
			code="app.logLevels"
			hint="留「跟随全局」即用 app.logLevel；改完保存后需重启服务（pino 等级在构造时定型）"
			full
		>
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
