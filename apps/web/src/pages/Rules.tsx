import type { GlobalSettingsView } from "@bilibili-notify/contract";
import { presetsOf } from "@bilibili-notify/internal/ai";
import { DEFAULT_LOCALE, textSettingsOf } from "@bilibili-notify/internal/i18n";
import { buildPatch } from "@bilibili-notify/internal/patch";
import {
	factoryTemplateAt,
	pendingTemplateUpdates,
	storedTemplateAt,
	syncTemplatesSeen,
	templateFingerprint,
} from "@bilibili-notify/internal/template-defaults";
import { builtinPresetsFor, templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
import {
	ConfirmDialog,
	type FieldUpdate,
	FieldUpdatesProvider,
	LoadingBlock,
	RailDot,
	SectionNav,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Scope, ScopeTabs } from "../components/scope-tabs";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../hooks/useSettings";
import { useSources } from "../hooks/useSources";
import { useT } from "../i18n";
import { api } from "../services/api";
import { type Subscription, subscriptionIdentityOf } from "../types/domain";
import type { GlobalDefaults, GlobalSettings, GlobalSettingsPatch } from "../types/globals";
import { buildOverridesPatch } from "./rules/overrides-patch";
import {
	type SubscriptionOverrideKey,
	SubscriptionRulesEditor,
	subscriptionOverrideKeys,
} from "./rules/SubscriptionRulesEditor";
import { isSectionCustomized } from "./rules/section-scope";
import {
	DynamicMsgSection,
	FilterSection,
	GuardSection,
	globalSectionsOf,
	ImageGroupSection,
	LiveMsgSection,
	LiveThresholdsSection,
	perUpSectionsFor,
	type SectionId,
	type SectionMeta,
	SummarySection,
} from "./rules/sections";
import { displayName } from "./subscriptions/helpers";
import {
	type SubscriptionPlatform,
	subscriptionPlatformOf,
	visibleFeaturesOf,
} from "./subscriptions/subscription-source";

// 账本(「默认文案有更新」)按简体原文算,不随语言变:换语言不亮,以后补上别的语言的译文也不亮。
// 输入框显示的「没存时的默认」才跟当前语言(见 `Rules` 里的 `factory`)。
const FACTORY_TEMPLATES = templateDefaultsFor(DEFAULT_LOCALE);
const NO_SEEN: GlobalSettings["templatesSeen"] = Object.freeze({});

// ── Helpers ────────────────────────────────────────────────────────────────

/** 把点路径摊成嵌套对象:`membership.guard.default.template` → `{membership:{guard:{default:{template:v}}}}`。 */
function nestByPath(path: string, value: string | null): Record<string, unknown> {
	const segs = path.split(".");
	let node: Record<string, unknown> = { [segs[segs.length - 1] as string]: value };
	for (let i = segs.length - 2; i >= 0; i -= 1) node = { [segs[i] as string]: node };
	return node;
}

/** Slices on Subscription.overrides that are populated; per-UP "已覆盖" 状态来源。 */
function overrideKeysOf(sub: Subscription): Set<SubscriptionOverrideKey> {
	const keys = new Set<SubscriptionOverrideKey>();
	for (const key of subscriptionOverrideKeys) {
		if (sub.overrides[key] !== undefined) keys.add(key);
	}
	return keys;
}

/** 特别关注是订阅的公共格;来源不支持的(今天只有 B 站支持)这一格恒空,所以恒 false。 */
function hasSpecialViewers(sub: Subscription): boolean {
	return sub.specialViewers.length > 0;
}

function hasAnyCustomization(sub: Subscription): boolean {
	return overrideKeysOf(sub).size > 0 || hasSpecialViewers(sub);
}

// isSectionCustomized 已抽到 ./rules/section-scope(与 SubscriptionRulesEditor 的 toggle 判定共用
// 同一份字段分域常量,避免 filter/live 共享 overrides.filters 切片时口径不一致)。

// ── Sidebar (规则分类) ─────────────────────────────────────────────────────

function SectionList({
	sections,
	current,
	onPick,
	heading,
	customizedIds,
}: {
	sections: SectionMeta[];
	current: SectionId;
	onPick: (id: SectionId) => void;
	heading: string;
	/** 已设置覆盖的 sectionId 集合;有则在 section 标签上加红点。 */
	customizedIds?: Set<SectionId>;
}) {
	const tx = useT();
	return (
		<SectionNav
			heading={heading}
			activeId={current}
			onPick={(id) => onPick(id as SectionId)}
			items={sections.map((s) => ({
				id: s.id,
				label: s.label,
				desc: s.desc,
				icon: s.icon,
				badge: customizedIds?.has(s.id) ? (
					<RailDot title={tx("sourceUi.pages.Rules.title.1")} active={s.id === current} />
				) : undefined,
			}))}
		/>
	);
}

// ── Deep merge (for global PATCH draft) ────────────────────────────────────

/**
 * 草稿的合并走 JSON Merge Patch 的语义(同服务端):补丁里的 `null` = **把这个键从草稿里拿掉**,不是把 `null` 存进去。
 * 清空一个可选字段(上舰提示里某一档的文案)靠它 —— 拿掉之后草稿里就没有这个键,保存时 `buildPatch` 拿草稿与基线一比,
 * 才会编出显式 null 去服务端真的删;存成 `null` 的话界面读到的是 `null`、草稿与基线对不上又说不清是改了还是没改。
 */
function deepMerge<T>(base: T, patch: GlobalSettingsPatch): T {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const k of Object.keys(patch)) {
		const pv = (patch as Record<string, unknown>)[k];
		if (pv === null) {
			delete out[k];
			continue;
		}
		const bv = out[k];
		if (
			pv != null &&
			typeof pv === "object" &&
			!Array.isArray(pv) &&
			bv != null &&
			typeof bv === "object" &&
			!Array.isArray(bv)
		) {
			out[k] = deepMerge(bv, pv as GlobalSettingsPatch);
		} else {
			out[k] = pv;
		}
	}
	return out as T;
}

