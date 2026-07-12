/**
 * AI page (智能女仆) — port of `SmartMaidContent` from
 * `.bn-design/variation-ac-plugins.jsx`.
 *
 * Bound to GlobalConfig.defaults.ai. Three GlassBoxes:
 *   1. 模型连接 — apiKey / baseUrl / model / log level
 *   2. 能力开关 — enable + temperature (the design's enableThinking /
 *      enableSearch / enableVision / enableConversation toggles aren't yet
 *      in the canonical AISettings schema, so they're commented at the UI
 *      level until the schema gains them)
 *   3. 人格塑造 — preset + persona{name,addressUser,addressSelf,traits,
 *      catchphrase} + dynamicPrompt + liveSummaryPrompt
 *
 * Saves through PATCH /api/globals { defaults: { ai: ... } }.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pill } from "../components/atoms";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	Picker,
	TArea,
	TInput,
	TNum,
} from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon } from "../components/icons";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { api } from "../services/api";
import type { AIPersona, AISettings, GlobalConfig, LogLevel } from "../types/globals";
import { AiTestPanel } from "./ai/TestPanel";

// 日志等级绑定到 `app.logLevels.ai` (per-module override),不再压全局 `app.logLevel`。
// `null` 表示「跟随全局」(没有 override)。
type AiLogLevel = LogLevel | "";
const LOG_LEVEL_TO_NUM: Record<LogLevel, LogLevelValue> = { error: 1, warn: 2, info: 3, debug: 4 };
const NUM_TO_LOG_LEVEL: Record<LogLevelValue, LogLevel> = {
	1: "error",
	2: "warn",
	3: "info",
	4: "debug",
};
const toPickerValue = (v: AiLogLevel): LogLevelValue | null =>
	v === "" ? null : LOG_LEVEL_TO_NUM[v];
const fromPickerValue = (v: LogLevelValue | null): AiLogLevel =>
	v === null ? "" : NUM_TO_LOG_LEVEL[v];

/**
 * 灵动岛 draft/baseline 打包:walkTreeDiff 输出的 dot-path 跟 FIELD_LABELS
 * 字典 key 对齐(否则 diff panel 归 "其他" 段、click 跳转锚点缺失)。
 *
 * AISettings 字段在 JSX 里 code 风格分两组:
 * - 模型连接 / 参数 / prompts:`<Field code="ai.apiKey">` 等 → 包到 `ai` 命名空间
 * - 人格 / 预设:`<Field code="persona.name">` / `code="presets"` → 顶层
 */
function packIsland(ai: AISettings, levelOverride: AiLogLevel) {
	const {
		apiKey,
		baseUrl,
		model,
		temperature,
		dynamicPrompt,
		liveSummaryPrompt,
		persona,
		presets,
		enabled,
	} = ai;
	return {
		ai: { apiKey, baseUrl, model, temperature, dynamicPrompt, liveSummaryPrompt },
		persona,
		presets,
		enabled,
		app: { logLevels: { ai: levelOverride === "" ? null : levelOverride } },
	};
}

