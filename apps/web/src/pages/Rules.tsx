import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/dialog";
import { type Scope, ScopeTabs } from "../components/scope-tabs";
import { SectionNav } from "../components/section-nav";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { api } from "../services/api";
import type { Subscription } from "../types/domain";
import type { GlobalConfig, GlobalConfigPatch, GlobalDefaults } from "../types/globals";
import { buildOverridesPatch } from "./rules/overrides-patch";
import { PerUpEditor, type PerUpOverrideKey, perUpOverrideKeys } from "./rules/PerUpEditor";
import { isSectionCustomized } from "./rules/section-scope";
import {
	DynamicMsgSection,
	FilterSection,
	GLOBAL_SECTIONS,
	GuardSection,
	ImageGroupSection,
	LiveMsgSection,
	LiveThresholdsSection,
	PERUP_SECTIONS,
	type SectionId,
	type SectionMeta,
	SummarySection,
} from "./rules/sections";
import { displayName } from "./up/helpers";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Slices on Subscription.overrides that are populated; per-UP "已覆盖" 状态来源。 */
function overrideKeysOf(sub: Subscription): Set<PerUpOverrideKey> {
	const keys = new Set<PerUpOverrideKey>();
	for (const key of perUpOverrideKeys) {
		if (sub.overrides[key] !== undefined) keys.add(key);
	}
	return keys;
}

function hasAnyCustomization(sub: Subscription): boolean {
	return overrideKeysOf(sub).size > 0 || sub.specialUsers.length > 0;
}

// isSectionCustomized 已抽到 ./rules/section-scope(与 PerUpEditor 的 toggle 判定共用
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
					<span
						className="inline-block h-1.5 w-1.5 rounded-full bg-bn-pink"
						title="该 UP 主已设置该项覆盖"
					/>
				) : undefined,
			}))}
		/>
	);
}

// ── Deep merge (for global PATCH draft) ────────────────────────────────────

function deepMerge<T>(base: T, patch: GlobalConfigPatch): T {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const k of Object.keys(patch)) {
		const pv = (patch as Record<string, unknown>)[k];
		const bv = out[k];
		if (
			pv != null &&
			typeof pv === "object" &&
			!Array.isArray(pv) &&
			bv != null &&
			typeof bv === "object" &&
			!Array.isArray(bv)
		) {
			out[k] = deepMerge(bv, pv as GlobalConfigPatch);
		} else {
			out[k] = pv;
		}
	}
	return out as T;
}

// ── GlobalDraftBinder (全局 island,互斥挂载) ───────────────────────────────

/**
 * 全局 island 绑定器 —— 把 GlobalDefaults 打平成扁平 code 结构喂 useDirtyDraft:
 * filters / imageGroup 顶层字段无前缀(字典 code 无前缀)→ 打平;schedule /
 * templates 字典 code 带前缀 → 保 nested,walkTreeDiff 递归出 `schedule.X` /
 * `templates.X`。
 *
 * 刻意抽成独立组件、仅在 isGlobal 时挂载,与 per-UP 的 PerUpEditor(自调
 * pageKey "rules-perup" 的 useDirtyDraft)**互斥** —— 同一时刻只有一个 binder
 * 在册,杜绝两个 useDirtyDraft 同时挂载时抢单槽 draftStore 的注册/注销 effect
 * 时序竞态(子 register 先于父 unregister 把当前页 stomp 成 null)。
 */
