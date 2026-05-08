import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Btn, Input } from "../components/atoms";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import { makeEmptySubscription, type PushTarget, type Subscription } from "../types/domain";
import type { GlobalConfig } from "../types/globals";
import { CorePluginSection } from "./up/CorePluginSection";
import { displayName } from "./up/helpers";
import { UpCard } from "./up/UpCard";
import { UpDrawer } from "./up/UpDrawer";

type FilterId = "all" | "enabled" | "disabled" | "live";

interface FilterDef {
	id: FilterId;
	label: string;
	matches: (s: Subscription) => boolean;
}

const FILTERS: ReadonlyArray<FilterDef> = [
	{ id: "all", label: "全部", matches: () => true },
	{ id: "live", label: "直播中", matches: (s) => s.state.liveStatus === "live" },
	{ id: "enabled", label: "已启用", matches: (s) => s.enabled },
	{ id: "disabled", label: "已禁用", matches: (s) => !s.enabled },
];

function NewSubDialog({
	onSubmit,
	onCancel,
	pending,
	error,
}: {
	onSubmit: (uid: string) => void;
	onCancel: () => void;
	pending: boolean;
	error: string | null;
}) {
	const [uid, setUid] = useState("");
	const valid = /^\d+$/.test(uid);
	return (
		<div className="bn-anim-fade-in fixed inset-0 z-30 flex items-center justify-center bg-black/30 backdrop-blur-sm">
			<div className="w-[420px] rounded-bn-card border border-white/60 bg-white p-5 shadow-bn-elev">
				<div className="mb-1 text-base font-bold text-bn-text-primary">添加 UP 主</div>
				<div className="mb-4 text-[12px] text-bn-text-secondary">
					输入 B 站 UID，女仆就能帮主人盯着 TA 的动态啦 (๑•̀ㅂ•́)و✧
				</div>
				<Input
					full
					value={uid}
					onChange={setUid}
					placeholder="纯数字 UID（例：401742377）"
					icon={<Icon.user size={14} />}
				/>
				{error ? (
					<div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
						{error}
					</div>
				) : null}
				<div className="mt-4 flex justify-end gap-2">
					<Btn variant="outline" size="sm" onClick={onCancel} disabled={pending}>
						取消
					</Btn>
					<Btn
						variant="primary"
						size="sm"
						onClick={() => onSubmit(uid)}
						disabled={!valid || pending}
					>
						{pending ? "添加中…" : "添加"}
					</Btn>
				</div>
			</div>
		</div>
	);
}

