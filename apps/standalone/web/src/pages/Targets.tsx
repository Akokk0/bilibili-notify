import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../services/api";
import {
	KNOWN_PLATFORMS,
	makeEmptyTarget,
	type OnebotConfig,
	type PushTarget,
	type PushTargetScope,
	platformLabel,
	type WebDashboardConfig,
	type WebhookConfig,
} from "../types/domain";

const SCOPES: PushTargetScope[] = ["group", "private", "channel"];

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[120px_1fr] items-center gap-3">
			<span className="text-xs text-gray-500">{label}</span>
			<div>{children}</div>
		</div>
	);
}

const inputClass =
	"w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200";

function PlatformSpecificFields({
	target,
	onChange,
}: {
	target: PushTarget;
	onChange: (next: PushTarget) => void;
}) {
	if (target.platform === "onebot") {
		const cfg = target.config as OnebotConfig;
		return (
			<>
				<FieldRow label="baseUrl">
					<input
						className={inputClass}
						value={cfg.baseUrl}
						onChange={(e) => onChange({ ...target, config: { ...cfg, baseUrl: e.target.value } })}
					/>
				</FieldRow>
				<FieldRow label="accessToken">
					<input
						className={inputClass}
						value={cfg.accessToken ?? ""}
						onChange={(e) =>
							onChange({
								...target,
								config: { ...cfg, accessToken: e.target.value || undefined },
							})
						}
					/>
				</FieldRow>
				<FieldRow label="groupId">
					<input
						className={inputClass}
						value={cfg.groupId ?? ""}
						onChange={(e) =>
							onChange({
								...target,
								config: { ...cfg, groupId: e.target.value || undefined },
							})
						}
					/>
				</FieldRow>
				<FieldRow label="userId">
					<input
						className={inputClass}
						value={cfg.userId ?? ""}
						onChange={(e) =>
							onChange({
								...target,
								config: { ...cfg, userId: e.target.value || undefined },
							})
						}
					/>
				</FieldRow>
			</>
		);
	}
	if (target.platform === "webhook") {
		const cfg = target.config as WebhookConfig;
		return (
			<>
				<FieldRow label="url">
					<input
						className={inputClass}
						value={cfg.url}
						onChange={(e) => onChange({ ...target, config: { ...cfg, url: e.target.value } })}
					/>
				</FieldRow>
				<FieldRow label="secret">
					<input
						className={inputClass}
						value={cfg.secret ?? ""}
						onChange={(e) =>
							onChange({
								...target,
								config: { ...cfg, secret: e.target.value || undefined },
							})
						}
					/>
				</FieldRow>
			</>
		);
	}
	if (target.platform === "web-dashboard") {
		const cfg = target.config as WebDashboardConfig;
		return (
			<FieldRow label="dashboardUser">
				<input
					className={inputClass}
					placeholder="留空 = 广播给所有 dashboard 客户端"
					value={cfg.dashboardUser ?? ""}
					onChange={(e) =>
						onChange({
							...target,
							config: { dashboardUser: e.target.value || undefined },
						})
					}
				/>
			</FieldRow>
		);
	}
	// koishi-*
	const cfg = target.config as { botPlatform: string; selfId?: string; channelId?: string };
	return (
		<>
			<FieldRow label="botPlatform">
				<input
					className={inputClass}
					value={cfg.botPlatform}
					onChange={(e) =>
						onChange({
							...target,
							platform: `koishi-${e.target.value}`,
							config: { ...cfg, botPlatform: e.target.value },
						})
					}
				/>
			</FieldRow>
			<FieldRow label="selfId">
				<input
					className={inputClass}
					value={cfg.selfId ?? ""}
					onChange={(e) =>
						onChange({
							...target,
							config: { ...cfg, selfId: e.target.value || undefined },
						})
					}
				/>
			</FieldRow>
			<FieldRow label="channelId">
				<input
					className={inputClass}
					value={cfg.channelId ?? ""}
					onChange={(e) =>
						onChange({
							...target,
							config: { ...cfg, channelId: e.target.value || undefined },
						})
					}
				/>
			</FieldRow>
		</>
	);
}

