import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Btn, PlatformIcon, platformLabel, StatusDot, Toggle } from "../components/atoms";
import { ModalShell } from "../components/dialog";
import { Field, TInput, TNum } from "../components/forms";
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

const ONEBOT_SCOPES: ReadonlyArray<{ value: PushTargetScope; label: string }> = [
	{ value: "group", label: "群聊" },
	{ value: "private", label: "私聊" },
];

function scopesFor(platform: PushTarget["platform"]): ReadonlyArray<{
	value: PushTargetScope;
	label: string;
}> {
	if (platform === "onebot") return ONEBOT_SCOPES;
	return SCOPES;
}

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

			<div className="space-y-2.5">
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
							value.platform === "onebot" ? "OneBot v11 HTTP 服务接入信息" : "Webhook 投递终点"
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
				<Field label="请求超时" code="config.timeoutMs" hint="单次 HTTP 请求总超时(毫秒)">
					<TNum
						value={cfg.timeoutMs}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, timeoutMs: v } })}
						min={1000}
						step={1000}
						suffix="ms"
						width={120}
					/>
				</Field>
				<Field label="重试次数" code="config.retryTimes" hint="不含首次,失败后再尝试">
					<TNum
						value={cfg.retryTimes}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, retryTimes: v } })}
						min={0}
						max={10}
						suffix="次"
					/>
				</Field>
				<Field label="重试间隔" code="config.retryIntervalMs">
					<TNum
						value={cfg.retryIntervalMs}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, retryIntervalMs: v } })}
						min={0}
						step={500}
						suffix="ms"
						width={120}
					/>
				</Field>
				<Field label="自定义请求头" code="config.headers" hint="例如反向代理鉴权头">
					<HeadersEditor
						value={cfg.headers}
						onChange={(next) => onChange({ ...adapter, config: { ...cfg, headers: next } })}
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
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, secret: v || undefined } })}
						secret
					/>
				</Field>
			</>
		);
	}
	return null;
}

