import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Btn, PlatformIcon, platformLabel, StatusDot, Toggle } from "../components/atoms";
import { ModalShell } from "../components/dialog";
import { Field, TInput } from "../components/forms";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import {
	KNOWN_PLATFORMS,
	makeEmptyAdapter,
	makeEmptyTarget,
	type OnebotSession,
	type PushAdapter,
	type PushTarget,
	type PushTargetPlatform,
	type PushTargetScope,
	type WebDashboardSession,
} from "../types/domain";

/**
 * Targets page — two-layer "adapter → target" model.
 *
 * **Adapter** = a connection instance (NapCat HTTP endpoint, webhook URL,
 * dashboard bridge). Holds baseUrl / accessToken etc.
 *
 * **Target** = a session bound to an adapter (group/private/channel). Holds
 * groupId / userId / dashboardUser. References its adapter by `adapterId`.
 *
 * One adapter can drive many targets, so a single NapCat connection only needs
 * its credentials filled once even when pushing to N groups.
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
};

function tintFor(platform: string): string {
	return PLATFORM_TINT[platform] ?? "#888";
}

function scopeLabel(s: PushTargetScope): string {
	return SCOPES.find((x) => x.value === s)?.label ?? s;
}

function adapterEndpointSummary(a: PushAdapter): string {
	if (a.platform === "onebot") return a.config.baseUrl;
	if (a.platform === "webhook") return a.config.url;
	return "Dashboard 通知中心";
}

function targetSessionSummary(target: PushTarget): string {
	if (target.platform === "onebot") {
		const s = target.session;
		if (target.scope === "private") return s.userId ? `→ 用户 ${s.userId}` : "→ 未指定用户";
		return s.groupId ? `→ 群 ${s.groupId}` : "→ 未指定群号";
	}
	if (target.platform === "webhook") {
		return "→ webhook 终点";
	}
	const s = target.session as WebDashboardSession;
	return s.dashboardUser ? `→ ${s.dashboardUser}` : "→ 广播";
}

// ── Adapter card ────────────────────────────────────────────────────────────

interface AdapterCardProps {
	adapter: PushAdapter;
	targetCount: number;
	testing: TestState | undefined;
	onTest: () => void;
	onEdit: () => void;
	onDelete: () => void;
}

function AdapterCard({
	adapter,
	targetCount,
	testing,
	onTest,
	onEdit,
	onDelete,
}: AdapterCardProps) {
	const tint = tintFor(adapter.platform);
	const borderColor =
		testing === "fail" ? "#fecaca" : testing === "ok" ? "#bbf7d0" : "rgba(0,0,0,0.06)";
	const lastTestLabel = adapter.testStatus
		? adapter.testStatus.ok
			? `上次测试 OK${
					adapter.testStatus.latencyMs != null ? ` · ${adapter.testStatus.latencyMs}ms` : ""
				}`
			: `上次测试失败${adapter.testStatus.err ? ` — ${adapter.testStatus.err}` : ""}`
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
					<PlatformIcon platform={adapter.platform} size={18} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-bold text-bn-text-primary">
						{adapter.name || "（未命名）"}
					</div>
					<div className="truncate font-mono text-[11px] text-bn-text-tertiary">
						{adapterEndpointSummary(adapter)}
					</div>
				</div>
				{testing ? <TestingDot kind={testing} /> : <StatusDot kind={adapterStatusFor(adapter)} />}
			</div>

			<div className="flex items-center justify-between text-[11.5px] text-bn-text-secondary">
				<span className="truncate">
					{platformLabel(adapter.platform)} · {targetCount} 个目标
					{adapter.enabled ? null : <span className="ml-1.5 text-bn-text-tertiary">(已停用)</span>}
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
						adapter.testStatus?.ok
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

function adapterStatusFor(a: PushAdapter): "ok" | "warn" | "err" | "off" {
	if (!a.enabled) return "off";
	if (!a.testStatus) return "ok";
	return a.testStatus.ok ? "ok" : "err";
}

// ── Target card ─────────────────────────────────────────────────────────────

interface TargetCardProps {
	target: PushTarget;
	adapter: PushAdapter | undefined;
	onEdit: () => void;
	onDelete: () => void;
}

function TargetCard({ target, adapter, onEdit, onDelete }: TargetCardProps) {
	const tint = tintFor(target.platform);
	const adapterMissing = !adapter;

	return (
		<div
			className="rounded-[10px] border bg-white p-3.5 transition-[border-color] duration-200"
			style={{
				borderColor: adapterMissing ? "#fca5a5" : "rgba(0,0,0,0.06)",
			}}
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
					<div className="truncate font-mono text-[11px] text-bn-text-tertiary">
						{targetSessionSummary(target)}
					</div>
				</div>
				<StatusDot kind={target.enabled ? "ok" : "off"} />
			</div>

			<div className="flex items-center justify-between text-[11.5px] text-bn-text-secondary">
				<span className="truncate">
					{scopeLabel(target.scope)}
					{" · "}
					<span style={{ color: adapterMissing ? "#dc2626" : undefined }}>
						{adapterMissing ? "适配器缺失" : `适配器: ${adapter.name}`}
					</span>
					{target.enabled ? null : <span className="ml-1.5 text-bn-text-tertiary">(已停用)</span>}
				</span>
				<div className="flex shrink-0 gap-1">
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
		</div>
	);
}

// ── Testing dot ─────────────────────────────────────────────────────────────

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

// ── Add card (dashed) ───────────────────────────────────────────────────────

interface AddCardProps {
	label: string;
	hint: string;
	onClick: () => void;
	disabled?: boolean;
}

function AddCard({ label, hint, onClick, disabled }: AddCardProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex h-full min-h-[88px] flex-col items-center justify-center rounded-[10px] border border-dashed border-gray-300 bg-white px-3 py-4 text-center transition hover:border-bn-pink hover:bg-bn-pink/5 disabled:cursor-not-allowed disabled:opacity-60"
		>
			<span className="text-[20px] leading-none text-bn-text-tertiary">＋</span>
			<span className="mt-1 text-[12.5px] font-semibold text-bn-text-primary">{label}</span>
			<span className="mt-0.5 text-[10.5px] text-bn-text-tertiary">{hint}</span>
		</button>
	);
}

// ── Editor: Adapter ─────────────────────────────────────────────────────────

interface AdapterEditorProps {
	mode: "add" | "edit";
	value: PushAdapter;
	onChange: (next: PushAdapter) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}

function AdapterEditorModal({
	mode,
	value,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: AdapterEditorProps) {
	const valid = value.name.trim().length > 0;
	const tint = tintFor(value.platform);
	return (
		<ModalShell onCancel={onCancel} width={500}>
			<div className="mb-3 text-[15px] font-bold text-bn-text-primary">
				{mode === "add" ? "新建适配器" : "配置适配器"}
			</div>

			<div className="-mx-1 max-h-[64vh] space-y-2.5 overflow-y-auto px-1">
				<SectionBox title="基本" subtitle="适配器代表一个连接实例,可被多个目标共享" accent={tint}>
					<Field label="平台" code="adapter.platform" required>
						<div className="flex flex-wrap gap-1.5">
							{KNOWN_PLATFORMS.map((p) => {
								const active = value.platform === p.value;
								const pTint = tintFor(p.value);
								return (
									<button
										key={p.value}
										type="button"
										onClick={() => onChange(makeEmptyAdapter(p.value, value.name))}
										className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-bold transition"
										style={
											active
												? {
														background: `${pTint}18`,
														color: pTint,
														borderColor: `${pTint}55`,
													}
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
					<Field label="显示名称" code="adapter.name" required>
						<TInput
							value={value.name}
							onChange={(v) => onChange({ ...value, name: v })}
							placeholder="如：NapCat 主连接"
						/>
					</Field>
					<Field label="启用" code="adapter.enabled">
						<Toggle value={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
					</Field>
				</SectionBox>

				{value.platform !== "web-dashboard" ? (
					<SectionBox
						title="连接参数"
						subtitle={
							value.platform === "onebot"
								? "OneBot v11 HTTP 服务接入信息"
								: "Webhook 投递终点"
						}
						accent={tint}
					>
						<AdapterConnectionFields adapter={value} onChange={onChange} />
					</SectionBox>
				) : (
					<SectionBox
						title="说明"
						subtitle="Dashboard 通知中心通过本地 WebSocket 推送,无需额外连接参数"
						accent={tint}
					>
						<div className="py-1 text-[12px] text-bn-text-secondary">
							保存后即可在右侧"推送目标"区为该适配器创建会话。
						</div>
					</SectionBox>
				)}
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

function AdapterConnectionFields({
	adapter,
	onChange,
}: {
	adapter: PushAdapter;
	onChange: (next: PushAdapter) => void;
}) {
	if (adapter.platform === "onebot") {
		const cfg = adapter.config;
		return (
			<>
				<Field label="HTTP baseUrl" code="config.baseUrl" required>
					<TInput
						value={cfg.baseUrl}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, baseUrl: v } })}
						placeholder="http://napcat:3000"
						mono
					/>
				</Field>
				<Field label="accessToken" code="config.accessToken">
					<TInput
						value={cfg.accessToken ?? ""}
						onChange={(v) =>
							onChange({
								...adapter,
								config: { ...cfg, accessToken: v || undefined },
							})
						}
						secret
					/>
				</Field>
			</>
		);
	}
	if (adapter.platform === "webhook") {
		const cfg = adapter.config;
		return (
			<>
				<Field label="URL" code="config.url" required>
					<TInput
						value={cfg.url}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, url: v } })}
						placeholder="https://hooks.example.com/bn"
						mono
					/>
				</Field>
				<Field label="Secret" code="config.secret" hint="加在 x-bilibili-notify-secret 头">
					<TInput
						value={cfg.secret ?? ""}
						onChange={(v) =>
							onChange({ ...adapter, config: { ...cfg, secret: v || undefined } })
						}
						secret
					/>
				</Field>
			</>
		);
	}
	return null;
}

// ── Editor: Target ──────────────────────────────────────────────────────────

interface TargetEditorProps {
	mode: "add" | "edit";
	value: PushTarget;
	adapters: PushAdapter[];
	onChange: (next: PushTarget) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}

function TargetEditorModal({
	mode,
	value,
	adapters,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: TargetEditorProps) {
	const valid = value.name.trim().length > 0 && Boolean(value.adapterId);
	const tint = tintFor(value.platform);
	const eligibleAdapters = adapters; // any platform-platform mismatch resolved on switch
	return (
		<ModalShell onCancel={onCancel} width={500}>
			<div className="mb-3 text-[15px] font-bold text-bn-text-primary">
				{mode === "add" ? "新建推送目标" : "配置推送目标"}
			</div>

			<div className="-mx-1 max-h-[64vh] space-y-2.5 overflow-y-auto px-1">
				<SectionBox
					title="选择适配器"
					subtitle="目标的平台跟随适配器,连接参数(baseUrl/accessToken)在适配器层维护"
					accent={tint}
				>
					{eligibleAdapters.length === 0 ? (
						<div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-center text-[11.5px] text-bn-text-secondary">
							尚未配置任何适配器 · 请先在上方"适配器"区新建
						</div>
					) : (
						<div className="space-y-1.5">
							{eligibleAdapters.map((a) => {
								const active = value.adapterId === a.id;
								const aTint = tintFor(a.platform);
								return (
									<button
										key={a.id}
										type="button"
										onClick={() => {
											const next = makeEmptyTarget(a, value.name);
											// preserve user-typed identity if any
											onChange({ ...next, id: value.id, enabled: value.enabled });
										}}
										className="flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition"
										style={
											active
												? {
														background: `${aTint}10`,
														borderColor: `${aTint}55`,
													}
												: {
														background: "#fff",
														borderColor: "#ececec",
													}
										}
									>
										<PlatformIcon platform={a.platform} size={16} />
										<div className="min-w-0 flex-1">
											<div className="truncate text-[12px] font-semibold text-bn-text-primary">
												{a.name}
											</div>
											<div className="truncate font-mono text-[10.5px] text-bn-text-tertiary">
												{platformLabel(a.platform)} · {adapterEndpointSummary(a)}
											</div>
										</div>
										{active ? (
											<span className="text-[11px] font-bold" style={{ color: aTint }}>
												已选
											</span>
										) : null}
									</button>
								);
							})}
						</div>
					)}
				</SectionBox>

				<SectionBox title="基本" subtitle="目标的会话级配置" accent={tint}>
					<Field label="显示名称" code="target.name" required>
						<TInput
							value={value.name}
							onChange={(v) => onChange({ ...value, name: v })}
							placeholder="如:游戏交流群"
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
				</SectionBox>

				{value.platform === "onebot" || value.platform === "web-dashboard" ? (
					<SectionBox
						title="会话信息"
						subtitle={
							value.platform === "onebot"
								? "群号 / 私聊 QQ 二选一,作用域决定走哪个字段"
								: "Dashboard 通知中心接收方"
						}
						accent={tint}
					>
						<TargetSessionFields target={value} onChange={onChange} />
					</SectionBox>
				) : null}
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

function TargetSessionFields({
	target,
	onChange,
}: {
	target: PushTarget;
	onChange: (next: PushTarget) => void;
}) {
	if (target.platform === "onebot") {
		const s = target.session as OnebotSession;
		return (
			<>
				<Field label="群号 (groupId)" code="session.groupId">
					<TInput
						value={s.groupId ?? ""}
						onChange={(v) => onChange({ ...target, session: { ...s, groupId: v || undefined } })}
						placeholder="如:123456789"
						mono
					/>
				</Field>
				<Field label="QQ 号 (userId)" code="session.userId" hint="私聊用户;与群号二选一">
					<TInput
						value={s.userId ?? ""}
						onChange={(v) => onChange({ ...target, session: { ...s, userId: v || undefined } })}
						mono
					/>
				</Field>
			</>
		);
	}
	if (target.platform === "web-dashboard") {
		const s = target.session as WebDashboardSession;
		return (
			<Field
				label="dashboardUser"
				code="session.dashboardUser"
				hint="留空 = 广播给所有 dashboard 客户端"
			>
				<TInput
					value={s.dashboardUser ?? ""}
					onChange={(v) =>
						onChange({ ...target, session: { dashboardUser: v || undefined } })
					}
				/>
			</Field>
		);
	}
	return null;
}

// ── SectionBox (modal-internal) ─────────────────────────────────────────────

function SectionBox({
	title,
	subtitle,
	accent,
	children,
}: {
	title: string;
	subtitle?: string;
	accent: string;
	children: ReactNode;
}) {
	return (
		<div
			className="rounded-xl border px-3 py-2.5"
			style={{ borderColor: `${accent}33`, background: `${accent}06` }}
		>
			<div className="mb-1 flex items-baseline gap-2">
				<span className="text-[12px] font-bold" style={{ color: accent }}>
					{title}
				</span>
				{subtitle ? (
					<span className="text-[10.5px] text-bn-text-tertiary">{subtitle}</span>
				) : null}
			</div>
			<div>{children}</div>
		</div>
	);
}

// ── Delete modal ────────────────────────────────────────────────────────────

function DeleteModal({
	subjectKind,
	subjectName,
	hint,
	onCancel,
	onConfirm,
	deleting,
	error,
}: {
	subjectKind: "adapter" | "target";
	subjectName: string;
	hint?: ReactNode;
	onCancel: () => void;
	onConfirm: () => void;
	deleting: boolean;
	error: string | null;
}) {
	return (
		<ModalShell onCancel={onCancel} width={420}>
			<div className="mb-2 text-[15px] font-bold text-bn-text-primary">
				{subjectKind === "adapter" ? "删除适配器" : "删除推送目标"}
			</div>
			<div className="mb-5 text-[13px] leading-relaxed text-bn-text-secondary">
				确定要移除 <b className="text-bn-text-primary">{subjectName}</b> 吗？
				{hint ? (
					<>
						<br />
						{hint}
					</>
				) : null}
			</div>
			{error ? (
				<div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					{error}
				</div>
			) : null}
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

// ── Page ────────────────────────────────────────────────────────────────────

interface TestResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

export default function Targets() {
	const qc = useQueryClient();

	const adaptersQuery = useQuery({
		queryKey: ["adapters"],
		queryFn: () => api.get<PushAdapter[]>("/api/adapters"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [adapterDraft, setAdapterDraft] = useState<{
		mode: "add" | "edit";
		value: PushAdapter;
	} | null>(null);
	const [targetDraft, setTargetDraft] = useState<{
		mode: "add" | "edit";
		value: PushTarget;
	} | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<
		| { kind: "adapter"; value: PushAdapter }
		| { kind: "target"; value: PushTarget }
		| null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [testing, setTesting] = useState<Record<string, TestState>>({});
	const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

	const adapters = adaptersQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	const adaptersById = new Map(adapters.map((a) => [a.id, a]));
	const targetCountByAdapter = new Map<string, number>();
	for (const t of targets) {
		targetCountByAdapter.set(t.adapterId, (targetCountByAdapter.get(t.adapterId) ?? 0) + 1);
	}

	const showToast = (msg: string, ok = true): void => {
		setToast({ msg, ok });
		window.setTimeout(() => setToast(null), 2400);
	};

	const upsertAdapter = useMutation({
		mutationFn: async (a: PushAdapter) => {
			setError(null);
			try {
				await api.post<PushAdapter[]>("/api/adapters", a);
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["adapters"] });
			showToast(adapterDraft?.mode === "add" ? "已新建适配器" : "适配器已保存");
			setAdapterDraft(null);
		},
	});

	const delAdapter = useMutation({
		mutationFn: async (id: string) => {
			setDeleteError(null);
			try {
				await api.delete(`/api/adapters/${id}`);
			} catch (err) {
				const msg = err instanceof ApiError ? err.message : String(err);
				setDeleteError(msg);
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["adapters"] });
			showToast("已移除适配器");
			setConfirmDelete(null);
		},
	});

	const upsertTarget = useMutation({
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
			showToast(targetDraft?.mode === "add" ? "已新建推送目标" : "目标已保存");
			setTargetDraft(null);
		},
	});

	const delTarget = useMutation({
		mutationFn: async (id: string) => {
			setDeleteError(null);
			try {
				await api.delete(`/api/targets/${id}`);
			} catch (err) {
				const msg = err instanceof ApiError ? err.message : String(err);
				setDeleteError(msg);
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["targets"] });
			showToast("已移除推送目标");
			setConfirmDelete(null);
		},
	});

	async function testAdapter(a: PushAdapter): Promise<void> {
		// Reuse /api/push/test on any of this adapter's targets if available.
		// Otherwise tell the user to bind a target first (we don't yet have a
		// connection-only ping endpoint).
		const probe = targets.find((t) => t.adapterId === a.id);
		if (!probe) {
			showToast("请先为该适配器绑定一个目标再测试", false);
			return;
		}
		setTesting((p) => ({ ...p, [a.id]: "pending" }));
		try {
			const res = await api.post<TestResponse>("/api/push/test", {
				targetId: probe.id,
				kind: "text",
			});
			setTesting((p) => ({ ...p, [a.id]: res.ok ? "ok" : "fail" }));
			showToast(res.ok ? `连通 · ${res.latencyMs}ms` : `失败:${res.err ?? "未知错误"}`, res.ok);
		} catch (err) {
			setTesting((p) => ({ ...p, [a.id]: "fail" }));
			const msg = err instanceof ApiError ? err.message : String(err);
			showToast(`测试失败:${msg}`, false);
		}
		window.setTimeout(() => {
			setTesting((p) => {
				const next = { ...p };
				delete next[a.id];
				return next;
			});
		}, 2000);
	}

	function startNewAdapter(): void {
		setError(null);
		setAdapterDraft({
			mode: "add",
			value: makeEmptyAdapter("onebot" as PushTargetPlatform, ""),
		});
	}

	function startEditAdapter(a: PushAdapter): void {
		setError(null);
		setAdapterDraft({ mode: "edit", value: a });
	}

	function startNewTarget(): void {
		setError(null);
		if (adapters.length === 0) {
			showToast("请先新建一个适配器", false);
			return;
		}
		const firstAdapter = adapters[0];
		if (!firstAdapter) return;
		setTargetDraft({ mode: "add", value: makeEmptyTarget(firstAdapter, "") });
	}

	function startEditTarget(t: PushTarget): void {
		setError(null);
		setTargetDraft({ mode: "edit", value: t });
	}

	const isLoading = adaptersQuery.isLoading || targetsQuery.isLoading;

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{/* --- Adapters --- */}
			<div className="rounded-bn-card bg-white p-4 shadow-bn-card">
				<div className="mb-3 flex items-baseline justify-between">
					<div>
						<div className="text-[14px] font-bold text-bn-text-primary">推送适配器</div>
						<div className="text-[11.5px] text-bn-text-tertiary">
							连接级配置:OneBot HTTP 接入 / Webhook URL / Dashboard 通知中心。
						</div>
					</div>
					<Btn size="sm" variant="outline" onClick={startNewAdapter}>
						+ 新建适配器
					</Btn>
				</div>
				{isLoading ? (
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						<div className="h-24 animate-pulse rounded-[10px] bg-gray-100" />
						<div className="h-24 animate-pulse rounded-[10px] bg-gray-100" />
					</div>
				) : adapters.length === 0 ? (
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						<AddCard
							label="新建适配器"
							hint="OneBot HTTP / Webhook / Dashboard"
							onClick={startNewAdapter}
						/>
					</div>
				) : (
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						{adapters.map((a) => (
							<AdapterCard
								key={a.id}
								adapter={a}
								targetCount={targetCountByAdapter.get(a.id) ?? 0}
								testing={testing[a.id]}
								onTest={() => testAdapter(a)}
								onEdit={() => startEditAdapter(a)}
								onDelete={() => {
									setDeleteError(null);
									setConfirmDelete({ kind: "adapter", value: a });
								}}
							/>
						))}
						<AddCard
							label="新建适配器"
							hint="OneBot HTTP / Webhook / Dashboard"
							onClick={startNewAdapter}
						/>
					</div>
				)}
			</div>

			{/* --- Targets --- */}
			<div className="rounded-bn-card bg-white p-4 shadow-bn-card">
				<div className="mb-3 flex items-baseline justify-between">
					<div>
						<div className="text-[14px] font-bold text-bn-text-primary">推送目标</div>
						<div className="text-[11.5px] text-bn-text-tertiary">
							会话级配置:每个目标选定一个适配器 + 填写群号 / 用户 ID 等信息。
						</div>
					</div>
					<Btn
						size="sm"
						variant="outline"
						onClick={startNewTarget}
						disabled={adapters.length === 0}
					>
						+ 新建推送目标
					</Btn>
				</div>
				{isLoading ? (
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						<div className="h-24 animate-pulse rounded-[10px] bg-gray-100" />
						<div className="h-24 animate-pulse rounded-[10px] bg-gray-100" />
					</div>
				) : targets.length === 0 ? (
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						<AddCard
							label={adapters.length === 0 ? "请先新建适配器" : "新建推送目标"}
							hint="绑定到一个适配器"
							onClick={startNewTarget}
							disabled={adapters.length === 0}
						/>
					</div>
				) : (
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						{targets.map((t) => (
							<TargetCard
								key={t.id}
								target={t}
								adapter={adaptersById.get(t.adapterId)}
								onEdit={() => startEditTarget(t)}
								onDelete={() => {
									setDeleteError(null);
									setConfirmDelete({ kind: "target", value: t });
								}}
							/>
						))}
						<AddCard
							label="新建推送目标"
							hint="绑定到一个适配器"
							onClick={startNewTarget}
							disabled={adapters.length === 0}
						/>
					</div>
				)}
			</div>

			{adapterDraft ? (
				<AdapterEditorModal
					mode={adapterDraft.mode}
					value={adapterDraft.value}
					onChange={(v) => setAdapterDraft({ mode: adapterDraft.mode, value: v })}
					onSave={() => upsertAdapter.mutate(adapterDraft.value)}
					onCancel={() => {
						setAdapterDraft(null);
						setError(null);
					}}
					saving={upsertAdapter.isPending}
					error={error}
				/>
			) : null}

			{targetDraft ? (
				<TargetEditorModal
					mode={targetDraft.mode}
					value={targetDraft.value}
					adapters={adapters}
					onChange={(v) => setTargetDraft({ mode: targetDraft.mode, value: v })}
					onSave={() => upsertTarget.mutate(targetDraft.value)}
					onCancel={() => {
						setTargetDraft(null);
						setError(null);
					}}
					saving={upsertTarget.isPending}
					error={error}
				/>
			) : null}

			{confirmDelete ? (
				<DeleteModal
					subjectKind={confirmDelete.kind}
					subjectName={confirmDelete.value.name}
					hint={
						confirmDelete.kind === "adapter"
							? "适配器若仍被推送目标引用,删除会失败。请先把这些目标改挂到其他适配器或先删除它们。"
							: "该目标在订阅路由中的引用将变成空引用,推送会跳过它。"
					}
					onCancel={() => {
						setDeleteError(null);
						setConfirmDelete(null);
					}}
					onConfirm={() => {
						if (confirmDelete.kind === "adapter") {
							delAdapter.mutate(confirmDelete.value.id);
						} else {
							delTarget.mutate(confirmDelete.value.id);
						}
					}}
					deleting={delAdapter.isPending || delTarget.isPending}
					error={deleteError}
				/>
			) : null}

			{toast ? (
				<div
					className={`fixed bottom-4 right-4 z-[400] rounded-md px-4 py-2 text-[12.5px] font-semibold text-white shadow-lg ${
						toast.ok ? "bg-emerald-600" : "bg-red-500"
					}`}
				>
					{toast.msg}
				</div>
			) : null}
		</div>
	);
}
