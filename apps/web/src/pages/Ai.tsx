/**
 * AI page (智能女仆)。
 *
 * 两层 Tab,与 `Cards.tsx` 同一套双层结构(顶部 tab 条 + 左侧 `SectionNav`,
 * 外层 `grid xl:grid-bn-rail`):
 *
 * - **模型配置** —— 左栏列**已添加的服务商实例**(点添加才出现;同一家可以有多份,
 *   比如两个 DeepSeek 号)。点一项 = 切换**我在编辑谁**,不是「换用这一份」—— 后者是
 *   「全局配置」里那个 `ai.activeProfile` 选择器的事,与人格那半边的 `activePreset`
 *   同一套语义。右侧是那一份的整套配置:模型连接 / 图片理解 / 生成参数。哪些字段
 *   摆出来由 `AIProviderMeta` 的能力位说了算 —— 摆一个那家根本不支持的选项,
 *   主人调了没反应只会以为保存坏了。
 * - **女仆性格** —— 左栏是没删的内置(内容取当前语言,设置里只记删了哪几份)加主人自己的 `presets[]`。
 *   点某一项 = 切换**我在编辑谁**,不是「换用这一份」。要套用到全局有单独的「设为默认」按钮。
 *
 * 总开关不属于任何一家或任何一份人格,放在头图上,不进 Tab。(曾经并排摆在底部的
 * 日志等级已整体搬去系统页那格「按模块覆盖」,与另外四个模块同住。)
 *
 * 存盘走 PATCH /api/settings { ai: ... }。
 */

import type { SecretCellDraft } from "@bilibili-notify/contract";
import {
	type APIFlavorId,
	canProfileThink,
	EMPTY_AI_PROVIDER_PROFILE,
	providerMeta,
	resolveActivePersona,
	resolveAIProfile,
	type ThinkingLevel,
	WEB_SEARCH_BACKENDS,
	webSearchBackendMeta,
} from "@bilibili-notify/internal/ai";
import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import { buildPatch } from "@bilibili-notify/internal/patch";
import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import {
	Btn,
	DraftSecretInput,
	EmptyNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Pill,
	RailDot,
	SectionNav,
	TabBar,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Field, Picker, TArea, TInput } from "../components/forms";
import { HeroStrip } from "../components/hero-strip";
import { PROVIDER_BRANDS, ProviderLogo } from "../components/provider-logos";
import { ProviderPicker } from "../components/provider-picker";
import { AI_PURPLE } from "../config/colors";
import { SECTION_ACCENT } from "../config/section-accents";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../hooks/useSettings";
import { useT } from "../i18n/index";
import type {
	AIPersona,
	AIProviderProfileDraft,
	AISettingsDraft,
	GlobalConfigPatch,
} from "../types/globals";
import { MaidSkills } from "./ai/MaidSkills";
import {
	addPersona,
	addProfile,
	duplicatePersona,
	globalPersonaRailId,
	isBuiltinPersona,
	missingBuiltinPersonas,
	personaAt,
	personaRailItems,
	profileRailItems,
	removePersona,
	removeProfile,
	renamePersona,
	renameProfile,
	resolveEditingProfile,
	resolvePersonaRailId,
	restoreBuiltinPersona,
	setActiveProfile,
	setGlobalPersona,
	updatePersonaAt,
} from "./ai/model-ops";
import { personaIconKey } from "./ai/persona-icons";
import { AiTestPanel } from "./ai/TestPanel";

type TopTab = "global" | "model" | "persona" | "skills";

/** 顶部四个 tab。观感与 Rules / Cards 的作用域条同源(共用 `TabBar` 原语)。 */

/**
 * 逐实例摊平桶,code 走 `ai.providers.<实例>.<字段>`(字典里有一条前缀规则
 * 认它们,label / hint / **secret** 全继承 `ai.<字段>` 那条)。
 *
 * 曾经这里只摊平「当前在用的那一份」。左栏改成纯编辑器之后那样就漏了:改别份的桶
 * 在灵动岛眼里毫无变化 —— 保存条不亮,主人一离开页面改动就白做了。
 *
 * `keys` 是 draft 与 baseline 的**键并集**:只在一侧存在的实例(刚添加 / 刚删掉)
 * 在另一侧摆一副空档案,而不是整个缺席 —— 这一条是**安全项**:`walkTreeDiff`
 * 碰上「一侧是对象、另一侧 undefined」会把整只桶当**一个叶子**吐出来,那一行的值
 * 就是整只桶的 JSON,里面带着**明文 apiKey**(脱敏位挂在字段级,管不到整只桶)。
 * 铺平之后每个字段各走各的 code,该脱敏的照样脱敏。
 *
 * 骨架取 `EMPTY_AI_PROVIDER_PROFILE` 而不是一串 undefined,是为了让「没添加」与
 * 「添加了但一个字没填」在 diff 上**长得一样**:否则光是点一下添加就会亮出五六行
 * `(未设置) → ""` 的噪音。真有内容的桶被删掉时照样逐字段亮;全默认的那只桶靠
 * 下面那行 providerList 兜(它就是为这一刻存在的)。
 */
function packProviders(ai: AISettingsDraft, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const id of keys) out[id] = ai.providers[id] ?? EMPTY_AI_PROVIDER_PROFILE;
	return out;
}

/**
 * 灵动岛 draft/baseline 打包:walkTreeDiff 输出的 dot-path 跟 FIELD_LABELS
 * 字典 key 对齐(否则 diff panel 归 "其他" 段、click 跳转锚点缺失)。
 *
 * AISettings 字段在 JSX 里 code 风格分两组:
 * - 连接 / 参数:`<Field code={`ai.providers.${家}.apiKey`}>` → `ai.providers` 下逐家
 * - 人格 / 预设:`<Field code="persona.name">` / `code="presets"` → 顶层(只有主人自己的那几份;内置的不落盘)
 */
