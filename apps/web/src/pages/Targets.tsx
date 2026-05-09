import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Btn, PlatformIcon, platformLabel, StatusDot, Toggle } from "../components/atoms";
import { Field, TInput } from "../components/forms";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import {
	KNOWN_PLATFORMS,
	makeEmptyTarget,
	type OnebotConfig,
	type PushTarget,
	type PushTargetScope,
	type WebDashboardConfig,
	type WebhookConfig,
} from "../types/domain";

/**
 * Targets page — 1:1 port of `.bn-design/variation-a-tabs.jsx#TargetsTab`,
 * minus the per-target features tab. Per plan §3, PushTarget no longer carries
 * `features`; all feature gating lives on Subscription.routing/overrides.
 */

const SCOPES: ReadonlyArray<{ value: PushTargetScope; label: string }> = [
	{ value: "group", label: "群组" },
	{ value: "private", label: "私聊" },
	{ value: "channel", label: "频道" },
];

type TestState = "pending" | "ok" | "fail";

const PLATFORM_TINT: Record<string, string> = {
	onebot: "#3b82f6",
	webhook: "#22c55e",
	"web-dashboard": "#a29bfe",
	"koishi-onebot": "#1C9CEA",
	"koishi-discord": "#5865F2",
	"koishi-telegram": "#26A5E4",
};

function tintFor(platform: string): string {
	return PLATFORM_TINT[platform] ?? "#888";
}

// ── Card row ────────────────────────────────────────────────────────────────

interface TargetCardProps {
	target: PushTarget;
	testing: TestState | undefined;
	onTest: () => void;
	onEdit: () => void;
	onDelete: () => void;
}

function TargetCard({ target, testing, onTest, onEdit, onDelete }: TargetCardProps) {
	const tint = tintFor(target.platform);
	const borderColor =
		testing === "fail" ? "#fecaca" : testing === "ok" ? "#bbf7d0" : "rgba(0,0,0,0.06)";
	const headIdent = identForCard(target);
	const lastTestLabel = target.testStatus
		? target.testStatus.ok
			? `上次测试 OK${
					target.testStatus.latencyMs != null ? ` · ${target.testStatus.latencyMs}ms` : ""
				}`
			: `上次测试失败${target.testStatus.err ? ` — ${target.testStatus.err}` : ""}`
		: null;

	return (
		<div
			className="rounded-[10px] border bg-white p-3.5 transition-[border-color] duration-200"
			style={{ borderColor }}
		>
			<div className="mb-2.5 flex items-center gap-2.5">
				<div
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
					style={{ background: `${tint}1a` }}
				>
					<PlatformIcon platform={target.platform} size={18} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-bold text-bn-text-primary">
						{target.name || "（未命名）"}
					</div>
					<div className="truncate font-mono text-[11px] text-bn-text-tertiary">{headIdent}</div>
				</div>
				{testing ? <TestingDot kind={testing} /> : <StatusDot kind={statusForCard(target)} />}
			</div>

			<div className="flex items-center justify-between text-[11.5px] text-bn-text-secondary">
				<span className="truncate">
					{platformLabel(target.platform)} · {scopeLabel(target.scope)}
					{target.enabled ? null : <span className="ml-1.5 text-bn-text-tertiary">(已停用)</span>}
				</span>
				<div className="flex shrink-0 gap-1">
					<Btn size="sm" variant="ghost" onClick={onTest} disabled={testing === "pending"}>
						{testing === "pending"
							? "测试中…"
							: testing === "ok"
								? "已连通"
								: testing === "fail"
									? "失败"
									: "测试"}
					</Btn>
					<Btn size="sm" variant="ghost" onClick={onEdit}>
						配置
					</Btn>
					<Btn
						size="sm"
						variant="ghost"
						onClick={onDelete}
						title="删除"
						icon={<Icon.trash size={11} />}
					>
						{null}
					</Btn>
				</div>
			</div>

			{lastTestLabel && !testing ? (
				<div
					className="mt-2.5 rounded-[4px] border-l-[3px] px-2.5 py-1.5 text-[11px]"
					style={
						target.testStatus?.ok
							? { background: "#f0fdf4", borderLeftColor: "#22c55e", color: "#166534" }
							: { background: "#fffbeb", borderLeftColor: "#f59e0b", color: "#92400e" }
					}
				>
					{lastTestLabel}
				</div>
			) : null}
		</div>
	);
}

