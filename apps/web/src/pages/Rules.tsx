import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Btn, Pill } from "../components/atoms";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import type { Subscription } from "../types/domain";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { PerUpEditor, type PerUpOverrideKey, perUpOverrideKeys } from "./rules/PerUpEditor";
import {
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
import { colorFromUid, displayName } from "./up/helpers";

type Scope = "__global" | string; // string = subscription.id

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

/** per-UP 子分类是否当前 sub 已设置覆盖 → 侧栏小红点。 */
function isSectionCustomized(sub: Subscription, sectionId: SectionId): boolean {
	switch (sectionId) {
		case "filter":
			return sub.overrides.filters !== undefined;
		case "live":
			return sub.overrides.filters !== undefined || sub.overrides.schedule !== undefined;
		case "summary":
			return Boolean(sub.overrides.templates?.liveSummary);
		case "msg":
			return sub.overrides.templates?.liveMsgEnabled === true;
		case "guard":
			return sub.overrides.templates?.guardBuy?.enable === true;
		case "specialDanmaku":
			return (
				sub.specialUsers.some((u) => u.kinds.includes("danmaku")) ||
				Boolean(sub.overrides.templates?.specialDanmaku)
			);
		case "specialEnter":
			return (
				sub.specialUsers.some((u) => u.kinds.includes("enter")) ||
				Boolean(sub.overrides.templates?.specialUserEnter)
			);
		case "cardStyle":
			return sub.overrides.cardStyle !== undefined;
		case "ai":
			return sub.overrides.ai !== undefined;
		case "imageGroup":
			return sub.overrides.imageGroup !== undefined;
		default:
			return false;
	}
}

// ── Tab bar (作用域切换) ────────────────────────────────────────────────────

interface ScopeTabsProps {
	scope: Scope;
	onChange: (next: Scope) => void;
	tabSubs: Subscription[];
	availableSubs: Subscription[]; // candidates for "添加 UP" dropdown
	onAddSub: (id: string) => void;
	onRemoveSub: (id: string) => void;
	overridesCountFor: (sub: Subscription) => number;
}

function ScopeTabs({
	scope,
	onChange,
	tabSubs,
	availableSubs,
	onAddSub,
	onRemoveSub,
	overridesCountFor,
}: ScopeTabsProps) {
	const [adding, setAdding] = useState(false);
	const dropdownRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!adding) return;
		function handleDocClick(e: MouseEvent) {
			if (!dropdownRef.current) return;
			if (!dropdownRef.current.contains(e.target as Node)) setAdding(false);
		}
		document.addEventListener("mousedown", handleDocClick);
		return () => document.removeEventListener("mousedown", handleDocClick);
	}, [adding]);

	const isGlobal = scope === "__global";

	return (
		<div className="relative z-10 flex flex-wrap items-center gap-1.5 rounded-[11px] border border-black/5 bg-white/70 p-1.5 backdrop-blur-sm">
			{/* 全局 */}
			<button
				type="button"
				onClick={() => onChange("__global")}
				className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] font-bold transition ${
					isGlobal
						? "text-white shadow-[0_2px_8px_rgba(251,114,153,0.35)]"
						: "text-bn-text-tertiary hover:text-bn-text-primary"
				}`}
				style={isGlobal ? { background: "linear-gradient(135deg,#FB7299,#FF6699)" } : undefined}
			>
				<Icon.bell size={14} />
				全局 / 全部 UP
				<span
					className={`ml-0.5 rounded px-1.5 py-px font-mono text-[10px] font-semibold ${
						isGlobal ? "bg-white/25" : "bg-black/5"
					}`}
				>
					default
				</span>
			</button>

			{tabSubs.length > 0 ? <span className="mx-0.5 h-5.5 w-px bg-black/10" /> : null}

			{/* per-UP tabs (仅显示已定制 + 客户端临时添加的) */}
			{tabSubs.map((sub) => {
				const active = scope === sub.id;
				const color = colorFromUid(sub.uid);
				const count = overridesCountFor(sub);
				return (
					<div
						key={sub.id}
						className={`flex items-center gap-1.5 rounded-lg border py-1.5 pl-3 pr-1.5 text-[12.5px] font-bold transition ${
							active
								? "border-bn-pink/25 bg-white text-bn-pink shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
								: "border-transparent text-bn-text-tertiary hover:text-bn-text-primary"
						}`}
					>
						<button
							type="button"
							onClick={() => onChange(sub.id)}
							className="flex items-center gap-1.5"
						>
							<Avatar
								name={displayName(sub)}
								color={color}
								size={18}
								url={sub.cachedProfile?.avatar}
							/>
							<span className="max-w-[140px] truncate" title={displayName(sub)}>
								{displayName(sub)}
							</span>
							{count > 0 ? (
								<Pill color={active ? "#FB7299" : "#888"} subtle size="sm">
									{count}
								</Pill>
							) : null}
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onRemoveSub(sub.id);
							}}
							title={`移除 ${displayName(sub)} 的个性化配置`}
							className={`grid h-[18px] w-[18px] place-items-center rounded ${
								active
									? "text-bn-pink/80 hover:bg-bn-pink/10"
									: "text-bn-text-tertiary/70 hover:bg-black/5"
							}`}
						>
							<Icon.close size={11} />
						</button>
					</div>
				);
			})}

			{/* 添加 UP 按钮 + 下拉 */}
			<div className="relative" ref={dropdownRef}>
				<button
					type="button"
					onClick={() => setAdding((v) => !v)}
					title="从订阅列表添加 UP 主的个性化配置"
					className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold transition ${
						adding
							? "border-bn-pink/40 bg-bn-pink/[0.06] text-bn-pink"
							: "border-dashed border-black/15 text-bn-text-tertiary hover:text-bn-text-primary"
					}`}
				>
					<Icon.plus size={13} />
					添加 UP
				</button>
				{adding ? (
					<div className="absolute left-0 top-[calc(100%+6px)] z-30 min-w-[240px] overflow-hidden rounded-[10px] border border-black/[0.08] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
						<div className="border-b border-gray-100 px-3 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-wider text-bn-text-tertiary">
							选择要单独定制的 UP 主
						</div>
						{availableSubs.length === 0 ? (
							<div className="px-3 py-4 text-center text-[12px] text-bn-text-tertiary">
								所有已订阅的 UP 主都已添加
							</div>
						) : (
							<div className="max-h-72 overflow-y-auto py-1">
								{availableSubs.map((sub) => {
									const color = colorFromUid(sub.uid);
									return (
										<button
											type="button"
											key={sub.id}
											onClick={() => {
												onAddSub(sub.id);
												setAdding(false);
											}}
											className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[#fdf2f5]"
										>
											<Avatar
												name={displayName(sub)}
												color={color}
												size={28}
												url={sub.cachedProfile?.avatar}
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate text-[12.5px] font-bold text-bn-text-primary">
													{displayName(sub)}
												</div>
												<div className="text-[10.5px] text-bn-text-tertiary">UID {sub.uid}</div>
											</div>
											{sub.state.liveStatus === "live" ? (
												<Pill color="#FB7299" subtle size="sm">
													播
												</Pill>
											) : null}
										</button>
									);
								})}
							</div>
						)}
						<button
							type="button"
							onClick={() => setAdding(false)}
							className="block w-full border-t border-gray-100 py-2 text-center text-[11px] text-bn-text-tertiary hover:text-bn-text-primary"
						>
							取消
						</button>
					</div>
				) : null}
			</div>

			<div className="flex-1" />
			<div className="px-2 text-[11px] text-bn-text-tertiary">
				{isGlobal ? (
					"此处为全部 UP 默认设置"
				) : (
					<>
						仅作用于 <b className="text-bn-pink">{tabSubs.find((s) => s.id === scope)?.uid}</b>
						,未开启的项继承全局
					</>
				)}
			</div>
		</div>
	);
}

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
		<aside className="sticky top-[120px] h-fit min-w-0">
			<div className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wider text-bn-text-tertiary">
				{heading}
			</div>
			<div className="flex flex-col gap-1">
				{sections.map((s) => {
					const active = current === s.id;
					const overridden = customizedIds?.has(s.id) ?? false;
					return (
						<button
							type="button"
							key={s.id}
							onClick={() => onPick(s.id)}
							className={`flex w-full min-w-0 items-start gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition ${
								active
									? "border-bn-pink/35 bg-white/90 shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
									: "border-transparent hover:bg-white/55"
							}`}
						>
							<span
								className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center ${
									active ? "text-bn-pink" : "text-bn-text-secondary"
								}`}
							>
								{s.icon}
							</span>
							<span className="block min-w-0 flex-1">
								<span
									className={`flex items-center gap-1.5 text-[12.5px] font-bold ${
										active ? "text-bn-pink" : "text-bn-text-primary"
									}`}
								>
									{s.label}
									{overridden ? (
										<span
											className="inline-block h-1.5 w-1.5 rounded-full bg-bn-pink"
											title="该 UP 主已设置该项覆盖"
										/>
									) : null}
								</span>
								<span className="mt-0.5 block break-words text-[10.5px] leading-snug text-bn-text-tertiary">
									{s.desc}
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</aside>
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
	const [error, setError] = useState<string | null>(null);
	// 用户主动通过「添加 UP」加进来,但还没设任何 override 的 sub.id;客户端内存,刷新即清空。
	const [addedSubIds, setAddedSubIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	const dirty = useMemo(() => {
		if (!draft || !globalsQuery.data) return false;
		return JSON.stringify(draft) !== JSON.stringify(globalsQuery.data);
	}, [draft, globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (next: GlobalConfig) => {
			setError(null);
			try {
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
					},
				});
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	const removeSubCustomization = useMutation({
		mutationFn: async (id: string) => {
			// 移除该 UP 的所有 per-UP 配置:overrides 清空 + specialUsers 清空。
			return api.patch<Subscription>(`/api/subs/${id}`, { overrides: {}, specialUsers: [] });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	function patchDraft(delta: GlobalConfigPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}

	function discard(): void {
		if (globalsQuery.data) setDraft(globalsQuery.data);
		setError(null);
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

	function handleRemoveSub(id: string): void {
		// 临时添加(未保存任何 override)→ 仅从客户端 set 移除。
		// 已经有 backend 覆盖项 → 调 PATCH 清空 overrides + specialUsers。
		const sub = allSubs.find((s) => s.id === id);
		if (sub && hasAnyCustomization(sub)) removeSubCustomization.mutate(id);
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.delete(id);
			return next;
		});
		if (scope === id) setScope("__global");
	}

	function handleScopeChange(next: Scope): void {
		setScope(next);
		const nextSecs = next === "__global" ? GLOBAL_SECTIONS : PERUP_SECTIONS;
		if (!nextSecs.some((s) => s.id === section)) setSection(nextSecs[0].id);
	}

	const isGlobal = scope === "__global";
	const focusedSub = !isGlobal ? allSubs.find((s) => s.id === scope) : undefined;
	const sections = isGlobal ? GLOBAL_SECTIONS : PERUP_SECTIONS;
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
			<ScopeTabs
				scope={scope}
				onChange={handleScopeChange}
				tabSubs={tabSubs}
				availableSubs={availableSubs}
				onAddSub={handleAddSub}
				onRemoveSub={handleRemoveSub}
				overridesCountFor={(s) => overrideKeysOf(s).size + (s.specialUsers.length > 0 ? 1 : 0)}
			/>

			{isGlobal && dirty ? (
				<div className="flex items-center justify-end gap-2">
					<span className="text-[11.5px] font-semibold text-bn-pink">未保存的改动</span>
					<Btn variant="outline" size="sm" onClick={discard} disabled={save.isPending}>
						丢弃
					</Btn>
					<Btn
						variant="primary"
						size="sm"
						onClick={() => save.mutate(draft)}
						disabled={save.isPending}
					>
						{save.isPending ? "保存中…" : "保存全部"}
					</Btn>
				</div>
			) : null}

			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}

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
						<LiveMsgSection templates={draft.defaults.templates} onPatch={patchDraft} />
					) : section === "guard" ? (
						<GuardSection templates={draft.defaults.templates} onPatch={patchDraft} />
					) : null}
				</div>
			</div>
		</div>
	);
}