// ── GlobalDraftBinder (全局 island,互斥挂载) ───────────────────────────────

/**
 * 全局 island 绑定器 —— 把 GlobalDefaults 打平成扁平 code 结构喂 useDirtyDraft:
 * filters 顶层字段无前缀(字典 code 无前缀)→ 打平;imageGroup / schedule / liveStart /
 * liveStreaming / templates 字典 code 带前缀 → 保 nested,walkTreeDiff 递归出 `imageGroup.X` / `schedule.X` /
 * `liveStart.X` / `liveStreaming.X` / `templates.X`(图集的总开关叫 `enabled`,打平会和 AI 页的 `enabled` 撞键)。`features` 只投影周期那一把(这一页只编辑它)。
 *
 * 刻意抽成独立组件、仅在 isGlobal 时挂载,与 per-UP 的 SubscriptionRulesEditor(自调
 * pageKey "rules-perup" 的 useDirtyDraft)**互斥** —— 同一时刻只有一个 binder
 * 在册,杜绝两个 useDirtyDraft 同时挂载时抢单槽 draftStore 的注册/注销 effect
 * 时序竞态(子 register 先于父 unregister 把当前页 stomp 成 null)。
 */
export function GlobalDraftBinder({
	defaults,
	baseline,
	templatesSeen,
	baselineTemplatesSeen,
	onSave,
	onDiscard,
}: {
	defaults: GlobalDefaults;
	baseline: GlobalDefaults;
	/** 「默认文案看过哪一版」的账本:在核心设置顶层、不在 `defaults` 里,所以另带一格。 */
	templatesSeen: GlobalSettings["templatesSeen"];
	baselineTemplatesSeen: GlobalSettings["templatesSeen"];
	onSave: () => Promise<unknown> | unknown;
	onDiscard: () => void;
}): null {
	const tx = useT();
	const islandDraft = useMemo(
		() => ({
			...defaults.filters,
			imageGroup: defaults.imageGroup,
			schedule: defaults.schedule,
			liveStart: defaults.liveStart,
			liveStreaming: defaults.liveStreaming,
			// 醒目留言与会员的门槛(㉓d):漏了的话改了门槛保存条不亮,离开页面改动就丢。
			superchat: defaults.superchat,
			membership: defaults.membership,
			features: { liveStreaming: defaults.features.liveStreaming },
			templates: defaults.templates,
			messageLayout: defaults.messageLayout,
			// 账本也算脏:点「保持我的」时**只有**它变,不纳进来保存条就不亮,
			// 主人一离开页面这个决定就丢了,下次进来还被问同一件事。
			templatesSeen,
		}),
		[defaults, templatesSeen],
	);
	const islandBaseline = useMemo(
		() => ({
			...baseline.filters,
			imageGroup: baseline.imageGroup,
			schedule: baseline.schedule,
			liveStart: baseline.liveStart,
			liveStreaming: baseline.liveStreaming,
			superchat: baseline.superchat,
			membership: baseline.membership,
			features: { liveStreaming: baseline.features.liveStreaming },
			templates: baseline.templates,
			messageLayout: baseline.messageLayout,
			templatesSeen: baselineTemplatesSeen,
		}),
		[baseline, baselineTemplatesSeen],
	);
	useDirtyDraft({
		pageKey: "rules",
		pageLabel: tx("sourceUi.pages.Rules.pageLabel.2"),
		draft: islandDraft,
		baseline: islandBaseline,
		onSave,
		onDiscard,
	});
	return null;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Rules() {
	const tx = useT();
	const qc = useQueryClient();
	const globalsQuery = useCoreSettings();
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
	});

	const [scope, setScope] = useState<Scope>("__global");
	const [section, setSection] = useState<SectionId>("filter");
	const [draft, setDraft] = useState<GlobalSettingsView | null>(null);
	// 用户主动通过「添加 UP」加进来,但还没设任何 override 的 sub.id;客户端内存,刷新即清空。
	const [addedSubIds, setAddedSubIds] = useState<Set<string>>(new Set());
	// 待确认移除的 per-UP(有实际覆盖项,点 tab 的 x 后先弹确认 dialog 再清空)。
	const [pendingRemoval, setPendingRemoval] = useState<Subscription | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (next: GlobalSettingsView) => {
			// Only the scopes this page actually edits — filter / live thresholds /
			// templates / imageGroup。Posting the full draft would put
			// `defaults.cards` and `ai` into the body and trigger the
			// backend enable-check (puppeteer launch + chat.completions probe)
			// every save, even though nothing here touches those scopes.
			// 与基线 diff 而不是整份回传:这几片眼下全是必填字段,整份发也不会出事,
			// 但哪天有人往里加一个可选字段,「清空」就会又一次变成「什么都没说」。
			// 统一走 buildPatch,不给这个坑留复发的机会。
			const base = globalsQuery.data;
			await patchCoreSettings(
				buildPatch(
					{
						defaults: {
							filters: next.defaults.filters,
							schedule: next.defaults.schedule,
							liveStart: next.defaults.liveStart,
							liveStreaming: next.defaults.liveStreaming,
							superchat: next.defaults.superchat,
							membership: next.defaults.membership,
							// 特性开关这一页只编辑周期那一把;整个 features 对象带上也只会被 diff 成这一格,
							// 不过只列它,免得哪天别的格被谁顺手改了、悄悄跟着下发。
							features: { liveStreaming: next.defaults.features.liveStreaming },
							templates: next.defaults.templates,
							imageGroup: next.defaults.imageGroup,
							messageLayout: next.defaults.messageLayout,
						},
						// 账本必须跟模板同批下发:主人点「保持我的」时**只有**账本变了,
						// 不带上它这一下就等于什么都没保存,下次进来还问同一件事。
						// 它在核心设置顶层、不在 defaults 里 —— 写进 defaults 会被服务端悄悄剥掉。
						templatesSeen: next.templatesSeen,
					},
					{
						defaults: {
							filters: base?.defaults.filters,
							schedule: base?.defaults.schedule,
							liveStart: base?.defaults.liveStart,
							liveStreaming: base?.defaults.liveStreaming,
							superchat: base?.defaults.superchat,
							membership: base?.defaults.membership,
							features: { liveStreaming: base?.defaults.features.liveStreaming },
							templates: base?.defaults.templates,
							imageGroup: base?.defaults.imageGroup,
							messageLayout: base?.defaults.messageLayout,
						},
						templatesSeen: base?.templatesSeen,
					},
				),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
	});

	const removeSubCustomization = useMutation({
		mutationFn: async (sub: Subscription) => {
			// 移除该 UP 的所有 per-UP 配置。注意:发 `overrides: {}` 不行 —— 空对象给 store
			// deepMerge 遍历不到任何键 → 当「不改」→ 旧 slice 原样保留(同 SY1)。须把每个
			// 现存 slice 显式置 null(清除哨兵),buildOverridesPatch({}, base) 正好生成。
			const overrides = buildOverridesPatch({}, sub.overrides);
			// 特别关注只有 B 站订阅有,拓展订阅那一支没有这一格,不发。
			const supportsViewers = platformOf(sub).features.some(
				(feature) => feature === "viewerChat" || feature === "viewerEnter",
			);
			return api.patch<Subscription>(
				`/api/subscriptions/${sub.id}`,
				supportsViewers ? { overrides, specialViewers: [] } : { overrides },
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	// useCallback 不是为了省渲染:下面 `fieldUpdates` 那个 useMemo 要把它列进依赖,
	// 每渲染新建一个函数会让 memo 每次都重算,等于白 memo。
	//
	// 账本(`templatesSeen`)在编辑这一层跟着「存没存」走:一条文字从没存变成存了,记下此刻简体出厂原文的指纹;
	// 变回没存(恢复默认、用新默认、编辑到与默认一字不差)就拿掉。账本因此始终是草稿的纯函数,
	// 改了又改回、丢弃草稿都不会留脏条目 —— 放在保存那一层就得再拿基线比一遍,保存条的 diff 也看不见这笔。
	const patchDraft = useCallback((delta: GlobalSettingsPatch): void => {
		setDraft((d) => {
			if (!d) return d;
			const next = deepMerge(d, delta);
			// 基线里没有账本这一格(老形态)时别凭空补一个 `{}`,否则草稿与基线对不上、保存条白亮。
			const before = next.templatesSeen ?? NO_SEEN;
			const seen = syncTemplatesSeen(
				d.defaults.templates,
				next.defaults.templates,
				before,
				FACTORY_TEMPLATES,
			);
			return seen === before ? next : { ...next, templatesSeen: seen };
		});
	}, []);

	// 文字模板设置里只存主人改过的:没存的格显示「当前语言的默认」(ADR-0037 决策 10)。
	const locale = textSettingsOf(draft ?? globalsQuery.data ?? {}).locale;
	const factory = useMemo(() => templateDefaultsFor(locale), [locale]);
	// 人格库 = 没删的内置(内容取当前语言)+ 主人自己的:「AI 人格」那一节从里面挑一份。
	const personaBuiltins = useMemo(() => builtinPresetsFor(locale), [locale]);
	const personaList = useMemo(
		() => (draft ? presetsOf(draft.ai, personaBuiltins) : []),
		[draft, personaBuiltins],
	);

	// ── 「默认文案有更新」 ───────────────────────────────────────────────────
	//
	// 只对主人改过(存着)的那几条有意义:账本记的是他改那一刻的简体出厂指纹,简体出厂文案后来变了才亮。
	// 这里算出哪几条该亮,经 context 广播下去:`Field` 拿自己的 code 去认领,于是十几个
	// 模板字段的调用点**一个都不用改**(详见 packages/ui 的 field-updates.tsx)。
	const fieldUpdates = useMemo(() => {
		const templates = draft?.defaults.templates;
		const seen = draft?.templatesSeen ?? {};
		const pending = new Set(
			templates ? pendingTemplateUpdates(templates, FACTORY_TEMPLATES, seen) : [],
		);
		const pathOf = (code: string): string | null =>
			code.startsWith("templates.") ? code.slice("templates.".length) : null;
		// 「用新默认」「恢复默认」是同一件事:删键(没存 = 跟随当前语言的默认,下发 `null`),账本那一条也删。
		const dropStored = (path: string): void =>
			patchDraft({
				defaults: {
					templates: nestByPath(path, null) as NonNullable<
						GlobalSettingsPatch["defaults"]
					>["templates"],
				},
				templatesSeen: { [path]: null },
			});
		return {
			lookup(code: string): FieldUpdate | null {
				const path = pathOf(code);
				if (!path || !pending.has(path)) return null;
				// 预览摆当前语言的默认:点「用新默认」后他看到的就是它(没存 = 跟随当前语言)。
				const preview = factoryTemplateAt(factory, path);
				const latest = factoryTemplateAt(FACTORY_TEMPLATES, path);
				if (preview === undefined || latest === undefined) return null;
				return {
					preview,
					accept: () => dropStored(path),
					// 「保持我的」尤其要紧:账本记新的简体指纹,不记的话主人每次打开这页都被问一遍同一件事。
					keep: () => patchDraft({ templatesSeen: { [path]: templateFingerprint(latest) } }),
				};
			},
			// 「恢复默认」跟上面那个提示是两件事:它常驻,管的是「我改坏了想还原」,
			// 只要主人存了一句、又不是当前语言的默认就一直在。
			resetter(code: string): (() => void) | null {
				const path = pathOf(code);
				if (!path || !templates) return null;
				const stored = storedTemplateAt(templates, path);
				if (stored === undefined || stored === factoryTemplateAt(factory, path)) return null;
				return () => dropStored(path);
			},
		};
	}, [draft, factory, patchDraft]);

	// 拓展订阅也能按 UP 定制(ADR-0019 决策 64),只是露的节少 —— 见 perUpSectionsFor。
	const allSubs = useMemo(() => subsQuery.data ?? [], [subsQuery.data]);

	// 拓展订阅是哪个平台、那个源报得出什么:决定露哪几节、tab 上怎么称呼它。都照来源表里的描述符;来源表没回来
	// (还在读 / 读失败)时按拓展订阅最多能有的那几种画,同配置弹层。
	const sources = useSources().data?.sources;
	const programs = sources?.flatMap((source) => source.descriptor.membershipPrograms ?? []) ?? [];
	const platformOf = (s: Subscription): SubscriptionPlatform =>
		subscriptionPlatformOf(subscriptionIdentityOf(s), sources);
	const sectionsOf = (s: Subscription): SectionMeta[] =>
		perUpSectionsFor(s, visibleFeaturesOf(s, platformOf(s)), platformOf(s));

	// Tab 栏只显示:已经在 backend 有 overrides / specialViewers 的 sub + 客户端本轮添加的 sub。
	const tabSubs = useMemo(() => {
		const result: Subscription[] = [];
		for (const s of allSubs) {
			if (hasAnyCustomization(s) || addedSubIds.has(s.id)) result.push(s);
		}
		return result;
	}, [allSubs, addedSubIds]);

	const availableSubs = useMemo(() => {
		const taken = new Set(tabSubs.map((s) => s.id));
		return allSubs.filter((s) => !taken.has(s.id));
	}, [allSubs, tabSubs]);

	function handleAddSub(id: string): void {
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.add(id);
			return next;
		});
		handleScopeChange(id);
	}

	// 把 sub 从 tab 栏摘除(仅客户端态:addedSubIds 移除 + scope 回退全局),不动 backend。
	function detachSub(id: string): void {
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.delete(id);
			return next;
		});
		if (scope === id) setScope("__global");
	}

	function handleRemoveSub(id: string): void {
		const sub = allSubs.find((s) => s.id === id);
		// 已有 backend 覆盖项 → 销毁性操作(清空 overrides + specialViewers),先弹确认再执行。
		if (sub && hasAnyCustomization(sub)) {
			setPendingRemoval(sub);
			return;
		}
		// 纯客户端临时添加(无任何覆盖)→ 无数据可丢,直接摘除。
		detachSub(id);
	}

	// 确认后真正清空该 UP 的 per-UP 配置(PATCH overrides:{} + specialViewers:[])。
	function confirmRemoveSub(): void {
		if (!pendingRemoval) return;
		removeSubCustomization.mutate(pendingRemoval);
		detachSub(pendingRemoval.id);
		setPendingRemoval(null);
	}

	function sectionsFor(next: Scope): SectionMeta[] {
		if (next === "__global") return globalSectionsOf();
		const sub = allSubs.find((s) => s.id === next);
		return sub ? sectionsOf(sub) : [];
	}

	function handleScopeChange(next: Scope): void {
		setScope(next);
		// 切过去的那边没有当前这一节(全局没有特别关注、拓展订阅没有直播阈值……)就回退到第一项。
		const nextSecs = sectionsFor(next);
		if (nextSecs.length > 0 && !nextSecs.some((s) => s.id === section)) {
			setSection(nextSecs[0].id);
		}
	}

	const isGlobal = scope === "__global";
	const focusedSub = !isGlobal ? allSubs.find((s) => s.id === scope) : undefined;
	const focusedPlatform = focusedSub ? platformOf(focusedSub) : undefined;
	const sections = sectionsFor(scope);
	// 拓展列表晚一步回来时,源报得出的那几种会从「最多」收窄成它真报的,当前这一节可能就没了 ——
	// 那一刻画第一节,别画一个侧栏里已经不在的节。
	const shownSection: SectionId =
		sections.length === 0 || sections.some((s) => s.id === section)
			? section
			: (sections[0] as SectionMeta).id;

	// 灵动岛绑定改由互斥子组件承载:isGlobal → <GlobalDraftBinder>,per-UP →
	// <SubscriptionRulesEditor> 自调 useDirtyDraft。两者条件渲染互斥,见下方 JSX 与
	// GlobalDraftBinder 注释。
	// presets 只被「AI 人格」那一格用到 —— 它判的是「挑中的人格还在不在」,
	// 与 SubscriptionRulesEditor 里那颗开关同一个判据(见 section-scope#hasAiPersonaOverride)。
	const customizedIds: Set<SectionId> | undefined =
		!isGlobal && focusedSub
			? new Set(
					sections
						.map((s) => s.id)
						.filter((id) =>
							isSectionCustomized(
								focusedSub,
								id,
								personaList,
								focusedPlatform?.membershipPrograms ?? [],
							),
						),
				)
			: undefined;

	if (!draft) {
		return <LoadingBlock label={tx("sourceUi.pages.Rules.label.3")} />;
	}

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{isGlobal && globalsQuery.data ? (
				<GlobalDraftBinder
					defaults={draft.defaults}
					baseline={globalsQuery.data.defaults}
					templatesSeen={draft.templatesSeen}
					baselineTemplatesSeen={globalsQuery.data.templatesSeen}
					onSave={() => save.mutateAsync(draft)}
					onDiscard={() => {
						if (globalsQuery.data) setDraft(globalsQuery.data);
					}}
				/>
			) : null}
			<ScopeTabs
				scope={scope}
				onChange={handleScopeChange}
				tabSubs={tabSubs}
				availableSubs={availableSubs}
				onAddSub={handleAddSub}
				onRemoveSub={handleRemoveSub}
				overridesCountFor={(s) => overrideKeysOf(s).size + (hasSpecialViewers(s) ? 1 : 0)}
				platformOf={(identity) => subscriptionPlatformOf(identity, sources)}
			/>

			<div className="grid gap-4 xl:grid-bn-rail">
				<SectionList
					sections={sections}
					current={shownSection}
					onPick={setSection}
					heading={
						isGlobal
							? tx("sourceUi.pages.Rules.heading.4")
							: tx("sourceUi.pages.Rules.heading.5", {
									value1: focusedSub ? displayName(focusedSub, platformOf(focusedSub)) : "",
								})
					}
					customizedIds={customizedIds}
				/>

				{/* 「默认文案有更新」的提示只对**全局**模板成立:per-UP 的模板是主人显式
				    覆盖出来的,缺字段就跟随全局,没有「他没见过这版默认」这回事。 */}
				<FieldUpdatesProvider value={isGlobal ? fieldUpdates : null}>
					<div className="space-y-4">
						{!isGlobal && focusedSub ? (
							<SubscriptionRulesEditor
								sub={focusedSub}
								platform={focusedPlatform}
								defaults={draft.defaults}
								factory={factory}
								presets={personaList}
								section={shownSection}
							/>
						) : section === "filter" ? (
							<FilterSection value={draft.defaults.filters} onPatch={patchDraft} />
						) : section === "imageGroup" ? (
							<ImageGroupSection value={draft.defaults.imageGroup} onPatch={patchDraft} />
						) : section === "live" ? (
							<LiveThresholdsSection
								programs={programs}
								superchat={draft.defaults.superchat}
								membership={draft.defaults.membership}
								schedule={draft.defaults.schedule}
								liveStart={draft.defaults.liveStart}
								liveStreaming={draft.defaults.liveStreaming}
								liveStreamingOn={draft.defaults.features.liveStreaming}
								onPatch={patchDraft}
							/>
						) : section === "summary" ? (
							<SummarySection
								templates={draft.defaults.templates}
								factory={factory}
								onPatch={patchDraft}
							/>
						) : section === "msg" ? (
							<LiveMsgSection
								templates={draft.defaults.templates}
								factory={factory}
								layout={draft.defaults.messageLayout.live}
								onPatch={patchDraft}
							/>
						) : section === "dynamicMsg" ? (
							<DynamicMsgSection
								templates={draft.defaults.templates}
								factory={factory}
								layout={draft.defaults.messageLayout.post}
								onPatch={patchDraft}
							/>
						) : section === "guard" ? (
							<GuardSection
								programs={programs}
								templates={draft.defaults.templates}
								factory={factory}
								onPatch={patchDraft}
							/>
						) : null}
					</div>
				</FieldUpdatesProvider>
			</div>

			{pendingRemoval ? (
				<ConfirmDialog
					title={tx("sourceUi.pages.Rules.title.6")}
					message={
						<>
							{tx("sourceUi.pages.Rules.message.7")}
							<b className="text-bn-text-primary">
								{displayName(pendingRemoval, platformOf(pendingRemoval))}
							</b>
							{tx("sourceUi.pages.Rules.message.8")}
							{platformOf(pendingRemoval).features.some(
								(feature) => feature === "viewerChat" || feature === "viewerEnter",
							)
								? tx("sourceUi.pages.Rules.message.9")
								: ""}
							{tx("sourceUi.pages.Rules.message.10")}
						</>
					}
					confirmLabel={tx("cards.remove.confirm")}
					cancelLabel={tx("subs.new.cancel")}
					danger
					onConfirm={confirmRemoveSub}
					onCancel={() => setPendingRemoval(null)}
				/>
			) : null}
		</div>
	);
}