export function GlobalDraftBinder({
	defaults,
	baseline,
	onSave,
	onDiscard,
}: {
	defaults: GlobalDefaults;
	baseline: GlobalDefaults;
	onSave: () => Promise<unknown> | unknown;
	onDiscard: () => void;
}): null {
	const islandDraft = useMemo(
		() => ({
			...defaults.filters,
			...defaults.imageGroup,
			schedule: defaults.schedule,
			templates: defaults.templates,
			messageLayout: defaults.messageLayout,
		}),
		[defaults],
	);
	const islandBaseline = useMemo(
		() => ({
			...baseline.filters,
			...baseline.imageGroup,
			schedule: baseline.schedule,
			templates: baseline.templates,
			messageLayout: baseline.messageLayout,
		}),
		[baseline],
	);
	useDirtyDraft({
		pageKey: "rules",
		pageLabel: "动态过滤规则",
		draft: islandDraft,
		baseline: islandBaseline,
		onSave,
		onDiscard,
	});
	return null;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Rules() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});

	const [scope, setScope] = useState<Scope>("__global");
	const [section, setSection] = useState<SectionId>("filter");
	const [draft, setDraft] = useState<GlobalConfig | null>(null);
	// 用户主动通过「添加 UP」加进来,但还没设任何 override 的 sub.id;客户端内存,刷新即清空。
	const [addedSubIds, setAddedSubIds] = useState<Set<string>>(new Set());
	// 待确认移除的 per-UP(有实际覆盖项,点 tab 的 x 后先弹确认 dialog 再清空)。
	const [pendingRemoval, setPendingRemoval] = useState<Subscription | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (next: GlobalConfig) => {
			// Only the scopes this page actually edits — filter / live thresholds /
			// templates / imageGroup。Posting the full draft would put
			// `defaults.cardStyle` and `defaults.ai` into the body and trigger the
			// backend enable-check (puppeteer launch + chat.completions probe)
			// every save, even though nothing here touches those scopes.
			await api.patch<GlobalConfig>("/api/globals", {
				defaults: {
					filters: next.defaults.filters,
					schedule: next.defaults.schedule,
					templates: next.defaults.templates,
					imageGroup: next.defaults.imageGroup,
					messageLayout: next.defaults.messageLayout,
				},
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	const removeSubCustomization = useMutation({
		mutationFn: async (sub: Subscription) => {
			// 移除该 UP 的所有 per-UP 配置。注意:发 `overrides: {}` 不行 —— 空对象给 store
			// deepMerge 遍历不到任何键 → 当「不改」→ 旧 slice 原样保留(同 SY1)。须把每个
			// 现存 slice 显式置 null(清除哨兵),buildOverridesPatch({}, base) 正好生成。
			return api.patch<Subscription>(`/api/subs/${sub.id}`, {
				overrides: buildOverridesPatch({}, sub.overrides),
				specialUsers: [],
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	function patchDraft(delta: GlobalConfigPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}

	const allSubs = subsQuery.data ?? [];

	// Tab 栏只显示:已经在 backend 有 overrides / specialUsers 的 sub + 客户端本轮添加的 sub。
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
		setScope(id);
		// 切到 per-UP 时,如果 section 不在 PERUP_SECTIONS 里,回退到第一项。
		if (!PERUP_SECTIONS.some((s) => s.id === section)) setSection(PERUP_SECTIONS[0].id);
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
		// 已有 backend 覆盖项 → 销毁性操作(清空 overrides + specialUsers),先弹确认再执行。
		if (sub && hasAnyCustomization(sub)) {
			setPendingRemoval(sub);
			return;
		}
		// 纯客户端临时添加(无任何覆盖)→ 无数据可丢,直接摘除。
		detachSub(id);
	}

	// 确认后真正清空该 UP 的 per-UP 配置(PATCH overrides:{} + specialUsers:[])。
	function confirmRemoveSub(): void {
		if (!pendingRemoval) return;
		removeSubCustomization.mutate(pendingRemoval);
		detachSub(pendingRemoval.id);
		setPendingRemoval(null);
	}

	function handleScopeChange(next: Scope): void {
		setScope(next);
		const nextSecs = next === "__global" ? GLOBAL_SECTIONS : PERUP_SECTIONS;
		if (!nextSecs.some((s) => s.id === section)) setSection(nextSecs[0].id);
	}

	const isGlobal = scope === "__global";
	const focusedSub = !isGlobal ? allSubs.find((s) => s.id === scope) : undefined;
	const sections = isGlobal ? GLOBAL_SECTIONS : PERUP_SECTIONS;

	// 灵动岛绑定改由互斥子组件承载:isGlobal → <GlobalDraftBinder>,per-UP →
	// <PerUpEditor> 自调 useDirtyDraft。两者条件渲染互斥,见下方 JSX 与
	// GlobalDraftBinder 注释。
	const customizedIds: Set<SectionId> | undefined =
		!isGlobal && focusedSub
			? new Set(sections.map((s) => s.id).filter((id) => isSectionCustomized(focusedSub, id)))
			: undefined;

	if (!draft) {
		return (
			<div className="bn-glass rounded-bn-card p-10 text-center text-sm text-bn-text-secondary shadow-bn-card">
				加载全局配置中…
			</div>
		);
	}

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{isGlobal && globalsQuery.data ? (
				<GlobalDraftBinder
					defaults={draft.defaults}
					baseline={globalsQuery.data.defaults}
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
				overridesCountFor={(s) => overrideKeysOf(s).size + (s.specialUsers.length > 0 ? 1 : 0)}
			/>

			<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
				<SectionList
					sections={sections}
					current={section}
					onPick={setSection}
					heading={
						isGlobal ? "规则分类(全局)" : `${focusedSub ? displayName(focusedSub) : ""} · 覆盖项`
					}
					customizedIds={customizedIds}
				/>

				<div className="space-y-4">
					{!isGlobal && focusedSub ? (
						<PerUpEditor sub={focusedSub} defaults={draft.defaults} section={section} />
					) : section === "filter" ? (
						<FilterSection value={draft.defaults.filters} onPatch={patchDraft} />
					) : section === "imageGroup" ? (
						<ImageGroupSection value={draft.defaults.imageGroup} onPatch={patchDraft} />
					) : section === "live" ? (
						<LiveThresholdsSection
							filters={draft.defaults.filters}
							schedule={draft.defaults.schedule}
							onPatch={patchDraft}
						/>
					) : section === "summary" ? (
						<SummarySection templates={draft.defaults.templates} onPatch={patchDraft} />
					) : section === "msg" ? (
						<LiveMsgSection
							templates={draft.defaults.templates}
							layout={draft.defaults.messageLayout.live}
							onPatch={patchDraft}
						/>
					) : section === "dynamicMsg" ? (
						<DynamicMsgSection
							templates={draft.defaults.templates}
							layout={draft.defaults.messageLayout.dynamic}
							onPatch={patchDraft}
						/>
					) : section === "guard" ? (
						<GuardSection templates={draft.defaults.templates} onPatch={patchDraft} />
					) : null}
				</div>
			</div>

			{pendingRemoval ? (
				<ConfirmDialog
					title="移除该 UP 的个性化配置?"
					message={
						<>
							将清空 <b className="text-bn-text-primary">{displayName(pendingRemoval)}</b>{" "}
							的所有覆盖项与特别关注,该 UP 之后跟随全局规则。此操作不可撤销。
						</>
					}
					confirmLabel="移除"
					cancelLabel="取消"
					danger
					onConfirm={confirmRemoveSub}
					onCancel={() => setPendingRemoval(null)}
				/>
			) : null}
		</div>
	);
}