function packIsland(ai: AISettingsDraft, providerKeys: readonly string[]) {
	const { presets, removedBuiltinPresets, enabled, activeProfile, activePreset, search } = ai;
	return {
		ai: {
			// `ai.chat`(聊天页的思考等级)**不在**这里:它的编辑口在聊天侧栏的
			// 「设置」弹层,点档位立即 PATCH,不走本页的草稿 + 保存条。
			// 联网搜索(后端 / key / 引擎开关)。两侧都经 schema 补齐,恒为完整对象,
			// 不会踩「一侧 undefined 整块当叶子」那个明文 key 外泄的坑。
			search: {
				backend: search.backend,
				keys: search.keys,
				engines: {
					dynamic: search.scenes.post,
					live: search.scenes.live,
					roast: search.scenes.roast,
				},
			},
			// 女仆真正在用的是哪一份实例 —— 它是个**指针**,与左栏在看哪一份无关。
			activeProfile,
			// 「已添加哪几份」的人话版。逐实例摊平之后删一份其实也能逐字段看出来,
			// 但那是十来行「(未设置)」;这一行让主人一眼知道到底是加了还是删了。
			providerList: profileRailItems(ai)
				.map((i) => i.id)
				.join(","),
			providers: packProviders(ai, providerKeys),
			// 全局用哪份人格是个指针,不改写 persona —— 不显式喂给灵动岛的话,
			// 换一份性格在它眼里毫无变化,保存条不亮。
			activePreset: activePreset ?? "",
			// 删掉了哪几份内置:内置不落盘、删一份 `presets` 不会变,不喂进去的话删内置保存条不亮。
			removedBuiltinPresets: (removedBuiltinPresets ?? []).join(","),
		},
		presets,
		enabled,
	};
}

/**
 * 说明条。本页几乎每条都在解释**为什么某个选项看起来不做事、或者干脆不见了**
 * —— 兜底档不发方言参数、默认开思考的家关位反而要发东西、DeepSeek 没有视觉模型。
 * 不写清楚,主人只会觉得开关坏了或者设置没存上。
 */
function FieldNote({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-bn-border-subtle bg-bn-surface-muted px-3 py-2 text-bn-xs leading-relaxed text-bn-text-secondary">
			{children}
		</div>
	);
}

