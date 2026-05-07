import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError, api } from "../services/api";
import {
	FEATURE_KEYS,
	FEATURE_LABELS,
	type FeatureKey,
	makeEmptySubscription,
	type PushTarget,
	platformLabel,
	type Subscription,
	type SubscriptionRouting,
} from "../types/domain";

const inputClass =
	"w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200";

function RoutingMatrix({
	routing,
	targets,
	onChange,
}: {
	routing: SubscriptionRouting;
	targets: PushTarget[];
	onChange: (next: SubscriptionRouting) => void;
}) {
	if (targets.length === 0) {
		return (
			<div className="rounded border border-dashed border-amber-300 bg-amber-50 p-3 text-xs text-amber-700">
				尚未配置任何推送目标。请先在「推送目标」页创建至少一个目标。
			</div>
		);
	}
	function toggle(feature: FeatureKey, targetId: string, on: boolean): void {
		const ids = new Set(routing[feature]);
		if (on) ids.add(targetId);
		else ids.delete(targetId);
		onChange({ ...routing, [feature]: [...ids] });
	}
	return (
		<div className="overflow-x-auto rounded border border-gray-200">
			<table className="w-full text-xs">
				<thead className="bg-gray-50">
					<tr>
						<th className="sticky left-0 bg-gray-50 px-3 py-2 text-left font-medium text-gray-600">
							特性
						</th>
						{targets.map((t) => (
							<th key={t.id} className="px-3 py-2 text-left font-medium text-gray-600">
								<div>{t.name}</div>
								<div className="text-[10px] font-normal text-gray-400">
									{platformLabel(t.platform)} · {t.scope}
								</div>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{FEATURE_KEYS.map((feature) => (
						<tr key={feature} className="border-t border-gray-100">
							<td className="sticky left-0 bg-white px-3 py-2 text-gray-700">
								{FEATURE_LABELS[feature]}
								<div className="text-[10px] text-gray-400">{feature}</div>
							</td>
							{targets.map((t) => (
								<td key={t.id} className="px-3 py-2">
									<input
										type="checkbox"
										checked={routing[feature].includes(t.id)}
										onChange={(e) => toggle(feature, t.id, e.target.checked)}
									/>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function SubEditor({
	value,
	targets,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: {
	value: Subscription;
	targets: PushTarget[];
	onChange: (next: Subscription) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}) {
	return (
		<div className="space-y-4 rounded-lg border border-blue-200 bg-blue-50/40 p-4">
			<div className="text-sm font-medium text-blue-900">UID {value.uid || "（未填）"}</div>
			<label className="grid grid-cols-[120px_1fr] items-center gap-3">
				<span className="text-xs text-gray-500">B 站 UID</span>
				<input
					className={inputClass}
					placeholder="纯数字 UID"
					value={value.uid}
					onChange={(e) => onChange({ ...value, uid: e.target.value.replace(/[^\d]/g, "") })}
				/>
			</label>
			<label className="grid grid-cols-[120px_1fr] items-center gap-3">
				<span className="text-xs text-gray-500">分组（逗号分隔）</span>
				<input
					className={inputClass}
					value={value.groups.join(",")}
					onChange={(e) =>
						onChange({
							...value,
							groups: e.target.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
						})
					}
				/>
			</label>
			<label className="grid grid-cols-[120px_1fr] items-center gap-3">
				<span className="text-xs text-gray-500">备注</span>
				<input
					className={inputClass}
					value={value.notes ?? ""}
					onChange={(e) => onChange({ ...value, notes: e.target.value || undefined })}
				/>
			</label>
			<label className="grid grid-cols-[120px_1fr] items-center gap-3">
				<span className="text-xs text-gray-500">启用</span>
				<input
					type="checkbox"
					checked={value.enabled}
					onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
				/>
			</label>
			<div className="space-y-1">
				<div className="text-xs text-gray-500">推送路由：勾选哪些目标接收对应特性</div>
				<RoutingMatrix
					routing={value.routing}
					targets={targets}
					onChange={(routing) => onChange({ ...value, routing })}
				/>
			</div>
			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}
			<div className="flex gap-2 pt-1">
				<button
					type="button"
					disabled={saving || !/^\d+$/.test(value.uid)}
					onClick={onSave}
					className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
				>
					{saving ? "保存中…" : "保存"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={saving}
					className="rounded bg-white px-4 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
				>
					取消
				</button>
			</div>
		</div>
	);
}

function SubCard({
	sub,
	targets,
	onEdit,
	onDelete,
	deleting,
}: {
	sub: Subscription;
	targets: PushTarget[];
	onEdit: () => void;
	onDelete: () => void;
	deleting: boolean;
}) {
	const targetNameById = useMemo(() => {
		const m = new Map<string, string>();
		for (const t of targets) m.set(t.id, t.name);
		return m;
	}, [targets]);
	const enabledFeatures = FEATURE_KEYS.filter((f) => sub.routing[f].length > 0);
	return (
		<div className="rounded-lg border border-gray-200 bg-white p-4">
			<div className="flex items-start justify-between">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium">
							{sub.cachedProfile?.name ?? `UID ${sub.uid}`}
						</span>
						<span
							className={`rounded-full px-2 py-0.5 text-xs ${
								sub.enabled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"
							}`}
						>
							{sub.enabled ? "启用" : "停用"}
						</span>
						{sub.groups.map((g) => (
							<span key={g} className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
								{g}
							</span>
						))}
					</div>
					<div className="text-xs text-gray-500">
						UID {sub.uid} · id {sub.id}
					</div>
					{sub.notes ? <div className="text-xs text-gray-600">备注：{sub.notes}</div> : null}
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={onEdit}
						className="rounded px-3 py-1 text-xs text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
					>
						编辑
					</button>
					<button
						type="button"
						onClick={onDelete}
						disabled={deleting}
						className="rounded px-3 py-1 text-xs text-red-600 ring-1 ring-red-200 hover:bg-red-50 disabled:opacity-50"
					>
						{deleting ? "删除中…" : "删除"}
					</button>
				</div>
			</div>
			{enabledFeatures.length > 0 ? (
				<div className="mt-3 flex flex-wrap gap-1.5">
					{enabledFeatures.map((f) => (
						<span
							key={f}
							className="rounded bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700 ring-1 ring-gray-200"
						>
							{FEATURE_LABELS[f]} →{" "}
							{sub.routing[f].map((tid) => targetNameById.get(tid) ?? tid.slice(0, 6)).join(" / ")}
						</span>
					))}
				</div>
			) : (
				<div className="mt-3 text-xs text-gray-400">未配置任何推送特性</div>
			)}
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

	const [draft, setDraft] = useState<Subscription | null>(null);
	const [error, setError] = useState<string | null>(null);

	const upsert = useMutation({
		mutationFn: async (s: Subscription) => {
			setError(null);
			try {
				await api.post<Subscription[]>("/api/subs", s);
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["subscriptions"] });
			setDraft(null);
		},
	});

	const del = useMutation({
		mutationFn: async (id: string) => {
			await api.delete(`/api/subs/${id}`);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	function startNew(): void {
		setError(null);
		setDraft(makeEmptySubscription(""));
	}

	function startEdit(s: Subscription): void {
		setError(null);
		setDraft({ ...s });
	}

	return (
		<div className="space-y-5">
			<div className="flex items-center justify-between">
				<div className="space-y-1">
					<h2 className="text-base font-medium">订阅 UP 主</h2>
					<p className="text-xs text-gray-500">
						按 UID 添加 UP 主，并为每个特性勾选要推送的目标。所有覆盖项默认继承全局配置。
					</p>
				</div>
				<button
					type="button"
					onClick={startNew}
					disabled={draft !== null}
					className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
				>
					新增订阅
				</button>
			</div>

			{draft ? (
				<SubEditor
					value={draft}
					targets={targetsQuery.data ?? []}
					onChange={setDraft}
					saving={upsert.isPending}
					error={error}
					onCancel={() => {
						setDraft(null);
						setError(null);
					}}
					onSave={() => upsert.mutate(draft)}
				/>
			) : null}

			{subsQuery.isLoading ? <div className="text-sm text-gray-500">加载中…</div> : null}
			{subsQuery.error ? (
				<div className="text-sm text-red-600">
					加载失败：{String((subsQuery.error as Error).message)}
				</div>
			) : null}
			{subsQuery.data && subsQuery.data.length === 0 && !draft ? (
				<div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
					还没有订阅 UP 主。点击「新增订阅」开始。
				</div>
			) : null}

			<div className="space-y-3">
				{subsQuery.data?.map((s) => (
					<SubCard
						key={s.id}
						sub={s}
						targets={targetsQuery.data ?? []}
						onEdit={() => startEdit(s)}
						onDelete={() => del.mutate(s.id)}
						deleting={del.isPending && del.variables === s.id}
					/>
				))}
			</div>
		</div>
	);
}
