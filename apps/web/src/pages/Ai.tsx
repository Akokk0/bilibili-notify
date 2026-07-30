/**
 * AI page (智能女仆)。
 *
 * 两层 Tab,与 `Cards.tsx` 同一套双层结构(顶部 tab 条 + 左侧 `SectionNav`,
 * 外层 `grid xl:grid-cols-[220px_1fr]`):
 *
 * - **模型配置** —— 左栏列**已添加的服务商**(点添加才出现,同推送目标的适配器)。
 *   点一项 = 切换**我在编辑谁**,不是「换用这一家」—— 后者是「全局配置」里那个
 *   `ai.provider` 选择器的事,与人格那半边的 `activePreset` 同一套语义。右侧是那一家
 *   的整套配置:模型连接 / 图片理解 / 生成参数。哪些字段摆出来由 `AIProviderMeta`
 *   的能力位说了算 —— 摆一个那家根本不支持的选项,主人调了没反应只会以为保存坏了。
 * - **女仆性格** —— 左栏是「默认 + presets[]」。点某一项 = 切换**我在编辑谁**,
 *   不再像旧界面那样把预设复制进 `ai.persona`(点着看看就覆盖掉主人手写的全局
 *   人格)。要套用到全局有单独的「设为默认」按钮。
 *
 * 页面级的两项(总开关、日志等级)不属于任何一家或任何一份人格,分别放在头图与
 * 底部,不进 Tab。
 *
 * 存盘走 PATCH /api/globals { defaults: { ai: ... } }。
 */

import {
	AI_PROVIDER_IDS,
	type AIProviderId,
	type AIProviderProfileShape,
	EMPTY_AI_PROVIDER_PROFILE,
	providerMeta,
	resolveActivePersona,
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
import { PROVIDER_BRANDS, ProviderLogo } from "../components/provider-logos";
import { ProviderPicker } from "../components/provider-picker";
import { RailDot, SectionNav } from "../components/section-nav";
import { TabBar } from "../components/tab-bar";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { api } from "../services/api";
import type { AIPersona, AISettings, GlobalConfig, LogLevel } from "../types/globals";
import {
	addableProviders,
	addedProviders,
	addPersona,
	addProvider,
	duplicatePersona,
	globalPersonaRailId,
	isBuiltinPersona,
	missingBuiltinPersonas,
	personaAt,
	personaRailItems,
	removePersona,
	removeProvider,
	renamePersona,
	resolveEditingProvider,
	resolvePersonaRailId,
	restoreBuiltinPersona,
	setGlobalPersona,
	setGlobalProvider,
	updatePersonaAt,
} from "./ai/model-ops";
import { personaIconKey } from "./ai/persona-icons";
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

type TopTab = "global" | "model" | "persona";

/** 顶部三个 tab。观感与 Rules / Cards 的作用域条同源(共用 `TabBar` 原语)。 */
const TOP_TABS = [
	{ id: "global" as const, label: "全局配置", code: "global" },
	{ id: "model" as const, label: "模型配置", code: "provider" },
	{ id: "persona" as const, label: "女仆性格", code: "persona" },
];

const TAB_HINTS: Record<TopTab, string> = {
	global: "整个 AI 子系统的设置,不分服务商也不分性格",
	model: "每家服务商各存一套,点左栏切换",
	persona: "备着的性格清单;平时用哪一份在「全局配置」里选",
};

/**
 * 逐家摊平服务商的桶,code 走 `ai.providers.<家>.<字段>`(字典里有一条前缀规则
 * 认它们,label / hint / **secret** 全继承 `ai.<字段>` 那条)。
 *
 * 曾经这里只摊平「当前在用的那一家」。左栏改成纯编辑器之后那样就漏了:改别家的桶
 * 在灵动岛眼里毫无变化 —— 保存条不亮,主人一离开页面改动就白做了。
 *
 * 没添加过的那家也摆一副空档案,而不是整个缺席 —— 这一条是**安全项**:`walkTreeDiff`
 * 碰上「一侧是对象、另一侧 undefined」会把整只桶当**一个叶子**吐出来,那一行的值
 * 就是整只桶的 JSON,里面带着**明文 apiKey**(脱敏位挂在字段级,管不到整只桶)。
 * 铺平之后每个字段各走各的 code,该脱敏的照样脱敏。
 *
 * 骨架取 `EMPTY_AI_PROVIDER_PROFILE` 而不是一串 undefined,是为了让「没添加」与
 * 「添加了但一个字没填」在 diff 上**长得一样**:否则光是点一下添加就会亮出五六行
 * `(未设置) → ""` 的噪音。真有内容的桶被删掉时照样逐字段亮;全默认的那只桶靠
 * 下面那行 providerList 兜(它就是为这一刻存在的)。
 */
function packProviders(ai: AISettings): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const id of AI_PROVIDER_IDS) out[id] = ai.providers[id] ?? EMPTY_AI_PROVIDER_PROFILE;
	return out;
}