function TargetEditor({
	value,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: {
	value: PushTarget;
	onChange: (next: PushTarget) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}) {
	return (
		<div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-4">
			<div className="text-sm font-medium text-blue-900">{value.name || "（未命名）"}</div>
			<FieldRow label="名称">
				<input
					className={inputClass}
					value={value.name}
					onChange={(e) => onChange({ ...value, name: e.target.value })}
				/>
			</FieldRow>
			<FieldRow label="平台">
				<select
					className={inputClass}
					value={
						KNOWN_PLATFORMS.some((p) => p.value === value.platform) ? value.platform : "custom"
					}
					onChange={(e) => {
						const next = e.target.value;
						if (next === "custom") return;
						onChange(makeEmptyTarget(next, value.name));
					}}
				>
					{KNOWN_PLATFORMS.map((p) => (
						<option key={p.value} value={p.value}>
							{p.label}
						</option>
					))}
					<option value="custom">{`自定义（当前：${value.platform}）`}</option>
				</select>
			</FieldRow>
			<FieldRow label="scope">
				<select
					className={inputClass}
					value={value.scope}
					onChange={(e) => onChange({ ...value, scope: e.target.value as PushTargetScope })}
				>
					{SCOPES.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
			</FieldRow>
			<FieldRow label="启用">
				<input
					type="checkbox"
					checked={value.enabled}
					onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
				/>
			</FieldRow>
			<PlatformSpecificFields target={value} onChange={onChange} />
			{error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}
			<div className="flex gap-2 pt-2">
				<button
					type="button"
					disabled={saving || !value.name.trim()}
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

function TargetCard({
	target,
	onEdit,
	onDelete,
	deleting,
}: {
	target: PushTarget;
	onEdit: () => void;
	onDelete: () => void;
	deleting: boolean;
}) {
	return (
		<div className="flex items-start justify-between rounded-lg border border-gray-200 bg-white p-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">{target.name}</span>
					<span
						className={`rounded-full px-2 py-0.5 text-xs ${
							target.enabled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"
						}`}
					>
						{target.enabled ? "启用" : "停用"}
					</span>
					<span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
						{platformLabel(target.platform)}
					</span>
					<span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
						{target.scope}
					</span>
				</div>
				<div className="text-xs text-gray-500">id: {target.id}</div>
				{target.testStatus ? (
					<div className="text-xs text-gray-500">
						最近测试：{target.testStatus.ok ? "OK" : `失败 — ${target.testStatus.err ?? ""}`}
						{target.testStatus.latencyMs != null ? ` · ${target.testStatus.latencyMs}ms` : ""}
					</div>
				) : null}
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
	);
}

export default function Targets() {
	const qc = useQueryClient();
	const list = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [draft, setDraft] = useState<PushTarget | null>(null);
	const [error, setError] = useState<string | null>(null);

	const upsert = useMutation({
		mutationFn: async (t: PushTarget) => {
			setError(null);
			try {
				await api.post<PushTarget[]>("/api/targets", t);
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["targets"] });
			setDraft(null);
		},
	});

	const del = useMutation({
		mutationFn: async (id: string) => {
			await api.delete(`/api/targets/${id}`);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["targets"] }),
	});

	function startNew(): void {
		setError(null);
		setDraft(makeEmptyTarget("onebot", "新推送目标"));
	}

	function startEdit(t: PushTarget): void {
		setError(null);
		setDraft({ ...t });
	}

	return (
		<div className="space-y-5">
			<div className="flex items-center justify-between">
				<div className="space-y-1">
					<h2 className="text-base font-medium">推送目标</h2>
					<p className="text-xs text-gray-500">
						管理 OneBot / Webhook / Web Dashboard / Koishi 平台的推送通道；订阅页将引用这里的 id。
					</p>
				</div>
				<button
					type="button"
					onClick={startNew}
					disabled={draft !== null}
					className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
				>
					新增推送目标
				</button>
			</div>

			{draft ? (
				<TargetEditor
					value={draft}
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

			{list.isLoading ? <div className="text-sm text-gray-500">加载中…</div> : null}
			{list.error ? (
				<div className="text-sm text-red-600">
					加载失败：{String((list.error as Error).message)}
				</div>
			) : null}
			{list.data && list.data.length === 0 && !draft ? (
				<div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
					还没有推送目标。点击「新增推送目标」创建第一个。
				</div>
			) : null}

			<div className="space-y-3">
				{list.data?.map((t) => (
					<TargetCard
						key={t.id}
						target={t}
						onEdit={() => startEdit(t)}
						onDelete={() => del.mutate(t.id)}
						deleting={del.isPending && del.variables === t.id}
					/>
				))}
			</div>
		</div>
	);
}
