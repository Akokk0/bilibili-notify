/**
 * AI page (智能女仆) — port of `SmartMaidContent` from
 * `.bn-design/variation-ac-plugins.jsx`.
 *
 * Bound to GlobalConfig.defaults.ai. GlassBoxes:
 *   1. 模型连接 — provider 平铺选择 + apiKey / baseUrl / model / log level
 *   2. 图片理解 · vision — enableVision / vision.{model,baseUrl,apiKey}。与 1 并排,
 *      因为它同样在描述「接哪个模型」,只是整块可以不填
 *   3. 生成参数 — temperature + 深度思考(enableThinking / thinkingLevel / extraParams)。
 *      思考那半边的可见形态取决于 1 里选的服务商:各家写法不一样,兜底档什么都不发
 *   4. 人格塑造 — preset + persona{name,addressUser,addressSelf,traits,
 *      catchphrase} + dynamicPrompt + liveSummaryPrompt
 *
 * Saves through PATCH /api/globals { defaults: { ai: ... } }.
 */

import {
	type AIProviderProfileShape,
	providerMeta,
	resolveAIProfile,
	type ThinkingLevel,
} from "@bilibili-notify/internal/constants";
import { buildPatch } from "@bilibili-notify/internal/patch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pill, Toggle } from "../components/atoms";
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
import { ProviderPicker } from "../components/provider-picker";
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
	const { dynamicPrompt, liveSummaryPrompt, persona, presets, enabled, provider } = ai;
	// 连接与生成参数住在服务商桶里,但灵动岛的 dot-path 必须与 FIELD_LABELS 的键
	// 对齐(否则改动列表全落「其他」段、锚点跳转也失效)。所以这里把**当前生效那家**
	// 的桶摊平回 `ai.*` 命名空间 —— 页面一次只编辑一家,摊平后的 diff 正是主人看到的。
	const p = resolveAIProfile(ai);
	return {
		ai: {
			apiKey: p.apiKey,
			baseUrl: p.baseUrl,
			model: p.model,
			temperature: p.temperature,
			dynamicPrompt,
			liveSummaryPrompt,
			enableVision: p.enableVision,
			vision: p.vision,
			provider,
			enableThinking: p.enableThinking,
			thinkingLevel: p.thinkingLevel,
			extraParams: p.extraParams,
		},
		persona,
		presets,
		enabled,
		app: { logLevels: { ai: levelOverride === "" ? null : levelOverride } },
	};
}

/**
 * 说明条。本页几乎每条都在解释**为什么某个选项看起来不做事、或者干脆不见了**
 * —— 兜底档不发方言参数、默认开思考的家关位反而要发东西、DeepSeek 没有视觉模型、
 * 思考时 temperature 被忽略。不写清楚,主人只会觉得开关坏了或者设置没存上。
 */
