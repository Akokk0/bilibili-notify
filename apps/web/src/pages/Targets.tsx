import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Btn, PlatformIcon, platformLabel, StatusDot, Toggle } from "../components/atoms";
import { ModalShell } from "../components/dialog";
import { Field, TInput, TNum, TSelect } from "../components/forms";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import {
	KNOWN_PLATFORMS,
	makeEmptyAdapter,
	makeEmptyTarget,
	maskWebhookUrl,
	type OnebotAdapterConfig,
	type OnebotSession,
	type OnebotTransport,
	type PushAdapter,
	type PushTarget,
	type PushTargetPlatform,
	type PushTargetScope,
	switchOnebotTransport,
	WEBHOOK_PROVIDERS,
	type WebhookProvider,
	webhookProviderLabel,
	webhookSecretHint,
	webhookUrlPlaceholder,
} from "../types/domain";

/**
 * Targets page — two-layer "adapter → target" model.
 *
 * **Adapter** = a connection instance (NapCat HTTP endpoint, webhook URL,
 * dashboard bridge). Holds baseUrl / accessToken etc.
 *
 * **Target** = a session bound to an adapter (group/private/channel). Holds
 * groupId / userId. References its adapter by `adapterId`.
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

/** OneBot 连接方式 —— 是 adapter config 的 transport 字段,不是独立 platform。 */
const ONEBOT_TRANSPORTS: ReadonlyArray<{ value: OnebotTransport; label: string }> = [
	{ value: "http", label: "HTTP" },
	{ value: "ws", label: "正向 WS" },
	{ value: "ws-reverse", label: "反向 WS" },
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
	if (a.platform === "onebot") {
		const c = a.config;
		if (c.transport === "http") return c.baseUrl;
		if (c.transport === "ws") return c.url;
		return `反向 WS :${c.port}`;
	}
	if (a.platform === "webhook") {
		const provider = a.config.provider ?? "generic";
		const url = maskWebhookUrl(a.config.url);
		return provider === "generic" ? url : `${webhookProviderLabel(provider)} · ${url}`;
	}
	return "Dashboard 通知中心";
}

function targetSessionSummary(target: PushTarget): string {
	if (target.platform === "onebot") {
		const s = target.session;
		if (target.scope === "private") return s.userId ? `→ 用户 ${s.userId}` : "→ 未指定用户";
		return s.groupId ? `→ 群 ${s.groupId}` : "→ 未指定群号";
	}
	if (target.platform === "webhook") {
		return target.managedBy === "adapter" ? "→ 系统托管 webhook 终点" : "→ webhook 终点";
	}
	// web-dashboard 是单用户 in-process 广播,session 没有 per-user 字段。
	return "→ 广播给所有 dashboard 客户端";
}

function managedWebhookTargetForAdapter(
	adapter: PushAdapter,
	targets: readonly PushTarget[],
): PushTarget | undefined {
	if (adapter.platform !== "webhook") return undefined;
	const owned = targets.filter((t) => t.platform === "webhook" && t.adapterId === adapter.id);
	return owned.find((t) => t.managedBy === "adapter") ?? owned[0];
}

// ── Adapter card ────────────────────────────────────────────────────────────

function adapterStatusFor(a: PushAdapter): "ok" | "warn" | "err" | "off" | "pending" {
	if (!a.enabled) return "off";
	if (!a.testStatus) return "pending";
	return a.testStatus.ok ? "ok" : "err";
}

function targetStatusFor(t: PushTarget): "ok" | "warn" | "err" | "off" | "pending" {
	if (!t.enabled) return "off";
	if (!t.testStatus) return "pending";
	return t.testStatus.ok ? "ok" : "err";
}

// ── Target card ─────────────────────────────────────────────────────────────

interface TargetCardProps {
	target: PushTarget;
	adapter: PushAdapter | undefined;
	onEdit: () => void;
	onDelete: () => void;
	onTest: () => void;
	testing: TestState | undefined;
	readOnly?: boolean;
}