/**
 * 灵动岛 draft/baseline 打包:walkTreeDiff 输出的 dot-path 跟 FIELD_LABELS
 * 字典 key 对齐(否则 diff panel 归 "其他" 段、click 跳转锚点缺失)。
 *
 * AISettings 字段在 JSX 里 code 风格分两组:
 * - 连接 / 参数:`<Field code={`ai.providers.${家}.apiKey`}>` → `ai.providers` 下逐家
 * - 人格 / 预设:`<Field code="persona.name">` / `code="presets"` → 顶层
 */
function packIsland(ai: AISettings, levelOverride: AiLogLevel) {
	const { dynamicPrompt, liveSummaryPrompt, persona, presets, enabled, provider, activePreset } =
		ai;
	return {
		ai: {
			dynamicPrompt,
			liveSummaryPrompt,
			// 女仆真正在用的是哪一家 —— 它是个**指针**,与左栏在看哪一家无关。
			provider,
			// 「已添加哪几家」的人话版。逐家摊平之后删一家其实也能逐字段看出来,
			// 但那是十来行「(未设置)」;这一行让主人一眼知道到底是加了还是删了。
			providerList: addedProviders(ai).join(","),
			providers: packProviders(ai),
			// 全局用哪份人格是个指针,不改写 persona —— 不显式喂给灵动岛的话,
			// 换一份性格在它眼里毫无变化,保存条不亮。
			activePreset: activePreset ?? "",
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

/** 危险动作的小按钮(删除服务商 / 删除性格)。 */
function DangerButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-md border border-dashed border-bn-danger-border px-2.5 py-1 text-[11.5px] font-bold text-bn-danger-text transition hover:border-bn-danger-text hover:bg-bn-danger-soft"
		>
			{children}
		</button>
	);
}

function GhostButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-md border border-bn-border px-2.5 py-1 text-[11.5px] font-bold text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
		>
			{children}
		</button>
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
	const [tab, setTab] = useState<TopTab>("global");
	// 左栏选中的那份人格。存左栏 id 而不是 presets 下标 —— 下标会在删除时整体前移,
	// 指向另一份人格。空串交给 resolvePersonaRailId 收敛到第一份。
	const [personaRailId, setPersonaRailId] = useState<string>("");
	// 左栏在看哪一家 —— **纯界面状态**,与「女仆在用哪一家」(`ai.provider`)无关。
	// 两者曾经共用一个字段,于是点左栏想看看另一家 = 当场换掉了在用的那家。
	const [editingProvider, setEditingProvider] = useState<AIProviderId | null>(null);
	// 「+ 添加服务商」展开中。一家都没添加时无条件展开(那就是空态引导本身)。
	const [addingProvider, setAddingProvider] = useState(false);
	// 「添加性格」面板展开中(新建空白 / 从内置恢复)。与服务商那半边同一套交互。
	const [addingPersona, setAddingPersona] = useState(false);

	useEffect(() => {
		if (globalsQuery.data) {
			setDraft(globalsQuery.data.defaults.ai);
			setAiLogLevel(globalsQuery.data.app.logLevels?.ai ?? "");
		}
	}, [globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (payload: { ai: AISettings; aiLogLevel: AiLogLevel }) => {
			// 只挑本页编辑的 scope 做 diff:草稿里消失的键(退回「跟随全局」的日志等级、
			// 被删掉的服务商桶)由 buildPatch 变成显式 null,服务端 deepMerge 据此删键。
			// 手写 payload 时这些消失的键会被 JSON.stringify 一起丢掉 → 服务端当「不改」
			// → 删了却没真删。
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

	// 左栏在看的那一家,收敛到真实存在的一家(可能刚被删掉、也可能还没选过)。
	const editing = resolveEditingProvider(draft, editingProvider);
	// 这一家是不是女仆平时用的那家。右上角的按钮与说明条都跟着它 —— 与人格那半边
	// 的 `isGlobalPersona` 同一套语义。
	const isGlobalProvider = editing !== null && editing === draft.provider;
	// 选中服务商的能力描述。**设置页上显示什么由它说了算** —— 摆出一个那家根本
	// 不支持的选项,主人调了没反应,只会以为是保存坏了。
	const meta = providerMeta(editing ?? draft.provider);
	// 正在编辑那家的整套配置。桶可能还不存在(刚切到一家没配过的),
	// resolveAIProfile 兜一套空默认值 —— 表单照常显示空,一编辑即建桶。
	const profile = resolveAIProfile({
		provider: editing ?? draft.provider,
		providers: draft.providers,
	});
	// 头图那颗药丸报的是**女仆真正在用的那家**的模型,与左栏在看哪一家无关。
	const globalProfile = resolveAIProfile(draft);
	// 头图那行名字同理:报的是**女仆真正在用的那份人格**(`activePreset` 指的那份),
	// 与左栏在编辑哪一份无关。直读 `draft.persona` 的话换来换去它一动不动 —— 那个
	// 字段自人格指针上线就没有界面入口、永远冻在老值上。
	const globalPersona = resolveActivePersona(draft).persona;
	// 配了视觉副模型 = 副模型无条件接管,enableVision 与它的地址/密钥两格的
	// 可交互性都跟着这一个判断走(与 CommentaryGenerator#resolveImages 同源)。
	const visionSubModelOn = profile.vision.model.trim().length > 0;
	// 这家开思考时会静默忽略 temperature(DeepSeek 如此)。露着它纯属误导。
	const temperatureLive = !(meta.temperatureIgnoredWhenThinking && profile.enableThinking);

	const added = addedProviders(draft);
	const addable = addableProviders(draft);
	// 一家都没添加 → 右侧直接就是添加面板,那本身就是空态引导。
	const showAddPanel = addingProvider || added.length === 0;

	// 左栏选中项收敛到真实存在的一项,否则会出现「左栏没有任何高亮、右侧却显示着
	// 默认那一份」——高亮项与内容各说各话。
	const activePersonaId = resolvePersonaRailId(draft, personaRailId);
	const personaDraft = personaAt(draft, activePersonaId);
	// 这一份是不是女仆平时用的那份。左栏副标题、右上角按钮与说明条都跟着它。
	const isGlobalPersona = globalPersonaRailId(draft) === activePersonaId;
	const activePresetId =
		personaRailItems(draft).find((i) => i.id === activePersonaId)?.presetId ?? "";
	// 内置那几份是只读的参照库:能删、能「从内置修改」另存一份可改的,但不能就地改
	// —— 改花了「从内置恢复」就没有稳定的东西可恢复了。
	const personaLocked = isBuiltinPersona(activePresetId);
	const restorable = missingBuiltinPersonas(draft);
	const ActivePersonaGlyph =
		Icon[
			personaIconKey(personaRailItems(draft).find((i) => i.id === activePersonaId)?.presetId ?? "")
		];

	function setAi<K extends keyof AISettings>(k: K, v: AISettings[K]): void {
		setDraft((d) => (d ? { ...d, [k]: v } : d));
	}
	/**
	 * 改**正在编辑**那家桶里的一项(不是在用的那家 —— 两者可以不是同一家)。
	 * 桶不存在时按当前显示值(空默认)建出来。
	 */
	function setProfile<K extends keyof AIProviderProfileShape>(
		k: K,
		v: AIProviderProfileShape[K],
	): void {
		if (editing === null) return;
		setDraft((d) =>
			d
				? {
						...d,
						providers: {
							...d.providers,
							[editing]: {
								...resolveAIProfile({ provider: editing, providers: d.providers }),
								[k]: v,
							},
						},
					}
				: d,
		);
	}
	function setVision(k: "baseUrl" | "apiKey" | "model", v: string): void {
		setProfile("vision", { ...profile.vision, [k]: v });
	}
	/** 改当前编辑的那份人格里的一项 —— 落在 `ai.persona` 还是 `presets[i]` 由左栏选中项决定。 */
	function setPersona<K extends keyof AIPersona>(k: K, v: AIPersona[K]): void {
		setDraft((d) =>
			d
				? updatePersonaAt(d, activePersonaId, {
						persona: { ...personaAt(d, activePersonaId).persona, [k]: v },
					})
				: d,
		);
	}
	function setPersonaPrompt(k: "dynamicPrompt" | "liveSummaryPrompt", v: string): void {
		setDraft((d) => (d ? updatePersonaAt(d, activePersonaId, { [k]: v }) : d));
	}

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{/* Hero strip。总开关是页面级的 —— 它既不属于某一家服务商,也不属于某一份人格。 */}
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
							智能女仆 · {globalPersona.name || "女仆"}
							<span data-hero-model>
								<Pill color="#a29bfe" subtle size="sm">
									{globalProfile.model || "未配置"}
								</Pill>
							</span>
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

			{/* 开着总开关却一家都没配 —— 这不是「还没填完」而是**此刻确实不工作**:
			    引擎不会创建实例、发图与点评一律回 400。不偷偷替主人把开关关掉
			    (那是改主人存过的值),也不做点不动的置灰开关,只把话说明白。 */}
			{draft.enabled && added.length === 0 ? (
				<div className="rounded-bn-card border border-bn-warning-border bg-bn-warning-soft px-4 py-3 text-[12.5px] leading-relaxed text-bn-warning-text">
					AI 总开关是开着的，但<strong>一家服务商都还没添加</strong>
					，所以女仆此刻并不会真的写点评。到下面添加一家、填好模型与密钥就好了
				</div>
			) : null}

			<TabBar<TopTab>
				items={TOP_TABS.map((t) => ({
					...t,
					icon:
						t.id === "model" ? (
							<Icon.link size={14} />
						) : t.id === "persona" ? (
							// 「性格」问的是**她是谁**,不是「喜不喜欢」—— 心形读作后者。
							<Icon.user size={14} />
						) : (
							<Icon.gear size={14} />
						),
				}))}
				value={tab}
				onChange={setTab}
				hint={TAB_HINTS[tab]}
			/>

			{tab === "global" ? (
				<div className="flex flex-col gap-4">
					{/* 全局服务商选择 —— 与人格那条同一套语义:这里决定女仆**用**哪一家,
					    「模型配置」那个 Tab 的左栏只决定**在编辑**哪一家。两件事曾经共用
					    `ai.provider`,于是点左栏看看别家 = 当场把在用的那家换掉了。 */}
					<GlassBox
						title="全局服务商 · provider"
						subtitle="女仆平时用哪一家 · ai.provider"
						accent="#6c5ce7"
						icon={<Icon.link size={14} />}
						badge="provider"
					>
						<Field
							code="ai.provider"
							full
							hint={
								added.length === 0
									? "还没添加任何服务商 —— 到「模型配置」那个 Tab 点「+ 添加」加一家"
									: undefined
							}
						>
							<Picker<AIProviderId>
								value={draft.provider}
								onChange={(v) => setDraft((d) => (d ? setGlobalProvider(d, v) : d))}
								options={added.map((id) => ({
									value: id,
									label: providerMeta(id).label,
									color: PROVIDER_BRANDS[id].color,
								}))}
							/>
						</Field>
						<FieldNote>
							这里只决定<strong>用哪一家</strong>，不改它的配置 ——
							密钥、模型、思考那几项在「模型配置」那个 Tab 里填。每家各存一套，换来换去都不会丢
						</FieldNote>
					</GlassBox>

					{/* 全局人格选择 —— 它是个**指针**(ai.activePreset),不改写 ai.persona。
					    切回「默认」时主人手写的那份原封不动地回来;想改内容去「女仆性格」那个 Tab。 */}
					<GlassBox
						title="全局人格 · persona"
						subtitle="女仆平时用哪一份性格 · ai.activePreset"
						accent="#fdcb6e"
						icon={<Icon.heart size={14} />}
						badge="persona"
					>
						<Field
							code="ai.activePreset"
							full
							hint={
								draft.presets.length === 0
									? "还没有别的性格 —— 到「女仆性格」那个 Tab 点「+ 添加」造一份"
									: undefined
							}
						>
							<Picker<string>
								value={globalPersonaRailId(draft)}
								onChange={(v) => setDraft((d) => (d ? setGlobalPersona(d, v) : d))}
								options={personaRailItems(draft).map((i) => ({ value: i.id, label: i.label }))}
							/>
						</Field>
						<FieldNote>
							这里只决定<strong>用哪一份</strong>，不改它的内容 —— 内容在「女仆性格」那个 Tab
							里编辑。 换来换去都不会动到主人手写的那份「默认」
						</FieldNote>
					</GlassBox>

					{/* 日志等级是整个 AI 子系统的,不属于某一家服务商也不属于某一份人格。 */}
					<GlassBox
						title="诊断 · logging"
						subtitle="只影响日志详略，不影响生成 · app.logLevels.ai"
						accent="#94a3b8"
						icon={<Icon.list size={14} />}
						badge="logging"
					>
						<Field code="app.logLevels.ai" full>
							<LogLevelPicker
								value={toPickerValue(aiLogLevel)}
								onChange={(v) => setAiLogLevel(fromPickerValue(v))}
								allowInherit
							/>
						</Field>
					</GlassBox>

					{/* 试一句 —— 调完模型与人格,当场就能问她一句看看效果。 */}
					<AiTestPanel draft={draft} />
				</div>
			) : tab === "model" ? (
				<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
					<SectionNav
						heading="服务商"
						items={added.map((id) => {
							const m = providerMeta(id);
							const bucket = draft.providers[id];
							return {
								id,
								label: m.label,
								desc: bucket?.model || "未填模型",
								// 左栏是**编辑器**,高亮的是「在看谁」。哪一家是女仆真在用的,
								// 靠这颗指示器说 —— 否则两个概念在同一栏里没法区分。
								badge: id === draft.provider ? <RailDot title="女仆平时用的就是这家" /> : undefined,
								icon: <ProviderLogo id={id} size={16} />,
								iconTint: PROVIDER_BRANDS[id].color,
							};
						})}
						activeId={editing}
						onPick={(id) => {
							setEditingProvider(id as AIProviderId);
							setAddingProvider(false);
						}}
						onAdd={addable.length > 0 ? () => setAddingProvider(true) : undefined}
						addLabel="+ 添加"
						emptyState={
							<div className="rounded-[9px] border border-dashed border-bn-border px-3 py-4 text-center text-[11.5px] leading-relaxed text-bn-text-tertiary">
								还没添加任何服务商
								<br />
								先添加一家吧
							</div>
						}
					/>

					<div className="flex min-w-0 flex-col gap-4">
						{showAddPanel ? (
							<GlassBox
								title="添加服务商"
								subtitle="每家各存一套自己的配置 · ai.providers"
								accent="#6c5ce7"
								icon={<Icon.link size={14} />}
								badge="add"
							>
								{addable.length === 0 ? (
									<FieldNote>五家都添加过了 —— 在左栏点一家开始配置吧</FieldNote>
								) : (
									<>
										<FieldNote>
											选哪家决定了「开思考」翻译成哪家的方言（四家四种写法，没有通用解），也决定了这页摆出哪些选项。
											<strong>不按地址猜</strong>
											——
											猜错就是替主人往别家发方言参数。不在这几家里的话选「自定义」，需要什么写到额外请求参数里
										</FieldNote>
										<div className="pt-3">
											<ProviderPicker
												value={null}
												only={addable}
												onChange={(id) => {
													// 添加 ≠ 换用:新加的那家只是**切过去编辑**(否则左栏多一项、
													// 右侧还停在原来那家,像没反应)。要真换用得点「设为默认」。
													setDraft((d) => (d ? addProvider(d, id) : d));
													setEditingProvider(id);
													setAddingProvider(false);
												}}
											/>
										</div>
									</>
								)}
							</GlassBox>
						) : (
							<>
								<GlassBox
									title="模型连接"
									subtitle="OpenAI 兼容 API · ai.providers.<服务商>.{baseUrl,apiKey,model}"
									accent="#6c5ce7"
									icon={<Icon.link size={14} />}
									badge="connection"
									right={
										<div className="flex items-center gap-1.5">
											{/* 「在看这家」不等于「在用这家」。要换用得明确点一下 —— 与人格
											    那半边的「设为默认」同一个动作、同一句话。 */}
											{isGlobalProvider || editing === null ? null : (
												<GhostButton
													onClick={() => setDraft((d) => (d ? setGlobalProvider(d, editing) : d))}
												>
													设为默认
												</GhostButton>
											)}
											<DangerButton
												onClick={() =>
													setDraft((d) => (d && editing !== null ? removeProvider(d, editing) : d))
												}
											>
												删除 {meta.label}
											</DangerButton>
										</div>
									}
								>
									{isGlobalProvider ? (
										<FieldNote>
											<strong>女仆平时用的就是这家</strong>。改哪一项都立刻算数
										</FieldNote>
									) : (
										<FieldNote>
											这一家<strong>现在没在用</strong>
											，配置照样存着。想让女仆换用它，点右上角「设为默认」（或到「全局配置」里选）
										</FieldNote>
									)}
									<Field code={`ai.providers.${editing}.apiKey`} required>
										<TInput
											value={profile.apiKey}
											onChange={(v) => setProfile("apiKey", v)}
											secret
											mono
										/>
									</Field>
									<Field
										code={`ai.providers.${editing}.baseUrl`}
										full
										hint={`${meta.label}：${meta.baseUrlHint}`}
									>
										<TInput
											value={profile.baseUrl}
											onChange={(v) => setProfile("baseUrl", v)}
											mono
											placeholder={meta.baseUrlHint}
										/>
									</Field>
									<Field code={`ai.providers.${editing}.model`}>
										<TInput
											value={profile.model}
											onChange={(v) => setProfile("model", v)}
											mono
											full={false}
										/>
									</Field>
								</GlassBox>

								{/* 图片理解。它同样是在描述「接哪个模型」,只不过整块可以不填:
								    两条路都不开时,发图会被明确拒绝而不是静默丢掉。 */}
								<GlassBox
									title="图片理解"
									subtitle="两条路二选一 · ai.providers.<服务商>.{enableVision,vision}"
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
											<Field code={`ai.providers.${editing}.enableVision`}>
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
													已配视觉模型，图一律先经它转成文字 —— 上面那个开关
													<strong>暂不生效</strong>。 想让主模型自己看图的话，把下面的视觉模型 ID
													清空
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
									{/* 密钥 → 地址 → 模型,与上面「模型连接」**同序**:两块摆的是同一件事
									    (接哪个模型),顺序各走各的只会让人以为这是另一种东西。

									    地址与密钥**恒在场**,不等填了模型 ID 才现身。这块存在的前提就是主模型
									    那家没有视觉模型,副模型多半在另一家 —— 藏起来的话主人打开只看见一个
									    模型 ID 框,结论是「没法给它单配地址和密钥」,而副标题偏偏还写着有。
									    三格全是选填(留空即跟随主模型 / 不启用),摆着不会被当成漏填。 */}
									<Field code={`ai.providers.${editing}.vision.apiKey`} full>
										<TInput
											value={profile.vision.apiKey}
											onChange={(v) => setVision("apiKey", v)}
											secret
											mono
											placeholder="留空则跟随上面主模型的 apiKey"
										/>
									</Field>
									<Field code={`ai.providers.${editing}.vision.baseUrl`} full>
										<TInput
											value={profile.vision.baseUrl}
											onChange={(v) => setVision("baseUrl", v)}
											mono
											placeholder="留空则跟随上面主模型的 baseUrl"
										/>
									</Field>
									<Field code={`ai.providers.${editing}.vision.model`} full>
										<TInput
											value={profile.vision.model}
											onChange={(v) => setVision("model", v)}
											mono
											placeholder="留空则不启用，例如 Qwen/Qwen2.5-VL-32B-Instruct"
										/>
									</Field>
								</GlassBox>

								{/* 生成参数 —— temperature 与深度思考同属「这一次请求怎么生成」,合成一块。
								    思考那半边的可见形态取决于这一家:各家写法不同,兜底档索性不发。 */}
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
										<Field code={`ai.providers.${editing}.temperature`}>
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
											{meta.label} 一开思考就会<strong>忽略 temperature</strong>
											（连同 top_p 那几个）， 调了也不生效，所以先收起来。关掉下面的深度思考它就回来
										</FieldNote>
									)}
									{meta.supportsThinking ? (
										<>
											<Field code={`ai.providers.${editing}.enableThinking`}>
												<div className="flex h-7.5 items-center">
													<Toggle
														value={profile.enableThinking}
														onChange={(v) => setProfile("enableThinking", v)}
														ariaLabel="深度思考"
													/>
												</div>
											</Field>
											{profile.enableThinking ? (
												<Field code={`ai.providers.${editing}.thinkingLevel`} full>
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
											这一家是「自定义」，女仆不会自作主张发任何服务商专属参数（发错了几乎必然报错）。
											需要开思考的话，把那家的写法填到下面的额外请求参数里
										</FieldNote>
									)}
									<Field code={`ai.providers.${editing}.extraParams`} full>
										<TArea
											value={profile.extraParams}
											onChange={(v) => setProfile("extraParams", v)}
											rows={4}
											mono
											placeholder={'{"enable_search": true}'}
										/>
									</Field>
								</GlassBox>
							</>
						)}
					</div>
				</div>
			) : (
				<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
					<SectionNav
						heading="性格"
						items={personaRailItems(draft).map((item) => {
							// 四份内置的各有各的样子(主人一眼要认出哪个是哪个);自己加的
							// 用通用小人像。映射与漏画守卫见 ./ai/persona-icons。
							const Glyph = Icon[personaIconKey(item.presetId)];
							return {
								id: item.id,
								label: item.label,
								// 与服务商那栏同一颗指示器。此前这里写的是一行副标题文字,
								// 两栏各说各的;共用之后观感只有一处定义。
								badge:
									globalPersonaRailId(draft) === item.id ? (
										<RailDot title="女仆平时用的就是这份" />
									) : undefined,
								icon: <Glyph size={14} />,
							};
						})}
						activeId={activePersonaId}
						onPick={(id) => {
							setPersonaRailId(id);
							setAddingPersona(false);
						}}
						onAdd={() => setAddingPersona(true)}
						addLabel="+ 添加"
					/>

					<div className="flex min-w-0 flex-col gap-4">
						{addingPersona ? (
							<GlassBox
								title="添加性格"
								subtitle="新建一份,或把删掉的内置那份找回来 · ai.presets[]"
								accent="#fdcb6e"
								icon={<Icon.plus size={14} />}
								badge="add"
							>
								<Field code="presets" label="新建" full>
									<GhostButton
										onClick={() => {
											// 新建即切过去 —— 否则左栏多一项、右侧还停在原来那份,像没反应。
											const next = draft ? addPersona(draft) : null;
											if (!next) return;
											setDraft(next.ai);
											setPersonaRailId(next.railId);
											setAddingPersona(false);
										}}
									>
										+ 空白性格
									</GhostButton>
								</Field>
								{restorable.length > 0 ? (
									<Field
										code="presets"
										label="从内置恢复"
										hint="内置那几份删掉之后还能找回来,内容与出厂时一致"
										full
									>
										<div className="flex flex-wrap gap-1.5">
											{restorable.map((b) => {
												const Glyph = Icon[personaIconKey(b.id)];
												return (
													<button
														type="button"
														key={b.id}
														onClick={() => {
															const next = restoreBuiltinPersona(draft, b.id);
															setDraft(next.ai);
															setPersonaRailId(next.railId);
															setAddingPersona(false);
														}}
														className="flex items-center gap-1.5 rounded-md border border-bn-border px-2.5 py-1 text-[11.5px] font-bold text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
													>
														<Glyph size={13} />
														{b.label}
													</button>
												);
											})}
										</div>
									</Field>
								) : (
									<FieldNote>内置那四份都在清单里 —— 没有可恢复的</FieldNote>
								)}
							</GlassBox>
						) : (
							<GlassBox
								title="人格塑造 · persona"
								subtitle="这一份的口吻与称呼 · ai.presets[]"
								accent="#fdcb6e"
								icon={<ActivePersonaGlyph size={14} />}
								badge="persona"
								right={
									<div className="flex items-center gap-1.5">
										{/* 内置那份改不动 —— 给一条出路:以它为蓝本另存一份可改的。 */}
										{personaLocked ? (
											<GhostButton
												onClick={() => {
													const next = duplicatePersona(draft, activePersonaId);
													setDraft(next.ai);
													setPersonaRailId(next.railId);
												}}
											>
												从内置修改
											</GhostButton>
										) : null}
										{isGlobalPersona ? null : (
											<GhostButton
												onClick={() =>
													setDraft((d) => (d ? setGlobalPersona(d, activePersonaId) : d))
												}
											>
												设为默认
											</GhostButton>
										)}
										{/* 最后一份删不掉 —— AI 总得有一份人格。按钮直接不摆,
									    好过摆一个点了没反应的。 */}
										{draft.presets.length > 1 ? (
											<DangerButton
												onClick={() => {
													setDraft((d) => (d ? removePersona(d, activePersonaId) : d));
													setPersonaRailId("");
												}}
											>
												删除
											</DangerButton>
										) : null}
									</div>
								}
							>
								{personaLocked ? (
									<FieldNote>
										这是<strong>内置性格</strong>，锁着不让改 —— 有它在，删掉之后才能原样恢复回来。
										想在它的基础上调整，点右上角
										<strong>「从内置修改」</strong>另存一份可改的
									</FieldNote>
								) : null}
								{isGlobalPersona ? (
									<FieldNote>
										女仆<strong>平时用的就是这一份</strong>。改哪个字段都立刻算数
									</FieldNote>
								) : (
									<FieldNote>
										这一份<strong>现在没在用</strong>
										。它备着给单个 UP 指定（订阅页的 AI
										覆盖里选），想让女仆平时就用它，点右上角「设为默认」
									</FieldNote>
								)}
								<Field code="presets" label="性格名称" full>
									<TInput
										value={
											personaRailItems(draft).find((i) => i.id === activePersonaId)?.label ?? ""
										}
										onChange={(v) =>
											setDraft((d) => (d ? renamePersona(d, activePersonaId, v) : d))
										}
										placeholder="傲娇"
									/>
								</Field>
								<div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
									<Field code="persona.name">
										<TInput
											value={personaDraft.persona.name}
											disabled={personaLocked}
											onChange={(v) => setPersona("name", v)}
											placeholder="女仆"
											full={false}
										/>
									</Field>
									<Field code="persona.addressUser">
										<TInput
											value={personaDraft.persona.addressUser}
											disabled={personaLocked}
											onChange={(v) => setPersona("addressUser", v)}
											placeholder="主人"
											full={false}
										/>
									</Field>
									<Field code="persona.addressSelf">
										<TInput
											value={personaDraft.persona.addressSelf}
											disabled={personaLocked}
											onChange={(v) => setPersona("addressSelf", v)}
											placeholder="女仆"
											full={false}
										/>
									</Field>
									<Field code="persona.catchphrase">
										<TInput
											value={personaDraft.persona.catchphrase}
											disabled={personaLocked}
											onChange={(v) => setPersona("catchphrase", v)}
											placeholder="(*´∀`)~♡"
											full={false}
										/>
									</Field>
								</div>
								<Field code="persona.traits" full>
									<TInput
										value={personaDraft.persona.traits}
										disabled={personaLocked}
										onChange={(v) => setPersona("traits", v)}
									/>
								</Field>
								<Field code="persona.baseRole" full>
									<TArea
										value={personaDraft.persona.baseRole}
										disabled={personaLocked}
										onChange={(v) => setPersona("baseRole", v)}
										rows={2}
									/>
								</Field>
								<Field code="persona.extraSystemPrompt" full>
									<TArea
										value={personaDraft.persona.extraSystemPrompt}
										disabled={personaLocked}
										onChange={(v) => setPersona("extraSystemPrompt", v)}
										rows={2}
									/>
								</Field>
								{/* 预设的两段 prompt 是可选的:留空 = 跟随「默认」那一份(存回 undefined)。
							    这个提示必须写清楚,否则清空之后主人无从知道是「跟随」还是「强制发空」。 */}
								<Field code="ai.dynamicPrompt" full hint="留空则用内置的通用提示词">
									<TArea
										value={personaDraft.dynamicPrompt}
										disabled={personaLocked}
										onChange={(v) => setPersonaPrompt("dynamicPrompt", v)}
										rows={3}
										mono
									/>
								</Field>
								<Field code="ai.liveSummaryPrompt" full hint="留空则用内置的通用提示词">
									<TArea
										value={personaDraft.liveSummaryPrompt}
										disabled={personaLocked}
										onChange={(v) => setPersonaPrompt("liveSummaryPrompt", v)}
										rows={4}
										mono
									/>
								</Field>
							</GlassBox>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
