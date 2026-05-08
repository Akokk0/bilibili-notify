import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Btn } from "../components/atoms";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import type { PushTarget, Subscription } from "../types/domain";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { PerUpEditor } from "./rules/PerUpEditor";
import {
	CardStyleSection,
	CoreAppSection,
	FilterSection,
	GLOBAL_SECTIONS,
	GuardSection,
	LiveMsgSection,
	LiveThresholdsSection,
	type SectionId,
	SummarySection,
} from "./rules/sections";
import { colorFromUid, displayName } from "./up/helpers";

type Scope = "__global" | string; // string = subscription.id

function ScopePicker({
	scope,
	subs,
	onChange,
}: {
	scope: Scope;
	subs: Subscription[];
	onChange: (next: Scope) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5 rounded-md border border-black/5 bg-white/60 p-1 backdrop-blur-sm">
			<button
				type="button"
				onClick={() => onChange("__global")}
				className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition ${
					scope === "__global"
						? "bg-white text-bn-pink shadow-sm"
						: "text-bn-text-tertiary hover:text-bn-text-primary"
				}`}
			>
				<Icon.sparkle size={12} />
				全局
			</button>
			<span className="mx-1 h-4 w-px bg-black/10" />
			{subs.map((s) => {
				const active = scope === s.id;
				const color = colorFromUid(s.uid);
				return (
					<button
						type="button"
						key={s.id}
						onClick={() => onChange(s.id)}
						className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition ${
							active ? "bg-white shadow-sm" : "text-bn-text-tertiary hover:text-bn-text-primary"
						}`}
						style={active ? { color } : undefined}
					>
						<Avatar name={displayName(s)} color={color} size={18} />
						{displayName(s)}
					</button>
				);
			})}
		</div>
	);
}

function SectionList({
	sections,
	current,
	onPick,
}: {
	sections: typeof GLOBAL_SECTIONS;
	current: SectionId;
	onPick: (id: SectionId) => void;
}) {
	return (
		<div className="space-y-1.5">
			{sections.map((s) => {
				const active = current === s.id;
				return (
					<button
						type="button"
						key={s.id}
						onClick={() => onPick(s.id)}
						className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${
							active
								? "bg-white text-bn-text-primary shadow-bn-card"
								: "text-bn-text-tertiary hover:bg-white/70 hover:text-bn-text-primary"
						}`}
					>
						<span
							className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md ${
								active ? "bg-bn-pink/15 text-bn-pink" : "bg-black/5 text-bn-text-secondary"
							}`}
						>
							{s.icon}
						</span>
						<span className="min-w-0 flex-1">
							<span
								className={`block text-[12.5px] font-bold ${active ? "" : "text-bn-text-primary"}`}
							>
								{s.label}
							</span>
							<span className="mt-0.5 block truncate text-[10.5px] text-bn-text-secondary">
								{s.desc}
							</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

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
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [scope, setScope] = useState<Scope>("__global");
	const [section, setSection] = useState<SectionId>("filter");
	const [draft, setDraft] = useState<GlobalConfig | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Reset draft when the canonical globals change (initial load + after save).
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
				// Send the whole draft so app + master + defaults all flow back;
				// server PATCH deep-merges so unchanged fields stay put.
				await api.patch<GlobalConfig>("/api/globals", next);
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	function patchDraft(delta: GlobalConfigPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}

	function discard(): void {
		if (globalsQuery.data) setDraft(globalsQuery.data);
		setError(null);
	}

	const isGlobal = scope === "__global";
	const focusedSub = !isGlobal ? subsQuery.data?.find((s) => s.id === scope) : undefined;

	if (!draft) {
		return (
			<div className="bn-glass rounded-bn-card p-10 text-center text-sm text-bn-text-secondary shadow-bn-card">
				加载全局配置中…
			</div>
		);
	}

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<ScopePicker scope={scope} subs={subsQuery.data ?? []} onChange={setScope} />
				<div className="flex-1" />
				{dirty ? (
					<>
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
					</>
				) : (
					<span className="text-[11.5px] text-bn-text-secondary">已与服务端同步</span>
				)}
			</div>

			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}

			<div className="grid gap-4 xl:grid-cols-[260px_1fr]">
				<aside className="bn-glass sticky top-[120px] h-fit rounded-bn-card p-2 shadow-bn-card">
					<SectionList sections={GLOBAL_SECTIONS} current={section} onPick={setSection} />
				</aside>

				<div className="space-y-4">
					{!isGlobal && focusedSub ? (
						<PerUpEditor sub={focusedSub} defaults={draft.defaults} />
					) : section === "core" ? (
						<CoreAppSection
							app={draft.app}
							master={draft.master}
							targets={targetsQuery.data ?? []}
							onPatch={patchDraft}
						/>
					) : section === "filter" ? (
						<FilterSection value={draft.defaults.filters} onPatch={patchDraft} />
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
					) : section === "cardStyle" ? (
						<CardStyleSection cardStyle={draft.defaults.cardStyle} onPatch={patchDraft} />
					) : null}
				</div>
			</div>
		</div>
	);
}