function TargetCard({
	target,
	adapter,
	onEdit,
	onDelete,
	onTest,
	testing,
	readOnly,
}: TargetCardProps) {
	const tint = tintFor(target.platform);
	const adapterMissing = !adapter;
	const status = targetStatusFor(target);
	const testStatus = target.testStatus;

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
				<StatusDot kind={status} />
			</div>

			{testStatus ? (
				<div
					className="mb-2 rounded-sm border-l-[3px] px-2 py-0.5 text-[10.5px]"
					style={
						testStatus.ok
							? { background: "#f0fdf4", borderLeftColor: "#22c55e", color: "#166534" }
							: { background: "#fef2f2", borderLeftColor: "#ef4444", color: "#991b1b" }
					}
				>
					{testStatus.ok
						? `上次推送 OK${testStatus.latencyMs != null ? ` · ${testStatus.latencyMs}ms` : ""}`
						: `上次推送失败${testStatus.err ? ` — ${testStatus.err}` : ""}`}
				</div>
			) : null}

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
					<Btn
						size="sm"
						variant="ghost"
						onClick={onTest}
						disabled={testing === "pending" || !target.enabled || adapterMissing}
						title="向该目标真实发送一条测试消息"
					>
						{testing === "pending"
							? "发送中…"
							: testing === "ok"
								? "已送达"
								: testing === "fail"
									? "失败"
									: "测试"}
					</Btn>
					{readOnly ? null : (
						<>
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
						</>
					)}
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
			className="flex h-full min-h-22 flex-col items-center justify-center rounded-[10px] border border-dashed border-gray-300 bg-white px-3 py-4 text-center transition hover:border-bn-pink hover:bg-bn-pink/5 disabled:cursor-not-allowed disabled:opacity-60"
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
						subtitle={value.platform === "onebot" ? "OneBot v11 连接信息" : "Webhook 投递终点"}
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
		const setCfg = (next: OnebotAdapterConfig) => onChange({ ...adapter, config: next });
		return (
			<>
				<Field label="连接方式" code="config.transport" required>
					<div className="flex flex-wrap gap-1.5">
						{ONEBOT_TRANSPORTS.map((t) => {
							const active = cfg.transport === t.value;
							return (
								<button
									key={t.value}
									type="button"
									onClick={() => setCfg(switchOnebotTransport(cfg, t.value))}
									className="rounded-md border px-2.5 py-1 text-[12px] font-bold transition"
									style={
										active
											? { background: "#3b82f618", color: "#3b82f6", borderColor: "#3b82f655" }
											: { background: "#f5f5f5", color: "#666", borderColor: "#ececec" }
									}
								>
									{t.label}
								</button>
							);
						})}
					</div>
				</Field>

				{cfg.transport === "http" ? (
					<Field label="HTTP baseUrl" code="config.baseUrl" required>
						<TInput
							value={cfg.baseUrl}
							onChange={(v) => setCfg({ ...cfg, baseUrl: v })}
							placeholder="http://napcat:3000"
							mono
						/>
					</Field>
				) : null}
				{cfg.transport === "ws" ? (
					<Field label="正向 WS 地址" code="config.url" required hint="bot 的 OneBot 正向 WS 服务">
						<TInput
							value={cfg.url}
							onChange={(v) => setCfg({ ...cfg, url: v })}
							placeholder="ws://napcat:3001"
							mono
						/>
					</Field>
				) : null}
				{cfg.transport === "ws-reverse" ? (
					<Field
						label="反向 WS 监听端口"
						code="config.port"
						hint="bot 主动连入此端口;端口即身份,与主端口 8787 独立"
					>
						<TNum
							value={cfg.port}
							onChange={(v) => setCfg({ ...cfg, port: v })}
							min={1}
							max={65_535}
							width={120}
						/>
					</Field>
				) : null}

				<Field
					label="accessToken"
					code="config.accessToken"
					hint={
						cfg.transport === "ws-reverse"
							? "校验连入 bot 的握手;反向 WS 强烈建议设置,否则端口对局域网裸开"
							: undefined
					}
				>
					<TInput
						value={cfg.accessToken ?? ""}
						onChange={(v) => setCfg({ ...cfg, accessToken: v || undefined })}
						secret
					/>
				</Field>
				<Field
					label={cfg.transport === "http" ? "请求超时" : "响应超时"}
					code="config.timeoutMs"
					hint={
						cfg.transport === "http" ? "单次 HTTP 请求总超时(毫秒)" : "等 OneBot echo 响应的超时"
					}
				>
					<TNum
						value={cfg.timeoutMs}
						onChange={(v) => setCfg({ ...cfg, timeoutMs: v })}
						min={1000}
						step={1000}
						suffix="ms"
						width={120}
					/>
				</Field>
				<Field label="重试次数" code="config.retryTimes" hint="不含首次,失败后再尝试">
					<TNum
						value={cfg.retryTimes}
						onChange={(v) => setCfg({ ...cfg, retryTimes: v })}
						min={0}
						max={10}
						suffix="次"
					/>
				</Field>
				<Field label="重试间隔" code="config.retryIntervalMs">
					<TNum
						value={cfg.retryIntervalMs}
						onChange={(v) => setCfg({ ...cfg, retryIntervalMs: v })}
						min={0}
						step={500}
						suffix="ms"
						width={120}
					/>
				</Field>
				{cfg.transport !== "ws-reverse" ? (
					<Field
						label={cfg.transport === "http" ? "自定义请求头" : "WS 握手头"}
						code="config.headers"
						hint="例如反向代理鉴权头"
					>
						<HeadersEditor
							value={cfg.headers}
							onChange={(next) => setCfg({ ...cfg, headers: next })}
						/>
					</Field>
				) : null}
			</>
		);
	}
	if (adapter.platform === "webhook") {
		const cfg = adapter.config;
		const provider: WebhookProvider = cfg.provider ?? "generic";
		return (
			<>
				<Field
					label="Webhook 协议"
					code="config.provider"
					hint="Generic 保持旧 JSON envelope；钉钉/飞书/企业微信按平台机器人协议发送文本消息"
					required
				>
					<TSelect<WebhookProvider>
						value={provider}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, provider: v } })}
						options={[...WEBHOOK_PROVIDERS]}
					/>
				</Field>
				<Field label="URL" code="config.url" required>
					<TInput
						value={cfg.url}
						onChange={(v) => onChange({ ...adapter, config: { ...cfg, url: v } })}
						placeholder={webhookUrlPlaceholder(provider)}
						mono
					/>
				</Field>
				<Field label="Secret" code="config.secret" hint={webhookSecretHint(provider)}>
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
	// Webhook target 由 adapter 自动托管，不能从手动 target 弹窗创建 / 改挂。
	const eligibleAdapters = adapters.filter((a) => a.platform !== "webhook");
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
							尚未配置任何可手动绑定的适配器 · Webhook 目标由系统自动托管
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
		// web-dashboard 是单用户 in-process 广播,无 session 字段可配。
		return (
			<div className="text-[12px] leading-relaxed text-bn-text-tertiary">
				Web Dashboard 通知中心是单用户 in-process 通道,无需配置会话字段。所有保存的 web-dashboard
				target 都会通过 WS push-events 频道广播给当前 dashboard。
			</div>
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
					className="inline-flex h-7.5 items-center justify-center rounded-md border border-transparent bg-red-500 px-3.5 text-[13px] font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{deleting ? "移除中…" : "确认移除"}
				</button>
			</div>
		</ModalShell>
	);
}