export default function Subs() {
	const qc = useQueryClient();
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const subs = subsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];

	const [q, setQ] = useState("");
	const [filterId, setFilterId] = useState<FilterId>("all");
	const [selection, setSelection] = useState<Set<string>>(new Set());
	const [drawerSubId, setDrawerSubId] = useState<string | null>(null);
	const [showNewDialog, setShowNewDialog] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const filterDef = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];
	const filtered = useMemo(() => {
		const ql = q.trim().toLowerCase();
		return subs.filter((s) => {
			if (!filterDef.matches(s)) return false;
			if (!ql) return true;
			return (
				s.uid.includes(ql) ||
				displayName(s).toLowerCase().includes(ql) ||
				(s.notes ?? "").toLowerCase().includes(ql)
			);
		});
	}, [subs, filterDef, q]);

	const filterCounts: Record<FilterId, number> = {
		all: subs.length,
		live: subs.filter((s) => s.state.liveStatus === "live").length,
		enabled: subs.filter((s) => s.enabled).length,
		disabled: subs.filter((s) => !s.enabled).length,
	};

	const drawerSub = drawerSubId ? (subs.find((s) => s.id === drawerSubId) ?? null) : null;

	const upsert = useMutation({
		mutationFn: async (s: Subscription) => {
			setError(null);
			try {
				await api.post<Subscription[]>("/api/subs", s);
				return s;
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const del = useMutation({
		mutationFn: async (id: string) => {
			await api.delete(`/api/subs/${id}`);
			return id;
		},
		onSuccess: (id) => {
			qc.invalidateQueries({ queryKey: ["subscriptions"] });
			setSelection((sel) => {
				const next = new Set(sel);
				next.delete(id);
				return next;
			});
			if (drawerSubId === id) setDrawerSubId(null);
		},
	});

	function toggleSelect(id: string): void {
		setSelection((sel) => {
			const next = new Set(sel);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleEnabled(s: Subscription, on: boolean): void {
		upsert.mutate({ ...s, enabled: on });
	}

	function bulkSetEnabled(on: boolean): void {
		const ids = [...selection];
		void Promise.allSettled(
			ids.map((id) => {
				const s = subs.find((x) => x.id === id);
				if (!s) return Promise.resolve();
				return api.post<Subscription[]>("/api/subs", { ...s, enabled: on });
			}),
		).then(() => qc.invalidateQueries({ queryKey: ["subscriptions"] }));
	}

	function bulkDelete(): void {
		const ids = [...selection];
		void Promise.allSettled(ids.map((id) => api.delete(`/api/subs/${id}`))).then(() => {
			qc.invalidateQueries({ queryKey: ["subscriptions"] });
			setSelection(new Set());
		});
	}

	function handleNew(uid: string): void {
		const fresh = makeEmptySubscription(uid);
		upsert.mutate(fresh, {
			onSuccess: () => {
				setShowNewDialog(false);
				setDrawerSubId(fresh.id);
			},
		});
	}

	return (
		<div className="space-y-4">
			<CorePluginSection globals={globalsQuery.data} targets={targets} />
			<div className="flex flex-wrap items-center gap-2.5">
				<Input
					value={q}
					onChange={setQ}
					placeholder="搜索 UP 主名称或 UID..."
					icon={<Icon.search size={14} />}
				/>
				<div className="flex gap-1 rounded-md border border-black/5 bg-white/60 p-1 backdrop-blur-sm">
					{FILTERS.map((f) => {
						const active = filterId === f.id;
						return (
							<button
								type="button"
								key={f.id}
								onClick={() => setFilterId(f.id)}
								className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition ${
									active
										? "bg-white text-bn-pink shadow-sm"
										: "text-bn-text-tertiary hover:text-bn-text-primary"
								}`}
							>
								{f.label}
								<span
									className={`text-[10px] font-bold ${
										active ? "text-bn-pink" : "text-bn-text-secondary"
									}`}
								>
									{filterCounts[f.id]}
								</span>
							</button>
						);
					})}
				</div>
				<div className="flex-1" />
				{selection.size > 0 ? (
					<div className="flex items-center gap-2 rounded-md bg-bn-pink/12 px-2.5 py-1 text-xs font-semibold text-bn-pink">
						已选 {selection.size} 项
						<Btn size="sm" variant="ghost" onClick={() => bulkSetEnabled(true)}>
							批量启用
						</Btn>
						<Btn size="sm" variant="ghost" onClick={() => bulkSetEnabled(false)}>
							批量禁用
						</Btn>
						<Btn size="sm" variant="danger" onClick={bulkDelete}>
							批量删除
						</Btn>
					</div>
				) : null}
				<Btn
					variant="primary"
					size="sm"
					icon={<Icon.plus size={12} />}
					onClick={() => setShowNewDialog(true)}
				>
					添加
				</Btn>
			</div>

			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}

			{subsQuery.isLoading ? <div className="text-sm text-bn-text-secondary">加载中…</div> : null}
			{subsQuery.error ? (
				<div className="text-sm text-red-600">
					加载失败：{String((subsQuery.error as Error).message)}
				</div>
			) : null}
			{subsQuery.data && filtered.length === 0 ? (
				<div className="rounded-bn-card border border-dashed border-gray-300 bg-white/60 p-10 text-center">
					<div className="mb-1 text-sm font-bold text-bn-text-primary">
						{q.trim() || filterId !== "all" ? "没有匹配的订阅" : "还没有订阅任何 UP 主"}
					</div>
					<div className="text-[12px] text-bn-text-secondary">
						{q.trim() || filterId !== "all" ? "试试换个关键词或筛选条件" : "点击右上「添加」开始"}
					</div>
				</div>
			) : null}

			<div
				className="grid gap-3"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
			>
				{filtered.map((s) => (
					<UpCard
						key={s.id}
						sub={s}
						selected={selection.has(s.id)}
						togglePending={upsert.isPending && upsert.variables?.id === s.id}
						onClick={() => setDrawerSubId(s.id)}
						onToggleSelect={() => toggleSelect(s.id)}
						onToggleEnabled={(on) => toggleEnabled(s, on)}
					/>
				))}
			</div>

			{drawerSub ? (
				<UpDrawer
					sub={drawerSub}
					targets={targets}
					onClose={() => setDrawerSubId(null)}
					saving={upsert.isPending || del.isPending}
					onSave={(next) => {
						upsert.mutate(next, {
							onSuccess: () => setDrawerSubId(null),
						});
					}}
					onDelete={() => {
						del.mutate(drawerSub.id);
					}}
				/>
			) : null}

			{showNewDialog ? (
				<NewSubDialog
					onSubmit={handleNew}
					onCancel={() => {
						setShowNewDialog(false);
						setError(null);
					}}
					pending={upsert.isPending}
					error={error}
				/>
			) : null}
		</div>
	);
}
