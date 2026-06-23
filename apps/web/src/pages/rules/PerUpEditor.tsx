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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Toggle } from "../../components/atoms";
import {
	ArrayEditor,
	Field,
	Picker,
	QuietHoursEditor,
	TArea,
	TColor,
	TInput,
	TNum,
} from "../../components/forms";
import { CollapseBlock, GlassBox } from "../../components/glass-box";
import { Icon } from "../../components/icons";
import { useDirtyDraft } from "../../hooks/useDirtyDraft";
import { api } from "../../services/api";
import type {
	AIOverride,
	CardStyleOverride,
	ContentFiltersOverride,
	ImageGroupOverride,
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
import { buildOverridesPatch, type OverridesPatch } from "./overrides-patch";
import { projectPerUpIsland } from "./perup-island";
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

/** Override 切片名;Rules.tsx 用它判定 sub 是否"已定制"。 */
export const perUpOverrideKeys = [
	"filters",
	"schedule",
	"templates",
	"cardStyle",
	"ai",
	"imageGroup",
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
					background: `linear-gradient(135deg, ${color}22, var(--bn-glass-bg))`,
					borderColor: `${color}33`,
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
			{section === "cardStyle" ? (
				<CardStyleOverrideBox
					value={draft.overrides.cardStyle}
					onChange={(v) => setSlice("cardStyle", v)}
					baseline={defaults.cardStyle}
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
	const enabled = value !== undefined;
	const cur = value ?? {};
	const get = <K extends keyof typeof baseline>(k: K) =>
		(cur[k] ?? baseline[k]) as (typeof baseline)[K];
	function set<K extends keyof typeof baseline>(k: K, v: (typeof baseline)[K]): void {
		onChange({ ...cur, [k]: v });
	}
	return (
		<GlassBox
			title="动态过滤覆盖"
			subtitle="开 = 该 UP 使用自定义关键词 / 正则 / 屏蔽开关;关 = 继承全局过滤"
			accent="#FB7299"
			icon={<Icon.filter size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={
				<Toggle value={enabled} onChange={(on) => onChange(on ? { ...baseline } : undefined)} />
			}
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
	const enabled = filters !== undefined || schedule !== undefined;
	const fCur = filters ?? {};
	const sCur = schedule ?? {};
	function toggle(on: boolean): void {
		if (on) {
			onFilters({
				minScPrice: baselineFilters.minScPrice,
				minGuardLevel: baselineFilters.minGuardLevel,
			});
			onSchedule({ ...baselineSchedule });
		} else {
			onFilters(undefined);
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
										<code className="ml-1 rounded bg-bn-code-bg px-1 py-px font-mono text-[10.5px] text-bn-text-tertiary">
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

/* -------- Card style ------------------------------------------------------ */

function CardStyleOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: CardStyleOverride | undefined;
	onChange: (next: CardStyleOverride | undefined) => void;
	baseline: GlobalDefaults["cardStyle"];
}) {
	const enabled = value !== undefined;
	const cur = value ?? {};
	function set<K extends keyof typeof baseline>(k: K, v: (typeof baseline)[K]): void {
		onChange({ ...cur, [k]: v });
	}
	return (
		<GlassBox
			title="卡片样式覆盖"
			subtitle="开 = 该 UP 使用自定义卡片渐变 / 底板;关 = 继承全局卡片样式"
			accent="#FB7299"
			icon={<Icon.sparkle size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={
				<Toggle value={enabled} onChange={(on) => onChange(on ? { ...baseline } : undefined)} />
			}
		>
			{enabled ? (
				<>
					<Field code="cardColorStart">
						<TColor
							value={cur.cardColorStart ?? baseline.cardColorStart}
							onChange={(v) => set("cardColorStart", v)}
						/>
					</Field>
					<Field code="cardColorEnd">
						<TColor
							value={cur.cardColorEnd ?? baseline.cardColorEnd}
							onChange={(v) => set("cardColorEnd", v)}
						/>
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将继承全局卡片样式</InheritHint>
			)}
		</GlassBox>
	);
}

/* -------- AI -------------------------------------------------------------- */

function AiOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: AIOverride | undefined;
	onChange: (next: AIOverride | undefined) => void;
	baseline: GlobalDefaults["ai"];
}) {
	const enabled = value !== undefined;
	const cur: AIOverride = value ?? { preset: "inherit" };
	const presetOptions = [
		{ value: "inherit", label: "继承全局" },
		...baseline.presets.map((p) => ({ value: p.id, label: p.label })),
		{ value: "custom", label: "完全自定义" },
	];
	const isCustom = cur.preset === "custom";
	const isInherit = cur.preset === "inherit";
	const isPreset = !isCustom && !isInherit;
	const activePreset = isPreset ? baseline.presets.find((p) => p.id === cur.preset) : null;

	// In custom mode: empty until the user types. Don't fall back to the global
	// baseline persona — that would make "完全自定义" surface global state and
	// confuse users who just want a blank slate to fill out.
	const EMPTY_PERSONA = {
		name: "",
		addressUser: "",
		addressSelf: "",
		traits: "",
		catchphrase: "",
		baseRole: "",
		extraSystemPrompt: "",
	};
	const personaBase = isCustom ? (cur.persona ?? EMPTY_PERSONA) : (cur.persona ?? baseline.persona);
	function setPersonaField(k: keyof typeof baseline.persona, v: string): void {
		onChange({
			...cur,
			persona: { ...personaBase, [k]: v },
		});
	}

	return (
		<GlassBox
			title="AI 人格塑造覆盖"
			subtitle="开 = 该 UP 使用自定义 preset / persona / prompt;关 = 继承全局 AI 设置"
			accent="#6c5ce7"
			icon={<Icon.ai size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
			right={
				<Toggle
					value={enabled}
					onChange={(on) => onChange(on ? { preset: "inherit" } : undefined)}
				/>
			}
		>
			{enabled ? (
				<>
					<Field code="ai.preset" full>
						<Picker
							value={cur.preset}
							onChange={(v) => onChange({ ...cur, preset: v })}
							options={presetOptions}
						/>
					</Field>

					{isPreset && activePreset ? (
						<div className="rounded-lg border border-bn-purple/30 bg-bn-purple/8 px-3 py-2 text-[11.5px] text-bn-text-secondary">
							已套用预设「{activePreset.label}」 · 名字 {activePreset.persona.name} · 称呼用户{" "}
							{activePreset.persona.addressUser} ·
							提示词随预设。需要更细的微调请改用「完全自定义」。
						</div>
					) : null}

					{isCustom ? (
						<>
							<div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
								<Field code="ai.persona.name">
									<TInput
										value={personaBase.name}
										onChange={(v) => setPersonaField("name", v)}
										full={false}
									/>
								</Field>
								<Field code="ai.persona.addressUser">
									<TInput
										value={personaBase.addressUser}
										onChange={(v) => setPersonaField("addressUser", v)}
										full={false}
									/>
								</Field>
								<Field code="ai.persona.addressSelf">
									<TInput
										value={personaBase.addressSelf}
										onChange={(v) => setPersonaField("addressSelf", v)}
										full={false}
									/>
								</Field>
								<Field code="ai.persona.catchphrase">
									<TInput
										value={personaBase.catchphrase}
										onChange={(v) => setPersonaField("catchphrase", v)}
										full={false}
									/>
								</Field>
							</div>
							<Field code="ai.persona.traits" full>
								<TInput value={personaBase.traits} onChange={(v) => setPersonaField("traits", v)} />
							</Field>
							<Field code="ai.persona.baseRole" full>
								<TArea
									value={personaBase.baseRole}
									onChange={(v) => setPersonaField("baseRole", v)}
									rows={2}
								/>
							</Field>
							<Field code="ai.persona.extraSystemPrompt" full>
								<TArea
									value={personaBase.extraSystemPrompt}
									onChange={(v) => setPersonaField("extraSystemPrompt", v)}
									rows={2}
								/>
							</Field>
							<Field code="ai.dynamicPrompt" full>
								<TArea
									value={cur.dynamicPrompt ?? ""}
									onChange={(v) => onChange({ ...cur, dynamicPrompt: v })}
									rows={3}
									mono
								/>
							</Field>
							<Field code="ai.liveSummaryPrompt" full>
								<TArea
									value={cur.liveSummaryPrompt ?? ""}
									onChange={(v) => onChange({ ...cur, liveSummaryPrompt: v })}
									rows={3}
									mono
								/>
							</Field>
						</>
					) : null}
					<Field code="ai.temperature">
						<TNum
							value={cur.temperature ?? baseline.temperature}
							onChange={(v) => onChange({ ...cur, temperature: v })}
							min={0}
							max={2}
							step={0.1}
							width={100}
						/>
					</Field>
				</>
			) : (
				<InheritHint>该 UP 将继承全局 AI 人格塑造设置</InheritHint>
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