function FieldNote({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-bn-border-subtle bg-bn-surface-muted px-3 py-2 text-[11.5px] leading-relaxed text-bn-text-secondary">
			{children}
		</div>
	);
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
			// 只挑本页编辑的 scope 做 diff:草稿里消失的键(退回「跟随全局」的日志等级、
			// 被清空的 apiKey)由 buildPatch 变成显式 null。手写 payload 时 apiKey 清空
			// 会被 JSON.stringify 连键一起丢掉 → 服务端当「不改」→ 旧 key 一直留着。
			const base = globalsQuery.data;
			return await api.patch<GlobalConfig>(
				"/api/globals",
				buildPatch(
					{
						app: { logLevels: { ai: payload.aiLogLevel || undefined } },
						defaults: { ai: payload.ai },
					},
					{
						app: { logLevels: { ai: base?.app.logLevels?.ai } },
						defaults: { ai: base?.defaults.ai },
					},
				),
			);
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

	// 选中服务商的能力描述。**设置页上显示什么由它说了算** —— 摆出一个那家根本
	// 不支持的选项,主人调了没反应,只会以为是保存坏了。
	const meta = providerMeta(draft.provider);
	// 当前生效那家的整套配置。桶可能还不存在(刚切到一家没配过的),
	// resolveAIProfile 兜一套空默认值 —— 表单照常显示空,一编辑即建桶。
	const profile = resolveAIProfile(draft);
	// 配了视觉副模型 = 副模型无条件接管,enableVision 与它的地址/密钥两格的
	// 可交互性都跟着这一个判断走(与 CommentaryGenerator#resolveImages 同源)。
	const visionSubModelOn = profile.vision.model.trim().length > 0;
	// 这家开思考时会静默忽略 temperature(DeepSeek 如此)。露着它纯属误导。
	const temperatureLive = !(meta.temperatureIgnoredWhenThinking && profile.enableThinking);

	function setAi<K extends keyof AISettings>(k: K, v: AISettings[K]): void {
		setDraft((d) => (d ? { ...d, [k]: v } : d));
	}
	/** 改当前那家桶里的一项。桶不存在时按当前显示值(空默认)建出来。 */
	function setProfile<K extends keyof AIProviderProfileShape>(
		k: K,
		v: AIProviderProfileShape[K],
	): void {
		setDraft((d) =>
			d
				? {
						...d,
						providers: {
							...d.providers,
							[d.provider]: { ...resolveAIProfile(d), [k]: v },
						},
					}
				: d,
		);
	}
	function setPersona<K extends keyof AIPersona>(k: K, v: AIPersona[K]): void {
		setDraft((d) => (d ? { ...d, persona: { ...d.persona, [k]: v } } : d));
	}
	function setVision(k: "baseUrl" | "apiKey" | "model", v: string): void {
		setProfile("vision", { ...profile.vision, [k]: v });
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
								{profile.model || "未配置"}
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
					subtitle="OpenAI 兼容 API · ai.{provider,baseUrl,apiKey,model}"
					accent="#6c5ce7"
					icon={<Icon.link size={14} />}
					badge="connection"
				>
					<Field code="ai.provider" full>
						<ProviderPicker value={draft.provider} onChange={(v) => setAi("provider", v)} />
					</Field>
					<Field code="ai.apiKey" required>
						<TInput value={profile.apiKey} onChange={(v) => setProfile("apiKey", v)} secret mono />
					</Field>
					<Field code="ai.baseUrl" full>
						<TInput
							value={profile.baseUrl}
							onChange={(v) => setProfile("baseUrl", v)}
							mono
							placeholder="https://api.openai.com/v1"
						/>
					</Field>
					<Field code="ai.model">
						<TInput
							value={profile.model}
							onChange={(v) => setProfile("model", v)}
							mono
							full={false}
						/>
					</Field>
					<Field code="app.logLevels.ai" full>
						<LogLevelPicker
							value={toPickerValue(aiLogLevel)}
							onChange={(v) => setAiLogLevel(fromPickerValue(v))}
							allowInherit
						/>
					</Field>
				</GlassBox>

				{/* 图片理解。与「模型连接」并排 —— 它同样是在描述「接哪个模型」,
				    只不过整块可以不填:两条路都不开时,发图会被明确拒绝而不是静默丢掉。 */}
				<GlassBox
					title="图片理解 · vision"
					subtitle="两条路二选一 · ai.enableVision / ai.vision.{model,baseUrl,apiKey}"
					accent="#00b894"
					icon={<Icon.image size={14} />}
					badge="vision"
				>
					{/* 这家根本没有视觉模型(DeepSeek 官方接口一个都没有)的话,「主模型
					    支持看图」是个永远为否的问题,整格不摆出来 —— 摆出来只会让人勾了
					    发现没用。服务端的发图守卫也按同一条能力判断,两边同源。 */}
					{meta.supportsVision ? (
						<>
							{/* 配了视觉模型之后这个开关**完全不生效**(副模型无条件优先)。与其
							    只写在说明里,不如让它在那一刻就点不动 —— 否则一个能勾上、勾了
							    却什么也不改变的开关,比没有还糟。 */}
							<Field code="ai.enableVision">
								<div className="flex h-7.5 items-center">
									<Toggle
										value={profile.enableVision}
										onChange={(v) => setProfile("enableVision", v)}
										disabled={visionSubModelOn}
										ariaLabel="主模型支持看图"
									/>
								</div>
							</Field>
							{visionSubModelOn ? (
								<FieldNote>
									已配视觉模型，图一律先经它转成文字 —— 上面那个开关<strong>暂不生效</strong>。
									想让主模型自己看图的话，把下面的视觉模型 ID 清空
								</FieldNote>
							) : null}
						</>
					) : (
						<FieldNote>
							{meta.label} 的接口里<strong>没有能看图的模型</strong>
							，所以「主模型自己看图」这条路走不通。
							想让女仆看得见图，填下面的视觉模型（可以是别家的）
						</FieldNote>
					)}
					<Field code="ai.vision.model" full>
						<TInput
							value={profile.vision.model}
							onChange={(v) => setVision("model", v)}
							mono
							placeholder="留空则不启用，例如 Qwen/Qwen2.5-VL-32B-Instruct"
						/>
					</Field>
					{/* 副模型的地址与密钥只在真配了副模型时才有意义 —— 没填 model 时
					    这两格根本不参与任何请求,摆着只会让人以为漏填了。 */}
					{visionSubModelOn ? (
						<>
							<Field code="ai.vision.baseUrl" full>
								<TInput
									value={profile.vision.baseUrl}
									onChange={(v) => setVision("baseUrl", v)}
									mono
									placeholder="留空则跟随上面主模型的 baseUrl"
								/>
							</Field>
							<Field code="ai.vision.apiKey" full>
								<TInput
									value={profile.vision.apiKey}
									onChange={(v) => setVision("apiKey", v)}
									secret
									mono
									placeholder="留空则跟随上面主模型的 apiKey"
								/>
							</Field>
						</>
					) : null}
				</GlassBox>
			</div>

			{/* 生成参数 —— temperature 与深度思考同属「这一次请求怎么生成」,合成一块。
			    思考那半边的可见形态取决于上面选的服务商:各家写法不同,兜底档索性不发。 */}
			<GlassBox
				title="生成参数"
				subtitle="temperature / 深度思考 · ai.{temperature,enableThinking,thinkingLevel,extraParams}"
				accent="#a29bfe"
				icon={<Icon.sparkle size={14} />}
				badge="generation"
			>
				{/* 这家开思考时会静默忽略 temperature(DeepSeek 明确如此) —— 不报错也不
				    生效,摆着让人调只会以为设置没存上。收起来并说明原因。 */}
				{temperatureLive ? (
					<Field code="ai.temperature">
						<TNum
							value={profile.temperature}
							onChange={(v) => setProfile("temperature", v)}
							min={0}
							max={2}
							step={0.1}
							width={100}
						/>
					</Field>
				) : (
					<FieldNote>
						{meta.label} 一开思考就会<strong>忽略 temperature</strong>（连同 top_p 那几个），
						调了也不生效，所以先收起来。关掉下面的深度思考它就回来
					</FieldNote>
				)}
				{meta.supportsThinking ? (
					<>
						<Field code="ai.enableThinking">
							<div className="flex h-7.5 items-center">
								<Toggle
									value={profile.enableThinking}
									onChange={(v) => setProfile("enableThinking", v)}
									ariaLabel="深度思考"
								/>
							</div>
						</Field>
						{profile.enableThinking ? (
							<Field code="ai.thinkingLevel" full>
								<Picker<ThinkingLevel>
									value={profile.thinkingLevel}
									onChange={(v) => setProfile("thinkingLevel", v)}
									options={[
										{ value: "low", label: "低" },
										{ value: "medium", label: "中" },
										{ value: "high", label: "高" },
									]}
								/>
							</Field>
						) : null}
						{meta.thinkingDefaultsOn && !profile.enableThinking ? (
							<FieldNote>
								{meta.label} 的思考模型<strong>默认就是开着</strong>的 ——
								正因为如此，关掉这个开关女仆会显式告诉它别想那么久，而不是什么都不发
							</FieldNote>
						) : null}
					</>
				) : (
					<FieldNote>
						服务商选了「自定义」，女仆不会自作主张发任何服务商专属参数（发错了几乎必然报错）。
						需要开思考的话，把那家的写法填到下面的额外请求参数里
					</FieldNote>
				)}
				<Field code="ai.extraParams" full>
					<TArea
						value={profile.extraParams}
						onChange={(v) => setProfile("extraParams", v)}
						rows={4}
						mono
						placeholder={'{"enable_search": true}'}
					/>
				</Field>
			</GlassBox>

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