export default function Ai() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});

	const [draft, setDraft] = useState<AISettings | null>(null);
	const [aiLogLevel, setAiLogLevel] = useState<AiLogLevel>("");
	// "Which preset is currently active" is UI-local; AISettings has no
	// activePresetId field. Initialised by matching the persona/prompts
	// against each preset on hydrate; falls back to "custom".
	const [selectedPresetId, setSelectedPresetId] = useState<string>("custom");
	// Snapshot of the user's custom persona/prompts. Lets us restore their
	// edits when they bounce between "custom" and a named preset, while still
	// clearing the form on the *first* switch to custom from a preset.
	type CustomSnapshot = {
		persona: AIPersona;
		dynamicPrompt: string;
		liveSummaryPrompt: string;
	};
	const [customSnapshot, setCustomSnapshot] = useState<CustomSnapshot | null>(null);

	useEffect(() => {
		if (globalsQuery.data) {
			const ai = globalsQuery.data.defaults.ai;
			setDraft(ai);
			setAiLogLevel(globalsQuery.data.app.logLevels?.ai ?? "");
			// Try to match persona+prompts against each preset; if all fields
			// align, that's the active preset; otherwise it's "custom".
			const matched = ai.presets.find(
				(p) =>
					JSON.stringify(p.persona) === JSON.stringify(ai.persona) &&
					(p.dynamicPrompt ?? ai.dynamicPrompt) === ai.dynamicPrompt &&
					(p.liveSummaryPrompt ?? ai.liveSummaryPrompt) === ai.liveSummaryPrompt,
			);
			setSelectedPresetId(matched?.id ?? "custom");
			setCustomSnapshot(
				matched
					? null
					: {
							persona: ai.persona,
							dynamicPrompt: ai.dynamicPrompt,
							liveSummaryPrompt: ai.liveSummaryPrompt,
						},
			);
		}
	}, [globalsQuery.data]);

	// Keep customSnapshot in sync with edits made while in custom mode, so
	// switching away to a preset and back restores the user's work.
	useEffect(() => {
		if (draft && selectedPresetId === "custom") {
			setCustomSnapshot({
				persona: draft.persona,
				dynamicPrompt: draft.dynamicPrompt,
				liveSummaryPrompt: draft.liveSummaryPrompt,
			});
		}
	}, [selectedPresetId, draft?.persona, draft?.dynamicPrompt, draft?.liveSummaryPrompt, draft]);

	const save = useMutation({
		mutationFn: async (payload: { ai: AISettings; aiLogLevel: AiLogLevel }) => {
			const existing = globalsQuery.data?.app.logLevels ?? {};
			// 与 cards 同款合并:"" → 删 ai key,落到全局;具体值 → 仅 patch 该 key,
			// 其余模块 override 不动。
			const nextLogLevels =
				payload.aiLogLevel === ""
					? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== "ai"))
					: { ...existing, ai: payload.aiLogLevel };
			return await api.patch<GlobalConfig>("/api/globals", {
				app: {
					logLevels: Object.keys(nextLogLevels).length === 0 ? undefined : nextLogLevels,
				},
				defaults: { ai: payload.ai },
			});
		},
		// 用 PATCH 的**响应**(后端返回的正是 redact 后的新 globals)把 draft 拉回已保存态。
		//
		// 不能指望 refetch 来做这件事:apiKey 出后端永远是 REDACTED 占位,所以**只改
		// apiKey** 时,重新拉回的 globals 与拉取前**深度完全相等** —— React Query 的
		// structural sharing 会复用同一个对象引用,hydrate 的 useEffect([globalsQuery.data])
		// 因此不触发,draft 里就一直留着用户输入的明文 key。明文 draft 与占位 baseline
		// 永不相等 → 灵动岛**永久 dirty**,反复点保存也消不掉,看起来就是「保存不了」。
		// (顺手改了 model / 人格反而正常 —— 那些字段不脱敏,数据变了引用就变了。)
		onSuccess: (next) => {
			setDraft(next.defaults.ai);
			setAiLogLevel(next.app.logLevels?.ai ?? "");
			qc.invalidateQueries({ queryKey: ["globals"] });
		},
	});

	const islandDraft = useMemo(
		() => (draft === null ? null : packIsland(draft, aiLogLevel)),
		[draft, aiLogLevel],
	);
	const islandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return packIsland(
			globalsQuery.data.defaults.ai,
			(globalsQuery.data.app.logLevels?.ai ?? "") as AiLogLevel,
		);
	}, [globalsQuery.data]);

	useDirtyDraft({
		pageKey: "ai",
		pageLabel: "智能女仆",
		draft: islandDraft,
		baseline: islandBaseline,
		onSave: async () => {
			if (draft !== null) await save.mutateAsync({ ai: draft, aiLogLevel });
		},
		onDiscard: () => {
			if (globalsQuery.data) {
				setDraft(globalsQuery.data.defaults.ai);
				setAiLogLevel(globalsQuery.data.app.logLevels?.ai ?? "");
			}
		},
	});

	if (!draft) {
		return (
			<div className="bn-glass rounded-bn-card p-10 text-center text-sm text-bn-text-secondary shadow-bn-card">
				加载 AI 配置中…
			</div>
		);
	}

	function setAi<K extends keyof AISettings>(k: K, v: AISettings[K]): void {
		setDraft((d) => (d ? { ...d, [k]: v } : d));
	}
	function setPersona<K extends keyof AIPersona>(k: K, v: AIPersona[K]): void {
		setDraft((d) => (d ? { ...d, persona: { ...d.persona, [k]: v } } : d));
	}

	const presetOptions = [
		...draft.presets.map((p) => ({ value: p.id, label: p.label })),
		{ value: "custom", label: "完全自定义" },
	];

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{/* Hero strip */}
			<div
				className="relative rounded-bn-card border p-5"
				style={{
					background: "linear-gradient(135deg, rgba(162,155,254,0.18), rgba(108,92,231,0.08))",
					borderColor: "rgba(108,92,231,0.25)",
				}}
			>
				<div className="flex items-center gap-3.5">
					<div
						className="grid h-13 w-13 shrink-0 place-items-center rounded-2xl text-white"
						style={{
							background: "linear-gradient(135deg, #a29bfe, #6c5ce7)",
							boxShadow: "0 6px 18px rgba(108,92,231,0.35)",
							width: 52,
							height: 52,
						}}
					>
						<Icon.ai size={26} />
					</div>
					<div className="flex-1">
						<div className="flex items-center gap-2 text-[15.5px] font-bold text-bn-text-primary">
							智能女仆 · {draft.persona.name || "女仆"}
							<Pill color="#a29bfe" subtle size="sm">
								{draft.model || "未配置"}
							</Pill>
						</div>
						<div className="mt-1 text-xs text-bn-text-tertiary">
							会写动态点评、直播总结，支持 OpenAI 兼容的任意 base URL (｡•̀ᴗ-)✧
						</div>
					</div>
					<Picker
						value={draft.enabled}
						onChange={(v) => setAi("enabled", v)}
						options={[
							{ value: true, label: "启用", color: "#6c5ce7" },
							{ value: false, label: "停用", color: "#94a3b8" },
						]}
					/>
				</div>
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<GlassBox
					title="模型连接"
					subtitle="OpenAI 兼容 API · ai.{baseUrl,apiKey,model}"
					accent="#6c5ce7"
					icon={<Icon.link size={14} />}
					badge="connection"
				>
					<Field code="ai.apiKey" required>
						<TInput
							value={draft.apiKey ?? ""}
							onChange={(v) => setAi("apiKey", v || undefined)}
							secret
							mono
						/>
					</Field>
					<Field code="ai.baseUrl" full>
						<TInput
							value={draft.baseUrl ?? ""}
							onChange={(v) => setAi("baseUrl", v || undefined)}
							mono
							placeholder="https://api.openai.com/v1"
						/>
					</Field>
					<Field code="ai.model">
						<TInput value={draft.model} onChange={(v) => setAi("model", v)} mono full={false} />
					</Field>
					<Field code="app.logLevels.ai" full>
						<LogLevelPicker
							value={toPickerValue(aiLogLevel)}
							onChange={(v) => setAiLogLevel(fromPickerValue(v))}
							allowInherit
						/>
					</Field>
				</GlassBox>

				<GlassBox
					title="生成参数"
					subtitle="temperature"
					accent="#a29bfe"
					icon={<Icon.sparkle size={14} />}
					badge="generation"
				>
					<Field code="ai.temperature">
						<TNum
							value={draft.temperature}
							onChange={(v) => setAi("temperature", v)}
							min={0}
							max={2}
							step={0.1}
							width={100}
						/>
					</Field>
				</GlassBox>
			</div>

			<GlassBox
				title="人格塑造 · persona"
				subtitle="决定女仆的口吻与称呼方式 · ai.persona / ai.{dynamicPrompt,liveSummaryPrompt}"
				accent="#fdcb6e"
				icon={<Icon.heart size={14} />}
				badge="persona"
			>
				<Field
					code="presets"
					hint={
						draft.presets.length === 0
							? "未配置 ai.presets，可在「完全自定义」下手动填写人格"
							: undefined
					}
					full
				>
					<Picker
						value={selectedPresetId}
						onChange={(v) => {
							setSelectedPresetId(v);
							if (v === "custom") {
								// First switch to custom: clear all persona/prompt fields.
								// Subsequent switches with prior user edits: restore snapshot.
								setDraft((d) => {
									if (!d) return d;
									if (customSnapshot) {
										return {
											...d,
											persona: { ...customSnapshot.persona },
											dynamicPrompt: customSnapshot.dynamicPrompt,
											liveSummaryPrompt: customSnapshot.liveSummaryPrompt,
										};
									}
									return {
										...d,
										persona: {
											name: "",
											addressUser: "",
											addressSelf: "",
											traits: "",
											catchphrase: "",
											baseRole: "",
											extraSystemPrompt: "",
										},
										dynamicPrompt: "",
										liveSummaryPrompt: "",
									};
								});
								return;
							}
							const p = draft.presets.find((x) => x.id === v);
							if (!p) return;
							setDraft((d) =>
								d
									? {
											...d,
											persona: { ...p.persona },
											dynamicPrompt: p.dynamicPrompt ?? d.dynamicPrompt,
											liveSummaryPrompt: p.liveSummaryPrompt ?? d.liveSummaryPrompt,
										}
									: d,
							);
						}}
						options={presetOptions}
					/>
				</Field>
				<div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
					<Field code="persona.name">
						<TInput
							value={draft.persona.name}
							onChange={(v) => setPersona("name", v)}
							placeholder="女仆"
							full={false}
						/>
					</Field>
					<Field code="persona.addressUser">
						<TInput
							value={draft.persona.addressUser}
							onChange={(v) => setPersona("addressUser", v)}
							placeholder="主人"
							full={false}
						/>
					</Field>
					<Field code="persona.addressSelf">
						<TInput
							value={draft.persona.addressSelf}
							onChange={(v) => setPersona("addressSelf", v)}
							placeholder="女仆"
							full={false}
						/>
					</Field>
					<Field code="persona.catchphrase">
						<TInput
							value={draft.persona.catchphrase}
							onChange={(v) => setPersona("catchphrase", v)}
							placeholder="(*´∀`)~♡"
							full={false}
						/>
					</Field>
				</div>
				<Field code="persona.traits" full>
					<TInput value={draft.persona.traits} onChange={(v) => setPersona("traits", v)} />
				</Field>
				<Field code="persona.baseRole" full>
					<TArea
						value={draft.persona.baseRole}
						onChange={(v) => setPersona("baseRole", v)}
						rows={2}
					/>
				</Field>
				<Field code="persona.extraSystemPrompt" full>
					<TArea
						value={draft.persona.extraSystemPrompt}
						onChange={(v) => setPersona("extraSystemPrompt", v)}
						rows={2}
					/>
				</Field>
				<Field code="ai.dynamicPrompt" full>
					<TArea
						value={draft.dynamicPrompt}
						onChange={(v) => setAi("dynamicPrompt", v)}
						rows={3}
						mono
					/>
				</Field>
				<Field code="ai.liveSummaryPrompt" full>
					<TArea
						value={draft.liveSummaryPrompt}
						onChange={(v) => setAi("liveSummaryPrompt", v)}
						rows={4}
						mono
					/>
				</Field>
			</GlassBox>

			{/* 试一句 —— 排在人格塑造之后:调完人格,当场就能问她一句看看效果。 */}
			<AiTestPanel draft={draft} />
		</div>
	);
}