export default function Ai() {
	const tx = useT();
	const TOP_TABS = [
		{ id: "global" as const, label: tx("aiSettings.page.tabs.global"), code: "global" },
		{ id: "model" as const, label: tx("aiSettings.page.tabs.model"), code: "provider" },
		{ id: "persona" as const, label: tx("aiSettings.page.tabs.persona"), code: "persona" },
		// 技能不是配置(自己的一份 REST 资源),所以它的 `code` 与整页那条保存栏无关
		// —— 这一栏底下自带保存。摆在这儿只是因为「她是谁」与「她会做什么」该挨着。
		{ id: "skills" as const, label: tx("aiSettings.page.tabs.skills"), code: "skills" },
	];

	const TAB_HINTS: Record<TopTab, string> = {
		global: tx("aiSettings.page.tabs.globalHint"),
		model: tx("aiSettings.page.tabs.modelHint"),
		persona: tx("aiSettings.page.tabs.personaHint"),
		skills: tx("aiSettings.page.tabs.skillsHint"),
	};
	const qc = useQueryClient();
	const globalsQuery = useCoreSettings();

	const [draft, setDraft] = useState<AISettingsDraft | null>(null);
	const [tab, setTab] = useState<TopTab>("global");
	// 左栏选中的那份人格。存左栏 id 而不是 presets 下标 —— 下标会在删除时整体前移,
	// 指向另一份人格。空串交给 resolvePersonaRailId 收敛到第一份。
	const [personaRailId, setPersonaRailId] = useState<string>("");
	// 左栏在看哪一份实例 —— **纯界面状态**,与「女仆在用哪一份」(`ai.activeProfile`)
	// 无关。两者曾经共用一个字段,于是点左栏想看看另一份 = 当场换掉了在用的那份。
	const [editingProfile, setEditingProfile] = useState<string | null>(null);
	// 「+ 添加服务商」展开中。一家都没添加时无条件展开(那就是空态引导本身)。
	const [addingProvider, setAddingProvider] = useState(false);
	// 「添加性格」面板展开中(新建空白 / 从内置恢复)。与服务商那半边同一套交互。
	const [addingPersona, setAddingPersona] = useState(false);

	useEffect(() => {
		if (globalsQuery.data) {
			setDraft(globalsQuery.data.ai);
		}
	}, [globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (payload: { ai: AISettingsDraft }) => {
			// 只挑本页编辑的 scope 做 diff:草稿里消失的键(被删掉的服务商桶)由
			// buildPatch 变成显式 null,服务端 deepMerge 据此删键。手写 payload 时这些
			// 消失的键会被 JSON.stringify 一起丢掉 → 服务端当「不改」→ 删了却没真删。
			const base = globalsQuery.data;
			// 草稿的密钥格类型上还可能是遮挡,但两边都是遮挡(没动)的格 buildPatch 不发,换了的是明文 ——
			// 发出去的正是核心那份的补丁。
			return await patchCoreSettings(
				buildPatch({ ai: payload.ai }, { ai: base?.ai }) as GlobalConfigPatch,
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
			setDraft(next.core.ai);
			qc.invalidateQueries({ queryKey: SETTINGS_KEY });
		},
	});

	// draft 与 baseline 的实例键**并集** —— 两侧同键打包,刚添加 / 刚删掉的实例
	// 在缺席的那侧摆空档案,免得 walkTreeDiff 把整只桶(含明文 key)当一个叶子吐出来。
	const providerKeys = useMemo(() => {
		const keys = new Set<string>(Object.keys(draft?.providers ?? {}));
		for (const k of Object.keys(globalsQuery.data?.ai.providers ?? {})) keys.add(k);
		return [...keys];
	}, [draft, globalsQuery.data]);
	const islandDraft = useMemo(
		() => (draft === null ? null : packIsland(draft, providerKeys)),
		[draft, providerKeys],
	);
	const islandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return packIsland(globalsQuery.data.ai, providerKeys);
	}, [globalsQuery.data, providerKeys]);

	// 内置人格的内容按当前语言取,设置里不存(ADR-0037 决策 11);语言来自整份设置。
	const locale = textSettingsOf(globalsQuery.data ?? {}).locale;
	const builtins = useMemo(() => builtinPresetsFor(locale), [locale]);

	useDirtyDraft({
		pageKey: "ai",
		pageLabel: tx("aiSettings.page.pageLabel"),
		draft: islandDraft,
		baseline: islandBaseline,
		onSave: async () => {
			if (draft !== null) await save.mutateAsync({ ai: draft });
		},
		onDiscard: () => {
			if (globalsQuery.data) setDraft(globalsQuery.data.ai);
		},
	});

	if (!draft) {
		return <LoadingBlock label={tx("aiSettings.page.loading")} />;
	}

	// 左栏在看的那一份,收敛到真实存在的一份(可能刚被删掉、也可能还没选过)。
	const editing = resolveEditingProfile(draft, editingProfile);
	// 这一份是不是女仆平时用的那份。右上角的按钮与说明条都跟着它 —— 与人格那半边
	// 的 `isGlobalPersona` 同一套语义。
	const isActiveProfile = editing !== null && editing === draft.activeProfile;
	// 正在编辑那份实例的整套配置。桶可能还不存在(一份都没添加时 editing 为 null),
	// resolveAIProfile 兜一套空默认值 —— 表单照常显示空。
	const profile = resolveAIProfile({
		activeProfile: editing ?? "",
		providers: draft.providers,
	});
	// 选中实例的能力描述,认桶里的 provider 章 —— 键只是实例 id,认不得方言。
	// **设置页上显示什么由它说了算**:摆出一个那家根本不支持的选项,主人调了
	// 没反应,只会以为是保存坏了。
	const meta = providerMeta(profile.provider);
	// 基线(服务端下发的)里同一份实例 —— 密钥格是遮挡才算「已存着」(`DraftSecretInput` 据此画胶囊)。
	const savedProfile = editing === null ? undefined : globalsQuery.data?.ai.providers[editing];
	// 左栏 / 删除按钮上的显示名。
	const rail = profileRailItems(draft);
	const editingLabel = rail.find((i) => i.id === editing)?.label ?? meta.label;
	// 头图那颗药丸报的是**女仆真正在用的那份**的模型,与左栏在看哪一份无关。
	const globalProfile = resolveAIProfile(draft);
	// 头图那行名字同理:报的是**女仆真正在用的那份人格**(`activePreset` 指的那份),
	// 与左栏在编辑哪一份无关;内置那份的内容取当前语言。
	const globalPersona = resolveActivePersona(draft, builtins).persona;
	// 配了视觉副模型 = 副模型无条件接管,enableVision 与它的地址/密钥两格的
	// 可交互性都跟着这一个判断走(与 CommentaryGenerator#resolveImages 同源)。
	const visionSubModelOn = profile.vision.model.trim().length > 0;

	// 一份都没添加 → 右侧直接就是添加面板,那本身就是空态引导。
	const showAddPanel = addingProvider || rail.length === 0;

	// 左栏选中项收敛到真实存在的一项,否则会出现「左栏没有任何高亮、右侧却显示着
	// 默认那一份」——高亮项与内容各说各话。
	const activePersonaId = resolvePersonaRailId(draft, builtins, personaRailId);
	const personaDraft = personaAt(draft, builtins, activePersonaId);
	const personaRail = personaRailItems(draft, builtins);
	// 这一份是不是女仆平时用的那份。左栏副标题、右上角按钮与说明条都跟着它。
	const isGlobalPersona = globalPersonaRailId(draft, builtins) === activePersonaId;
	const activePresetId = personaRail.find((i) => i.id === activePersonaId)?.presetId ?? "";
	// 内置那几份是只读的参照库:能删、能「从内置修改」另存一份可改的,但不能就地改
	// —— 改花了「从内置恢复」就没有稳定的东西可恢复了。
	const personaLocked = isBuiltinPersona(activePresetId);
	const restorable = missingBuiltinPersonas(draft, builtins);
	const ActivePersonaGlyph = Icon[personaIconKey(activePresetId)];

	function setAi<K extends keyof AISettingsDraft>(k: K, v: AISettingsDraft[K]): void {
		setDraft((d) => (d ? { ...d, [k]: v } : d));
	}
	/**
	 * 改联网搜索段的若干项 —— backend 指针 / keys / engines 都走这一个口
	 * (曾经三个 setter 各抄一遍嵌套 spread)。
	 * keys / engines 是嵌套袋:调用方只给改动的那几格,这里在**函数式更新**里
	 * 补上其余的 —— 漏一层内 spread 就是静默丢兄弟键(换后端丢另一家的 key)。
	 */
	function setSearch(delta: {
		backend?: AISettingsDraft["search"]["backend"];
		keys?: Partial<AISettingsDraft["search"]["keys"]>;
		scenes?: Partial<AISettingsDraft["search"]["scenes"]>;
	}): void {
		setDraft((d) =>
			d
				? {
						...d,
						search: {
							...d.search,
							...delta,
							keys: { ...d.search.keys, ...delta.keys },
							scenes: { ...d.search.scenes, ...delta.scenes },
						},
					}
				: d,
		);
	}
	/**
	 * 改**正在编辑**那家桶里的一项(不是在用的那家 —— 两者可以不是同一家)。
	 * 桶不存在时按当前显示值(空默认)建出来。
	 */
	function setProfile<K extends keyof AIProviderProfileDraft>(
		k: K,
		v: AIProviderProfileDraft[K],
	): void {
		if (editing === null) return;
		setDraft((d) =>
			d
				? {
						...d,
						providers: {
							...d.providers,
							[editing]: {
								...resolveAIProfile({ activeProfile: editing, providers: d.providers }),
								[k]: v,
							},
						},
					}
				: d,
		);
	}
	function setVision(k: "baseUrl" | "apiKey" | "model", v: SecretCellDraft | string): void {
		setProfile("vision", { ...profile.vision, [k]: v });
	}
	/** 改当前编辑的那份人格里的一项 —— 落在 `ai.persona` 还是 `presets[i]` 由左栏选中项决定。 */
	function setPersona<K extends keyof AIPersona>(k: K, v: AIPersona[K]): void {
		setDraft((d) =>
			d
				? updatePersonaAt(d, builtins, activePersonaId, {
						persona: { ...personaAt(d, builtins, activePersonaId).persona, [k]: v },
					})
				: d,
		);
	}
	function setPersonaPrompt(k: "dynamicPrompt" | "liveSummaryPrompt", v: string): void {
		setDraft((d) => (d ? updatePersonaAt(d, builtins, activePersonaId, { [k]: v }) : d));
	}

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/* Hero strip。总开关是页面级的 —— 它既不属于某一家服务商,也不属于某一份人格。 */}
			<HeroStrip
				icon={<Icon.ai size={26} />}
				title={
					<>
						{tx("aiSettings.page.hero.titlePrefix")}
						{globalPersona.name || tx("aiSettings.page.hero.personaFallback")}
						<span data-hero-model>
							<Pill color="var(--color-bn-purple)" subtle size="sm">
								{globalProfile.model || tx("aiSettings.page.hero.unconfigured")}
							</Pill>
						</span>
					</>
				}
				subtitle={tx("aiSettings.page.hero.subtitle")}
				right={
					<Picker
						value={draft.enabled}
						onChange={(v) => setAi("enabled", v)}
						options={[
							{ value: true, label: tx("aiSettings.page.hero.enable"), color: AI_PURPLE },
							{
								value: false,
								label: tx("aiSettings.page.hero.disable"),
								color: "var(--color-bn-inactive)",
							},
						]}
					/>
				}
			/>

			{/* 开着总开关却一家都没配 —— 这不是「还没填完」而是**此刻确实不工作**:
			    引擎不会创建实例、发图与点评一律回 400。不偷偷替主人把开关关掉
			    (那是改主人存过的值),也不做点不动的置灰开关,只把话说明白。 */}
			{draft.enabled && rail.length === 0 ? (
				<div className="rounded-bn-card border border-bn-warning-border bg-bn-warning-soft px-4 py-3 text-bn-sm leading-relaxed text-bn-warning-text">
					{tx("aiSettings.page.warning.noProviderPrefix")}
					<strong>{tx("aiSettings.page.warning.noProviderEmphasis")}</strong>
					{tx("aiSettings.page.warning.noProviderSuffix")}
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
						) : t.id === "skills" ? (
							<Icon.sparkle size={14} />
						) : (
							<Icon.gear size={14} />
						),
				}))}
				value={tab}
				onChange={setTab}
				hint={TAB_HINTS[tab]}
			/>

			{tab === "skills" ? (
				<MaidSkills />
			) : tab === "global" ? (
				<div className="flex flex-col gap-4">
					{/* 全局实例选择 —— 与人格那条同一套语义:这里决定女仆**用**哪一份,
					    「模型配置」那个 Tab 的左栏只决定**在编辑**哪一份。两件事曾经共用
					    一个字段,于是点左栏看看别份 = 当场把在用的那份换掉了。 */}
					<GlassBox
						title={tx("aiSettings.page.global.profileTitle")}
						subtitle={tx("aiSettings.page.global.profileSubtitle")}
						accent={AI_PURPLE}
						icon={<Icon.link size={14} />}
						badge="profile"
					>
						<Field
							code="ai.activeProfile"
							full
							hint={rail.length === 0 ? tx("aiSettings.page.global.noProvider") : undefined}
						>
							<Picker<string>
								value={draft.activeProfile}
								onChange={(v) => setDraft((d) => (d ? setActiveProfile(d, v) : d))}
								options={rail.map((i) => ({
									value: i.id,
									label: i.label,
									color: PROVIDER_BRANDS[i.provider].color,
								}))}
							/>
						</Field>
						<FieldNote>
							{tx("aiSettings.page.global.profileNotePrefix")}
							<strong>{tx("aiSettings.page.global.profileNoteEmphasis")}</strong>
							{tx("aiSettings.page.global.profileNoteSuffix")}
						</FieldNote>
					</GlassBox>

					{/* 聊天页的思考设置不在这里:开关是输入框旁那颗 ✦ 胶囊(会话级不落盘),
					    **等级**(ai.chat.thinkingLevel)搬进了聊天侧栏的「设置」弹层 ——
					    深度只有聊天在用,编辑口跟着聊天走。 */}

					{/* 联网搜索 —— 与选哪家 AI 服务商**正交**:web_search 工具由这里选定的
					    后端真正执行,任何支持 function calling 的服务商都能用上。所以它不挂
					    在实例桶下,自己一块。聊天页那颗「联网搜索」胶囊是会话级的不落盘,
					    这里落盘的只有后端 / key / 引擎开关。 */}
					<GlassBox
						title={tx("aiSettings.page.search.title")}
						subtitle={tx("aiSettings.page.search.subtitle")}
						accent={SECTION_ACCENT.capability}
						icon={<Icon.search size={14} />}
						badge="search"
					>
						<Field code="ai.search.backend" full>
							<Picker<AISettingsDraft["search"]["backend"]>
								value={draft.search.backend}
								onChange={(v) => setSearch({ backend: v })}
								options={WEB_SEARCH_BACKENDS.map((b) => ({ value: b.id, label: b.label }))}
							/>
						</Field>
						<Field
							code={`ai.search.keys.${draft.search.backend}`}
							full
							hint={tx("aiSettings.page.search.keyHint", {
								url: webSearchBackendMeta(draft.search.backend).keyUrl,
							})}
						>
							<DraftSecretInput
								value={draft.search.keys[draft.search.backend]}
								saved={globalsQuery.data?.ai.search.keys[draft.search.backend]}
								onChange={(v) => setSearch({ keys: { [draft.search.backend]: v } })}
							/>
						</Field>
						{/* 三个引擎开关按表生成 —— 手抄三块只差 key/ariaLabel 的 JSX,
						    抄错一处在评审里根本看不出来;加第四个引擎也只改这张表。 */}
						{(
							[
								["post", tx("aiSettings.page.search.postAria")],
								["live", tx("aiSettings.page.search.liveAria")],
								["roast", tx("aiSettings.page.search.roastAria")],
							] as const
						).map(([k, aria]) => (
							<Field key={k} code={`ai.search.engines.${k === "post" ? "dynamic" : k}`}>
								<div className="flex h-7.5 items-center">
									<Toggle
										value={draft.search.scenes[k]}
										onChange={(v) => setSearch({ scenes: { [k]: v } })}
										ariaLabel={aria}
									/>
								</div>
							</Field>
						))}
						<FieldNote>
							{tx("aiSettings.page.search.feePrefix")}
							<strong>{tx("aiSettings.page.search.feeEmphasis")}</strong>
							{tx("aiSettings.page.search.feeSuffix")}
						</FieldNote>
					</GlassBox>

					{/* 全局人格选择 —— 它是个**指针**(ai.activePreset),不改写任何一份的内容;
					    想改内容去「女仆性格」那个 Tab。 */}
					<GlassBox
						title={tx("aiSettings.page.global.personaTitle")}
						subtitle={tx("aiSettings.page.global.personaSubtitle")}
						accent={SECTION_ACCENT.persona}
						icon={<Icon.heart size={14} />}
						badge="persona"
					>
						<Field
							code="ai.activePreset"
							full
							hint={personaRail.length === 0 ? tx("aiSettings.page.global.noPersona") : undefined}
						>
							<Picker<string>
								value={globalPersonaRailId(draft, builtins)}
								onChange={(v) => setDraft((d) => (d ? setGlobalPersona(d, builtins, v) : d))}
								options={personaRail.map((i) => ({ value: i.id, label: i.label }))}
							/>
						</Field>
						<FieldNote>
							{tx("aiSettings.page.global.personaNotePrefix")}
							<strong>{tx("aiSettings.page.global.personaNoteEmphasis")}</strong>
							{tx("aiSettings.page.global.personaNoteSuffix")}
						</FieldNote>
					</GlassBox>

					{/* 试一句 —— 调完模型与人格,当场就能问她一句看看效果。 */}
					<AiTestPanel draft={draft} />
				</div>
			) : tab === "model" ? (
				<div className="grid gap-4 xl:grid-bn-rail">
					<SectionNav
						heading={tx("aiSettings.page.models.railTitle")}
						items={rail.map((item) => {
							const bucket = draft.providers[item.id];
							return {
								id: item.id,
								label: item.label,
								desc: bucket?.model || tx("aiSettings.page.models.noModel"),
								// 左栏是**编辑器**,高亮的是「在看谁」。哪一份是女仆真在用的,
								// 靠这颗指示器说 —— 否则两个概念在同一栏里没法区分。
								badge:
									item.id === draft.activeProfile ? (
										<RailDot
											title={tx("aiSettings.page.models.defaultHint")}
											active={item.id === editing}
										/>
									) : undefined,
								// 同 Targets 左栏:选中那格的品牌色会跟皮肤的实心块撞,喂
								// currentColor 跟随。服务商名就在标签上,认得出是哪家。
								icon: (
									<ProviderLogo
										id={item.provider}
										size={16}
										tone={item.id === editing ? "currentColor" : undefined}
									/>
								),
								iconTint: PROVIDER_BRANDS[item.provider].color,
							};
						})}
						activeId={editing}
						onPick={(id) => {
							setEditingProfile(id);
							setAddingProvider(false);
						}}
						onAdd={() => setAddingProvider(true)}
						addLabel={tx("aiSettings.page.actions.add")}
						emptyState={
							<EmptyNote size="sm" className="leading-relaxed">
								{tx("aiSettings.page.models.emptyTitle")}
								<br />
								{tx("aiSettings.page.models.emptyHint")}
							</EmptyNote>
						}
					/>

					<div className="flex min-w-0 flex-col gap-4">
						{showAddPanel ? (
							<GlassBox
								title={tx("aiSettings.page.models.addTitle")}
								subtitle={tx("aiSettings.page.models.addSubtitle")}
								accent={AI_PURPLE}
								icon={<Icon.link size={14} />}
								badge="add"
							>
								<FieldNote>
									{tx("aiSettings.page.models.providerNotePrefix")}
									<strong>{tx("aiSettings.page.models.providerNoteEmphasis")}</strong>
									{tx("aiSettings.page.models.providerNoteSuffix")}
									<strong>{tx("aiSettings.page.models.multipleEmphasis")}</strong>
									{tx("aiSettings.page.models.multipleSuffix")}
								</FieldNote>
								<div className="pt-3">
									<ProviderPicker
										value={null}
										onChange={(pid) => {
											// 添加 ≠ 换用:新加的那份只是**切过去编辑**(否则左栏多一项、
											// 右侧还停在原来那份,像没反应)。要真换用得点「设为默认」。
											if (!draft) return;
											const { ai: next, id } = addProfile(draft, pid);
											setDraft(next);
											setEditingProfile(id);
											setAddingProvider(false);
										}}
									/>
								</div>
							</GlassBox>
						) : (
							<>
								<GlassBox
									title={tx("aiSettings.page.models.connectionTitle")}
									subtitle={tx("aiSettings.page.models.connectionSubtitle", {
										fields: "{label,baseUrl,apiKey,model,apiFlavor}",
									})}
									accent={AI_PURPLE}
									icon={<Icon.link size={14} />}
									badge="connection"
									right={
										<div className="flex items-center gap-1.5">
											{/* 「在看这份」不等于「在用这份」。要换用得明确点一下 —— 与人格
											    那半边的「设为默认」同一个动作、同一句话。 */}
											{isActiveProfile || editing === null ? null : (
												<Btn
													variant="outline"
													size="sm"
													onClick={() => setDraft((d) => (d ? setActiveProfile(d, editing) : d))}
												>
													{tx("aiSettings.page.actions.setDefault")}
												</Btn>
											)}
											<Btn
												variant="danger-outline"
												size="sm"
												onClick={() =>
													setDraft((d) => (d && editing !== null ? removeProfile(d, editing) : d))
												}
											>
												{tx("aiSettings.page.actions.deletePrefix")}
												{editingLabel}
											</Btn>
										</div>
									}
								>
									{isActiveProfile ? (
										<FieldNote>
											<strong>{tx("aiSettings.page.models.currentPrefix")}</strong>
											{tx("aiSettings.page.models.currentSuffix")}
										</FieldNote>
									) : (
										<FieldNote>
											{tx("aiSettings.page.models.inactivePrefix")}
											<strong>{tx("aiSettings.page.models.inactiveEmphasis")}</strong>
											{tx("aiSettings.page.models.inactiveSuffix")}
										</FieldNote>
									)}
									{/* 实例名。同一家添加多份时全靠它区分;留空则显示家名。 */}
									<Field code={`ai.providers.${editing}.label`}>
										<TInput
											value={profile.label}
											onChange={(v) => {
												if (editing !== null) {
													setDraft((d) => (d ? renameProfile(d, editing, v) : d));
												}
											}}
											placeholder={meta.label}
										/>
									</Field>
									<Field code={`ai.providers.${editing}.apiKey`} required>
										<DraftSecretInput
											value={profile.apiKey}
											saved={savedProfile?.apiKey}
											onChange={(v) => setProfile("apiKey", v)}
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
									{/* 接口风味 —— 只对确认支持 /responses 的家摆出来(supportsResponses),
									    硅基/火山未确认前不给选:选得到却必然 404 的组合比没有选项更糟。 */}
									{meta.supportsResponses ? (
										<>
											<Field code={`ai.providers.${editing}.apiFlavor`} full>
												<Picker<APIFlavorId>
													value={profile.apiFlavor}
													onChange={(v) => setProfile("apiFlavor", v)}
													options={[
														{ value: "chat", label: "chat completions" },
														{ value: "responses", label: "responses" },
													]}
												/>
											</Field>
											{profile.apiFlavor === "responses" ? (
												<FieldNote>
													{tx("aiSettings.page.models.responsesPrefix")}
													<strong>{tx("aiSettings.page.models.responsesEmphasis")}</strong>
													{tx("aiSettings.page.models.responsesSuffix")}
													<strong>
														{tx("aiSettings.page.models.responsesNoFallbackEmphasis")}
													</strong>
													{tx("aiSettings.page.models.responsesNoFallbackSuffix")}
												</FieldNote>
											) : null}
										</>
									) : null}
								</GlassBox>

								{/* 图片理解。它同样是在描述「接哪个模型」,只不过整块可以不填:
								    两条路都不开时,发图会被明确拒绝而不是静默丢掉。 */}
								<GlassBox
									title={tx("aiSettings.page.vision.title")}
									subtitle={tx("aiSettings.page.vision.subtitle", {
										fields: "{enableVision,vision}",
									})}
									accent={SECTION_ACCENT.capability}
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
														ariaLabel={tx("aiSettings.page.vision.directAria")}
													/>
												</div>
											</Field>
											{visionSubModelOn ? (
												<FieldNote>
													{tx("aiSettings.page.vision.submodelPrefix")}
													<strong>{tx("aiSettings.page.vision.submodelEmphasis")}</strong>
													{tx("aiSettings.page.vision.submodelSuffix")}
												</FieldNote>
											) : null}
										</>
									) : (
										<FieldNote>
											{meta.label} {tx("aiSettings.page.vision.unsupportedPrefix")}
											<strong>{tx("aiSettings.page.vision.unsupportedEmphasis")}</strong>
											{tx("aiSettings.page.vision.unsupportedSuffix")}
										</FieldNote>
									)}
									{/* 密钥 → 地址 → 模型,与上面「模型连接」**同序**:两块摆的是同一件事
									    (接哪个模型),顺序各走各的只会让人以为这是另一种东西。

									    地址与密钥**恒在场**,不等填了模型 ID 才现身。这块存在的前提就是主模型
									    那家没有视觉模型,副模型多半在另一家 —— 藏起来的话主人打开只看见一个
									    模型 ID 框,结论是「没法给它单配地址和密钥」,而副标题偏偏还写着有。
									    三格全是选填(留空即跟随主模型 / 不启用),摆着不会被当成漏填。 */}
									<Field code={`ai.providers.${editing}.vision.apiKey`} full>
										<DraftSecretInput
											value={profile.vision.apiKey}
											saved={savedProfile?.vision.apiKey}
											onChange={(v) => setVision("apiKey", v)}
											placeholder={tx("aiSettings.page.vision.keyPlaceholder")}
										/>
									</Field>
									<Field code={`ai.providers.${editing}.vision.baseUrl`} full>
										<TInput
											value={profile.vision.baseUrl}
											onChange={(v) => setVision("baseUrl", v)}
											mono
											placeholder={tx("aiSettings.page.vision.urlPlaceholder")}
										/>
									</Field>
									<Field code={`ai.providers.${editing}.vision.model`} full>
										<TInput
											value={profile.vision.model}
											onChange={(v) => setVision("model", v)}
											mono
											placeholder={tx("aiSettings.page.vision.modelPlaceholder")}
										/>
									</Field>
								</GlassBox>

								{/* 生成参数 —— 深度思考与额外请求参数同属「这一次请求怎么生成」,合成一块。
								    思考那半边的可见形态取决于这一家:各家写法不同,兜底档索性不发。
								    这里没有 temperature:请求里一律不发、走服务商默认(推理模型收到它
								    直接 400),想调的主人写进额外请求参数。 */}
								<GlassBox
									title={tx("aiSettings.page.generation.title")}
									subtitle={tx("aiSettings.page.generation.subtitle", {
										fields: "{enableThinking,thinkingLevel,extraParams}",
									})}
									accent="var(--color-bn-purple)"
									icon={<Icon.sparkle size={14} />}
									badge="generation"
								>
									{/* responses 风味下思考是标准字段(reasoning.effort),custom 也能开 ——
									    「方言未知不敢发」只是 chat completions 的处境。谓词一份,住 ai.ts。 */}
									{canProfileThink(profile) ? (
										<>
											<Field code={`ai.providers.${editing}.enableThinking`}>
												<div className="flex h-7.5 items-center">
													<Toggle
														value={profile.enableThinking}
														onChange={(v) => setProfile("enableThinking", v)}
														ariaLabel={tx("aiSettings.page.generation.thinkingAria")}
													/>
												</div>
											</Field>
											{profile.enableThinking ? (
												<Field code={`ai.providers.${editing}.thinkingLevel`} full>
													<Picker<ThinkingLevel>
														value={profile.thinkingLevel}
														onChange={(v) => setProfile("thinkingLevel", v)}
														options={[
															{ value: "low", label: tx("aiSettings.page.generation.low") },
															{ value: "medium", label: tx("aiSettings.page.generation.medium") },
															{ value: "high", label: tx("aiSettings.page.generation.high") },
														]}
													/>
												</Field>
											) : null}
											{/* 「默认开着」的说明只描述 chat 方言的关位语义;responses 那边
											    的关位各家不同(百炼发 effort:none,DeepSeek 什么都不发),
											    没有一句能概括两家的话,索性不说。 */}
											{meta.thinkingDefaultsOn &&
											!profile.enableThinking &&
											profile.apiFlavor !== "responses" ? (
												<FieldNote>
													{meta.label} {tx("aiSettings.page.generation.defaultPrefix")}
													<strong>{tx("aiSettings.page.generation.defaultEmphasis")}</strong>
													{tx("aiSettings.page.generation.defaultSuffix")}
												</FieldNote>
											) : null}
										</>
									) : (
										<FieldNote>{tx("aiSettings.page.generation.customHint")}</FieldNote>
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
									{profile.apiFlavor === "responses" ? (
										<FieldNote>
											{tx("aiSettings.page.generation.responsesPrefix")}
											<strong>{tx("aiSettings.page.generation.responsesEmphasis")}</strong>
											{tx("aiSettings.page.generation.responsesSuffix")}
										</FieldNote>
									) : null}
								</GlassBox>
							</>
						)}
					</div>
				</div>
			) : (
				<div className="grid gap-4 xl:grid-bn-rail">
					<SectionNav
						heading={tx("aiSettings.page.personas.railTitle")}
						items={personaRail.map((item) => {
							// 四份内置的各有各的样子(主人一眼要认出哪个是哪个);自己加的
							// 用通用小人像。映射与漏画守卫见 ./ai/persona-icons。
							const Glyph = Icon[personaIconKey(item.presetId)];
							return {
								id: item.id,
								label: item.label,
								// 与服务商那栏同一颗指示器。此前这里写的是一行副标题文字,
								// 两栏各说各的;共用之后观感只有一处定义。
								badge:
									globalPersonaRailId(draft, builtins) === item.id ? (
										<RailDot
											title={tx("aiSettings.page.personas.defaultHint")}
											active={item.id === activePersonaId}
										/>
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
						addLabel={tx("aiSettings.page.actions.add")}
					/>

					<div className="flex min-w-0 flex-col gap-4">
						{addingPersona ? (
							<GlassBox
								title={tx("aiSettings.page.personas.addTitle")}
								subtitle={tx("aiSettings.page.personas.addSubtitle")}
								accent={SECTION_ACCENT.persona}
								icon={<Icon.plus size={14} />}
								badge="add"
							>
								<Field code="presets" label={tx("aiSettings.page.personas.newLabel")} full>
									<Btn
										variant="outline"
										size="sm"
										onClick={() => {
											// 新建即切过去 —— 否则左栏多一项、右侧还停在原来那份,像没反应。
											const next = draft ? addPersona(draft) : null;
											if (!next) return;
											setDraft(next.ai);
											setPersonaRailId(next.railId);
											setAddingPersona(false);
										}}
									>
										{tx("aiSettings.page.personas.blankAction")}
									</Btn>
								</Field>
								{restorable.length > 0 ? (
									<Field
										code="presets"
										label={tx("aiSettings.page.personas.restoreLabel")}
										hint={tx("aiSettings.page.personas.restoreHint")}
										full
									>
										<div className="flex flex-wrap gap-1.5">
											{restorable.map((b) => {
												const Glyph = Icon[personaIconKey(b.id)];
												return (
													<Btn
														variant="outline"
														size="sm"
														key={b.id}
														onClick={() => {
															const next = restoreBuiltinPersona(draft, b.id);
															setDraft(next.ai);
															setPersonaRailId(next.railId);
															setAddingPersona(false);
														}}
													>
														<Glyph size={13} />
														{b.label}
													</Btn>
												);
											})}
										</div>
									</Field>
								) : (
									<FieldNote>{tx("aiSettings.page.personas.noneToRestore")}</FieldNote>
								)}
							</GlassBox>
						) : (
							<GlassBox
								title={tx("aiSettings.page.personas.editorTitle")}
								subtitle={tx("aiSettings.page.personas.editorSubtitle")}
								accent={SECTION_ACCENT.persona}
								icon={<ActivePersonaGlyph size={14} />}
								badge="persona"
								right={
									<div className="flex items-center gap-1.5">
										{/* 内置那份改不动 —— 给一条出路:以它为蓝本另存一份可改的。 */}
										{personaLocked ? (
											<Btn
												variant="outline"
												size="sm"
												onClick={() => {
													const next = duplicatePersona(draft, builtins, activePersonaId);
													setDraft(next.ai);
													setPersonaRailId(next.railId);
												}}
											>
												{tx("aiSettings.page.personas.duplicateAction")}
											</Btn>
										) : null}
										{isGlobalPersona ? null : (
											<Btn
												variant="outline"
												size="sm"
												onClick={() =>
													setDraft((d) => (d ? setGlobalPersona(d, builtins, activePersonaId) : d))
												}
											>
												{tx("aiSettings.page.actions.setDefault")}
											</Btn>
										)}
										{/* 最后一份删不掉 —— AI 总得有一份人格。按钮直接不摆,
									    好过摆一个点了没反应的。 */}
										{personaRail.length > 1 ? (
											<Btn
												variant="danger-outline"
												size="sm"
												onClick={() => {
													setDraft((d) => (d ? removePersona(d, builtins, activePersonaId) : d));
													setPersonaRailId("");
												}}
											>
												{tx("aiSettings.page.actions.delete")}
											</Btn>
										) : null}
									</div>
								}
							>
								{personaLocked ? (
									<FieldNote>
										{tx("aiSettings.page.personas.builtinPrefix")}
										<strong>{tx("aiSettings.page.personas.builtinEmphasis")}</strong>
										{tx("aiSettings.page.personas.builtinSuffix")}
										<strong>{tx("aiSettings.page.personas.duplicateEmphasis")}</strong>
										{tx("aiSettings.page.personas.duplicateSuffix")}
									</FieldNote>
								) : null}
								{isGlobalPersona ? (
									<FieldNote>
										{tx("aiSettings.page.personas.currentPrefix")}
										<strong>{tx("aiSettings.page.personas.currentEmphasis")}</strong>
										{tx("aiSettings.page.personas.currentSuffix")}
									</FieldNote>
								) : (
									<FieldNote>
										{tx("aiSettings.page.personas.inactivePrefix")}
										<strong>{tx("aiSettings.page.personas.inactiveEmphasis")}</strong>
										{tx("aiSettings.page.personas.inactiveSuffix")}
									</FieldNote>
								)}
								<Field code="presets" label={tx("aiSettings.page.personas.namePlaceholder")} full>
									<TInput
										value={personaRail.find((i) => i.id === activePersonaId)?.label ?? ""}
										onChange={(v) =>
											setDraft((d) => (d ? renamePersona(d, builtins, activePersonaId, v) : d))
										}
										placeholder={tx("aiSettings.page.personas.traitsPlaceholder")}
									/>
								</Field>
								<div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
									<Field code="persona.name">
										<TInput
											value={personaDraft.persona.name}
											disabled={personaLocked}
											onChange={(v) => setPersona("name", v)}
											placeholder={tx("aiSettings.page.personas.nameFallback")}
											full={false}
										/>
									</Field>
									<Field code="persona.addressUser">
										<TInput
											value={personaDraft.persona.addressUser}
											disabled={personaLocked}
											onChange={(v) => setPersona("addressUser", v)}
											placeholder={tx("aiSettings.page.personas.userPlaceholder")}
											full={false}
										/>
									</Field>
									<Field code="persona.addressSelf">
										<TInput
											value={personaDraft.persona.addressSelf}
											disabled={personaLocked}
											onChange={(v) => setPersona("addressSelf", v)}
											placeholder={tx("aiSettings.page.personas.selfPlaceholder")}
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
								<Field
									code="ai.dynamicPrompt"
									full
									hint={tx("aiSettings.page.personas.promptPlaceholder")}
								>
									<TArea
										value={personaDraft.dynamicPrompt}
										disabled={personaLocked}
										onChange={(v) => setPersonaPrompt("dynamicPrompt", v)}
										rows={3}
										mono
									/>
								</Field>
								<Field
									code="ai.liveSummaryPrompt"
									full
									hint={tx("aiSettings.page.personas.promptPlaceholder")}
								>
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
