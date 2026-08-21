/**
 * Per-UP overrides editor — Subscription.overrides + Subscription.specialUsers
 * bound to /api/subs PATCH.
 *
 * Each override family is gated by a "覆盖全局" toggle. Off → undefined
 * (inherit). On → seeded with the corresponding global default so the user
 * starts editing from a real baseline rather than empty fields.
 *
 * Driven by a `section` prop from the parent so only ONE section box renders
 * at a time — matching the design's "侧栏选 section · 主体只看一项" pattern.
 */

import { resolveAIProfile } from "@bilibili-notify/internal/constants";
import { Avatar, CollapseBlock, GlassBox, Icon, Toggle } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
	ArrayEditor,
	Field,
	Picker,
	QuietHoursEditor,
	TArea,
	TInput,
	TNum,
} from "../../components/forms";
import { AI_PURPLE } from "../../config/colors";
import { useDirtyDraft } from "../../hooks/useDirtyDraft";
import { api } from "../../services/api";
import type {
	AIOverride,
	ContentFiltersOverride,
	ImageGroupOverride,
	MessageLayoutOverride,
	OverridesShape,
	ScheduleOverride,
	SpecialUser,
	Subscription,
	TemplateOverride,
} from "../../types/domain";
import type {
	GlobalDefaults,
	GuardEntry,
	ImageGroupSettings,
	TemplateBundle,
} from "../../types/globals";
import { colorFromUid, displayName } from "../up/helpers";
import { MessageLayoutEditor } from "./MessageLayoutEditor";
import { buildOverridesPatch, type OverridesPatch } from "./overrides-patch";
import { projectPerUpIsland } from "./perup-island";
import {
	FILTER_CONTENT_KEYS,
	hasAiPersonaOverride,
	hasFilterContentOverride,
	hasLiveThresholdOverride,
} from "./section-scope";
import {
	DynamicMsgVariableHints,
	GuardVariableHints,
	LiveMsgVariableHints,
	type SectionId,
	SpecialDanmakuVariableHints,
	SpecialEnterVariableHints,
	StopWordsHint,
	SummaryVariableHints,
} from "./sections";

/* -------------------------------------------------------------------------- */

/**
 * Override 切片名;Rules.tsx 用它判定 sub 是否"已定制"。
 * cardStyle / cardLayout 不在此列 —— 卡片相关覆盖已统一迁到 /cards 页编辑,
 * 由 Cards 自管 tab 与计数,Rules 不再surface 卡片定制。
 */
export const perUpOverrideKeys = [
	"filters",
	"schedule",
	"templates",
	"ai",
	"imageGroup",
	"messageLayout",
] as const;
export type PerUpOverrideKey = (typeof perUpOverrideKeys)[number];

interface SubPatch {
	// overrides 走清除哨兵线格式:被关闭的 slice 显式 null(见 buildOverridesPatch / store SY1)。
	overrides?: OverridesPatch;
	specialUsers?: SpecialUser[];
}

function patchSub(id: string, body: SubPatch) {
	return api.patch<Subscription>(`/api/subs/${id}`, body);
}

/* -------------------------------------------------------------------------- */

export interface PerUpEditorProps {
	sub: Subscription;
	defaults: GlobalDefaults;
	section: SectionId;
}

interface PerUpDraft {
	overrides: Subscription["overrides"];
	specialUsers: SpecialUser[];
}