function TestingDot({ kind }: { kind: TestState }) {
	const tone =
		kind === "pending"
			? { bg: "#fdcb6e", ring: "rgba(253,203,110,0.3)" }
			: kind === "ok"
				? { bg: "#22c55e", ring: "rgba(34,197,94,0.2)" }
				: { bg: "#ef4444", ring: "rgba(239,68,68,0.2)" };
	return (
		<span
			className={`inline-block h-2 w-2 shrink-0 rounded-full ${kind === "pending" ? "bn-anim-pulse" : ""}`}
			style={{ background: tone.bg, boxShadow: `0 0 0 3px ${tone.ring}` }}
		/>
	);
}

function identForCard(target: PushTarget): string {
	if (target.platform === "onebot") {
		const cfg = target.config as OnebotConfig;
		const id = cfg.groupId ?? cfg.userId ?? cfg.baseUrl;
		return id || target.id;
	}
	if (target.platform === "webhook") {
		return (target.config as WebhookConfig).url;
	}
	if (target.platform === "web-dashboard") {
		const cfg = target.config as WebDashboardConfig;
		return cfg.dashboardUser ? `→ ${cfg.dashboardUser}` : "→ 广播";
	}
	const cfg = target.config as { selfId?: string; channelId?: string };
	return cfg.channelId ?? cfg.selfId ?? target.id;
}

function statusForCard(t: PushTarget): "ok" | "warn" | "err" | "off" {
	if (!t.enabled) return "off";
	if (!t.testStatus) return "ok";
	return t.testStatus.ok ? "ok" : "err";
}

function scopeLabel(s: PushTargetScope): string {
	return SCOPES.find((x) => x.value === s)?.label ?? s;
}

// ── Add card (dashed) ───────────────────────────────────────────────────────

function AddCard({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex min-h-[122px] flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed border-gray-200 bg-transparent text-[12.5px] text-gray-400 transition hover:border-bn-pink hover:text-bn-pink"
		>
			<Icon.plus size={20} />
			绑定新的频道 / 群组
		</button>
	);
}

// ── Toast ───────────────────────────────────────────────────────────────────

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
	return (
		<div
			className="bn-anim-fade-in pointer-events-none absolute right-4 top-2 z-50 flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-bold shadow-md"
			style={
				ok
					? { background: "#f0fdf4", borderColor: "#bbf7d0", color: "#15803d" }
					: { background: "#fef2f2", borderColor: "#fecaca", color: "#b91c1c" }
			}
		>
			{ok ? <Icon.check size={13} /> : <Icon.close size={13} />}
			{msg}
		</div>
	);
}

// ── Editor modal ────────────────────────────────────────────────────────────

interface EditorModalProps {
	mode: "add" | "edit";
	value: PushTarget;
	onChange: (next: PushTarget) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}

