/**
 * Per-UP overrides editor — Subscription.overrides bound to /api/subs PATCH.
 *
 * Each override family (filters / schedule / templates / cardStyle / ai) is
 * gated by a "覆盖全局" toggle. Off → undefined (inherit). On → seeded with
 * the corresponding global default so the user starts editing from a real
 * baseline rather than empty fields.
 *
 * Mirrors `.bn-design/variation-ac-plugins.jsx`'s AdvancedRulesContent per-UP
 * scope without 1:1 importing every legacy field — fields not in the canonical
 * Subscription.overrides schema are intentionally dropped (the design's
 * customSpecialDanmaku UID list etc. lives on Subscription.specialUsers).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Btn } from "../../components/atoms";
import { ArrayEditor, Field, TArea, TColor, TInput, TNum, TSelect } from "../../components/forms";
import { CollapseBlock, GlassBox } from "../../components/glass-box";
import { Icon } from "../../components/icons";
import { ApiError, api } from "../../services/api";
import type {
	AIOverride,
	CardStyleOverride,
	ContentFiltersOverride,
	OverridesShape,
	ScheduleOverride,
	Subscription,
	TemplateOverride,
} from "../../types/domain";
import type { GlobalDefaults, GuardEntry } from "../../types/globals";
import { colorFromUid, displayName } from "../up/helpers";

/* -------------------------------------------------------------------------- */

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function patchSub(id: string, body: { overrides: Subscription["overrides"] }) {
	return api.patch<Subscription>(`/api/subs/${id}`, body);
}

/* -------------------------------------------------------------------------- */

export interface PerUpEditorProps {
	sub: Subscription;
	defaults: GlobalDefaults;
}

