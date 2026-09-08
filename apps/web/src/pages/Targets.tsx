import type { QQDiscoveredEntry, TestResponse } from "@bilibili-notify/contract";
// 走零依赖的 /constants 子路径 —— 从包根 import 会把 zod 拖进浏览器 bundle。
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/constants";
import {
	AddCard,
	Btn,
	EmptyNote,
	ErrorNote,
	Icon,
	ModalShell,
	PlatformIcon,
	platformLabel,
	platformTint,
	SectionNav,
	StatusDot,
	TOAST_DURATION_MS,
	Toast,
	Toggle,
	ToneChip,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FIELD_ROW_CHROME, Field, Picker, TInput, TNum } from "../components/forms";
import { QQQrBindButton } from "../components/qq-qr-bind";
import { ApiError, api } from "../services/api";
import {
	type Connection,
	KNOWN_PLATFORMS,
	makeEmptyConnection,
	makeEmptyTarget,
	maskWebhookUrl,
	type OnebotConnectionConfig,
	type OnebotTransport,
	type PushTarget,
	type PushTargetPlatform,
	type PushTargetScope,
	type QQOfficialBotType,
	type QQOfficialConnectionConfig,
	switchOnebotTransport,
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

function scopeLabel(s: PushTargetScope): string {
	return SCOPES.find((x) => x.value === s)?.label ?? s;
}

function connectionEndpointSummary(a: Connection): string {
	if (a.platform === "onebot") {
		const c = a.config;
		if (c.transport === "http") return c.baseUrl;
		if (c.transport === "ws") return c.url;
		return `反向 WS :${c.port}`;
	}
	if (a.platform === "qq-official") {
		const c = a.config;
		const domain = c.botType === "private" ? "私域" : "公域";
		const id = c.appId || "未配置 appId";
		return `QQ ${domain} · ${id}${c.sandbox ? " · 沙箱" : ""}`;
	}
	// webhook 那一族:平台名已经写在同一行的前半段(platformLabel),这里只报地址。
	return maskWebhookUrl(a.config.url);
}

/**
 * 一行小字,写这个目标「投到哪」。
 *
 * **先判形态再判平台** —— endpoint 那一支的地址烧在连接里,目标本身没有会话可写;
 * 剩下的会话目标各按自己的平台取地址。以前这里是 onebot / qq-official 两个 if 加一个
 * 兜底 return,兜底那句写死「webhook 终点」:等桥把 telegram 驮进来,新平台会落进
 * 兜底、被标成一个它根本不是的终点,而且**没有编译错也没有测试红**。
 */
function targetSessionSummary(target: PushTarget): string {
	if (target.kind === "endpoint") {
		return target.managedBy === "adapter" ? "→ 系统托管 webhook 终点" : "→ webhook 终点";
	}
	// 地址收成一格之后,这里只剩「叫它什么」这一件事 —— 取哪一格由 scope 说了算,
	// 不再是每个平台一套 session 字段名。
	const noun = addressNoun(target.platform, target.scope);
	return target.address ? `→ ${noun} ${target.address}` : `→ 未指定${noun}`;
}

/** 这个平台的这种会话,地址那一格该叫什么。 */
function addressNoun(platform: string, scope: PushTargetScope): string {
	if (scope === "channel") return "子频道";
	if (platform === "qq-official") return scope === "private" ? "C2C" : "群 openid";
	return scope === "private" ? "用户" : "群";
}

function managedWebhookTargetForConnection(
	connection: Connection,
	targets: readonly PushTarget[],
): PushTarget | undefined {
	if (connection.connector !== "webhook") return undefined;
	const owned = targets.filter((t) => t.kind === "endpoint" && t.adapterId === connection.id);
	return owned.find((t) => t.managedBy === "adapter") ?? owned[0];
}

// ── Adapter card ────────────────────────────────────────────────────────────

function connectionStatusFor(a: Connection): "ok" | "warn" | "err" | "off" | "pending" {
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
	connection: Connection | undefined;
	onEdit: () => void;
	onDelete: () => void;
	onTest: () => void;
	testing: TestState | undefined;
	readOnly?: boolean;
}

/** 左竖条色标的一行小状态(「上次推送/测试 OK · 12ms」)。三色查表,别在调用点拼 token 名。 */
const EDGE_BADGE_TONES = {
	success: {
		background: "var(--color-bn-success-soft)",
		borderLeftColor: "var(--color-bn-success)",
		color: "var(--color-bn-success-text)",
	},
	warning: {
		background: "var(--color-bn-warning-soft)",
		borderLeftColor: "var(--color-bn-warning)",
		color: "var(--color-bn-warning-text)",
	},
	danger: {
		background: "var(--color-bn-danger-soft)",
		borderLeftColor: "var(--color-bn-danger)",
		color: "var(--color-bn-danger-text)",
	},
} as const;

function EdgeBadge({
	tone,
	size = "2xs",
	className,
	children,
}: {
	tone: keyof typeof EDGE_BADGE_TONES;
	size?: "2xs" | "xs";
	/** 外边距与 display(`mb-2` / `mt-2 inline-block`)由摆放处给。 */
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={`rounded-sm border-l-[3px] px-2 py-0.5 ${size === "xs" ? "text-bn-xs" : "text-bn-2xs"} ${className ?? ""}`}
			style={EDGE_BADGE_TONES[tone]}
		>
			{children}
		</div>
	);
}

function TargetCard({
	target,
	connection,
	onEdit,
	onDelete,
	onTest,
	testing,
	readOnly,
}: TargetCardProps) {
	const tint = platformTint(target.platform);
	const connectionMissing = !connection;
	const status = targetStatusFor(target);
	const testStatus = target.testStatus;

	return (
		<div
			className="rounded-bn-sm border bg-bn-surface p-3.5 transition-[border-color] duration-200"
			style={{
				borderColor: connectionMissing ? "var(--color-bn-danger-border)" : "var(--color-bn-border)",
			}}
		>
			<div className="mb-2.5 flex items-center gap-2.5">
				<div
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
					style={{ background: `color-mix(in srgb, ${tint} 10%, transparent)` }}
				>
					<PlatformIcon platform={target.platform} size={18} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-bn-base font-bold text-bn-text-primary">
						{target.name || "（未命名）"}
					</div>
					<div className="truncate font-mono text-bn-xs text-bn-text-tertiary">
						{targetSessionSummary(target)}
					</div>
				</div>
				<StatusDot kind={status} />
			</div>

			{testStatus ? (
				<EdgeBadge tone={testStatus.ok ? "success" : "danger"} className="mb-2">
					{testStatus.ok
						? `上次推送 OK${testStatus.latencyMs != null ? ` · ${testStatus.latencyMs}ms` : ""}`
						: `上次推送失败${testStatus.err ? ` — ${testStatus.err}` : ""}`}
				</EdgeBadge>
			) : null}

			<div className="flex items-center justify-between text-bn-xs text-bn-text-secondary">
				<span className="truncate">
					{scopeLabel(target.scope)}
					{" · "}
					<span style={{ color: connectionMissing ? "var(--color-bn-danger-text)" : undefined }}>
						{connectionMissing ? "连接缺失" : `连接: ${connection.name}`}
					</span>
					{target.enabled ? null : <span className="ml-1.5 text-bn-text-tertiary">(已停用)</span>}
				</span>
				<div className="flex shrink-0 gap-1">
					{/* 导览「发送测试推送」的控件级灯位 —— 只挂在**还没测通**的行上,
					    待测的每一行一起亮(同名实例=等价入口) */}
					<Btn
						data-tour={target.testStatus?.ok === true ? undefined : "target-test"}
						size="sm"
						variant="ghost"
						onClick={onTest}
						disabled={testing === "pending" || !target.enabled || connectionMissing}
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
							{/* 导览失败链的灯位:测试失败的行才亮 —— 不改配置,重测永远失败 */}
							<Btn
								data-tour={target.testStatus?.ok === false ? "target-config" : undefined}
								size="sm"
								variant="ghost"
								onClick={onEdit}
							>
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

// ── Editor: Adapter ─────────────────────────────────────────────────────────

interface ConnectionEditorProps {
	mode: "add" | "edit";
	value: Connection;
	onChange: (next: Connection) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}

function ConnectionEditorModal({
	mode,
	value,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: ConnectionEditorProps) {
	const valid = value.name.trim().length > 0;
	// 保存钮灰着时说清楚为什么 —— 扫码回填流程尤其容易只剩名称没填。
	const invalidHint = valid ? undefined : "请先填写显示名称";
	const tint = platformTint(value.platform);
	return (
		<ModalShell onCancel={onCancel} width={500} title={mode === "add" ? "新建连接" : "配置连接"}>
			{/* data-tour:弹窗打开后导览聚光灯从「+ 新建」转移到这张表单上 */}
			<div data-tour="adapter-form" className="space-y-2.5">
				<SectionBox title="基本" subtitle="一个连接实例可被多个推送目标共享" accent={tint}>
					<Field label="平台" code="adapter.platform" required>
						<div className="flex flex-wrap gap-1.5">
							{KNOWN_PLATFORMS.map((p) => {
								const active = value.platform === p.value;
								const pTint = platformTint(p.value);
								return (
									<ToneChip
										key={p.value}
										tone={pTint}
										active={active}
										onClick={() => onChange(makeEmptyConnection(p.value, value.name))}
									>
										<PlatformIcon platform={p.value} size={13} />
										{p.label}
									</ToneChip>
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

				<SectionBox
					title="连接参数"
					subtitle={
						value.platform === "onebot"
							? "OneBot v11 连接信息"
							: value.platform === "qq-official"
								? "QQ 官方机器人凭据(q.qq.com)"
								: "Webhook 投递终点"
					}
					accent={tint}
				>
					<ConnectionConfigFields connection={value} onChange={onChange} />
				</SectionBox>
			</div>

			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}

			<div className="mt-4 flex items-center justify-end gap-2">
				{invalidHint ? (
					<span className="mr-auto text-bn-xs text-bn-text-tertiary">{invalidHint}</span>
				) : null}
				<Btn variant="outline" onClick={onCancel} disabled={saving}>
					取消
				</Btn>
				<Btn variant="primary" onClick={onSave} disabled={saving || !valid} title={invalidHint}>
					{saving ? "保存中…" : "保存"}
				</Btn>
			</div>
		</ModalShell>
	);
}

function ConnectionConfigFields({
	connection,
	onChange,
}: {
	connection: Connection;
	onChange: (next: Connection) => void;
}) {
	if (connection.platform === "onebot") {
		const cfg = connection.config;
		// connector 跟着 transport 走 —— 这一版两份并存,schema 的 refine 会把漂掉的挡下来。
		const setCfg = (next: OnebotConnectionConfig) =>
			onChange({ ...connection, connector: next.transport, config: next });
		return (
			<>
				<Field label="连接方式" code="config.transport" required>
					<div className="flex flex-wrap gap-1.5">
						{ONEBOT_TRANSPORTS.map((t) => {
							const active = cfg.transport === t.value;
							return (
								<ToneChip
									key={t.value}
									tone={platformTint("onebot")}
									active={active}
									onClick={() => setCfg(switchOnebotTransport(cfg, t.value))}
								>
									{t.label}
								</ToneChip>
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
				{/* 这句 hint 要说的不是「超时是什么」,而是「为什么它看起来没生效」:带图
				    消息另有更长的下限,不然主人会以为自己调的 15s 被无视了。下限现在就在
				    下面两栏里,调得动也关得掉 —— 别再让它在代码里悄悄盖掉主人配的数。 */}
				<Field
					label={cfg.transport === "http" ? "请求超时" : "响应超时"}
					code="config.timeoutMs"
					hint={`${
						cfg.transport === "http" ? "单次 HTTP 请求总超时(毫秒)" : "等 OneBot echo 响应的超时"
					}。纯文字消息按这个数走；带图的另看下面两栏的下限`}
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
				<Field
					label="带图超时下限"
					code="config.imageMinTimeoutMs"
					hint={`带图消息实际等 max(上面的超时, 此值)。协议端要先把图传到 QQ 图床才回响应，实测常超 15s，所以单独放宽（默认 ${ONEBOT_IMAGE_MIN_TIMEOUT_MS / 1000}s）。填 0 = 不放宽，严格按上面的超时走`}
				>
					<TNum
						value={cfg.imageMinTimeoutMs}
						onChange={(v) => setCfg({ ...cfg, imageMinTimeoutMs: v })}
						min={0}
						step={1000}
						suffix="ms"
						width={120}
					/>
				</Field>
				<Field
					label="合并转发超时下限"
					code="config.forwardMinTimeoutMs"
					hint={`语义同上，只是合并转发要把每张图逐张下载再上传组装，更慢（默认 ${ONEBOT_FORWARD_MIN_TIMEOUT_MS / 1000}s）。填 0 = 不放宽`}
				>
					<TNum
						value={cfg.forwardMinTimeoutMs}
						onChange={(v) => setCfg({ ...cfg, forwardMinTimeoutMs: v })}
						min={0}
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
	if (connection.platform === "qq-official") {
		const cfg = connection.config;
		const setCfg = (next: QQOfficialConnectionConfig) => onChange({ ...connection, config: next });
		return (
			<>
				{/* 行框吃 Field 的 FIELD_ROW_CHROME —— 扫码行要与底下的字段行排同一栏,
				    此前逐字符手抄,行距一漂两种行就对不齐。 */}
				<div className={`flex flex-wrap items-center gap-3 ${FIELD_ROW_CHROME}`}>
					<QQQrBindButton
						// 回填 = 「用扫出来的这个 lite bot」,顺手把域/沙箱归到它的正确档:
						// lite bot 无原生 markdown 特权,留在私域档会让图集推送必败。
						// 显示名称为空时补默认名 —— 扫码流程跳过了表单上半截,名称空着
						// 会让保存钮一直灰着(唯一前端必填),用户看不出为什么存不了。
						onCredentials={({ appId, appSecret }) =>
							onChange({
								...connection,
								name: connection.name.trim() ? connection.name : `QQ 机器人 ${appId}`,
								config: { ...cfg, appId, appSecret, botType: "public", sandbox: false },
							})
						}
					/>
					<span className="text-bn-xs text-bn-text-secondary">
						没有机器人?扫码在腾讯页面一键创建,凭据自动回填下方两栏
					</span>
				</div>
				<Field
					label="AppID"
					code="config.appId"
					required
					hint="QQ 开放平台机器人的 AppID(明文存储)"
				>
					<TInput
						value={cfg.appId}
						onChange={(v) => setCfg({ ...cfg, appId: v })}
						placeholder="102xxxxxx"
						mono
					/>
				</Field>
				<Field
					label="AppSecret"
					code="config.appSecret"
					required
					hint="机器人密钥;用于换取 App Access Token"
				>
					<TInput value={cfg.appSecret} onChange={(v) => setCfg({ ...cfg, appSecret: v })} secret />
				</Field>
				<Field
					label="机器人域"
					code="config.botType"
					required
					hint="私域可发原生 markdown(图集合并成一条多图);公域不支持原生 markdown(图集逐条发,需报备模板)"
				>
					<Picker<QQOfficialBotType>
						value={cfg.botType}
						onChange={(v) => setCfg({ ...cfg, botType: v })}
						options={[
							{ value: "public", label: "公域" },
							{ value: "private", label: "私域" },
						]}
					/>
				</Field>
				<Field
					label="沙箱模式"
					code="config.sandbox"
					hint="开启后走 QQ 沙箱环境(sandbox.api.sgroup.qq.com),仅对沙箱内成员可见"
				>
					<Toggle value={cfg.sandbox} onChange={(v) => setCfg({ ...cfg, sandbox: v })} />
				</Field>
				<Field
					label="记录重连日志"
					code="config.logReconnects"
					hint="QQ 官方网关约每 30 分钟主动要求重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启"
				>
					<Toggle
						value={cfg.logReconnects}
						onChange={(v) => setCfg({ ...cfg, logReconnects: v })}
					/>
				</Field>
			</>
		);
	}
	if (connection.connector === "webhook") {
		const cfg = connection.config;
		// 「哪家的机器人」原先是这张表里一个叫「Webhook 协议」的下拉 —— 它现在就是上面
		// 那排平台胶囊,不再问第二遍。
		const platform = connection.platform;
		return (
			<>
				<Field label="URL" code="config.url" required>
					<TInput
						value={cfg.url}
						onChange={(v) => onChange({ ...connection, config: { ...cfg, url: v } })}
						placeholder={webhookUrlPlaceholder(platform)}
						mono
					/>
				</Field>
				<Field label="Secret" code="config.secret" hint={webhookSecretHint(platform)}>
					<TInput
						value={cfg.secret ?? ""}
						onChange={(v) =>
							onChange({ ...connection, config: { ...cfg, secret: v || undefined } })
						}
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
	connections: Connection[];
	onChange: (next: PushTarget) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}

function TargetEditorModal({
	mode,
	value,
	connections,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: TargetEditorProps) {
	const valid = value.name.trim().length > 0 && Boolean(value.adapterId);
	const tint = platformTint(value.platform);
	// Webhook target 由 adapter 自动托管，不能从手动 target 弹窗创建 / 改挂。
	const eligibleConnections = connections.filter((a) => a.connector !== "webhook");
	return (
		<ModalShell
			onCancel={onCancel}
			width={500}
			title={mode === "add" ? "新建推送目标" : "配置推送目标"}
		>
			{/* data-tour:弹窗打开后导览聚光灯从「+ 新建」转移到这张表单上 */}
			<div data-tour="target-form" className="space-y-2.5">
				<SectionBox
					title="选择连接"
					subtitle="目标的平台跟随连接;baseUrl / accessToken 这些参数在连接上维护"
					accent={tint}
				>
					{eligibleConnections.length === 0 ? (
						<EmptyNote size="sm">
							尚未配置任何可手动绑定的连接 · Webhook 目标由系统自动托管
						</EmptyNote>
					) : (
						<div className="space-y-1.5">
							{eligibleConnections.map((a) => {
								const active = value.adapterId === a.id;
								const aTint = platformTint(a.platform);
								return (
									<button
										key={a.id}
										type="button"
										onClick={() => {
											const next = makeEmptyTarget(a, value.name);
											// preserve user-typed identity if any
											onChange({ ...next, id: value.id, enabled: value.enabled });
										}}
										// 候选行走 option。选中态曾经**只买到一半** —— 底与边写在 `style`
										// 里(平台 tint),inline 压过一切 author 样式,挂着 option-active
										// 也白挂;未选中那一档更亏,两个静态 token 也一起锁在了 inline 上。
										// 现在 inline 只剩 `--bn-tint` 一个值,涂法在 `bn-tint-row` 那条
										// @utility 里,两态皮肤都盖得动。
										data-bn={active ? "option option-active" : "option"}
										className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition ${
											active ? "bn-tint-row" : "border-bn-border bg-bn-surface"
										}`}
										style={{ "--bn-tint": aTint } as CSSProperties}
									>
										<PlatformIcon platform={a.platform} size={16} />
										<div className="min-w-0 flex-1">
											<div className="truncate text-bn-sm font-semibold text-bn-text-primary">
												{a.name}
											</div>
											<div className="truncate font-mono text-bn-2xs text-bn-text-tertiary">
												{platformLabel(a.platform)} · {connectionEndpointSummary(a)}
											</div>
										</div>
										{active ? (
											<span className="text-bn-xs font-bold" style={{ color: aTint }}>
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
									<ToneChip
										key={s.value}
										active={active}
										onClick={() => {
											// 换了 scope 就是换了一种会话,原来那个地址不再有意义(群号不是 QQ 号)
											// —— 清掉。老形状是每种 scope 各占一个 session 字段,换过去等于换了个
											// 格子读,旧值还留在原格子里;收成一格之后必须自己清。
											if (value.kind !== "session" || value.scope === s.value) return;
											onChange({ ...value, scope: s.value, address: "", parentAddress: undefined });
										}}
									>
										{s.label}
									</ToneChip>
								);
							})}
						</div>
					</Field>
					<Field label="启用" code="target.enabled">
						<Toggle value={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
					</Field>
				</SectionBox>

				{value.platform === "onebot" || value.platform === "qq-official" ? (
					<SectionBox
						title="会话信息"
						subtitle={
							value.platform === "onebot"
								? value.scope === "private"
									? "私聊目标 QQ 号"
									: "群聊号(QQ 群号)"
								: "QQ 官方机器人会话寻址(频道/群/C2C)"
						}
						accent={tint}
					>
						<TargetSessionFields target={value} onChange={onChange} />
					</SectionBox>
				) : null}
			</div>

			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}

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
	if (target.kind !== "session") return null;
	const setAddress = (address: string) => onChange({ ...target, address });

	if (target.platform === "onebot") {
		return target.scope === "private" ? (
			<Field label="QQ 号" code="target.address" required>
				<TInput value={target.address} onChange={setAddress} placeholder="如:10001" mono />
			</Field>
		) : (
			<Field label="群号" code="target.address" required>
				<TInput value={target.address} onChange={setAddress} placeholder="如:123456789" mono />
			</Field>
		);
	}
	if (target.platform === "qq-official") {
		if (target.scope === "channel") {
			return (
				<>
					<Field
						label="频道服务器 ID"
						code="target.parentAddress"
						hint="用下方「拉取频道」自动填入,或手填"
					>
						<TInput
							value={target.parentAddress ?? ""}
							onChange={(v) => onChange({ ...target, parentAddress: v || undefined })}
							placeholder="guild_id"
							mono
						/>
					</Field>
					<Field label="子频道 ID" code="target.address" required>
						<TInput
							value={target.address}
							onChange={setAddress}
							placeholder="文字子频道 channel_id"
							mono
						/>
					</Field>
					<QQGuildPicker
						adapterId={target.adapterId}
						onPick={(guildId, channelId) =>
							onChange({ ...target, address: channelId, parentAddress: guildId })
						}
					/>
				</>
			);
		}
		const isPrivate = target.scope === "private";
		return (
			<>
				<Field
					label={isPrivate ? "用户 openid (C2C)" : "群 openid"}
					code="target.address"
					required
					hint={
						isPrivate
							? "QQ 无「列我的好友」接口,openid 只能从机器人收到的 C2C 消息事件捞 —— 见下方发现列表"
							: "QQ 无「列我的群」接口,openid 只能从机器人被 @ 的群消息事件捞 —— 见下方发现列表"
					}
				>
					<TInput
						value={target.address}
						onChange={setAddress}
						placeholder={isPrivate ? "用户 openid" : "群 openid"}
						mono
					/>
				</Field>
				<QQSessionPicker
					adapterId={target.adapterId}
					scope={isPrivate ? "private" : "group"}
					onPick={setAddress}
				/>
			</>
		);
	}
	return null;
}

// ── QQ 官方机器人选择器 ───────────────────────────────────────────────────────

interface QQGuildChannelView {
	channelId: string;
	name: string;
	type: number;
}
interface QQGuildView {
	guildId: string;
	name: string;
	channels: QQGuildChannelView[];
}

/**
 * 群/C2C 发现列表 —— 读 `/api/qq/sessions/:adapterId`(内存 ring buffer,网关从入站
 * 事件捞的 openid)。点一条把 openid 填进会话。QQ 无「列我的群/好友」接口,这是唯一来源。
 */
function QQSessionPicker({
	adapterId,
	scope,
	onPick,
}: {
	adapterId: string;
	scope: "group" | "private";
	onPick: (openid: string) => void;
}) {
	const { data, isLoading, isError, refetch, isFetching } = useQuery({
		queryKey: ["qq-sessions", adapterId],
		queryFn: () => api.get<QQDiscoveredEntry[]>(`/api/qq/sessions/${adapterId}`),
		enabled: Boolean(adapterId),
	});
	const list = (data ?? []).filter((e) => e.scope === scope);
	const label = scope === "group" ? "群" : "用户";
	return (
		<CandidateBox
			title={`发现的${label}会话`}
			actionLabel="刷新"
			pendingLabel="刷新中…"
			pending={isFetching}
			onAction={() => refetch()}
		>
			{isLoading ? (
				<div className="text-bn-xs text-bn-text-tertiary">加载中…</div>
			) : isError ? (
				<div className="text-bn-xs text-bn-danger">拉取失败(这条连接是否已保存并连上网关?)</div>
			) : list.length === 0 ? (
				<div className="text-bn-xs leading-relaxed text-bn-text-tertiary">
					暂无发现的{label}会话 —— 先让机器人在目标
					{scope === "group" ? "群里被 @ 一次" : "处收到一条 C2C 消息"}
					,再点刷新。
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{/* 候选行走 option —— 从列表里挑一个,不是执行动作,所以不吃按钮的皮。 */}
					{list.map((e) => (
						<button
							key={e.openid}
							type="button"
							onClick={() => onPick(e.openid)}
							data-bn="option"
							className="flex items-center gap-2 rounded-sm border border-bn-border bg-bn-surface px-2 py-1 text-left transition hover:border-bn-pink"
						>
							<span className="truncate text-bn-xs font-semibold text-bn-text-primary">
								{e.displayHint ?? "(无名称)"}
							</span>
							<span className="truncate font-mono text-bn-2xs text-bn-text-tertiary">
								{e.openid}
							</span>
						</button>
					))}
				</div>
			)}
		</CandidateBox>
	);
}

/**
 * 频道子频道选择器 —— 手动触发 `/api/qq/guilds/:adapterId`(每次实时拉,避免每次打开
 * 弹窗都打 QQ REST)。点子频道把 guildId+channelId 一起填进会话。
 */
function QQGuildPicker({
	adapterId,
	onPick,
}: {
	adapterId: string;
	onPick: (guildId: string, channelId: string) => void;
}) {
	const { data, isError, refetch, isFetching, fetchStatus } = useQuery({
		queryKey: ["qq-guilds", adapterId],
		queryFn: () => api.get<QQGuildView[]>(`/api/qq/guilds/${adapterId}`),
		enabled: false, // 手动触发:枚举会打 QQ REST,不在打开弹窗时自动拉
	});
	const guilds = data ?? [];
	const fetched = fetchStatus === "idle" && data !== undefined;
	return (
		<CandidateBox
			title="频道子频道列表"
			actionLabel="拉取频道"
			pendingLabel="拉取中…"
			pending={isFetching}
			onAction={() => refetch()}
		>
			{isError ? (
				<div className="text-bn-xs text-bn-danger">拉取失败(这条连接是否已保存且凭据正确?)</div>
			) : !fetched ? (
				<div className="text-bn-xs text-bn-text-tertiary">点「拉取频道」从 QQ 实时枚举。</div>
			) : guilds.length === 0 ? (
				<div className="text-bn-xs text-bn-text-tertiary">未发现任何频道服务器。</div>
			) : (
				<div className="flex flex-col gap-1.5">
					{guilds.map((g) => (
						<div key={g.guildId}>
							<div className="truncate text-bn-xs font-semibold text-bn-text-secondary">
								{g.name}
							</div>
							<div className="mt-0.5 flex flex-wrap gap-1">
								{g.channels.length === 0 ? (
									<span className="text-bn-2xs text-bn-text-tertiary">(无文字子频道)</span>
								) : (
									// 候选 chip 走 option:挑频道,不是执行动作。
									g.channels.map((ch) => (
										<button
											key={ch.channelId}
											type="button"
											onClick={() => onPick(g.guildId, ch.channelId)}
											data-bn="option"
											className="rounded-sm border border-bn-border bg-bn-surface px-2 py-0.5 text-bn-xs text-bn-text-primary transition hover:border-bn-pink"
										>
											{ch.name}
										</button>
									))
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</CandidateBox>
	);
}

/**
 * 候选拉取盒 —— 虚线盒 + 「标题 + ghost 触发钮」头行。QQ 会话与频道两个选择器
 * 此前各抄一份,连 mb-1 的头行都逐字符相同;拉取状态与候选列表由调用方摆。
 */
function CandidateBox({
	title,
	actionLabel,
	pendingLabel,
	pending,
	onAction,
	children,
}: {
	title: string;
	actionLabel: string;
	pendingLabel: string;
	pending: boolean;
	onAction: () => void;
	children: ReactNode;
}) {
	return (
		<div className="mt-1.5 rounded-md border border-dashed border-bn-border px-2.5 py-2">
			<div className="mb-1 flex items-center justify-between">
				<span className="text-bn-xs font-bold text-bn-text-secondary">{title}</span>
				<Btn variant="ghost" size="sm" onClick={onAction} disabled={pending}>
					{pending ? pendingLabel : actionLabel}
				</Btn>
			</div>
			{children}
		</div>
	);
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
			style={{
				borderColor: `color-mix(in srgb, ${accent} 20%, transparent)`,
				background: `color-mix(in srgb, ${accent} 2%, transparent)`,
			}}
		>
			<div className="mb-1 flex items-baseline gap-2">
				<span className="text-bn-sm font-bold" style={{ color: accent }}>
					{title}
				</span>
				{subtitle ? <span className="text-bn-2xs text-bn-text-tertiary">{subtitle}</span> : null}
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
		<ModalShell
			onCancel={onCancel}
			width={420}
			title={subjectKind === "adapter" ? "删除连接" : "删除推送目标"}
			description={
				<>
					确定要移除 <b className="text-bn-text-primary">{subjectName}</b> 吗？
					{hint ? (
						<>
							<br />
							{hint}
						</>
					) : null}
				</>
			}
		>
			{error ? <ErrorNote className="mb-3">{error}</ErrorNote> : null}
			<div className="flex justify-end gap-2">
				<Btn variant="outline" onClick={onCancel} disabled={deleting}>
					取消
				</Btn>
				<Btn variant="danger-solid" onClick={onConfirm} disabled={deleting}>
					{deleting ? "移除中…" : "确认移除"}
				</Btn>
			</div>
		</ModalShell>
	);
}

// ── Test confirm modal ─────────────────────────────────────────────────────

function TestConfirmModal({
	target,
	connection,
	onCancel,
	onConfirm,
}: {
	target: PushTarget;
	connection: Connection | undefined;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<ModalShell
			onCancel={onCancel}
			width={420}
			title="发送测试推送?"
			description={
				<>
					将通过 <b className="text-bn-text-primary">{connection?.name ?? "(未知连接)"}</b> 向{" "}
					<b className="text-bn-text-primary">{target.name}</b> 真实发送一条测试消息。
					<br />
					<span className="font-mono text-bn-xs text-bn-text-tertiary">
						[bilibili-notify] 测试推送已送达 ✓
					</span>
				</>
			}
		>
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

function ConnectionRail({
	connections,
	selectedId,
	onPick,
	onAddClick,
	targetCountByConnection,
}: {
	connections: Connection[];
	selectedId: string | null;
	onPick: (id: string) => void;
	onAddClick: () => void;
	targetCountByConnection: Map<string, number>;
}) {
	return (
		<SectionNav
			heading="推送连接"
			activeId={selectedId}
			onPick={onPick}
			onAdd={onAddClick}
			addLabel="+ 新建"
			// data-tour:导览「新建推送适配器」的常驻灯位(控件级 —— 只框按钮本体)
			addButtonProps={{ "data-tour": "adapter-add" }}
			// 不带底色 —— 虚线家族统一成 Subs「添加 UP 主」那样只有虚线框(2026-08-30 主人定案)
			emptyState={<EmptyNote size="sm">尚未配置任何连接</EmptyNote>}
			items={connections.map((a) => {
				const count = targetCountByConnection.get(a.id) ?? 0;
				return {
					id: a.id,
					label: a.name || "（未命名）",
					desc: `${platformLabel(a.platform)} · ${a.connector === "webhook" ? "单向投递" : `${count} 个目标`}`,
					// 选中那格喂 currentColor —— 标识色是中等亮度,摆在皮肤画的实心块上会撞
					// (QQ官方 #14b8a6 对主人那块粉只有 1.24:1)。平台名在副标题里写着,不丢。
					icon: (
						<PlatformIcon
							platform={a.platform}
							size={12}
							tone={a.id === selectedId ? "currentColor" : undefined}
						/>
					),
					iconTint: platformTint(a.platform),
					// **不写死前景色** —— 它落在左栏选中项内部,而那一项的底由皮肤说了算
					// (见 SectionNav 的 RAIL_ITEM_ACTIVE)。tertiary 这一档假设底是页面色,
					// 皮肤把选中项画成实心块之后它就糊在上面了。弱化改由字号 + 字重扛,
					// 和同一张卡上的副标题同一个办法。
					badge: !a.enabled ? (
						<span className="shrink-0 text-bn-2xs font-normal">(停用)</span>
					) : undefined,
				};
			})}
		/>
	);
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Targets() {
	const qc = useQueryClient();

	const connectionsQuery = useQuery({
		queryKey: ["adapters"],
		queryFn: () => api.get<Connection[]>("/api/adapters"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [connectionDraft, setConnectionDraft] = useState<{
		mode: "add" | "edit";
		value: Connection;
	} | null>(null);
	const [targetDraft, setTargetDraft] = useState<{
		mode: "add" | "edit";
		value: PushTarget;
	} | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<
		{ kind: "adapter"; value: Connection } | { kind: "target"; value: PushTarget } | null
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
	const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

	const connections = connectionsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	const connectionsById = new Map(connections.map((a) => [a.id, a]));
	const targetCountByConnection = new Map<string, number>();
	for (const t of targets) {
		targetCountByConnection.set(t.adapterId, (targetCountByConnection.get(t.adapterId) ?? 0) + 1);
	}

	// Keep selectedConnectionId valid: default to the first adapter; reselect if
	// the user deletes the current one.
	useEffect(() => {
		if (connections.length === 0) {
			if (selectedConnectionId !== null) setSelectedConnectionId(null);
			return;
		}
		if (!selectedConnectionId || !connections.some((a) => a.id === selectedConnectionId)) {
			setSelectedConnectionId(connections[0]?.id ?? null);
		}
	}, [connections, selectedConnectionId]);

	const selectedConnection = selectedConnectionId
		? connections.find((a) => a.id === selectedConnectionId)
		: undefined;
	const selectedTargets = selectedConnection
		? targets.filter((t) => t.adapterId === selectedConnection.id)
		: [];
	const selectedManagedWebhookTarget = selectedConnection
		? managedWebhookTargetForConnection(selectedConnection, targets)
		: undefined;

	const showToast = (msg: string, ok = true): void => {
		setToast({ msg, ok });
		if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
	};

	const upsertConnection = useMutation({
		mutationFn: async (a: Connection) => {
			setError(null);
			try {
				await api.post<Connection[]>("/api/adapters", a);
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["adapters"] });
			qc.invalidateQueries({ queryKey: ["targets"] });
			showToast(connectionDraft?.mode === "add" ? "已新建连接" : "连接已保存");
			setConnectionDraft(null);
		},
	});

	const delConnection = useMutation({
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
			showToast("已移除连接");
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

	async function testConnection(a: Connection): Promise<void> {
		if (a.connector === "webhook") {
			const target = managedWebhookTargetForConnection(a, targets);
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

	function startNewConnection(): void {
		setError(null);
		setConnectionDraft({
			mode: "add",
			value: makeEmptyConnection("onebot" as PushTargetPlatform, ""),
		});
	}

	function startEditConnection(a: Connection): void {
		setError(null);
		setConnectionDraft({ mode: "edit", value: a });
	}

	function startNewTarget(connection?: Connection): void {
		setError(null);
		const a = connection ?? selectedConnection ?? connections[0];
		if (!a) {
			showToast("请先新建一个连接", false);
			return;
		}
		if (a.connector === "webhook") {
			showToast("Webhook 目标由系统自动托管，无需手动新建", false);
			return;
		}
		setTargetDraft({ mode: "add", value: makeEmptyTarget(a, "") });
	}

	function startEditTarget(t: PushTarget): void {
		setError(null);
		if (t.kind === "endpoint" && t.managedBy === "adapter") {
			showToast("Webhook 目标由系统自动托管，请在连接里修改 URL", false);
			return;
		}
		setTargetDraft({ mode: "edit", value: t });
	}

	const selectedConnectionStatus =
		selectedConnection?.connector === "webhook" && selectedManagedWebhookTarget
			? targetStatusFor(selectedManagedWebhookTarget)
			: selectedConnection
				? connectionStatusFor(selectedConnection)
				: "pending";
	const selectedConnectionTestStatus =
		selectedConnection?.connector === "webhook"
			? selectedManagedWebhookTarget?.testStatus
			: selectedConnection?.testStatus;

	const isLoading = connectionsQuery.isLoading || targetsQuery.isLoading;

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-bn-rail">
				{/* ConnectionRail 直接坐在 grid 上,中间不许夹盒子 —— SectionNav 的根在 xl 以下是
				    `display:contents`,包一层 div 就把它的包含块缩成矮格子,sticky 失去吸附
				    行程(见 packages/ui/src/section-nav.tsx 的同段注释)。导览挂点(adapter-add)
				    在内部「+ 新建」按钮本体上,不需要外层盒子 —— 曾框整栏:洞大到点空态占位
				    也算「点过了」,灯白白退散(真机踩过)。 */}
				<ConnectionRail
					connections={connections}
					selectedId={selectedConnectionId}
					onPick={setSelectedConnectionId}
					onAddClick={startNewConnection}
					targetCountByConnection={targetCountByConnection}
				/>

				<div className="space-y-4">
					{isLoading ? (
						<div className="bn-glass rounded-bn-card p-6 shadow-bn-card">
							<div className="h-20 animate-pulse rounded-bn-sm bg-bn-surface-muted" />
						</div>
					) : !selectedConnection ? (
						<div className="bn-glass rounded-bn-card p-8 text-center shadow-bn-card">
							<div className="mb-1 text-bn-md font-bold text-bn-text-primary">还没有连接</div>
							<div className="mb-4 text-bn-xs text-bn-text-tertiary">
								先新建一个连接(QQ 官方机器人 / OneBot / Webhook),再为它配置推送目标。
							</div>
							{/* 与左栏「+ 新建」同名挂点 —— 同名实例是等价入口,聚光灯一起亮 */}
							<Btn data-tour="adapter-add" variant="primary" size="sm" onClick={startNewConnection}>
								+ 新建连接
							</Btn>
						</div>
					) : (
						<>
							{/* Adapter detail header */}
							<div className="bn-glass rounded-bn-card p-4 shadow-bn-card">
								<div className="flex items-start gap-3">
									<div
										className="grid h-11 w-11 shrink-0 place-items-center rounded-lg"
										style={{
											background: `color-mix(in srgb, ${platformTint(selectedConnection.platform)} 12%, transparent)`,
										}}
									>
										<PlatformIcon platform={selectedConnection.platform} size={22} />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-bn-md font-bold text-bn-text-primary">
												{selectedConnection.name || "（未命名）"}
											</span>
											<StatusDot kind={selectedConnectionStatus} />
											{!selectedConnection.enabled ? (
												<span className="text-bn-2xs text-bn-text-tertiary">(已停用)</span>
											) : null}
										</div>
										<div className="mt-0.5 truncate font-mono text-bn-xs text-bn-text-tertiary">
											{platformLabel(selectedConnection.platform)} ·{" "}
											{connectionEndpointSummary(selectedConnection)}
										</div>
										{selectedConnectionTestStatus ? (
											<EdgeBadge
												tone={selectedConnectionTestStatus.ok ? "success" : "warning"}
												size="xs"
												className="mt-2 inline-block"
											>
												{selectedConnectionTestStatus.ok
													? `上次测试 OK${
															selectedConnectionTestStatus.latencyMs != null
																? ` · ${selectedConnectionTestStatus.latencyMs}ms`
																: ""
														}`
													: `上次测试失败${
															selectedConnectionTestStatus.err
																? ` — ${selectedConnectionTestStatus.err}`
																: ""
														}`}
											</EdgeBadge>
										) : null}
									</div>
									<div className="flex shrink-0 gap-1">
										{/* 导览「测试适配器连通」一步的控件级灯位 */}
										<Btn
											data-tour="adapter-test"
											size="sm"
											variant="ghost"
											onClick={() => testConnection(selectedConnection)}
											disabled={testing[selectedConnection.id] === "pending"}
										>
											{testing[selectedConnection.id] === "pending"
												? selectedConnection.connector === "webhook"
													? "发送中…"
													: "测试中…"
												: testing[selectedConnection.id] === "ok"
													? selectedConnection.connector === "webhook"
														? "已送达"
														: "已连通"
													: testing[selectedConnection.id] === "fail"
														? "失败"
														: selectedConnection.connector === "webhook"
															? "发送测试"
															: "测试"}
										</Btn>
										<Btn
											// 导览失败链的灯位:测试失败时才亮(同 target-config)
											data-tour={
												selectedConnection.testStatus?.ok === false ? "adapter-config" : undefined
											}
											size="sm"
											variant="ghost"
											onClick={() => startEditConnection(selectedConnection)}
										>
											配置
										</Btn>
										<Btn
											size="sm"
											variant="ghost"
											onClick={() => {
												setDeleteError(null);
												setConfirmDelete({ kind: "adapter", value: selectedConnection });
											}}
											title="删除"
											icon={<Icon.trash size={11} />}
										>
											{null}
										</Btn>
									</div>
								</div>
							</div>

							{/* Targets bound to this adapter。data-tour:导览「发送测试推送」一步聚这整卡 */}
							<div data-tour="target-list" className="bn-glass rounded-bn-card p-4 shadow-bn-card">
								<div className="mb-3 flex items-baseline justify-between">
									<div>
										<div className="text-bn-md font-bold text-bn-text-primary">
											{selectedConnection.connector === "webhook" ? "Webhook 投递目标" : "推送目标"}
										</div>
										<div className="text-bn-xs text-bn-text-tertiary">
											{selectedConnection.connector === "webhook"
												? "Webhook 是单向投递终点，保存 URL 后系统会自动创建默认投递目标。"
												: "本连接下的会话:群号 / 用户 ID 等。"}
										</div>
									</div>
									{selectedConnection.connector === "webhook" ? null : (
										<Btn
											data-tour="target-add"
											size="sm"
											variant="outline"
											onClick={() => startNewTarget(selectedConnection)}
										>
											+ 新建推送目标
										</Btn>
									)}
								</div>
								{selectedConnection.connector === "webhook" ? (
									<div className="space-y-2.5">
										<div className="rounded-bn-sm border border-bn-success-border bg-bn-success-soft/70 px-3 py-2 text-bn-xs leading-relaxed text-bn-success-text">
											无需手动配置额外 PushTarget；订阅页会看到这个 Webhook，可直接选择并投递。
										</div>
										{selectedManagedWebhookTarget ? (
											<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
												<TargetCard
													target={selectedManagedWebhookTarget}
													connection={selectedConnection}
													onEdit={() => {}}
													onDelete={() => {}}
													onTest={() => testTarget(selectedManagedWebhookTarget)}
													testing={targetTesting[selectedManagedWebhookTarget.id]}
													readOnly
												/>
											</div>
										) : (
											<EmptyNote size="sm">保存 Webhook 后系统会自动创建默认投递目标。</EmptyNote>
										)}
									</div>
								) : selectedTargets.length === 0 ? (
									<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
										{/* 与右上「+ 新建推送目标」同名挂点 —— 等价入口,聚光灯一起亮 */}
										<AddCard
											data-tour="target-add"
											label="新建推送目标"
											hint="绑定到当前连接"
											className="min-h-22"
											onClick={() => startNewTarget(selectedConnection)}
										/>
									</div>
								) : (
									<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
										{selectedTargets.map((t) => (
											<TargetCard
												key={t.id}
												target={t}
												connection={connectionsById.get(t.adapterId)}
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
											hint="绑定到当前连接"
											className="min-h-22"
											onClick={() => startNewTarget(selectedConnection)}
										/>
									</div>
								)}
							</div>
						</>
					)}
				</div>
			</div>

			{connectionDraft ? (
				<ConnectionEditorModal
					mode={connectionDraft.mode}
					value={connectionDraft.value}
					onChange={(v) => setConnectionDraft({ mode: connectionDraft.mode, value: v })}
					onSave={() => upsertConnection.mutate(connectionDraft.value)}
					onCancel={() => {
						setConnectionDraft(null);
						setError(null);
					}}
					saving={upsertConnection.isPending}
					error={error}
				/>
			) : null}

			{targetDraft ? (
				<TargetEditorModal
					mode={targetDraft.mode}
					value={targetDraft.value}
					connections={connections}
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
							? confirmDelete.value.connector === "webhook"
								? "该 Webhook 的系统托管目标会一并删除，订阅路由中的引用会同步清理。"
								: "连接若仍被推送目标引用,删除会失败。请先把这些目标改挂到其他连接或先删除它们。"
							: "该目标在订阅路由中的引用将变成空引用,推送会跳过它。"
					}
					onCancel={() => {
						setDeleteError(null);
						setConfirmDelete(null);
					}}
					onConfirm={() => {
						if (confirmDelete.kind === "adapter") {
							delConnection.mutate(confirmDelete.value.id);
						} else {
							delTarget.mutate(confirmDelete.value.id);
						}
					}}
					deleting={delConnection.isPending || delTarget.isPending}
					error={deleteError}
				/>
			) : null}

			{confirmTest ? (
				<TestConfirmModal
					target={confirmTest}
					connection={connectionsById.get(confirmTest.adapterId)}
					onCancel={() => setConfirmTest(null)}
					onConfirm={() => {
						const t = confirmTest;
						setConfirmTest(null);
						void runTargetTest(t);
					}}
				/>
			) : null}

			{toast ? <Toast tone={toast.ok ? "ok" : "err"}>{toast.msg}</Toast> : null}
		</div>
	);
}