export function PerUpEditor({ sub, defaults, section }: PerUpEditorProps) {
	const qc = useQueryClient();
	const [draft, setDraft] = useState<PerUpDraft>({
		overrides: sub.overrides,
		specialUsers: sub.specialUsers,
	});

	useEffect(() => {
		setDraft({ overrides: sub.overrides, specialUsers: sub.specialUsers });
	}, [sub.overrides, sub.specialUsers]);

	const save = useMutation({
		mutationFn: () =>
			patchSub(sub.id, {
				// 关闭的覆盖 slice 需显式 null 清除,否则 deepMerge 当「不改」→ 旧值残留、diff 不归零。
				overrides: buildOverridesPatch(draft.overrides, sub.overrides),
				specialUsers: draft.specialUsers,
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	function discard(): void {
		setDraft({ overrides: sub.overrides, specialUsers: sub.specialUsers });
	}

	// per-UP 草稿接入灵动岛:draft / sub 同款投影成扁平 code 结构,walkTreeDiff 出的
	// code 对齐 FIELD_LABELS(section 分组 / 跳转锚点),详见 perup-island.ts。保存 /
	// 丢弃统一由灵动岛触发,不再走页内按钮;保存失败时 mutateAsync reject →
	// useDirtyDraft 捕获并切 error 态展示在灵动岛。
	const islandDraft = useMemo(
		() => projectPerUpIsland(draft.overrides, draft.specialUsers),
		[draft],
	);
	const islandBaseline = useMemo(
		() => projectPerUpIsland(sub.overrides, sub.specialUsers),
		[sub.overrides, sub.specialUsers],
	);
	useDirtyDraft({
		pageKey: "rules-perup",
		pageLabel: `${displayName(sub)} · 覆盖`,
		draft: islandDraft,
		baseline: islandBaseline,
		onSave: () => save.mutateAsync(),
		onDiscard: discard,
	});

	function setSlice<K extends keyof OverridesShape>(
		key: K,
		value: OverridesShape[K] | undefined,
	): void {
		setDraft((d) => {
			const next: Subscription["overrides"] = { ...d.overrides };
			if (value === undefined) delete next[key];
			else next[key] = value;
			return { ...d, overrides: next };
		});
	}

	function setSpecialUsers(next: SpecialUser[]): void {
		setDraft((d) => ({ ...d, specialUsers: next }));
	}

	const color = colorFromUid(sub.uid);

	return (
		<div className="space-y-4">
			<div
				className="bn-glass flex items-center gap-3 rounded-bn-card p-4 shadow-bn-card"
				style={{
					background: `linear-gradient(135deg, color-mix(in srgb, ${color} 13%, transparent), var(--bn-glass-bg))`,
					borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
				}}
			>
				<Avatar
					name={displayName(sub)}
					color={color}
					size={48}
					url={sub.cachedProfile?.avatar}
					ring
				/>
				<div className="min-w-0 flex-1">
					<div className="text-base font-bold text-bn-text-primary">{displayName(sub)}</div>
					<div className="text-[12px] text-bn-text-secondary">
						UID {sub.uid} · 关闭一个分组 = 恢复继承全局默认
					</div>
				</div>
			</div>

			{section === "filter" ? (
				<FilterOverrideBox
					value={draft.overrides.filters}
					onChange={(v) => setSlice("filters", v)}
					baseline={defaults.filters}
				/>
			) : null}
			{section === "live" ? (
				<LiveOverrideBox
					filters={draft.overrides.filters}
					schedule={draft.overrides.schedule}
					onFilters={(v) => setSlice("filters", v)}
					onSchedule={(v) => setSlice("schedule", v)}
					baselineFilters={defaults.filters}
					baselineSchedule={defaults.schedule}
				/>
			) : null}
			{section === "summary" ? (
				<SummaryOverrideBox
					value={draft.overrides.templates}
					onChange={(v) => setSlice("templates", v)}
					baseline={defaults.templates}
				/>
			) : null}
			{section === "msg" ? (
				<MsgOverrideBox
					value={draft.overrides.templates}
					onChange={(v) => setSlice("templates", v)}
					baseline={defaults.templates}
				/>
			) : null}
			{section === "dynamicMsg" ? (
				<DynamicMsgOverrideBox
					value={draft.overrides.templates}
					onChange={(v) => setSlice("templates", v)}
					baseline={defaults.templates}
				/>
			) : null}
			{section === "messageLayout" ? (
				<MessageLayoutOverrideBox
					value={draft.overrides.messageLayout}
					onChange={(v) => setSlice("messageLayout", v)}
					baseline={defaults.messageLayout}
				/>
			) : null}
			{section === "guard" ? (
				<GuardOverrideBox
					value={draft.overrides.templates}
					onChange={(v) => setSlice("templates", v)}
					baseline={defaults.templates}
				/>
			) : null}
			{section === "specialDanmaku" ? (
				<SpecialUserBox
					kind="danmaku"
					title="特别关注弹幕"
					subtitle="UID 进入直播间时弹幕高亮 · specialUsers + overrides.templates.specialDanmaku"
					accent="#fdcb6e"
					icon={<Icon.star size={14} />}
					users={draft.specialUsers}
					onUsersChange={setSpecialUsers}
					template={draft.overrides.templates}
					onTemplateChange={(v) => setSlice("templates", v)}
					baselineTemplate={defaults.templates.specialDanmaku}
					templateField="specialDanmaku"
				/>
			) : null}
			{section === "specialEnter" ? (
				<SpecialUserBox
					kind="enter"
					title="特别关注进房"
					subtitle="特定 UID 进入直播间时单独提醒 · specialUsers + overrides.templates.specialUserEnter"
					accent="#00AEEC"
					icon={<Icon.user size={14} />}
					users={draft.specialUsers}
					onUsersChange={setSpecialUsers}
					template={draft.overrides.templates}
					onTemplateChange={(v) => setSlice("templates", v)}
					baselineTemplate={defaults.templates.specialUserEnter}
					templateField="specialUserEnter"
				/>
			) : null}
			{section === "ai" ? (
				<AiOverrideBox
					value={draft.overrides.ai}
					onChange={(v) => setSlice("ai", v)}
					baseline={defaults.ai}
				/>
			) : null}
			{section === "imageGroup" ? (
				<ImageGroupOverrideBox
					value={draft.overrides.imageGroup}
					onChange={(v) => setSlice("imageGroup", v)}
					baseline={defaults.imageGroup}
				/>
			) : null}
		</div>
	);
}

/**
 * 关闭态下方一行说明文字 —— 与设计稿"未启用 · xx 将继承全局 xx 规则"一致。
 */
function InheritHint({ children }: { children: React.ReactNode }) {
	return (
		<div className="py-5 text-center text-[12px] text-bn-text-tertiary">未启用 · {children}</div>
	);
}

/* -------- Filters --------------------------------------------------------- */

function FilterOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: ContentFiltersOverride | undefined;
	onChange: (next: ContentFiltersOverride | undefined) => void;
	baseline: GlobalDefaults["filters"];
}) {
	const enabled = hasFilterContentOverride(value);
	const cur = value ?? {};
	const get = <K extends keyof typeof baseline>(k: K) =>
		(cur[k] ?? baseline[k]) as (typeof baseline)[K];
	function set<K extends keyof typeof baseline>(k: K, v: (typeof baseline)[K]): void {
		onChange({ ...cur, [k]: v });
	}
	function toggle(on: boolean): void {
		if (on) {
			onChange({
				...cur,
				blockKeywords: baseline.blockKeywords,
				blockRegex: baseline.blockRegex,
				whitelistKeywords: baseline.whitelistKeywords,
				whitelistRegex: baseline.whitelistRegex,
				blockForward: baseline.blockForward,
				blockArticle: baseline.blockArticle,
				blockDraw: baseline.blockDraw,
				blockAv: baseline.blockAv,
			});
		} else {
			const next = { ...cur };
			for (const k of FILTER_CONTENT_KEYS) delete next[k];
			onChange(Object.keys(next).length > 0 ? next : undefined);
		}
	}
	return (
		<GlassBox
			title="动态过滤覆盖"
			subtitle="开 = 该 UP 使用自定义关键词 / 正则 / 屏蔽开关;关 = 继承全局过滤"
			accent="#FB7299"
			icon={<Icon.filter size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<>
					<Field code="blockKeywords" full>
						<ArrayEditor value={get("blockKeywords")} onChange={(n) => set("blockKeywords", n)} />
					</Field>
					<Field code="blockRegex" full>
						<ArrayEditor value={get("blockRegex")} onChange={(n) => set("blockRegex", n)} />
					</Field>
					<Field code="whitelistKeywords" full>
						<ArrayEditor
							value={get("whitelistKeywords")}
							onChange={(n) => set("whitelistKeywords", n)}
						/>
					</Field>
					<div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
						<Field code="blockForward">
							<div className="flex h-7.5 items-center">
								<Toggle
									value={get("blockForward")}
									onChange={(v) => set("blockForward", v)}
									size="sm"
								/>
							</div>
						</Field>
						<Field code="blockArticle">
							<div className="flex h-7.5 items-center">
								<Toggle
									value={get("blockArticle")}
									onChange={(v) => set("blockArticle", v)}
									size="sm"
								/>
							</div>
						</Field>
						<Field code="blockDraw">
							<div className="flex h-7.5 items-center">
								<Toggle value={get("blockDraw")} onChange={(v) => set("blockDraw", v)} size="sm" />
							</div>
						</Field>
						<Field code="blockAv">
							<div className="flex h-7.5 items-center">
								<Toggle value={get("blockAv")} onChange={(v) => set("blockAv", v)} size="sm" />
							</div>
						</Field>
					</div>
				</>
			) : (
				<InheritHint>该 UP 将继承全局动态过滤规则</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- Live thresholds (filters.minScPrice/minGuardLevel + schedule) -- */

function LiveOverrideBox({
	filters,
	schedule,
	onFilters,
	onSchedule,
	baselineFilters,
	baselineSchedule,
}: {
	filters: ContentFiltersOverride | undefined;
	schedule: ScheduleOverride | undefined;
	onFilters: (next: ContentFiltersOverride | undefined) => void;
	onSchedule: (next: ScheduleOverride | undefined) => void;
	baselineFilters: GlobalDefaults["filters"];
	baselineSchedule: GlobalDefaults["schedule"];
}) {
	const enabled = hasLiveThresholdOverride({ filters, schedule });
	const fCur = filters ?? {};
	const sCur = schedule ?? {};
	function toggle(on: boolean): void {
		if (on) {
			onFilters({
				...fCur,
				minScPrice: baselineFilters.minScPrice,
				minGuardLevel: baselineFilters.minGuardLevel,
			});
			onSchedule({ ...baselineSchedule });
		} else {
			// 只清阈值域两个字段,保留可能由 FilterOverrideBox 写入的过滤域字段。
			const { minScPrice: _s, minGuardLevel: _g, ...rest } = fCur;
			onFilters(Object.keys(rest).length > 0 ? rest : undefined);
			onSchedule(undefined);
		}
	}
	return (
		<GlassBox
			title="直播阈值覆盖"
			subtitle="开 = 该 UP 使用自定义 SC / 上舰 / 推送频率;关 = 继承全局直播阈值"
			accent="#FF6699"
			icon={<Icon.mic size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
					<Field code="minScPrice">
						<TNum
							value={fCur.minScPrice ?? baselineFilters.minScPrice}
							onChange={(v) => onFilters({ ...fCur, minScPrice: v })}
							min={0}
							suffix="元"
						/>
					</Field>
					<Field code="minGuardLevel">
						<Picker<1 | 2 | 3>
							value={fCur.minGuardLevel ?? baselineFilters.minGuardLevel}
							onChange={(v) => onFilters({ ...fCur, minGuardLevel: v })}
							options={[
								{ value: 3, label: "舰长" },
								{ value: 2, label: "提督" },
								{ value: 1, label: "总督" },
							]}
						/>
					</Field>
					<Field code="schedule.pushTime">
						<TNum
							value={sCur.pushTime ?? baselineSchedule.pushTime}
							onChange={(v) => onSchedule({ ...sCur, pushTime: v })}
							min={0}
							max={23}
							suffix="小时"
						/>
					</Field>
					<Field code="schedule.restartPush">
						<div className="flex h-7.5 items-center">
							<Toggle
								value={sCur.restartPush ?? baselineSchedule.restartPush}
								onChange={(v) => onSchedule({ ...sCur, restartPush: v })}
								size="sm"
							/>
						</div>
					</Field>
					<Field code="schedule.liveEndGrace" hint="覆盖断流接续:下播先延迟判定">
						<div className="flex h-7.5 items-center">
							<Toggle
								value={sCur.liveEndGrace ?? baselineSchedule.liveEndGrace}
								onChange={(v) => onSchedule({ ...sCur, liveEndGrace: v })}
								size="sm"
							/>
						</div>
					</Field>
					{(sCur.liveEndGrace ?? baselineSchedule.liveEndGrace) ? (
						<Field code="schedule.liveEndGraceMinutes">
							<TNum
								value={sCur.liveEndGraceMinutes ?? baselineSchedule.liveEndGraceMinutes}
								onChange={(v) => onSchedule({ ...sCur, liveEndGraceMinutes: v })}
								min={1}
								max={10}
								suffix="分钟"
							/>
						</Field>
					) : null}
					<Field code="schedule.quietHours" hint="该 UP 在此区间内的推送一律丢弃(覆盖全局)" full>
						<QuietHoursEditor
							value={sCur.quietHours ?? baselineSchedule.quietHours}
							onChange={(v) => onSchedule({ ...sCur, quietHours: v })}
						/>
					</Field>
				</div>
			) : (
				<InheritHint>该 UP 将继承全局直播阈值与调度</InheritHint>
			)}
		</GlassBox>
	);
}

/* ----- Summary section (overrides.templates.{wordcloudStopWords,liveSummary}) ----- */

/**
 * 「直播总结」per-UP 覆盖框 —— 总开关 + 总结正文二级开关。
 *
 * 总开关(与其它覆盖项一致)= 是否覆盖本段:关 → 两键全清、整段继承全局;开 → seed
 * 停用词为 baseline(=当前全局值,直接显示),总结正文另由内部二级 CollapseBlock 单独
 * 控制。停用词短、随总开关直接可见;总结正文长,折进二级开关,层级清爽。
 *
 * seed 用 baseline(全局值)而非空串:故「开了但没动」== 等同继承(merge 后 eff === 全局
 * 值,无副作用);用户改谁谁生效,语义与其它模板覆盖一致(覆盖即钉住快照、不跟随全局热更)。
 */
function SummaryOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: TemplateOverride | undefined;
	onChange: (next: TemplateOverride | undefined) => void;
	baseline: GlobalDefaults["templates"];
}) {
	const cur = value ?? {};
	const enabled = cur.liveSummary !== undefined || cur.wordcloudStopWords !== undefined;
	const summaryOn = cur.liveSummary !== undefined;

	function toggle(on: boolean): void {
		if (on) {
			onChange({ ...cur, wordcloudStopWords: baseline.wordcloudStopWords });
		} else {
			const { wordcloudStopWords: _w, liveSummary: _l, ...rest } = cur;
			onChange(Object.keys(rest).length > 0 ? rest : undefined);
		}
	}
	function toggleSummary(on: boolean): void {
		if (on) onChange({ ...cur, liveSummary: baseline.liveSummary });
		else {
			const { liveSummary: _l, ...rest } = cur;
			onChange(Object.keys(rest).length > 0 ? rest : undefined);
		}
	}

	return (
		<GlassBox
			title="直播总结覆盖"
			subtitle="开 = 该 UP 自定义弹幕词云停用词;总结正文由内部二级开关控制;关 = 全部继承全局"
			accent="#a29bfe"
			icon={<Icon.list size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<>
					<StopWordsHint />
					<Field code="templates.wordcloudStopWords" full>
						<TArea
							value={cur.wordcloudStopWords ?? baseline.wordcloudStopWords}
							onChange={(v) => onChange({ ...cur, wordcloudStopWords: v })}
							rows={2}
							mono
							placeholder="例如：哈哈,2333,前面的"
						/>
					</Field>
					<div className="my-3 border-t border-bn-border-subtle" />
					<CollapseBlock
						label="自定义直播总结正文 · 仅本 UP"
						enabled={summaryOn}
						onToggle={toggleSummary}
						accent="#a29bfe"
					>
						<SummaryVariableHints />
						<Field code="templates.liveSummary" full>
							<TArea
								value={cur.liveSummary ?? baseline.liveSummary}
								onChange={(v) => onChange({ ...cur, liveSummary: v })}
								rows={8}
								mono
							/>
						</Field>
					</CollapseBlock>
				</>
			) : (
				<InheritHint>该 UP 将继承全局弹幕词云停用词与直播总结模板</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- Msg templates (liveStart / liveOngoing / liveEnd) ------------- */

function MsgOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: TemplateOverride | undefined;
	onChange: (next: TemplateOverride | undefined) => void;
	baseline: GlobalDefaults["templates"];
}) {
	// 无 enable flag(与动态模板一致):有 liveStart/liveOngoing/liveEnd 任一覆盖即「覆盖中」。
	const enabled =
		value?.liveStart !== undefined ||
		value?.liveOngoing !== undefined ||
		value?.liveEnd !== undefined;
	const cur = value ?? {};
	function set<K extends "liveStart" | "liveOngoing" | "liveEnd">(k: K, v: string): void {
		onChange({ ...cur, [k]: v });
	}
	function toggle(on: boolean): void {
		if (on) {
			onChange({
				...cur,
				liveStart: cur.liveStart ?? baseline.liveStart,
				liveOngoing: cur.liveOngoing ?? baseline.liveOngoing,
				liveEnd: cur.liveEnd ?? baseline.liveEnd,
			});
		} else {
			const { liveStart: _a, liveOngoing: _b, liveEnd: _c, ...rest } = cur;
			onChange(Object.keys(rest).length > 0 ? rest : undefined);
		}
	}
	return (
		<GlassBox
			title="直播消息覆盖"
			subtitle="开 = 该 UP 使用自定义开播 / 直播中 / 下播文案;关 = 继承全局"
			accent="#FB7299"
			icon={<Icon.chat size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<>
					<LiveMsgVariableHints />
					<Field code="templates.liveStart" full>
						<TArea
							value={cur.liveStart ?? baseline.liveStart}
							onChange={(v) => set("liveStart", v)}
							rows={3}
							mono
						/>
					</Field>
					<Field code="templates.liveOngoing" full>
						<TArea
							value={cur.liveOngoing ?? baseline.liveOngoing}
							onChange={(v) => set("liveOngoing", v)}
							rows={3}
							mono
						/>
					</Field>
					<Field code="templates.liveEnd" full>
						<TArea
							value={cur.liveEnd ?? baseline.liveEnd}
							onChange={(v) => set("liveEnd", v)}
							rows={2}
							mono
						/>
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将继承全局直播消息模板</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- Dynamic msg (overrides.templates.dynamic / dynamicVideo) -------- */

function DynamicMsgOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: TemplateOverride | undefined;
	onChange: (next: TemplateOverride | undefined) => void;
	baseline: GlobalDefaults["templates"];
}) {
	// 无 enable flag —— 动态推送总会发;有 dynamic / dynamicVideo 任一覆盖即「覆盖中」。
	const enabled = value?.dynamic !== undefined || value?.dynamicVideo !== undefined;
	const cur = value ?? {};
	function set<K extends "dynamic" | "dynamicVideo">(k: K, v: string): void {
		onChange({ ...cur, [k]: v });
	}
	function toggle(on: boolean): void {
		if (on) {
			onChange({
				...cur,
				dynamic: cur.dynamic ?? baseline.dynamic,
				dynamicVideo: cur.dynamicVideo ?? baseline.dynamicVideo,
			});
		} else {
			const { dynamic: _a, dynamicVideo: _b, ...rest } = cur;
			onChange(Object.keys(rest).length > 0 ? rest : undefined);
		}
	}
	return (
		<GlassBox
			title="动态消息覆盖"
			subtitle="开 = 该 UP 使用自定义动态 / 视频投稿文案;关 = 继承全局"
			accent="#9b6dff"
			icon={<Icon.chat size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<>
					<DynamicMsgVariableHints />
					<Field code="templates.dynamic" full>
						<TArea
							value={cur.dynamic ?? baseline.dynamic}
							onChange={(v) => set("dynamic", v)}
							rows={2}
							mono
						/>
					</Field>
					<Field code="templates.dynamicVideo" full>
						<TArea
							value={cur.dynamicVideo ?? baseline.dynamicVideo}
							onChange={(v) => set("dynamicVideo", v)}
							rows={2}
							mono
						/>
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将继承全局动态消息模板</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- Message layout (overrides.messageLayout, 整份覆盖) --------------- */

function MessageLayoutOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: MessageLayoutOverride | undefined;
	onChange: (next: MessageLayoutOverride | undefined) => void;
	baseline: GlobalDefaults["messageLayout"];
}) {
	const enabled = value !== undefined;
	const cur = value ?? baseline;
	return (
		<GlassBox
			title="消息版式覆盖"
			subtitle="开 = 该 UP 使用自定义部件排列 / 分条 / 分隔符(动态 + 直播两套);关 = 继承全局"
			accent="#9b6dff"
			icon={<Icon.list size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={
				<Toggle
					value={enabled}
					onChange={(on) => onChange(on ? structuredClone(baseline) : undefined)}
				/>
			}
		>
			{enabled ? (
				<>
					<div className="mb-2 text-[12.5px] font-bold text-bn-text-primary">动态消息版式</div>
					<MessageLayoutEditor
						value={cur.dynamic}
						onChange={(next) => onChange({ ...cur, dynamic: next })}
						separatorCode="messageLayout.dynamic.separator"
						accent="#9b6dff"
					/>
					<div className="my-3 border-t border-bn-border-subtle" />
					<div className="mb-2 text-[12.5px] font-bold text-bn-text-primary">直播消息版式</div>
					<MessageLayoutEditor
						value={cur.live}
						onChange={(next) => onChange({ ...cur, live: next })}
						separatorCode="messageLayout.live.separator"
						accent="#FB7299"
					/>
					<div className="mt-2 text-[11px] text-bn-text-tertiary">
						文案模板的 per-UP 覆盖在「动态消息」/「直播消息」分类;此处只覆盖结构。
					</div>
				</>
			) : (
				<InheritHint>该 UP 将继承全局消息版式(部件排列 / 分条 / 分隔符)</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- Guard (overrides.templates.guardBuy) ---------------------------- */

function GuardOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: TemplateOverride | undefined;
	onChange: (next: TemplateOverride | undefined) => void;
	baseline: GlobalDefaults["templates"];
}) {
	// 覆盖语义:开 = 该 UP 强制启用自定义上舰文案/图片(guardBuy.enable=true);关 = 继承全局决定。
	const enabled = value?.guardBuy?.enable === true;
	const cur = value ?? {};
	type GuardRole = "captain" | "commander" | "governor";
	const guardOf = (role: GuardRole): GuardEntry => cur.guardBuy?.[role] ?? baseline.guardBuy[role];
	function setGuard(role: GuardRole, entry: GuardEntry): void {
		onChange({
			...cur,
			guardBuy: { ...(cur.guardBuy ?? baseline.guardBuy), [role]: entry },
		});
	}
	function toggle(on: boolean): void {
		if (on) {
			onChange({ ...cur, guardBuy: { ...baseline.guardBuy, enable: true } });
		} else {
			const { guardBuy: _g, ...rest } = cur;
			onChange(Object.keys(rest).length > 0 ? rest : undefined);
		}
	}
	return (
		<GlassBox
			title="上舰提示覆盖"
			subtitle="开 = 该 UP 强制使用自定义文案 / 图片;关 = 继承全局(默认 B 站官方上舰图)"
			accent="#f2a053"
			icon={<Icon.anchor size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<>
					<GuardVariableHints />
					<div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
						{(["captain", "commander", "governor"] as const).map((role) => {
							const e = guardOf(role);
							const label = role === "captain" ? "舰长" : role === "commander" ? "提督" : "总督";
							return (
								<div
									key={role}
									className="rounded-lg border border-bn-border bg-bn-surface/70 p-2.5"
								>
									<div className="mb-1.5 text-[12px] font-bold text-bn-text-primary">
										{label}{" "}
										<code className="ml-1 rounded-sm bg-bn-code-bg px-1 py-px font-mono text-[10.5px] text-bn-text-tertiary">
											{role}
										</code>
									</div>
									<TInput
										value={e.template}
										onChange={(v) => setGuard(role, { ...e, template: v })}
										mono
									/>
									<div className="h-1" />
									<TInput
										value={e.imageUrl}
										onChange={(v) => setGuard(role, { ...e, imageUrl: v })}
										mono
										placeholder="image url"
									/>
								</div>
							);
						})}
					</div>
				</>
			) : (
				<InheritHint>该 UP 将继承全局上舰提示设置</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- Special user (UID list + template) ----------------------------- */

function SpecialUserBox({
	kind,
	title,
	subtitle,
	accent,
	icon,
	users,
	onUsersChange,
	template,
	onTemplateChange,
	baselineTemplate,
	templateField,
}: {
	kind: "danmaku" | "enter";
	title: string;
	subtitle: string;
	accent: string;
	icon: React.ReactNode;
	users: SpecialUser[];
	onUsersChange: (next: SpecialUser[]) => void;
	template: TemplateOverride | undefined;
	onTemplateChange: (next: TemplateOverride | undefined) => void;
	baselineTemplate: string;
	templateField: keyof Pick<TemplateBundle, "specialDanmaku" | "specialUserEnter">;
}) {
	// 把 specialUsers 投影成"该 kind 的 UID 列表",编辑时再写回完整 specialUsers。
	const uids = useMemo(
		() => users.filter((u) => u.kinds.includes(kind)).map((u) => u.uid),
		[users, kind],
	);

	function setUids(nextUids: string[]): void {
		// 同步:删去本 kind 不在 nextUids 里的;加上 nextUids 里没出现过的。
		const set = new Set(nextUids.filter((u) => u.trim() !== ""));
		const next: SpecialUser[] = [];
		const seen = new Set<string>();
		for (const u of users) {
			if (set.has(u.uid)) {
				const kinds = u.kinds.includes(kind) ? u.kinds : [...u.kinds, kind];
				next.push({ ...u, kinds });
				seen.add(u.uid);
			} else if (u.kinds.includes(kind)) {
				const kinds = u.kinds.filter((k) => k !== kind);
				if (kinds.length > 0) next.push({ ...u, kinds });
				// kinds 为空 → 整个用户从 specialUsers 里去掉
			} else {
				next.push(u);
			}
		}
		for (const uid of set) {
			if (!seen.has(uid)) next.push({ uid, kinds: [kind] });
		}
		onUsersChange(next);
	}

	const curTemplate = template ?? {};
	const tplValue = curTemplate[templateField] ?? baselineTemplate;
	const tplOverridden = curTemplate[templateField] !== undefined;

	function setTemplate(v: string | undefined): void {
		const next = { ...curTemplate };
		if (v === undefined) delete next[templateField];
		else next[templateField] = v;
		onTemplateChange(Object.keys(next).length > 0 ? next : undefined);
	}

	const enabled = uids.length > 0 || tplOverridden;

	function toggle(on: boolean): void {
		if (on) {
			// 启用:暂不写入 UID,仅切换显示态;用户开始增加 UID 后即"已设置"。
			// 这里给 ArrayEditor 留一个空白条目通过 onChange 进入,但更稳妥是让 isSectionCustomized
			// 在 Rules.tsx 里看 uids/template 即可。这里设一个占位保留模板继承。
			if (uids.length === 0 && !tplOverridden) {
				// 通过把 templateField 设成 baseline 来"激活"区段;用户随后可改写或新增 UID。
				setTemplate(baselineTemplate);
			}
		} else {
			// 关闭:清空本 kind 所有 UID + 移除 template 覆盖
			setUids([]);
			setTemplate(undefined);
		}
	}

	const inheritLabel = kind === "danmaku" ? "特别关注弹幕规则" : "特别关注进房规则";

	return (
		<GlassBox
			title={title}
			subtitle={subtitle}
			accent={accent}
			icon={icon}
			badge={enabled ? "已设置" : "未启用"}
			right={<Toggle value={enabled} onChange={toggle} />}
		>
			{enabled ? (
				<>
					<Field
						code="specialUsers"
						hint={
							kind === "danmaku" ? "命中后该 UID 的弹幕会单独提醒" : "命中后该 UID 进房会单独提醒"
						}
						full
					>
						<ArrayEditor value={uids} onChange={setUids} placeholder="纯数字 UID" />
					</Field>
					{kind === "danmaku" ? <SpecialDanmakuVariableHints /> : <SpecialEnterVariableHints />}
					<Field
						code={`templates.${templateField}`}
						hint={tplOverridden ? "已覆盖全局" : "继承全局模板"}
						full
					>
						<TArea
							value={tplValue}
							onChange={(v) => setTemplate(v)}
							rows={2}
							mono
							placeholder={baselineTemplate}
						/>
						{tplOverridden ? (
							<button
								type="button"
								onClick={() => setTemplate(undefined)}
								className="mt-1 text-[11px] text-bn-text-tertiary underline-offset-2 hover:text-bn-pink hover:underline"
							>
								恢复继承全局模板
							</button>
						) : null}
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将继承全局{inheritLabel}</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- AI -------------------------------------------------------------- */

/**
 * 覆盖开着时写回磁盘的那个对象 —— 只留「挑了哪份人格」,外加与人格无关的那两项。
 *
 * 刻意**逐字段挑**而不是 `{ ...prev, preset }`:老配置里可能还留着当年那档
 * 「完全自定义」写下的 persona 与两段 prompt(见 schema/resolve.ts 的说明)。
 * 它们已经不参与解析了,原样带上就等于把一份死配置重新写回盘上,下一个人打开
 * 文件照样看得见,还以为它在起作用。
 */
function pickAiOverride(prev: AIOverride | undefined, presetId: string): AIOverride {
	const next: AIOverride = { preset: presetId };
	if (prev?.temperature !== undefined) next.temperature = prev.temperature;
	// AstrBot 端的人格 id,与挑哪份 preset 是两回事,照旧留着。
	if (prev?.personaId !== undefined) next.personaId = prev.personaId;
	return next;
}

function AiOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: AIOverride | undefined;
	onChange: (next: AIOverride | undefined) => void;
	baseline: GlobalDefaults["ai"];
}) {
	// 人格一律在「智能女仆」页里写,这里只负责**挑一份**。所以选项就是已有的那几份,
	// 没有「继承全局」(关掉开关就是继承,再摆一个同义的选项纯属多此一举),也没有
	// 「完全自定义」(想要专属人格就去那边新建一份,再回来挑它)。
	const presetOptions = baseline.presets.map((p) => ({ value: p.id, label: p.label }));
	const activePreset = baseline.presets.find((p) => p.id === value?.preset);
	/*
	 * 覆盖到底开着没有 —— 判据是**挑中的那份人格真实存在**(判定本身住在
	 * `section-scope`,侧栏那颗小点用的是同一个,两处口径不许各走各的)。
	 *
	 * 三种指不着人格的老值在 `resolveAI` 眼里都是完整继承全局 —— 与关掉开关一模
	 * 一样,所以这里就照实显示成「关」。界面和实际行为于是永远对得上;主人哪天真去
	 * 开它,写回去的是一个干干净净的新对象,当年残留的 persona / prompt 顺手就没了。
	 */
	const enabled = hasAiPersonaOverride(value, baseline.presets);
	// 开关打开时落到第一份。`presets` 恒非空是 schema 保证的不变量
	// (见 ai-persona-pointer.test.ts:「presets 空 → 把内置四份补齐」),
	// 所以这里不必为空列表留一条永远走不到的分支。
	const firstPresetId = baseline.presets[0]?.id ?? "";

	return (
		<GlassBox
			title="AI 人格"
			subtitle="给这个 UP 单挑一份人格 · 关 = 跟着全局那份走"
			accent={AI_PURPLE}
			icon={<Icon.ai size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={
				<Toggle
					value={enabled}
					// 开:落到第一份人格。关:整个 override 拿掉 —— 那才是「继承全局」,
					// 不必再往里塞一个表示同一件事的值。
					onChange={(on) => onChange(on ? pickAiOverride(value, firstPresetId) : undefined)}
				/>
			}
		>
			{enabled && activePreset ? (
				<>
					<Field code="ai.preset" full>
						<Picker
							value={activePreset.id}
							onChange={(v) => onChange(pickAiOverride(value, v))}
							options={presetOptions}
						/>
					</Field>

					<div className="rounded-lg border border-bn-purple/30 bg-bn-purple/8 px-3 py-2 text-[11.5px] text-bn-text-secondary">
						这个 UP 用「{activePreset.label}」 · 名字 {activePreset.persona.name} · 称呼你{" "}
						{activePreset.persona.addressUser} ·
						提示词随这份走。想改内容或另起一份，都到「智能女仆」页
					</div>

					<Field code="ai.temperature">
						<TNum
							value={value?.temperature ?? resolveAIProfile(baseline).temperature}
							onChange={(v) =>
								onChange({ ...pickAiOverride(value, activePreset.id), temperature: v })
							}
							min={0}
							max={2}
							step={0.1}
							width={100}
						/>
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将跟着全局那份人格走</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- ImageGroup (enable + forward) ---------------------------------- */

function ImageGroupOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: ImageGroupOverride | undefined;
	onChange: (next: ImageGroupOverride | undefined) => void;
	baseline: ImageGroupSettings;
}) {
	const enabled = value !== undefined;
	const cur = value ?? {};
	const effEnable = cur.enable ?? baseline.enable;
	const effForward = cur.forward ?? baseline.forward;
	function set<K extends keyof ImageGroupOverride>(k: K, v: ImageGroupOverride[K]): void {
		onChange({ ...cur, [k]: v });
	}
	return (
		<GlassBox
			title="动态图集覆盖"
			subtitle="开 = 该 UP 使用自定义图集策略;关 = 继承全局"
			accent="#FB7299"
			icon={<Icon.dyn size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={
				<Toggle
					value={enabled}
					onChange={(on) =>
						onChange(on ? { enable: baseline.enable, forward: baseline.forward } : undefined)
					}
				/>
			}
		>
			{enabled ? (
				<>
					<Field code="enable">
						<Toggle value={effEnable} onChange={(v) => set("enable", v)} />
					</Field>
					<Field code="forward">
						<Toggle value={effForward} onChange={(v) => set("forward", v)} disabled={!effEnable} />
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将继承全局动态图集策略</InheritHint>
			)}
		</GlassBox>
	);
}