function HeadersEditor({
	value,
	onChange,
}: {
	value: Record<string, string>;
	onChange: (next: Record<string, string>) => void;
}) {
	const entries = Object.entries(value);
	function update(idx: number, key: string, val: string) {
		const next: Record<string, string> = {};
		for (let i = 0; i < entries.length; i++) {
			const [k, v] = entries[i];
			if (i === idx) {
				if (key) next[key] = val;
			} else {
				next[k] = v;
			}
		}
		onChange(next);
	}
	function remove(idx: number) {
		const next: Record<string, string> = {};
		entries.forEach(([k, v], i) => {
			if (i !== idx) next[k] = v;
		});
		onChange(next);
	}
	function add() {
		const next = { ...value };
		let i = 1;
		let key = "X-Header";
		while (key in next) {
			i += 1;
			key = `X-Header-${i}`;
		}
		next[key] = "";
		onChange(next);
	}
	return (
		<div className="flex flex-col gap-1.5">
			{entries.map(([k, v], idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: order-stable while editing
				<div key={idx} className="flex gap-1.5">
					<TInput value={k} onChange={(nk) => update(idx, nk, v)} placeholder="Header-Name" mono />
					<TInput value={v} onChange={(nv) => update(idx, k, nv)} placeholder="value" mono />
					<Btn variant="ghost" size="sm" onClick={() => remove(idx)}>
						删除
					</Btn>
				</div>
			))}
			<div>
				<Btn variant="outline" size="sm" onClick={add}>
					+ 添加请求头
				</Btn>
			</div>
		</div>
	);
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

			<div className="space-y-2.5">
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
							{scopesFor(value.platform).map((s) => {
								const active = value.scope === s.value;
								return (
									<button
										key={s.value}
										type="button"
										onClick={() => {
											if (value.platform === "onebot") {
												// OneBot group/private are mutually exclusive — drop the other field
												const old = value.session as OnebotSession;
												const session: OnebotSession =
													s.value === "group" ? { groupId: old.groupId } : { userId: old.userId };
												onChange({ ...value, scope: s.value, session });
											} else {
												onChange({ ...value, scope: s.value });
											}
										}}
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
								? value.scope === "private"
									? "私聊目标 QQ 号"
									: "群聊号(QQ 群号)"
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
		if (target.scope === "private") {
			return (
				<Field label="QQ 号 (userId)" code="session.userId" required>
					<TInput
						value={s.userId ?? ""}
						onChange={(v) => onChange({ ...target, session: { userId: v || undefined } })}
						placeholder="如:10001"
						mono
					/>
				</Field>
			);
		}
		return (
			<Field label="群号 (groupId)" code="session.groupId" required>
				<TInput
					value={s.groupId ?? ""}
					onChange={(v) => onChange({ ...target, session: { groupId: v || undefined } })}
					placeholder="如:123456789"
					mono
				/>
			</Field>
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
					onChange={(v) => onChange({ ...target, session: { dashboardUser: v || undefined } })}
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
				{subtitle ? <span className="text-[10.5px] text-bn-text-tertiary">{subtitle}</span> : null}
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

// ── Adapter rail (left sidebar) ─────────────────────────────────────────────

function AdapterRail({
	adapters,
	selectedId,
	onPick,
	onAddClick,
	targetCountByAdapter,
}: {
	adapters: PushAdapter[];
	selectedId: string | null;
	onPick: (id: string) => void;
	onAddClick: () => void;
	targetCountByAdapter: Map<string, number>;
}) {
	return (
		<aside className="sticky top-[120px] h-fit min-w-0">
			<div className="mb-2 flex items-center justify-between px-1">
				<span className="text-[11px] font-bold uppercase tracking-wider text-bn-text-tertiary">
					推送适配器
				</span>
				<button
					type="button"
					onClick={onAddClick}
					className="rounded-md border border-dashed border-gray-300 px-2 py-0.5 text-[10.5px] font-bold text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
				>
					+ 新建
				</button>
			</div>
			{adapters.length === 0 ? (
				<div className="rounded-[9px] border border-dashed border-gray-200 bg-white/55 px-3 py-3 text-center text-[11px] text-bn-text-tertiary">
					尚未配置任何适配器
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{adapters.map((a) => {
						const active = selectedId === a.id;
						const tint = tintFor(a.platform);
						const count = targetCountByAdapter.get(a.id) ?? 0;
						return (
							<button
								type="button"
								key={a.id}
								onClick={() => onPick(a.id)}
								className={`flex w-full min-w-0 items-start gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition ${
									active
										? "border-bn-pink/35 bg-white/90 shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
										: "border-transparent hover:bg-white/55"
								}`}
							>
								<span
									className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[5px]"
									style={{ background: `${tint}1f` }}
								>
									<PlatformIcon platform={a.platform} size={12} />
								</span>
								<span className="block min-w-0 flex-1">
									<span
										className={`flex items-center gap-1.5 text-[12.5px] font-bold ${
											active ? "text-bn-pink" : "text-bn-text-primary"
										}`}
									>
										<span className="truncate">{a.name || "（未命名）"}</span>
										{!a.enabled ? (
											<span className="shrink-0 text-[10px] text-bn-text-tertiary">(停用)</span>
										) : null}
									</span>
									<span className="mt-0.5 block break-words text-[10.5px] leading-snug text-bn-text-tertiary">
										{platformLabel(a.platform)} · {count} 个目标
									</span>
								</span>
							</button>
						);
					})}
				</div>
			)}
		</aside>
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
		{ kind: "adapter"; value: PushAdapter } | { kind: "target"; value: PushTarget } | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [testing, setTesting] = useState<Record<string, TestState>>({});
	const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
	const [selectedAdapterId, setSelectedAdapterId] = useState<string | null>(null);

	const adapters = adaptersQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	const adaptersById = new Map(adapters.map((a) => [a.id, a]));
	const targetCountByAdapter = new Map<string, number>();
	for (const t of targets) {
		targetCountByAdapter.set(t.adapterId, (targetCountByAdapter.get(t.adapterId) ?? 0) + 1);
	}

	// Keep selectedAdapterId valid: default to the first adapter; reselect if
	// the user deletes the current one.
	useEffect(() => {
		if (adapters.length === 0) {
			if (selectedAdapterId !== null) setSelectedAdapterId(null);
			return;
		}
		if (!selectedAdapterId || !adapters.some((a) => a.id === selectedAdapterId)) {
			setSelectedAdapterId(adapters[0]?.id ?? null);
		}
	}, [adapters, selectedAdapterId]);

	const selectedAdapter = selectedAdapterId
		? adapters.find((a) => a.id === selectedAdapterId)
		: undefined;
	const selectedTargets = selectedAdapter
		? targets.filter((t) => t.adapterId === selectedAdapter.id)
		: [];

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

	function startNewTarget(adapter?: PushAdapter): void {
		setError(null);
		const a = adapter ?? selectedAdapter ?? adapters[0];
		if (!a) {
			showToast("请先新建一个适配器", false);
			return;
		}
		setTargetDraft({ mode: "add", value: makeEmptyTarget(a, "") });
	}

	function startEditTarget(t: PushTarget): void {
		setError(null);
		setTargetDraft({ mode: "edit", value: t });
	}

	const isLoading = adaptersQuery.isLoading || targetsQuery.isLoading;

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-cols-[240px_1fr]">
				<AdapterRail
					adapters={adapters}
					selectedId={selectedAdapterId}
					onPick={setSelectedAdapterId}
					onAddClick={startNewAdapter}
					targetCountByAdapter={targetCountByAdapter}
				/>

				<div className="space-y-4">
					{isLoading ? (
						<div className="rounded-bn-card bg-white p-6 shadow-bn-card">
							<div className="h-20 animate-pulse rounded-[10px] bg-gray-100" />
						</div>
					) : !selectedAdapter ? (
						<div className="rounded-bn-card bg-white p-8 text-center shadow-bn-card">
							<div className="mb-1 text-[14px] font-bold text-bn-text-primary">还没有适配器</div>
							<div className="mb-4 text-[11.5px] text-bn-text-tertiary">
								先在左侧新建一个适配器(OneBot HTTP / Webhook / Dashboard
								通知中心),再为它配置推送目标。
							</div>
							<Btn variant="primary" size="sm" onClick={startNewAdapter}>
								+ 新建适配器
							</Btn>
						</div>
					) : (
						<>
							{/* Adapter detail header */}
							<div className="rounded-bn-card bg-white p-4 shadow-bn-card">
								<div className="flex items-start gap-3">
									<div
										className="grid h-11 w-11 shrink-0 place-items-center rounded-lg"
										style={{ background: `${tintFor(selectedAdapter.platform)}1f` }}
									>
										<PlatformIcon platform={selectedAdapter.platform} size={22} />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-[14.5px] font-bold text-bn-text-primary">
												{selectedAdapter.name || "（未命名）"}
											</span>
											<StatusDot kind={adapterStatusFor(selectedAdapter)} />
											{!selectedAdapter.enabled ? (
												<span className="text-[10.5px] text-bn-text-tertiary">(已停用)</span>
											) : null}
										</div>
										<div className="mt-0.5 truncate font-mono text-[11.5px] text-bn-text-tertiary">
											{platformLabel(selectedAdapter.platform)} ·{" "}
											{adapterEndpointSummary(selectedAdapter)}
										</div>
										{selectedAdapter.testStatus ? (
											<div
												className="mt-2 inline-block rounded-[4px] border-l-[3px] px-2 py-0.5 text-[11px]"
												style={
													selectedAdapter.testStatus.ok
														? {
																background: "#f0fdf4",
																borderLeftColor: "#22c55e",
																color: "#166534",
															}
														: {
																background: "#fffbeb",
																borderLeftColor: "#f59e0b",
																color: "#92400e",
															}
												}
											>
												{selectedAdapter.testStatus.ok
													? `上次测试 OK${
															selectedAdapter.testStatus.latencyMs != null
																? ` · ${selectedAdapter.testStatus.latencyMs}ms`
																: ""
														}`
													: `上次测试失败${
															selectedAdapter.testStatus.err
																? ` — ${selectedAdapter.testStatus.err}`
																: ""
														}`}
											</div>
										) : null}
									</div>
									<div className="flex shrink-0 gap-1">
										<Btn
											size="sm"
											variant="ghost"
											onClick={() => testAdapter(selectedAdapter)}
											disabled={testing[selectedAdapter.id] === "pending"}
										>
											{testing[selectedAdapter.id] === "pending"
												? "测试中…"
												: testing[selectedAdapter.id] === "ok"
													? "已连通"
													: testing[selectedAdapter.id] === "fail"
														? "失败"
														: "测试"}
										</Btn>
										<Btn
											size="sm"
											variant="ghost"
											onClick={() => startEditAdapter(selectedAdapter)}
										>
											配置
										</Btn>
										<Btn
											size="sm"
											variant="ghost"
											onClick={() => {
												setDeleteError(null);
												setConfirmDelete({ kind: "adapter", value: selectedAdapter });
											}}
											title="删除"
											icon={<Icon.trash size={11} />}
										>
											{null}
										</Btn>
									</div>
								</div>
							</div>

							{/* Targets bound to this adapter */}
							<div className="rounded-bn-card bg-white p-4 shadow-bn-card">
								<div className="mb-3 flex items-baseline justify-between">
									<div>
										<div className="text-[14px] font-bold text-bn-text-primary">推送目标</div>
										<div className="text-[11.5px] text-bn-text-tertiary">
											本适配器下的会话:群号 / 用户 ID / dashboardUser。
										</div>
									</div>
									<Btn size="sm" variant="outline" onClick={() => startNewTarget(selectedAdapter)}>
										+ 新建推送目标
									</Btn>
								</div>
								{selectedTargets.length === 0 ? (
									<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
										<AddCard
											label="新建推送目标"
											hint="绑定到当前适配器"
											onClick={() => startNewTarget(selectedAdapter)}
										/>
									</div>
								) : (
									<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
										{selectedTargets.map((t) => (
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
											hint="绑定到当前适配器"
											onClick={() => startNewTarget(selectedAdapter)}
										/>
									</div>
								)}
							</div>
						</>
					)}
				</div>
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