// ── Test confirm modal ─────────────────────────────────────────────────────

function TestConfirmModal({
	target,
	adapter,
	onCancel,
	onConfirm,
}: {
	target: PushTarget;
	adapter: PushAdapter | undefined;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<ModalShell onCancel={onCancel} width={420}>
			<div className="mb-2 text-[15px] font-bold text-bn-text-primary">发送测试推送?</div>
			<div className="mb-4 text-[13px] leading-relaxed text-bn-text-secondary">
				将通过 <b className="text-bn-text-primary">{adapter?.name ?? "(未知适配器)"}</b> 向{" "}
				<b className="text-bn-text-primary">{target.name}</b> 真实发送一条测试消息。
				<br />
				<span className="font-mono text-[11.5px] text-bn-text-tertiary">
					[bilibili-notify] 测试推送已送达 ✓
				</span>
			</div>
			<div className="flex justify-end gap-2">
				<Btn variant="outline" onClick={onCancel}>
					取消
				</Btn>
				<Btn variant="primary" onClick={onConfirm}>
					发送
				</Btn>
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
		<aside className="sticky top-30 h-fit min-w-0">
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
									<span className="mt-0.5 block wrap-break-word text-[10.5px] leading-snug text-bn-text-tertiary">
										{platformLabel(a.platform)} ·{" "}
										{a.platform === "webhook" ? "单向投递" : `${count} 个目标`}
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
	const [targetTesting, setTargetTesting] = useState<Record<string, TestState>>({});
	const [confirmTest, setConfirmTest] = useState<PushTarget | null>(null);
	const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
	// P2:toast 定时器句柄。此前裸 window.setTimeout 无 unmount 清理 →
	// 组件卸载后仍 setToast(已卸载组件)+ 定时器泄漏。
	const toastTimer = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
		};
	}, []);
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
	const selectedManagedWebhookTarget = selectedAdapter
		? managedWebhookTargetForAdapter(selectedAdapter, targets)
		: undefined;

	const showToast = (msg: string, ok = true): void => {
		setToast({ msg, ok });
		if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), 2400);
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
			qc.invalidateQueries({ queryKey: ["targets"] });
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
			qc.invalidateQueries({ queryKey: ["targets"] });
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
		if (a.platform === "webhook") {
			const target = managedWebhookTargetForAdapter(a, targets);
			if (!target) {
				showToast("请先保存 Webhook，系统会自动创建默认投递目标", false);
				return;
			}
			setTesting((p) => ({ ...p, [a.id]: "pending" }));
			setTargetTesting((p) => ({ ...p, [target.id]: "pending" }));
			try {
				const res = await api.post<TestResponse>("/api/push/test", {
					targetId: target.id,
					kind: "text",
				});
				setTesting((p) => ({ ...p, [a.id]: res.ok ? "ok" : "fail" }));
				setTargetTesting((p) => ({ ...p, [target.id]: res.ok ? "ok" : "fail" }));
				showToast(res.ok ? `已送达 · ${res.latencyMs}ms` : `失败:${res.err ?? "未知错误"}`, res.ok);
				qc.invalidateQueries({ queryKey: ["targets"] });
			} catch (err) {
				setTesting((p) => ({ ...p, [a.id]: "fail" }));
				setTargetTesting((p) => ({ ...p, [target.id]: "fail" }));
				const msg = err instanceof ApiError ? err.message : String(err);
				showToast(`测试失败:${msg}`, false);
			}
			window.setTimeout(() => {
				setTesting((p) => {
					const next = { ...p };
					delete next[a.id];
					return next;
				});
				setTargetTesting((p) => {
					const next = { ...p };
					delete next[target.id];
					return next;
				});
			}, 2000);
			return;
		}

		// Connection-only probe — calls platformAdapter.probe(), no real message sent.
		setTesting((p) => ({ ...p, [a.id]: "pending" }));
		try {
			const res = await api.post<{ ok: boolean | null; latencyMs: number; err?: string }>(
				`/api/adapters/${a.id}/test`,
				{},
			);
			if (res.ok === null) {
				setTesting((p) => {
					const next = { ...p };
					delete next[a.id];
					return next;
				});
				showToast("该平台不支持连接探测", false);
				return;
			}
			setTesting((p) => ({ ...p, [a.id]: res.ok ? "ok" : "fail" }));
			showToast(res.ok ? `连通 · ${res.latencyMs}ms` : `失败:${res.err ?? "未知错误"}`, res.ok);
			qc.invalidateQueries({ queryKey: ["adapters"] });
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

	async function runTargetTest(t: PushTarget): Promise<void> {
		setTargetTesting((p) => ({ ...p, [t.id]: "pending" }));
		try {
			const res = await api.post<TestResponse>("/api/push/test", {
				targetId: t.id,
				kind: "text",
			});
			setTargetTesting((p) => ({ ...p, [t.id]: res.ok ? "ok" : "fail" }));
			showToast(res.ok ? `已送达 · ${res.latencyMs}ms` : `失败:${res.err ?? "未知错误"}`, res.ok);
			qc.invalidateQueries({ queryKey: ["targets"] });
		} catch (err) {
			setTargetTesting((p) => ({ ...p, [t.id]: "fail" }));
			const msg = err instanceof ApiError ? err.message : String(err);
			showToast(`测试失败:${msg}`, false);
		}
		window.setTimeout(() => {
			setTargetTesting((p) => {
				const next = { ...p };
				delete next[t.id];
				return next;
			});
		}, 2000);
	}

	function testTarget(t: PushTarget): void {
		setConfirmTest(t);
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
		if (a.platform === "webhook") {
			showToast("Webhook 目标由系统自动托管，无需手动新建", false);
			return;
		}
		setTargetDraft({ mode: "add", value: makeEmptyTarget(a, "") });
	}

	function startEditTarget(t: PushTarget): void {
		setError(null);
		if (t.platform === "webhook" && t.managedBy === "adapter") {
			showToast("Webhook 目标由系统自动托管，请在适配器里修改 URL", false);
			return;
		}
		setTargetDraft({ mode: "edit", value: t });
	}

	const selectedAdapterStatus =
		selectedAdapter?.platform === "webhook" && selectedManagedWebhookTarget
			? targetStatusFor(selectedManagedWebhookTarget)
			: selectedAdapter
				? adapterStatusFor(selectedAdapter)
				: "pending";
	const selectedAdapterTestStatus =
		selectedAdapter?.platform === "webhook"
			? selectedManagedWebhookTarget?.testStatus
			: selectedAdapter?.testStatus;

	const isLoading = adaptersQuery.isLoading || targetsQuery.isLoading;

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
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
											<StatusDot kind={selectedAdapterStatus} />
											{!selectedAdapter.enabled ? (
												<span className="text-[10.5px] text-bn-text-tertiary">(已停用)</span>
											) : null}
										</div>
										<div className="mt-0.5 truncate font-mono text-[11.5px] text-bn-text-tertiary">
											{platformLabel(selectedAdapter.platform)} ·{" "}
											{adapterEndpointSummary(selectedAdapter)}
										</div>
										{selectedAdapterTestStatus ? (
											<div
												className="mt-2 inline-block rounded-sm border-l-[3px] px-2 py-0.5 text-[11px]"
												style={
													selectedAdapterTestStatus.ok
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
												{selectedAdapterTestStatus.ok
													? `上次测试 OK${
															selectedAdapterTestStatus.latencyMs != null
																? ` · ${selectedAdapterTestStatus.latencyMs}ms`
																: ""
														}`
													: `上次测试失败${
															selectedAdapterTestStatus.err
																? ` — ${selectedAdapterTestStatus.err}`
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
												? selectedAdapter.platform === "webhook"
													? "发送中…"
													: "测试中…"
												: testing[selectedAdapter.id] === "ok"
													? selectedAdapter.platform === "webhook"
														? "已送达"
														: "已连通"
													: testing[selectedAdapter.id] === "fail"
														? "失败"
														: selectedAdapter.platform === "webhook"
															? "发送测试"
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
										<div className="text-[14px] font-bold text-bn-text-primary">
											{selectedAdapter.platform === "webhook" ? "Webhook 投递目标" : "推送目标"}
										</div>
										<div className="text-[11.5px] text-bn-text-tertiary">
											{selectedAdapter.platform === "webhook"
												? "Webhook 是单向投递终点，保存 URL 后系统会自动创建默认投递目标。"
												: "本适配器下的会话:群号 / 用户 ID 等。"}
										</div>
									</div>
									{selectedAdapter.platform === "webhook" ? null : (
										<Btn
											size="sm"
											variant="outline"
											onClick={() => startNewTarget(selectedAdapter)}
										>
											+ 新建推送目标
										</Btn>
									)}
								</div>
								{selectedAdapter.platform === "webhook" ? (
									<div className="space-y-2.5">
										<div className="rounded-[9px] border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-emerald-800">
											无需手动配置额外 PushTarget；订阅页会看到这个 Webhook，可直接选择并投递。
										</div>
										{selectedManagedWebhookTarget ? (
											<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
												<TargetCard
													target={selectedManagedWebhookTarget}
													adapter={selectedAdapter}
													onEdit={() => {}}
													onDelete={() => {}}
													onTest={() => testTarget(selectedManagedWebhookTarget)}
													testing={targetTesting[selectedManagedWebhookTarget.id]}
													readOnly
												/>
											</div>
										) : (
											<div className="rounded-[9px] border border-dashed border-gray-200 px-3 py-3 text-center text-[11.5px] text-bn-text-secondary">
												保存 Webhook 后系统会自动创建默认投递目标。
											</div>
										)}
									</div>
								) : selectedTargets.length === 0 ? (
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
												onTest={() => testTarget(t)}
												testing={targetTesting[t.id]}
												readOnly={t.managedBy === "adapter"}
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
							? confirmDelete.value.platform === "webhook"
								? "该 Webhook 的系统托管目标会一并删除，订阅路由中的引用会同步清理。"
								: "适配器若仍被推送目标引用,删除会失败。请先把这些目标改挂到其他适配器或先删除它们。"
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

			{confirmTest ? (
				<TestConfirmModal
					target={confirmTest}
					adapter={adaptersById.get(confirmTest.adapterId)}
					onCancel={() => setConfirmTest(null)}
					onConfirm={() => {
						const t = confirmTest;
						setConfirmTest(null);
						void runTargetTest(t);
					}}
				/>
			) : null}

			{toast ? (
				<div
					className={`fixed bottom-4 right-4 z-400 rounded-md px-4 py-2 text-[12.5px] font-semibold text-white shadow-lg ${
						toast.ok ? "bg-emerald-600" : "bg-red-500"
					}`}
				>
					{toast.msg}
				</div>
			) : null}
		</div>
	);
}