function EditorModal({ mode, value, onChange, onSave, onCancel, saving, error }: EditorModalProps) {
	const valid = value.name.trim().length > 0;
	return (
		<ModalShell onCancel={onCancel} width={460}>
			<div className="mb-3 text-[15px] font-bold text-bn-text-primary">
				{mode === "add" ? "绑定新推送目标" : "配置推送目标"}
			</div>

			<div className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
				<Field label="平台" code="target.platform" required>
					<div className="flex flex-wrap gap-1.5">
						{KNOWN_PLATFORMS.map((p) => {
							const active = value.platform === p.value;
							const tint = tintFor(p.value);
							return (
								<button
									key={p.value}
									type="button"
									onClick={() => onChange(makeEmptyTarget(p.value, value.name))}
									className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-bold transition"
									style={
										active
											? { background: `${tint}18`, color: tint, borderColor: `${tint}55` }
											: {
													background: "#f5f5f5",
													color: "#666",
													borderColor: "#ececec",
												}
									}
								>
									<PlatformIcon platform={p.value} size={13} />
									{p.label}
								</button>
							);
						})}
					</div>
				</Field>

				<Field label="显示名称" code="target.name" required>
					<TInput
						value={value.name}
						onChange={(v) => onChange({ ...value, name: v })}
						placeholder="如：游戏交流群"
					/>
				</Field>

				<Field label="作用域" code="target.scope">
					<div className="flex gap-1.5">
						{SCOPES.map((s) => {
							const active = value.scope === s.value;
							return (
								<button
									key={s.value}
									type="button"
									onClick={() => onChange({ ...value, scope: s.value })}
									className="rounded-md border px-3 py-1 text-[12px] font-bold transition"
									style={
										active
											? {
													background: "#FB72991f",
													color: "#FB7299",
													borderColor: "#FB729955",
												}
											: {
													background: "#f5f5f5",
													color: "#666",
													borderColor: "#ececec",
												}
									}
								>
									{s.label}
								</button>
							);
						})}
					</div>
				</Field>

				<Field label="启用" code="target.enabled">
					<Toggle value={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
				</Field>

				<PlatformSpecificFields target={value} onChange={onChange} />
			</div>

			{error ? (
				<div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}

			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" onClick={onCancel} disabled={saving}>
					取消
				</Btn>
				<Btn variant="primary" onClick={onSave} disabled={saving || !valid}>
					{saving ? "保存中…" : "保存"}
				</Btn>
			</div>
		</ModalShell>
	);
}

// ── Delete modal ────────────────────────────────────────────────────────────

function DeleteModal({
	target,
	onCancel,
	onConfirm,
	deleting,
}: {
	target: PushTarget;
	onCancel: () => void;
	onConfirm: () => void;
	deleting: boolean;
}) {
	return (
		<ModalShell onCancel={onCancel} width={420}>
			<div className="mb-2 text-[15px] font-bold text-bn-text-primary">移除推送目标</div>
			<div className="mb-5 text-[13px] leading-relaxed text-bn-text-secondary">
				确定要移除 <b className="text-bn-text-primary">{target.name}</b> 吗？
				<br />
				该频道 / 群组下的所有推送配置将一并清除。
			</div>
			<div className="flex justify-end gap-2">
				<Btn variant="outline" onClick={onCancel} disabled={deleting}>
					取消
				</Btn>
				<button
					type="button"
					onClick={onConfirm}
					disabled={deleting}
					className="inline-flex h-[30px] items-center justify-center rounded-md border border-transparent bg-red-500 px-3.5 text-[13px] font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{deleting ? "移除中…" : "确认移除"}
				</button>
			</div>
		</ModalShell>
	);
}

// ── Modal shell (overlay + esc) ─────────────────────────────────────────────

function ModalShell({
	children,
	onCancel,
	width,
}: {
	children: React.ReactNode;
	onCancel: () => void;
	width: number;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	return (
		<div className="bn-anim-fade-in fixed inset-0 z-[300] flex items-center justify-center">
			<button
				type="button"
				aria-label="关闭弹窗"
				onClick={onCancel}
				className="absolute inset-0 cursor-default border-0 bg-black/35 backdrop-blur-[4px]"
			/>
			<div
				role="dialog"
				aria-modal="true"
				className="relative rounded-[14px] bg-white p-6"
				style={{ width, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
			>
				{children}
			</div>
		</div>
	);
}

// ── Platform-specific fields ────────────────────────────────────────────────

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
				<Field label="HTTP baseUrl" code="config.baseUrl" required>
					<TInput
						value={cfg.baseUrl}
						onChange={(v) => onChange({ ...target, config: { ...cfg, baseUrl: v } })}
						placeholder="http://napcat:3000"
						mono
					/>
				</Field>
				<Field label="accessToken" code="config.accessToken">
					<TInput
						value={cfg.accessToken ?? ""}
						onChange={(v) =>
							onChange({ ...target, config: { ...cfg, accessToken: v || undefined } })
						}
						secret
					/>
				</Field>
				<Field label="群号 (groupId)" code="config.groupId">
					<TInput
						value={cfg.groupId ?? ""}
						onChange={(v) => onChange({ ...target, config: { ...cfg, groupId: v || undefined } })}
						mono
					/>
				</Field>
				<Field label="QQ 号 (userId)" code="config.userId">
					<TInput
						value={cfg.userId ?? ""}
						onChange={(v) => onChange({ ...target, config: { ...cfg, userId: v || undefined } })}
						mono
					/>
				</Field>
			</>
		);
	}
	if (target.platform === "webhook") {
		const cfg = target.config as WebhookConfig;
		return (
			<>
				<Field label="URL" code="config.url" required>
					<TInput
						value={cfg.url}
						onChange={(v) => onChange({ ...target, config: { ...cfg, url: v } })}
						placeholder="https://hooks.example.com/bn"
						mono
					/>
				</Field>
				<Field label="Secret" code="config.secret" hint="加在 x-bilibili-notify-secret 头">
					<TInput
						value={cfg.secret ?? ""}
						onChange={(v) => onChange({ ...target, config: { ...cfg, secret: v || undefined } })}
						secret
					/>
				</Field>
			</>
		);
	}
	if (target.platform === "web-dashboard") {
		const cfg = target.config as WebDashboardConfig;
		return (
			<Field
				label="dashboardUser"
				code="config.dashboardUser"
				hint="留空 = 广播给所有 dashboard 客户端"
			>
				<TInput
					value={cfg.dashboardUser ?? ""}
					onChange={(v) => onChange({ ...target, config: { dashboardUser: v || undefined } })}
				/>
			</Field>
		);
	}
	const cfg = target.config as { botPlatform: string; selfId?: string; channelId?: string };
	return (
		<>
			<Field label="botPlatform" code="config.botPlatform" required>
				<TInput
					value={cfg.botPlatform}
					onChange={(v) =>
						onChange({
							...target,
							platform: `koishi-${v}`,
							config: { ...cfg, botPlatform: v },
						})
					}
					mono
				/>
			</Field>
			<Field label="selfId" code="config.selfId">
				<TInput
					value={cfg.selfId ?? ""}
					onChange={(v) => onChange({ ...target, config: { ...cfg, selfId: v || undefined } })}
					mono
				/>
			</Field>
			<Field label="channelId" code="config.channelId" required>
				<TInput
					value={cfg.channelId ?? ""}
					onChange={(v) => onChange({ ...target, config: { ...cfg, channelId: v || undefined } })}
					mono
				/>
			</Field>
		</>
	);
}

// ── Page ────────────────────────────────────────────────────────────────────

interface TestResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

export default function Targets() {
	const qc = useQueryClient();
	const list = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [draft, setDraft] = useState<{ mode: "add" | "edit"; value: PushTarget } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<PushTarget | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState<Record<string, TestState>>({});
	const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

	const showToast = (msg: string, ok = true): void => {
		setToast({ msg, ok });
		window.setTimeout(() => setToast(null), 2400);
	};

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
			showToast(draft?.mode === "add" ? "已绑定新推送目标" : "配置已保存");
			setDraft(null);
		},
	});

	const del = useMutation({
		mutationFn: async (id: string) => {
			await api.delete(`/api/targets/${id}`);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["targets"] });
			showToast("已移除推送目标");
			setConfirmDelete(null);
		},
	});

	async function testOne(t: PushTarget): Promise<void> {
		setTesting((p) => ({ ...p, [t.id]: "pending" }));
		try {
			const res = await api.post<TestResponse>("/api/push/test", {
				targetId: t.id,
				kind: "text",
			});
			setTesting((p) => ({ ...p, [t.id]: res.ok ? "ok" : "fail" }));
			showToast(res.ok ? `连通 · ${res.latencyMs}ms` : `失败：${res.err ?? "未知错误"}`, res.ok);
		} catch (err) {
			setTesting((p) => ({ ...p, [t.id]: "fail" }));
			const msg = err instanceof ApiError ? err.message : String(err);
			showToast(`连接失败：${msg}`, false);
		}
		window.setTimeout(() => {
			setTesting((p) => {
				const next = { ...p };
				delete next[t.id];
				return next;
			});
		}, 2000);
	}

	function startNew(): void {
		setError(null);
		setDraft({ mode: "add", value: makeEmptyTarget("onebot", "新推送目标") });
	}

	function startEdit(t: PushTarget): void {
		setError(null);
		setDraft({ mode: "edit", value: { ...t } });
	}

	return (
		<div className="relative">
			{toast ? <Toast msg={toast.msg} ok={toast.ok} /> : null}

			<div className="mb-3.5 flex items-end justify-between">
				<div>
					<div className="text-[14px] font-bold text-bn-text-primary">推送目标管理</div>
					<div className="mt-0.5 text-[11.5px] text-bn-text-tertiary">
						女仆会把消息送到这些频道哦 (｡•ㅅ•｡)♡
					</div>
				</div>
				<Btn
					size="sm"
					variant="primary"
					icon={<Icon.plus size={12} />}
					onClick={startNew}
					disabled={draft !== null}
				>
					绑定新目标
				</Btn>
			</div>

			{list.isLoading ? (
				<div className="text-sm text-bn-text-tertiary">加载中…</div>
			) : list.error ? (
				<div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
					加载失败：{String((list.error as Error).message)}
				</div>
			) : (
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
				>
					{list.data?.map((t) => (
						<TargetCard
							key={t.id}
							target={t}
							testing={testing[t.id]}
							onTest={() => void testOne(t)}
							onEdit={() => startEdit(t)}
							onDelete={() => setConfirmDelete(t)}
						/>
					))}
					<AddCard onClick={startNew} />
				</div>
			)}

			{draft ? (
				<EditorModal
					mode={draft.mode}
					value={draft.value}
					onChange={(v) => setDraft({ ...draft, value: v })}
					onSave={() => upsert.mutate(draft.value)}
					onCancel={() => {
						setDraft(null);
						setError(null);
					}}
					saving={upsert.isPending}
					error={error}
				/>
			) : null}

			{confirmDelete ? (
				<DeleteModal
					target={confirmDelete}
					onCancel={() => setConfirmDelete(null)}
					onConfirm={() => del.mutate(confirmDelete.id)}
					deleting={del.isPending}
				/>
			) : null}
		</div>
	);
}
