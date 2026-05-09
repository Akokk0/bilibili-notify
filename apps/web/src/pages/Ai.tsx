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
import { Btn, Pill } from "../components/atoms";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	TArea,
	TInput,
	TNum,
	TSelect,
} from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import type { AIPersona, AISettings, GlobalConfig, LogLevel } from "../types/globals";

// 日志等级绑定到 `app.logLevels.ai` (per-module override),不再压全局 `app.logLevel`。
// `null` 表示「跟随全局」(没有 override)。
type AiLogLevel = LogLevel | "";
const LOG_LEVEL_TO_NUM: Record<LogLevel, LogLevelValue> = { error: 1, info: 2, debug: 3 };
const NUM_TO_LOG_LEVEL: Record<LogLevelValue, LogLevel> = { 1: "error", 2: "info", 3: "debug" };
const toPickerValue = (v: AiLogLevel): LogLevelValue | null =>
	v === "" ? null : LOG_LEVEL_TO_NUM[v];
const fromPickerValue = (v: LogLevelValue | null): AiLogLevel =>
	v === null ? "" : NUM_TO_LOG_LEVEL[v];

export default function Ai() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});

	const [draft, setDraft] = useState<AISettings | null>(null);
	const [aiLogLevel, setAiLogLevel] = useState<AiLogLevel>("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (globalsQuery.data) {
			setDraft(globalsQuery.data.defaults.ai);
			setAiLogLevel(globalsQuery.data.app.logLevels?.ai ?? "");
		}
	}, [globalsQuery.data]);

	const serverAiLogLevel = globalsQuery.data?.app.logLevels?.ai ?? "";
	const dirty = useMemo(() => {
		if (!draft || !globalsQuery.data) return false;
		return (
			JSON.stringify(draft) !== JSON.stringify(globalsQuery.data.defaults.ai) ||
			aiLogLevel !== serverAiLogLevel
		);
	}, [draft, globalsQuery.data, aiLogLevel, serverAiLogLevel]);

	const save = useMutation({
		mutationFn: async (payload: { ai: AISettings; aiLogLevel: AiLogLevel }) => {
			setError(null);
			try {
				const existing = globalsQuery.data?.app.logLevels ?? {};
				// 与 cards 同款合并:"" → 删 ai key,落到全局;具体值 → 仅 patch 该 key,
				// 其余模块 override 不动。
				const nextLogLevels =
					payload.aiLogLevel === ""
						? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== "ai"))
						: { ...existing, ai: payload.aiLogLevel };
				await api.patch<GlobalConfig>("/api/globals", {
					app: {
						logLevels: Object.keys(nextLogLevels).length === 0 ? undefined : nextLogLevels,
					},
					defaults: { ai: payload.ai },
				});
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
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
		{ value: "custom", label: "custom · 完全自定义" },
		...draft.presets.map((p) => ({ value: p.id, label: p.label })),
	];
	const presetValue = draft.presets.some((p) => p.id === draft.persona.name)
		? draft.persona.name
		: "custom";

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
					<div className="flex items-center gap-2">
						<span className="text-[12px] text-bn-text-secondary">总开关</span>
						<Btn
							size="sm"
							variant={draft.enabled ? "primary" : "outline"}
							onClick={() => setAi("enabled", !draft.enabled)}
						>
							{draft.enabled ? "已启用" : "未启用"}
						</Btn>
					</div>
				</div>

				{dirty ? (
					<div className="mt-3.5 flex items-center justify-end gap-2">
						<span className="text-[11.5px] font-semibold text-bn-pink">未保存</span>
						<Btn
							variant="outline"
							size="sm"
							onClick={() => {
								if (globalsQuery.data) {
									setDraft(globalsQuery.data.defaults.ai);
									setAiLogLevel(globalsQuery.data.app.logLevels?.ai ?? "");
								}
							}}
							disabled={save.isPending}
						>
							丢弃
						</Btn>
						<Btn
							variant="primary"
							size="sm"
							onClick={() => draft && save.mutate({ ai: draft, aiLogLevel })}
							disabled={save.isPending}
						>
							{save.isPending ? "保存中…" : "保存"}
						</Btn>
					</div>
				) : null}
			</div>

			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}

			<div className="grid gap-4 lg:grid-cols-2">
				<GlassBox
					title="模型连接"
					subtitle="OpenAI 兼容 API · ai.{baseUrl,apiKey,model}"
					accent="#6c5ce7"
					icon="API"
					badge="connection"
				>
					<Field label="API Key" code="ai.apiKey" required>
						<TInput
							value={draft.apiKey ?? ""}
							onChange={(v) => setAi("apiKey", v || undefined)}
							secret
							mono
						/>
					</Field>
					<Field label="Base URL" code="ai.baseUrl" full>
						<TInput
							value={draft.baseUrl ?? ""}
							onChange={(v) => setAi("baseUrl", v || undefined)}
							mono
							placeholder="https://api.openai.com/v1"
						/>
					</Field>
					<Field label="模型 ID" code="ai.model">
						<TInput value={draft.model} onChange={(v) => setAi("model", v)} mono full={false} />
					</Field>
					<Field
						label="日志等级"
						code="app.logLevels.ai"
						hint="只影响 ai 模块;选「跟随全局」时与 app.logLevel 同步。改完保存后需重启服务。"
						full
					>
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
					<Field label="temperature" code="ai.temperature" hint="0–2，越高越发散">
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
					label="基础预设"
					code="presets"
					hint={
						draft.presets.length === 0
							? "未配置 ai.presets，可在「完全自定义」下手动填写人格"
							: "选择预设可快速套用人格 / prompts"
					}
					full
				>
					<TSelect
						value={presetValue}
						onChange={(v) => {
							if (v === "custom") return;
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
					<Field label="名字" code="persona.name" hint="留空跟随预设">
						<TInput
							value={draft.persona.name}
							onChange={(v) => setPersona("name", v)}
							placeholder="女仆"
							full={false}
						/>
					</Field>
					<Field label="称呼用户" code="persona.addressUser">
						<TInput
							value={draft.persona.addressUser}
							onChange={(v) => setPersona("addressUser", v)}
							placeholder="主人"
							full={false}
						/>
					</Field>
					<Field label="自称" code="persona.addressSelf">
						<TInput
							value={draft.persona.addressSelf}
							onChange={(v) => setPersona("addressSelf", v)}
							placeholder="女仆"
							full={false}
						/>
					</Field>
					<Field label="口头禅" code="persona.catchphrase">
						<TInput
							value={draft.persona.catchphrase}
							onChange={(v) => setPersona("catchphrase", v)}
							placeholder="(*´∀`)~♡"
							full={false}
						/>
					</Field>
				</div>
				<Field label="性格特点" code="persona.traits" hint="逗号分隔" full>
					<TInput value={draft.persona.traits} onChange={(v) => setPersona("traits", v)} />
				</Field>
				<Field label="动态点评 prompt" code="ai.dynamicPrompt" full>
					<TArea
						value={draft.dynamicPrompt}
						onChange={(v) => setAi("dynamicPrompt", v)}
						rows={3}
						mono
					/>
				</Field>
				<Field label="直播总结 prompt" code="ai.liveSummaryPrompt" full>
					<TArea
						value={draft.liveSummaryPrompt}
						onChange={(v) => setAi("liveSummaryPrompt", v)}
						rows={4}
						mono
					/>
				</Field>
			</GlassBox>
		</div>
	);
}