export function PerUpEditor({ sub, defaults }: PerUpEditorProps) {
	const qc = useQueryClient();
	const [draft, setDraft] = useState<Subscription["overrides"]>(sub.overrides);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setDraft(sub.overrides);
	}, [sub.overrides]);

	const dirty = useMemo(() => !deepEqual(draft, sub.overrides), [draft, sub.overrides]);

	const save = useMutation({
		mutationFn: async () => {
			setError(null);
			try {
				return await patchSub(sub.id, { overrides: draft });
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	function discard(): void {
		setDraft(sub.overrides);
		setError(null);
	}

	function setSlice<K extends keyof OverridesShape>(
		key: K,
		value: OverridesShape[K] | undefined,
	): void {
		setDraft((d) => {
			const next = { ...d };
			if (value === undefined) {
				delete next[key];
			} else {
				next[key] = value;
			}
			return next;
		});
	}

	const color = colorFromUid(sub.uid);

	return (
		<div className="space-y-4">
			<div
				className="bn-glass flex items-center gap-3 rounded-bn-card p-4 shadow-bn-card"
				style={{
					background: `linear-gradient(135deg, ${color}22, rgba(255,255,255,0.78))`,
					borderColor: `${color}33`,
				}}
			>
				<Avatar name={displayName(sub)} color={color} size={48} ring />
				<div className="min-w-0 flex-1">
					<div className="text-base font-bold text-bn-text-primary">{displayName(sub)}</div>
					<div className="text-[12px] text-bn-text-secondary">
						UID {sub.uid} · per-UP overrides 编辑器；关闭一个分组 = 恢复继承全局默认
					</div>
				</div>
				<div className="flex items-center gap-2">
					{dirty ? (
						<>
							<span className="text-[11.5px] font-semibold text-bn-pink">未保存</span>
							<Btn variant="outline" size="sm" onClick={discard} disabled={save.isPending}>
								丢弃
							</Btn>
							<Btn
								variant="primary"
								size="sm"
								onClick={() => save.mutate()}
								disabled={save.isPending}
							>
								{save.isPending ? "保存中…" : "保存"}
							</Btn>
						</>
					) : (
						<span className="text-[11.5px] text-bn-text-secondary">已与服务端同步</span>
					)}
				</div>
			</div>

			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}

			<FilterOverrideBox
				value={draft.filters}
				onChange={(v) => setSlice("filters", v)}
				baseline={defaults.filters}
			/>
			<ScheduleOverrideBox
				value={draft.schedule}
				onChange={(v) => setSlice("schedule", v)}
				baseline={defaults.schedule}
			/>
			<TemplateOverrideBox
				value={draft.templates}
				onChange={(v) => setSlice("templates", v)}
				baseline={defaults.templates}
			/>
			<CardStyleOverrideBox
				value={draft.cardStyle}
				onChange={(v) => setSlice("cardStyle", v)}
				baseline={defaults.cardStyle}
			/>
			<AiOverrideBox value={draft.ai} onChange={(v) => setSlice("ai", v)} baseline={defaults.ai} />
		</div>
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
			subtitle="overrides.filters · 关键词 / 正则 / 屏蔽开关"
			accent="#FB7299"
			icon={<Icon.filter size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
		>
			<CollapseBlock
				label="启用 per-UP 过滤覆盖"
				enabled={enabled}
				onToggle={(on) => onChange(on ? { ...baseline } : undefined)}
				accent="#FB7299"
			>
				<Field label="关键词黑名单" code="blockKeywords" full>
					<ArrayEditor value={get("blockKeywords")} onChange={(n) => set("blockKeywords", n)} />
				</Field>
				<Field label="正则黑名单" code="blockRegex" full>
					<ArrayEditor value={get("blockRegex")} onChange={(n) => set("blockRegex", n)} />
				</Field>
				<Field label="关键词白名单" code="whitelistKeywords" full>
					<ArrayEditor
						value={get("whitelistKeywords")}
						onChange={(n) => set("whitelistKeywords", n)}
					/>
				</Field>
				<Field label="屏蔽转发" code="blockForward">
					<TSelect
						value={get("blockForward") ? "true" : "false"}
						onChange={(v) => set("blockForward", v === "true")}
						options={[
							{ value: "false", label: "不屏蔽" },
							{ value: "true", label: "屏蔽" },
						]}
					/>
				</Field>
				<Field label="SC 最小金额" code="minScPrice">
					<TNum
						value={get("minScPrice")}
						onChange={(v) => set("minScPrice", v)}
						min={0}
						suffix="¥"
					/>
				</Field>
				<Field label="上舰最低等级" code="minGuardLevel">
					<TSelect
						value={String(get("minGuardLevel")) as "1" | "2" | "3"}
						onChange={(v) => set("minGuardLevel", Number(v) as 1 | 2 | 3)}
						options={[
							{ value: "3", label: "舰长（含以上）" },
							{ value: "2", label: "提督（含以上）" },
							{ value: "1", label: "仅总督" },
						]}
					/>
				</Field>
			</CollapseBlock>
		</GlassBox>
	);
}

/* -------- Schedule -------------------------------------------------------- */

function ScheduleOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: ScheduleOverride | undefined;
	onChange: (next: ScheduleOverride | undefined) => void;
	baseline: GlobalDefaults["schedule"];
}) {
	const enabled = value !== undefined;
	const cur = value ?? {};
	return (
		<GlassBox
			title="调度覆盖"
			subtitle="overrides.schedule · 推送时段 / 启动补推"
			accent="#00AEEC"
			icon={<Icon.mic size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
		>
			<CollapseBlock
				label="启用 per-UP 调度覆盖"
				enabled={enabled}
				onToggle={(on) => onChange(on ? { ...baseline } : undefined)}
				accent="#00AEEC"
			>
				<Field label="推送时段开始" code="pushTime" hint="0=全天">
					<TNum
						value={cur.pushTime ?? baseline.pushTime}
						onChange={(v) => onChange({ ...cur, pushTime: v })}
						min={0}
						max={23}
						suffix="时"
					/>
				</Field>
				<Field label="启动补推" code="restartPush">
					<TSelect
						value={(cur.restartPush ?? baseline.restartPush) ? "true" : "false"}
						onChange={(v) => onChange({ ...cur, restartPush: v === "true" })}
						options={[
							{ value: "false", label: "关" },
							{ value: "true", label: "开" },
						]}
					/>
				</Field>
			</CollapseBlock>
		</GlassBox>
	);
}

/* -------- Templates ------------------------------------------------------- */

function TemplateOverrideBox({
	value,
	onChange,
	baseline,
}: {
	value: TemplateOverride | undefined;
	onChange: (next: TemplateOverride | undefined) => void;
	baseline: GlobalDefaults["templates"];
}) {
	const enabled = value !== undefined;
	const cur = value ?? {};
	function set<K extends keyof typeof baseline>(k: K, v: (typeof baseline)[K]): void {
		onChange({ ...cur, [k]: v });
	}
	const guardOf = (role: keyof typeof baseline.guardBuy): GuardEntry =>
		cur.guardBuy?.[role] ?? baseline.guardBuy[role];
	function setGuard(role: keyof typeof baseline.guardBuy, entry: GuardEntry): void {
		onChange({
			...cur,
			guardBuy: { ...(cur.guardBuy ?? baseline.guardBuy), [role]: entry },
		});
	}
	return (
		<GlassBox
			title="模板覆盖"
			subtitle="overrides.templates · 开播 / 直播中 / 下播 / 总结 / 上舰"
			accent="#a29bfe"
			icon={<Icon.chat size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
		>
			<CollapseBlock
				label="启用 per-UP 模板覆盖"
				enabled={enabled}
				onToggle={(on) => onChange(on ? { ...baseline } : undefined)}
				accent="#a29bfe"
			>
				<Field label="开播" code="liveStart" full>
					<TArea
						value={cur.liveStart ?? baseline.liveStart}
						onChange={(v) => set("liveStart", v)}
						rows={2}
						mono
					/>
				</Field>
				<Field label="直播中" code="liveOngoing" full>
					<TArea
						value={cur.liveOngoing ?? baseline.liveOngoing}
						onChange={(v) => set("liveOngoing", v)}
						rows={2}
						mono
					/>
				</Field>
				<Field label="下播" code="liveEnd" full>
					<TArea
						value={cur.liveEnd ?? baseline.liveEnd}
						onChange={(v) => set("liveEnd", v)}
						rows={2}
						mono
					/>
				</Field>
				<Field label="直播总结" code="liveSummary" full>
					<TArea
						value={cur.liveSummary ?? baseline.liveSummary}
						onChange={(v) => set("liveSummary", v)}
						rows={5}
						mono
					/>
				</Field>
				<div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
					{(["captain", "commander", "governor"] as const).map((role) => {
						const e = guardOf(role);
						const label = role === "captain" ? "舰长" : role === "commander" ? "提督" : "总督";
						return (
							<div key={role} className="rounded-lg border border-gray-200 bg-white/70 p-2.5">
								<div className="mb-1.5 text-[12px] font-bold text-bn-text-primary">
									{label}{" "}
									<code className="ml-1 rounded bg-black/5 px-1 py-px font-mono text-[10.5px] text-bn-text-tertiary">
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
			</CollapseBlock>
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
			subtitle="overrides.cardStyle · 4 个颜色字段"
			accent="#FB7299"
			icon={<Icon.sparkle size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
		>
			<CollapseBlock
				label="启用 per-UP 卡片样式覆盖"
				enabled={enabled}
				onToggle={(on) => onChange(on ? { ...baseline } : undefined)}
				accent="#FB7299"
			>
				<Field label="渐变起始" code="cardColorStart">
					<TColor
						value={cur.cardColorStart ?? baseline.cardColorStart}
						onChange={(v) => set("cardColorStart", v)}
					/>
				</Field>
				<Field label="渐变结束" code="cardColorEnd">
					<TColor
						value={cur.cardColorEnd ?? baseline.cardColorEnd}
						onChange={(v) => set("cardColorEnd", v)}
					/>
				</Field>
				<Field label="底板颜色" code="cardBasePlateColor">
					<TColor
						value={cur.cardBasePlateColor ?? baseline.cardBasePlateColor}
						onChange={(v) => set("cardBasePlateColor", v)}
					/>
				</Field>
				<Field label="底板边框" code="cardBasePlateBorder">
					<TColor
						value={cur.cardBasePlateBorder ?? baseline.cardBasePlateBorder}
						onChange={(v) => set("cardBasePlateBorder", v)}
					/>
				</Field>
			</CollapseBlock>
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
	const presets = [
		{ value: "inherit", label: "继承全局" },
		{ value: "custom", label: "完全自定义" },
		...baseline.presets.map((p) => ({ value: p.id, label: p.label })),
	];
	const isCustom = cur.preset === "custom";
	return (
		<GlassBox
			title="AI 覆盖"
			subtitle="overrides.ai · preset / persona / prompts / temperature"
			accent="#6c5ce7"
			icon={<Icon.ai size={14} />}
			badge={enabled ? "覆盖中" : "继承"}
		>
			<CollapseBlock
				label="启用 per-UP AI 覆盖"
				enabled={enabled}
				onToggle={(on) => onChange(on ? { preset: "inherit" } : undefined)}
				accent="#6c5ce7"
			>
				<Field label="预设" code="ai.preset" full>
					<TSelect
						value={cur.preset}
						onChange={(v) => onChange({ ...cur, preset: v })}
						options={presets}
						full
					/>
				</Field>
				{isCustom ? (
					<>
						<Field label="名字" code="ai.persona.name">
							<TInput
								value={cur.persona?.name ?? baseline.persona.name}
								onChange={(v) =>
									onChange({
										...cur,
										persona: { ...(cur.persona ?? baseline.persona), name: v },
									})
								}
								full={false}
							/>
						</Field>
						<Field label="动态点评 prompt" code="ai.dynamicPrompt" full>
							<TArea
								value={cur.dynamicPrompt ?? baseline.dynamicPrompt}
								onChange={(v) => onChange({ ...cur, dynamicPrompt: v })}
								rows={3}
								mono
							/>
						</Field>
						<Field label="直播总结 prompt" code="ai.liveSummaryPrompt" full>
							<TArea
								value={cur.liveSummaryPrompt ?? baseline.liveSummaryPrompt}
								onChange={(v) => onChange({ ...cur, liveSummaryPrompt: v })}
								rows={3}
								mono
							/>
						</Field>
					</>
				) : null}
				<Field label="temperature" code="ai.temperature" hint="0–2，越高越发散">
					<TNum
						value={cur.temperature ?? baseline.temperature}
						onChange={(v) => onChange({ ...cur, temperature: v })}
						min={0}
						max={2}
						step={0.1}
						width={100}
					/>
				</Field>
			</CollapseBlock>
		</GlassBox>
	);
}
