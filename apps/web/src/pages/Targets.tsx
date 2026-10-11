import type {
	ConnectionTestResponse,
	ConnectionView,
	ExtensionBotsResponse,
	ExtensionBotView,
	ExtensionDTO,
	TestResponse,
} from "@bilibili-notify/contract";
// 走零依赖的 /constants 子路径 —— 从包根 import 会把 zod 拖进浏览器 bundle。
import { addressNounFor, platformDescriptor } from "@bilibili-notify/internal/constants";
import {
	AddCard,
	Btn,
	EmptyNote,
	ErrorNote,
	HintNote,
	Icon,
	LoadingBlock,
	ModalShell,
	PlatformIcon,
	SectionNav,
	StatusDot,
	TOAST_DURATION_MS,
	Toast,
	Toggle,
	ToneChip,
	usePlatformLabel,
	usePlatformTint,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { FIELD_ROW_CHROME, Field, Picker, TInput, TNum } from "../components/forms";
import { useConnectionFace } from "../components/platform-meta";
import { QQGuildPicker, QQSessionPicker } from "../components/qq-address-pickers";
import { QQQrBindButton } from "../components/qq-qr-bind";
import { SavedSecretControl } from "../components/secret-cell";
import {
	EXTENSION_BOTS_QUERY_PREFIX,
	extensionBotsKey,
	isExtensionPresent,
	useExtensions,
} from "../hooks/useExtensions";
import { ApiError, api } from "../services/api";
import { issueTextsOf } from "../services/error-text";
import {
	clearedCredentials,
	connectionPatch,
	displayConnection,
	savedMasksOf,
	settingsAreMasked,
} from "../types/connection-credentials";
import {
	type ConnectionField,
	connectionFields,
	extensionConnectionFields,
} from "../types/connection-fields";
import {
	type Connection,
	connectionProbeOf,
	isBuiltinConnection,
	isEndpointConnection,
	KNOWN_PLATFORMS,
	type LinkState,
	makeEmptyConnection,
	makeEmptyExtensionConnection,
	makeEmptyTarget,
	makeExtensionConnectionDraft,
	type NewConnection,
	type OnebotConnectionSettings,
	type PushTarget,
	type PushTargetScope,
	platformOfTarget,
	type QQOfficialConnectionSettings,
	targetReachabilityOf,
	type WebhookConnectionSettings,
} from "../types/domain";
import { copyToClipboard } from "../utils/clipboard";
import { safeImage } from "./extensions/declarative/image";

/**
 * Targets page — two-layer "connection → target" model.
 *
 * **Connection** = one instance of somewhere to send to (a NapCat HTTP
 * endpoint, a QQ official gateway, a webhook URL). Holds baseUrl / token etc.
 *
 * **Target** = a session or a one-way endpoint under a connection, referencing
 * it by `connectionId`. A session target holds the address; an endpoint target
 * is a shell, its address burnt into the connection's config.
 *
 * One connection can drive many targets, so a single NapCat connection only
 * needs its credentials filled once even when pushing to N groups.
 */

const SCOPES: ReadonlyArray<{ value: PushTargetScope; label: string }> = [
	{ value: "group", label: "群组" },
	{ value: "private", label: "私聊" },
	{ value: "channel", label: "频道" },
];

/**
 * 这个平台的目标能选哪几种会话 —— 词表在 {@link PLATFORM_REGISTRY}(OneBot 没有频道概念,
 * 只有群与私聊)。**认不出的平台给全三档**:桥驮进来的平台我们不知道它有没有频道,
 * 少给一档就是让主人配不出一个本来配得出的会话。
 */
function scopesFor(platform: string): ReadonlyArray<{
	value: PushTargetScope;
	label: string;
}> {
	const allowed = platformDescriptor(platform)?.scopes;
	return allowed ? SCOPES.filter((s) => allowed.includes(s.value)) : SCOPES;
}

/**
 * 「会话信息」那一节的小字 —— 说清这一格该填什么。
 *
 * OneBot 与官机各有一句专门的话(QQ 号 / 群号、频道 / 群 / C2C 三档寻址);别的平台
 * 拿注册表里的地址称呼拼一句 —— 认不出的平台也说得出话,而不是留一句空白。
 */
function sessionFieldsHint(
	target: Extract<PushTarget, { kind: "session" }>,
	platform: string | undefined,
): string {
	if (platform === "onebot") {
		return target.scope === "private" ? "私聊目标 QQ 号" : "群聊号(QQ 群号)";
	}
	if (platform === "qq-official") return "QQ 官方机器人会话寻址(频道/群/C2C)";
	return `这个会话的${addressNounFor(platform ?? "", target.scope)}地址`;
}

type TestState = "pending" | "ok" | "fail";

function scopeLabel(s: PushTargetScope): string {
	return SCOPES.find((x) => x.value === s)?.label ?? s;
}

function connectionEndpointSummary(
	a: Pick<NewConnection, "adapterKey" | "settings">,
	platformLabel: (p: string) => string,
): string {
	if (!isBuiltinConnection(a)) {
		// 拓展提供的连接是一个借来的 bot:说清经谁借的。settings 的形状归拓展自己定,这一层
		// 看不懂,也不该看懂。
		return `经 ${platformLabel(a.adapterKey)}`;
	}
	// 适配器没在跑 / 设置不合法:服务端整格遮住了 settings,这里没有地址可报。
	if (settingsAreMasked(a)) return "设置看不了";
	if (a.adapterKey === "onebot") {
		const c = a.settings as OnebotConnectionSettings;
		if (c.transport === "http") return c.baseUrl;
		if (c.transport === "ws") return c.url;
		return `反向 WS :${c.port}`;
	}
	if (a.adapterKey === "qq-official") {
		const c = a.settings as QQOfficialConnectionSettings;
		const domain = c.botType === "private" ? "私域" : "公域";
		const id = c.appId || "未配置 appId";
		return `QQ ${domain} · ${id}${c.sandbox ? " · 沙箱" : ""}`;
	}
	// webhook 那一族:平台名已经写在同一行的前半段(platformLabel),这里只报地址。
	// 地址是凭据:下发的是服务端算好的遮挡串(列表里的连接已经把它换成了那串字),原样显示。
	return (a.settings as WebhookConnectionSettings).url || "未配置地址";
}

/**
 * 一行小字,写这个目标「投到哪」。
 *
 * **先判形态再判平台** —— endpoint 那一支的地址烧在连接里,目标本身没有会话可写;
 * 剩下的会话目标各按自己的平台取地址。以前这里是 onebot / qq-official 两个 if 加一个
 * 兜底 return,兜底那句写死「webhook 终点」:等桥把 telegram 驮进来,新平台会落进
 * 兜底、被标成一个它根本不是的终点,而且**没有编译错也没有测试红**。
 */
function targetSessionSummary(target: PushTarget, platform: string | undefined): string {
	if (target.kind === "endpoint") {
		return target.managedBy === "connection" ? "→ 系统托管 webhook 终点" : "→ webhook 终点";
	}
	// 地址收成一格之后,这里只剩「叫它什么」这一件事 —— 取哪一格由 scope 说了算,
	// 不再是每个平台一套 session 字段名。称呼在注册表里,认不出的平台走通用说法。
	const noun = addressNounFor(platform ?? "", target.scope);
	return target.address ? `→ ${noun} ${target.address}` : `→ 未指定${noun}`;
}

function managedWebhookTargetForConnection(
	connection: Connection,
	targets: readonly PushTarget[],
): PushTarget | undefined {
	if (!isEndpointConnection(connection)) return undefined;
	const owned = targets.filter((t) => t.kind === "endpoint" && t.connectionId === connection.id);
	return owned.find((t) => t.managedBy === "connection") ?? owned[0];
}

// ── Adapter card ────────────────────────────────────────────────────────────

function connectionStatusFor(a: Connection): "ok" | "warn" | "err" | "off" | "pending" {
	return a.enabled ? connectionProbeOf(a).status : "off";
}

function targetStatusFor(t: PushTarget): "ok" | "warn" | "err" | "off" | "pending" {
	return t.enabled ? targetReachabilityOf(t).status : "off";
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
	const platformTint = usePlatformTint();
	// 平台取自目标挂着的连接;连接缺了就是认不出(灰徽标)。
	const platform = platformOfTarget(target, connection ? [connection] : []);
	const tint = platformTint(platform ?? "");
	const connectionMissing = !connection;
	const status = targetStatusFor(target);
	const reachability = targetReachabilityOf(target);

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
					<PlatformIcon platform={platform ?? ""} size={18} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-bn-base font-bold text-bn-text-primary">
						{target.name || "（未命名）"}
					</div>
					<div className="truncate font-mono text-bn-xs text-bn-text-tertiary">
						{targetSessionSummary(target, platform)}
					</div>
				</div>
				<StatusDot kind={status} />
			</div>

			{reachability.status !== "pending" ? (
				<EdgeBadge tone={reachability.status === "ok" ? "success" : "danger"} className="mb-2">
					{reachability.status === "ok"
						? `上次推送 OK${reachability.latencyMs != null ? ` · ${reachability.latencyMs}ms` : ""}`
						: `上次推送失败${reachability.message ? ` — ${reachability.message}` : ""}`}
				</EdgeBadge>
			) : null}

			<div className="flex items-center justify-between text-bn-xs text-bn-text-secondary">
				<span className="truncate">
					{scopeLabel(target.kind === "session" ? target.scope : "channel")}
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
						data-tour={reachability.status === "ok" ? undefined : "target-test"}
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
								data-tour={reachability.status === "err" ? "target-config" : undefined}
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

/** 连接弹窗的草稿。编辑时 `base` 是列表里那条(凭据格是遮挡串),`saved` 记着哪些凭据格已配了。 */
interface ConnectionDraft {
	mode: "add" | "edit";
	value: NewConnection;
	base?: NewConnection;
	/** 已存着的凭据格 → 服务端算好的遮挡串,按字段 code 索引。 */
	saved: Record<string, string>;
	/** 点了「换一份」的凭据格(按字段 code)。 */
	replacing: Record<string, boolean>;
}

interface ConnectionEditorProps {
	mode: "add" | "edit";
	value: NewConnection;
	saved: Record<string, string>;
	replacing: Record<string, boolean>;
	onReplacingChange: (code: string, on: boolean) => void;
	/**
	 * 开推送源那一口的拓展(停着的 v2 也在,见 {@link PushExtension})—— 在场的是平台那一排的
	 * 后几档;名字与连接配置项照它们交的画,停着也画。
	 */
	extensions: readonly PushExtension[];
	onChange: (next: NewConnection) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
}

function ConnectionEditorModal({
	mode,
	value,
	saved,
	replacing,
	onReplacingChange,
	extensions,
	onChange,
	onSave,
	onCancel,
	saving,
	error,
}: ConnectionEditorProps) {
	const platformTint = usePlatformTint();
	const face = useConnectionFace();
	const builtin = isBuiltinConnection(value);
	const extension = builtin ? undefined : extensions.find((ext) => ext.id === value.adapterKey);
	// 整格是遮挡的(适配器没在跑 / 设置不合法)没有表单可画,名字与开关照常能改。
	const masked = settingsAreMasked(value);
	const fields = editorFields(value, extension);
	// 必填的空着也不许存 —— 拓展的字段表里标了 required 的尤其。
	const requiredMissing = fields.find(
		(f): f is Extract<ConnectionField, { kind: "text" }> =>
			f.kind === "text" &&
			f.required === true &&
			f.value.trim().length === 0 &&
			// 已存着的凭据格草稿里是空的(没点「换一份」时存着的那份就是它的值;点了之后留空 = 清空,
			// 是主人明确要的,服务端校验不过会原样说出来)。
			saved[f.code] === undefined,
	);
	// 拓展连接就是一个 bot(ADR-0012 决策 45):没挑 bot 的连接没有平台,存不了。
	const botMissing = !builtin && value.platform === "";
	const valid = value.name.trim().length > 0 && !requiredMissing && !botMissing;
	// 保存钮灰着时说清楚为什么 —— 扫码回填流程尤其容易只剩名称没填。
	const invalidHint = botMissing
		? "先挑一个 bot"
		: value.name.trim().length === 0
			? "请先填写显示名称"
			: requiredMissing
				? `请先填写${requiredMissing.label}`
				: undefined;
	const tint = platformTint(face(value));
	return (
		<ModalShell onCancel={onCancel} width={500} title={mode === "add" ? "新建连接" : "配置连接"}>
			{/* data-tour:弹窗打开后导览聚光灯从「+ 新建」转移到这张表单上 */}
			<div data-tour="connection-form" className="space-y-2.5">
				<SectionBox title="基本" subtitle="一个连接实例可被多个推送目标共享" accent={tint}>
					<Field label="平台" code="connection.platform" required>
						<div className="flex flex-wrap gap-1.5">
							{KNOWN_PLATFORMS.map((p) => {
								const active = builtin && value.platform === p.value;
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
							{/*
							 * 跑着的推送源拓展是同一排的后几档 —— 挑了它,底下从它借得到的 bot 里挑一个,
							 * 连接就是那个 bot。这一排**不认得任何具体拓展**:名字来自它报的外观。
							 */}
							{extensions.filter(isExtensionPresent).map((ext) => {
								const active = !builtin && value.adapterKey === ext.id;
								const eTint = platformTint(ext.id);
								return (
									<ToneChip
										key={ext.id}
										tone={eTint}
										active={active}
										onClick={() => {
											if (active) return;
											onChange(makeExtensionConnectionDraft(ext.id, value.name));
										}}
									>
										<PlatformIcon platform={ext.id} size={13} />
										{ext.push.display.label}
									</ToneChip>
								);
							})}
						</div>
					</Field>
					<Field label="显示名称" code="connection.name" required>
						<TInput
							value={value.name}
							onChange={(v) => onChange({ ...value, name: v })}
							placeholder="如：NapCat 主连接"
						/>
					</Field>
					<Field label="启用" code="connection.enabled">
						<Toggle value={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
					</Field>
				</SectionBox>

				{!builtin ? (
					<SectionBox
						title="哪个 bot"
						subtitle={`经 ${extension?.push.display.label ?? value.adapterKey} 借来的,连接就是它`}
						accent={tint}
					>
						{extension && isExtensionPresent(extension) ? (
							<ExtensionBotPicker
								extension={extension}
								value={value}
								onChange={onChange}
								editing={mode === "edit"}
							/>
						) : (
							<HintNote>这个拓展现在没跑起来,问不到它有哪些 bot —— 先去拓展页把它开起来。</HintNote>
						)}
					</SectionBox>
				) : null}

				{/* 拓展的字段表可以是空的(桥):连接是挑出来的,没有一栏是人填的,那一节就不画。 */}
				{!builtin && (extension?.push.connectionFields.length ?? 0) === 0 ? null : (
					<SectionBox
						title="连接参数"
						subtitle={
							!builtin
								? `${extension?.push.display.label ?? value.adapterKey} 的接入参数`
								: value.platform === "onebot"
									? "OneBot v11 连接信息"
									: value.platform === "qq-official"
										? "QQ 官方机器人凭据(q.qq.com)"
										: "Webhook 投递终点"
						}
						accent={tint}
					>
						{masked ? (
							<HintNote>
								这条连接的设置现在看不了(适配器没在跑 / 设置不合法),名字与开关照常能改。
							</HintNote>
						) : (
							<ConnectionConfigFields
								fields={fields}
								connection={value}
								saved={saved}
								replacing={replacing}
								onReplacingChange={onReplacingChange}
								onChange={onChange}
							/>
						)}
					</SectionBox>
				)}
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

/**
 * 「一排里挑一个」的那种候选行:左边一枚脸、中间两行字、右边一句状态,选中的那条按平台
 * 标识色染。这一页有三处(选连接 / 挑 bot / 现在绑着的那一条),此前各写各的。
 *
 * 🔴 **底与边只经 `--bn-tint` 一个 CSS 变量进来**,涂法在 `bn-tint-row` 那条 @utility 里 ——
 * 选中态曾经只买到一半:两样都写在 `style` 里,而 inline 压过一切 author 样式,挂着
 * `option-active` 也白挂,皮肤一个都盖不动。别把颜色搬回 `style`。
 *
 * `as="div"` 是那条「现在绑着的那个」—— 它不可点(名单里根本没有它),按钮语义会让读屏器
 * 报一颗按不动的钮。
 */
function TintOptionRow({
	tint,
	active,
	disabled,
	icon,
	title,
	subtitle,
	trailing,
	onClick,
	as = "button",
}: {
	/** 平台标识色 —— 走 `--bn-tint`,`bn-tint-row` 拿它算底与边。 */
	tint: string;
	active: boolean;
	disabled?: boolean;
	icon: ReactNode;
	title: ReactNode;
	subtitle: ReactNode;
	/** 行尾那句话(「已选」/「已加过」/「换平台要重建连接」)。 */
	trailing?: ReactNode;
	onClick?: () => void;
	as?: "button" | "div";
}) {
	const className = `flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition ${
		active ? "bn-tint-row" : "border-bn-border bg-bn-surface"
	} ${disabled ? "cursor-not-allowed opacity-50" : ""}`;
	const style = { "--bn-tint": tint } as CSSProperties;
	const body = (
		<>
			{icon}
			<div className="min-w-0 flex-1">
				<div className="truncate text-bn-sm font-semibold text-bn-text-primary">{title}</div>
				<div className="truncate font-mono text-bn-2xs text-bn-text-tertiary">{subtitle}</div>
			</div>
			{trailing}
		</>
	);
	// 候选行走 option;选中那档再加 option-active(与 ui 库的 OptionCard 同一种东西)。
	const hook = active ? "option option-active" : "option";
	if (as === "div") {
		return (
			<div data-bn={hook} className={className} style={style}>
				{body}
			</div>
		);
	}
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			data-bn={hook}
			className={className}
			style={style}
		>
			{body}
		</button>
	);
}

/**
 * 「挑哪个 bot」那一节 —— 拓展连接就是一个 bot(ADR-0012 决策 45)。
 *
 * bot 只有拓展知道(桥后面挂着什么是握手时才知道的),经 `/api/ext/:id/bots` 交上来;
 * 这里**不认得任何具体拓展**,列什么就画什么。挑中的那个:它的 `config` 原样落进连接、
 * `platform` 落进连接的平台、名字补进空着的显示名。
 *
 * 三种「没得挑」要分开说:问不到(拓展没跑起来)、名单空(桥没连上)、都被加过了。
 * 已经绑成别的连接的 bot 标出来、不给点 —— 同一个 bot 建两条连接只会让目标各推一遍。
 */
function ExtensionBotPicker({
	extension,
	value,
	onChange,
	editing,
}: {
	extension: PushExtension;
	value: NewConnection;
	onChange: (next: NewConnection) => void;
	/** 改连接时名单里可能没有它现在绑的那个(桥没连着)—— 那一行要照画,别让它像没绑过。 */
	editing: boolean;
}) {
	const platformTint = usePlatformTint();
	const bots = useQuery({
		queryKey: extensionBotsKey(extension.id),
		queryFn: () => api.get<ExtensionBotsResponse>(`/api/ext/${extension.id}/bots`),
		retry: false,
	});
	const list = bots.data?.bots ?? [];
	const chosen = JSON.stringify(value.settings ?? null);
	const isChosen = (bot: ExtensionBotView) => JSON.stringify(bot.config) === chosen;
	const currentListed = list.some(isChosen);

	if (bots.isPending) return <LoadingBlock variant="inset" label="正在问它有哪些 bot" />;
	if (bots.isError) {
		return <HintNote>这个拓展现在没跑起来,问不到它有哪些 bot —— 先去拓展页把它开起来。</HintNote>;
	}
	if (list.length === 0 && !(editing && value.platform)) {
		return (
			<EmptyNote size="sm">
				现在一个 bot 都没有 —— 去拓展页把桥接上、让它报了名单,这里才有得挑。
			</EmptyNote>
		);
	}
	return (
		<div className="space-y-1.5">
			{editing && value.platform && !currentListed ? (
				<TintOptionRow
					as="div"
					active
					tint={platformTint(value.platform)}
					icon={<PlatformIcon platform={value.platform} size={16} />}
					title="现在绑着的那个"
					subtitle={`${value.platform} · 它这会儿不在线,名单里没有它`}
				/>
			) : null}
			{list.map((bot) => {
				const active = isChosen(bot);
				const taken = bot.boundTo !== undefined && bot.boundTo !== value.id;
				/*
				 * 🔴 **改连接时不许换平台。** 连接的平台就是底下那些推送目标的平台,而目标
				 * 不会跟着改 —— 换过去之后它们原地变成「telegram 的地址挂在 onebot 连接上」。
				 * 服务端那头会拒,面板这头却一路绿灯(类型、渲染、保存全绿),主人只看到
				 * 一句莫名其妙的失败。要换到别的平台去,那是**另一条连接**。
				 */
				const wrongPlatform = editing && value.platform !== "" && bot.platform !== value.platform;
				const botTint = platformTint(bot.platform);
				/*
				 * 图标是拓展交来的(桥那头是插件报的),画之前过面板出口那道闸 —— 与声明式积木同一份判据
				 * (ADR-0019 决策 31):只收图片 data URL。一个 `https://` 地址当 `<img src>` 画,面板一开
				 * 就去对家点名;不合格的当它没有,退回平台图标。
				 */
				const botIcon = safeImage(bot.icon);
				return (
					<TintOptionRow
						// config 才是它的身份(拓展自己定的),名单里没有别的稳定键。
						key={JSON.stringify(bot.config)}
						tint={botTint}
						active={active}
						disabled={taken || wrongPlatform}
						onClick={() => {
							if (active) return;
							onChange({
								...makeEmptyExtensionConnection(extension.id, bot, value.name),
								id: value.id,
								enabled: value.enabled,
							});
						}}
						icon={
							botIcon ? (
								<img src={botIcon} alt="" draggable={false} className="size-4 shrink-0" />
							) : (
								<PlatformIcon platform={bot.platform} size={16} />
							)
						}
						title={bot.name ?? bot.selfId ?? bot.platform}
						subtitle={[bot.platform, bot.selfId, bot.via ? `经 ${bot.via}` : undefined]
							.filter(Boolean)
							.join(" · ")}
						trailing={
							active ? (
								<span className="text-bn-xs font-bold" style={{ color: botTint }}>
									已选
								</span>
							) : taken ? (
								<span className="text-bn-xs text-bn-text-tertiary">已加过</span>
							) : wrongPlatform ? (
								// 说清是「不能这么换」,不是「这个 bot 坏了」—— 出路在另一条连接上。
								<span className="shrink-0 text-bn-xs text-bn-text-tertiary">换平台要重建连接</span>
							) : null
						}
					/>
				);
			})}
		</div>
	);
}

/**
 * 开推送源那一口、交了 `push` 的拓展。`push` 里外观与连接配置项一起交、一起有,缺一不可:
 * 少外观没名字,少连接配置项画不出表单。
 *
 * ⚠️ **有 `push` 不等于它在场**(ADR-0019 决策 41):v2 的这一格照清单给,停着也有 —— 名字、
 * 连接配置项照它画;要它在场的(新建它的连接、挑 bot)另看 {@link isExtensionPresent} —— 连接就是
 * 一个 bot(ADR-0012 决策 45),而 bot 名单只有跑着的拓展交得出来,停着也给新建那一档的话,点进去
 * 一个 bot 都挑不了、存不了。
 */
type PushExtension = ExtensionDTO & { push: NonNullable<ExtensionDTO["push"]> };

function pushExtensionsOf(extensions: readonly ExtensionDTO[]): PushExtension[] {
	return extensions.filter(
		(ext): ext is PushExtension => (ext.provides ?? []).includes("push") && ext.push !== undefined,
	);
}

/**
 * 借来这条连接的拓展此刻不在场 —— 回它的名字;在场的、不是拓展连接的、拓展列表还没回来的都是
 * `undefined`。
 *
 * 外观照清单画之后(ADR-0019 决策 41),停着的拓展借来的连接**看上去与好好的一模一样**,可平台
 * 适配器已经随拓展撤了,推送走到它发不出去 —— 只在「配置」里挑 bot 那一节才看得出来的话,就是
 * 「界面正常、推送不来」那一类最难查的。所以左栏与详情头当场说。
 *
 * 🔴 拓展列表没回来(还在读 / 读失败)时**不下结论**:那一刻什么都不知道,说「没在跑」是冤枉它。
 */
function absentExtensionOf(
	connection: Pick<NewConnection, "adapterKey">,
	extensions: readonly ExtensionDTO[] | undefined,
): string | undefined {
	if (isBuiltinConnection(connection) || extensions === undefined) return undefined;
	const ext = extensions.find((one) => one.id === connection.adapterKey);
	if (ext && isExtensionPresent(ext)) return undefined;
	return ext?.push?.display.label ?? ext?.name ?? connection.adapterKey;
}

/** 这条连接在表单上的那几栏:内置平台走注册好的字段函数,拓展连接照它的连接配置项翻。 */
function editorFields(
	connection: NewConnection,
	extension: PushExtension | undefined,
): ConnectionField[] {
	// 整格是遮挡的没有表单可画,也不许往里加键(见 connection-credentials.ts)。
	if (settingsAreMasked(connection)) return [];
	if (!isBuiltinConnection(connection)) {
		return extension ? extensionConnectionFields(connection, extension.push.connectionFields) : [];
	}
	return connectionFields(connection);
}

function ConnectionConfigFields({
	fields,
	connection,
	saved,
	replacing,
	onReplacingChange,
	onChange,
}: {
	fields: ConnectionField[];
	connection: NewConnection;
	saved: Record<string, string>;
	replacing: Record<string, boolean>;
	onReplacingChange: (code: string, on: boolean) => void;
	onChange: (next: NewConnection) => void;
}) {
	const platformTint = usePlatformTint();
	const face = useConnectionFace();
	return (
		<>
			{fields.map((field) => {
				if (field.kind === "ws-reverse-address") {
					return <ReverseWsAddressRow key="ws-reverse-address" port={field.port} />;
				}
				if (field.kind === "qq-bind") {
					return (
						/* 行框吃 Field 的 FIELD_ROW_CHROME —— 扫码行要与底下的字段行排同一栏,
						   此前逐字符手抄,行距一漂两种行就对不齐。 */
						<div key="qq-bind" className={`flex flex-wrap items-center gap-3 ${FIELD_ROW_CHROME}`}>
							<QQQrBindButton
								adapterKey={field.adapterKey}
								onCredentials={(creds) => {
									onChange(field.apply(creds));
									// 扫出来的新凭据是「换了一份」:已存着的 appSecret 不能还画成胶囊盖住它。
									if (saved["settings.appSecret"] !== undefined) {
										onReplacingChange("settings.appSecret", true);
									}
								}}
							/>
							<span className="text-bn-xs text-bn-text-secondary">
								没有机器人?扫码在腾讯页面一键创建,凭据自动回填下方两栏
							</span>
						</div>
					);
				}
				return (
					<Field
						key={field.code}
						label={field.label}
						code={field.code}
						hint={field.hint}
						required={field.required}
					>
						<ConnectionFieldControl
							field={field}
							tint={platformTint(face(connection))}
							savedMask={saved[field.code]}
							replacing={replacing[field.code] === true}
							onReplacingChange={(on) => onReplacingChange(field.code, on)}
							onChange={onChange}
						/>
					</Field>
				);
			})}
		</>
	);
}

/**
 * 反向 WS:把 bot 该连的那条地址印出来(issue #49)。
 *
 * 🔴 **主机名按浏览器地址栏现算,端口取这一栏填的那个** —— 不是主端口。服务端算不了这件事,
 * 它只知道自己绑在哪个口上,不知道别人从哪儿访问得到它(同桥接那条 BN 地址)。
 *
 * 🔴 **路径随便填这句必须写出来**:监听那头 `WebSocketServer({ port })` 不带 `path`,
 * 什么路径都收。不写的话,从 koishi 过来的人会以为这里少了一栏。
 */
function ReverseWsAddressRow({ port }: { port: number }) {
	const [copied, setCopied] = useState(false);
	const address = `ws://${window.location.hostname}:${port}/onebot`;
	return (
		<div
			data-code="settings.reverseAddress"
			className={`flex flex-col gap-1.5 ${FIELD_ROW_CHROME}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-bn-sm font-bold text-bn-text-primary">bot 那头填这个</span>
				<code className="min-w-0 flex-1 truncate rounded-bn-sm bg-bn-surface-muted px-2 py-1 font-mono text-bn-xs text-bn-text-secondary">
					{address}
				</code>
				<Btn
					variant="outline"
					size="sm"
					onClick={() => {
						void copyToClipboard(address).then(setCopied);
					}}
				>
					{copied ? "已复制" : "复制"}
				</Btn>
			</div>
			<span className="text-bn-xs text-bn-text-secondary">
				末尾的<strong>路径随便填</strong>(`/onebot` 只是个例子,不填也行)。这是{" "}
				<strong>bot 那台机器</strong>要访问得到的地址 —— BN 在 NAS / 容器里时别照抄 `127.0.0.1`。
			</span>
		</div>
	);
}

/** 一栏的控件 —— 只认 kind,不认平台。 */
function ConnectionFieldControl({
	field,
	tint,
	savedMask,
	replacing,
	onReplacingChange,
	onChange,
}: {
	field: Exclude<ConnectionField, { kind: "qq-bind" | "ws-reverse-address" }>;
	tint: string;
	/** 这一栏是凭据且已存着时,服务端算好的遮挡串。 */
	savedMask: string | undefined;
	replacing: boolean;
	onReplacingChange: (on: boolean) => void;
	onChange: (next: NewConnection) => void;
}) {
	switch (field.kind) {
		case "text": {
			const input = (
				<TInput
					value={field.value}
					onChange={(v) => onChange(field.set(v))}
					placeholder={field.placeholder}
					mono={field.mono}
					secret={field.secret}
				/>
			);
			if (!field.credential) return input;
			return (
				<SavedSecretControl
					savedMask={savedMask}
					replacing={replacing}
					onReplace={() => onReplacingChange(true)}
					onCancelReplace={() => {
						// 不换了:草稿里这格清回空(已存着的那份仍在服务端),保存时不进 PATCH。
						onChange(field.set(""));
						onReplacingChange(false);
					}}
				>
					{input}
				</SavedSecretControl>
			);
		}
		case "number":
			return (
				<TNum
					value={field.value}
					onChange={(v) => onChange(field.set(v))}
					min={field.min}
					max={field.max}
					step={field.step}
					suffix={field.suffix}
					width={field.width}
				/>
			);
		case "toggle":
			return <Toggle value={field.value} onChange={(v) => onChange(field.set(v))} />;
		case "select":
			return (
				<Picker
					value={field.value}
					onChange={(v) => onChange(field.set(v))}
					// Picker 的 options 收可变数组;字段表交出来的是只读的,拷一份给它。
					options={[...field.options]}
				/>
			);
		case "chips":
			return (
				<div className="flex flex-wrap gap-1.5">
					{field.options.map((o) => (
						<ToneChip
							key={o.value}
							tone={tint}
							active={field.value === o.value}
							onClick={() => onChange(field.set(o.value))}
						>
							{o.label}
						</ToneChip>
					))}
				</div>
			);
		case "headers":
			return <HeadersEditor value={field.value} onChange={(next) => onChange(field.set(next))} />;
	}
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
	const platformTint = usePlatformTint();
	const platformLabel = usePlatformLabel();
	const face = useConnectionFace();
	const connection = connections.find((a) => a.id === value.connectionId);
	const valid = value.name.trim().length > 0 && Boolean(value.connectionId);
	// 平台取自目标挂着的连接,不读草稿自己那一格。
	const platform = platformOfTarget(value, connections);
	const tint = platformTint(platform || (connection ? face(connection) : ""));
	// Webhook target 由 adapter 自动托管，不能从手动 target 弹窗创建 / 改挂。
	const eligibleConnections = connections.filter((a) => !isEndpointConnection(a));
	return (
		<ModalShell
			onCancel={onCancel}
			width={500}
			title={mode === "add" ? "新建推送目标" : "配置推送目标"}
		>
			{/* data-tour:弹窗打开后导览聚光灯从「+ 新建」转移到这张表单上 */}
			<div data-tour="target-form" className="space-y-2.5">
				<SectionBox
					title={mode === "edit" ? "所属连接" : "选择连接"}
					subtitle={
						mode === "edit"
							? "目标建好之后不能换连接；要推到别的连接上请新建一个目标"
							: "目标的平台跟随连接;baseUrl / accessToken 这些参数在连接上维护"
					}
					accent={tint}
				>
					{mode === "edit" ? (
						connection ? (
							<TintOptionRow
								as="div"
								tint={platformTint(face(connection))}
								active
								icon={<PlatformIcon platform={face(connection)} size={16} />}
								title={connection.name}
								subtitle={
									<>
										{platformLabel(face(connection))} ·{" "}
										{connectionEndpointSummary(connection, platformLabel)}
									</>
								}
							/>
						) : (
							<EmptyNote size="sm">连接缺失</EmptyNote>
						)
					) : eligibleConnections.length === 0 ? (
						<EmptyNote size="sm">
							尚未配置任何可手动绑定的连接 · Webhook 目标由系统自动托管
						</EmptyNote>
					) : (
						<div className="space-y-1.5">
							{eligibleConnections.map((a) => {
								const active = value.connectionId === a.id;
								const aTint = platformTint(face(a));
								return (
									<TintOptionRow
										key={a.id}
										tint={aTint}
										active={active}
										onClick={() => {
											const next = makeEmptyTarget(a, value.name);
											// preserve user-typed identity if any
											onChange({ ...next, id: value.id, enabled: value.enabled });
										}}
										icon={<PlatformIcon platform={face(a)} size={16} />}
										title={a.name}
										subtitle={
											<>
												{platformLabel(face(a))} · {connectionEndpointSummary(a, platformLabel)}
											</>
										}
										trailing={
											active ? (
												<span className="text-bn-xs font-bold" style={{ color: aTint }}>
													已选
												</span>
											) : null
										}
									/>
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
							{scopesFor(platform ?? "").map((s) => {
								const active = (value.kind === "session" ? value.scope : "channel") === s.value;
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

				{/*
				 * 判据是**形态**不是平台名:会话目标要填地址,单向终点的地址烧在连接里。
				 * 原先这里写死「onebot 或官机」,桥把 telegram 驮进来时那个会话目标会连
				 * 地址栏都没有 —— 保存得下、发不出去,而且没有编译错。
				 */}
				{value.kind === "session" ? (
					<SectionBox title="会话信息" subtitle={sessionFieldsHint(value, platform)} accent={tint}>
						<TargetSessionFields target={value} platform={platform} onChange={onChange} />
					</SectionBox>
				) : null}
			</div>

			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}

			<div className="mt-4 flex items-center justify-end gap-2">
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
	platform,
	onChange,
}: {
	target: PushTarget;
	/** 目标的平台,取自它挂着的连接;连接不在是 `undefined`,走通用那一支。 */
	platform: string | undefined;
	onChange: (next: PushTarget) => void;
}) {
	if (target.kind !== "session") return null;
	const setAddress = (address: string) => onChange({ ...target, address });

	if (platform === "onebot") {
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
	if (platform === "qq-official") {
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
						connectionId={target.connectionId}
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
					connectionId={target.connectionId}
					scope={isPrivate ? "private" : "group"}
					onPick={setAddress}
				/>
			</>
		);
	}
	// 认不出的平台(桥驮进来的)。地址收成一格之后通用的一格输入就够了 —— 叫什么由
	// 注册表说,不认识就走通用称呼。这里以前是 `return null`:那种目标连地址栏都没有。
	const noun = addressNounFor(platform ?? "", target.scope);
	return (
		<Field label={`${noun}地址`} code="target.address" required>
			<TInput value={target.address} onChange={setAddress} placeholder={`${noun}的 id`} mono />
		</Field>
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
	subjectKind: "connection" | "target";
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
			title={subjectKind === "connection" ? "删除连接" : "删除推送目标"}
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
	absentOf,
}: {
	connections: Connection[];
	selectedId: string | null;
	onPick: (id: string) => void;
	onAddClick: () => void;
	targetCountByConnection: Map<string, number>;
	/** 借来这条连接的拓展不在场时回它的名字,见 {@link absentExtensionOf}。 */
	absentOf: (connection: Connection) => string | undefined;
}) {
	const platformTint = usePlatformTint();
	const platformLabel = usePlatformLabel();
	const face = useConnectionFace();
	return (
		<SectionNav
			heading="推送连接"
			activeId={selectedId}
			onPick={onPick}
			onAdd={onAddClick}
			addLabel="+ 新建"
			// data-tour:导览「新建连接」的常驻灯位(控件级 —— 只框按钮本体)
			addButtonProps={{ "data-tour": "connection-add" }}
			// 不带底色 —— 虚线家族统一成 Subs「添加 UP 主」那样只有虚线框(2026-08-30 主人定案)
			emptyState={<EmptyNote size="sm">尚未配置任何连接</EmptyNote>}
			items={connections.map((a) => {
				const count = targetCountByConnection.get(a.id) ?? 0;
				return {
					id: a.id,
					label: a.name || "（未命名）",
					desc: `${platformLabel(face(a))} · ${isEndpointConnection(a) ? "单向投递" : `${count} 个目标`}`,
					// 选中那格喂 currentColor —— 标识色是中等亮度,摆在皮肤画的实心块上会撞
					// (QQ官方 #14b8a6 对主人那块粉只有 1.24:1)。平台名在副标题里写着,不丢。
					icon: (
						<PlatformIcon
							platform={face(a)}
							size={12}
							tone={a.id === selectedId ? "currentColor" : undefined}
						/>
					),
					iconTint: platformTint(face(a)),
					// **不写死前景色** —— 它落在左栏选中项内部,而那一项的底由皮肤说了算
					// (见 SectionNav 的 RAIL_ITEM_ACTIVE)。tertiary 这一档假设底是页面色,
					// 皮肤把选中项画成实心块之后它就糊在上面了。弱化改由字号 + 字重扛,
					// 和同一张卡上的副标题同一个办法。
					// 停用的先说停用(主人自己拨的,也本来就发不出去);开着而借它的拓展不在场,说那一句 ——
					// 副标题只有一行、会截断,整句放不下,详情头里说全。
					badge: !a.enabled ? (
						<span className="shrink-0 text-bn-2xs font-normal">(停用)</span>
					) : absentOf(a) !== undefined ? (
						<span className="shrink-0 text-bn-2xs font-normal">(拓展没在跑)</span>
					) : undefined,
				};
			})}
		/>
	);
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Targets() {
	const qc = useQueryClient();
	const platformTint = usePlatformTint();
	const platformLabel = usePlatformLabel();
	const face = useConnectionFace();

	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<ConnectionView[]>("/api/connections"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	// 开推送源那一口的拓展:在场的是「新建连接」那一排的后几档,停着的 v2 名字与连接配置项照清单
	// 也在(决策 41)。与拓展页共用同一张表。
	const extensionsQuery = useExtensions({ retry: false });
	const pushExtensions = pushExtensionsOf(extensionsQuery.data?.extensions ?? []);

	const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
	const [targetDraft, setTargetDraft] = useState<{
		mode: "add" | "edit";
		value: PushTarget;
	} | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<
		{ kind: "connection"; value: Connection } | { kind: "target"; value: PushTarget } | null
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

	// 凭据格下发时是遮挡:列表与表单用的是把遮挡换成那串字的 `Connection`(只用来显示,从不写回)。
	const connections = (connectionsQuery.data ?? []).map(displayConnection);
	const targets = targetsQuery.data ?? [];
	const connectionsById = new Map(connections.map((a) => [a.id, a]));
	const targetCountByConnection = new Map<string, number>();
	for (const t of targets) {
		targetCountByConnection.set(
			t.connectionId,
			(targetCountByConnection.get(t.connectionId) ?? 0) + 1,
		);
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
		? targets.filter((t) => t.connectionId === selectedConnection.id)
		: [];
	const selectedManagedWebhookTarget = selectedConnection
		? managedWebhookTargetForConnection(selectedConnection, targets)
		: undefined;

	const showToast = (msg: string, ok = true): void => {
		setToast({ msg, ok });
		if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
	};

	/**
	 * 新建 POST、编辑 PATCH(`POST` 只管新建,整条覆盖分不开「没带这格」与「清空这格」)。编辑时没动过的
	 * 凭据格不进 PATCH,见 `connectionPatch`。编辑中途换了平台(新 id)就是新建。
	 */
	const saveConnection = useMutation({
		mutationFn: async (d: ConnectionDraft) => {
			setError(null);
			try {
				if (d.mode === "edit" && d.base !== undefined && d.base.id === d.value.id) {
					await api.patch(
						`/api/connections/${d.value.id}`,
						connectionPatch(d.value, d.base, d.saved, d.replacing),
					);
				} else {
					await api.post("/api/connections", d.value);
				}
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["connections"] });
			qc.invalidateQueries({ queryKey: ["targets"] });
			// 🔴 bot 名单里的 `boundTo` 跟着连接走,而那条查询有 5 秒 staleTime:不作废它的话,
			// 5 秒内再开一次弹窗读到的还是旧名单 —— 刚绑走的那个仍然「挑得动」,于是同一个
			// bot 建出两条连接,每条推一遍。整个前缀一起失效:哪个拓展的名单变了这里说不准。
			qc.invalidateQueries({ queryKey: EXTENSION_BOTS_QUERY_PREFIX });
			showToast(connectionDraft?.base === undefined ? "已新建连接" : "连接已保存");
			setConnectionDraft(null);
		},
	});

	const delConnection = useMutation({
		mutationFn: async (id: string) => {
			setDeleteError(null);
			try {
				await api.delete(`/api/connections/${id}`);
			} catch (err) {
				const msg = err instanceof ApiError ? err.message : String(err);
				setDeleteError(msg);
				throw err;
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["connections"] });
			qc.invalidateQueries({ queryKey: ["targets"] });
			// 删掉一条,它绑着的那个 bot 该重新挑得动 —— 同上,名单得当场作废。
			qc.invalidateQueries({ queryKey: EXTENSION_BOTS_QUERY_PREFIX });
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
		if (isEndpointConnection(a)) {
			const target = managedWebhookTargetForConnection(a, targets);
			if (!target) {
				showToast("请先保存 Webhook，系统会自动创建默认投递目标", false);
				return;
			}
			setTesting((p) => ({ ...p, [a.id]: "pending" }));
			setTargetTesting((p) => ({ ...p, [target.id]: "pending" }));
			try {
				const res = await api.post<TestResponse>(`/api/targets/${target.id}/test`, {
					kind: "text",
				});
				setTesting((p) => ({ ...p, [a.id]: res.ok ? "ok" : "fail" }));
				setTargetTesting((p) => ({ ...p, [target.id]: res.ok ? "ok" : "fail" }));
				showToast(res.ok ? `已送达 · ${res.latencyMs}ms` : `失败:${res.message}`, res.ok);
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
			const res = await api.post<ConnectionTestResponse>(`/api/connections/${a.id}/probe`, {});
			// 这个平台没有探测协议(如 webhook):既不是通、也不是不通 —— 清掉进行中的状态,只提示一句。
			if (!res.ok && res.code === "unsupported") {
				setTesting((p) => {
					const next = { ...p };
					delete next[a.id];
					return next;
				});
				showToast(res.message, false);
				return;
			}
			setTesting((p) => ({ ...p, [a.id]: res.ok ? "ok" : "fail" }));
			showToast(res.ok ? `连通 · ${res.latencyMs}ms` : `失败:${res.message}`, res.ok);
			qc.invalidateQueries({ queryKey: ["connections"] });
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
			const res = await api.post<TestResponse>(`/api/targets/${t.id}/test`, {
				kind: "text",
			});
			setTargetTesting((p) => ({ ...p, [t.id]: res.ok ? "ok" : "fail" }));
			showToast(res.ok ? `已送达 · ${res.latencyMs}ms` : `失败:${res.message}`, res.ok);
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
			value: makeEmptyConnection("onebot", ""),
			saved: {},
			replacing: {},
		});
	}

	function startEditConnection(a: Connection): void {
		setError(null);
		setConnectionDraft({
			mode: "edit",
			value: clearedCredentials(a),
			base: a,
			saved: savedMasksOf(a),
			replacing: {},
		});
	}

	function startNewTarget(connection?: Connection): void {
		setError(null);
		const a = connection ?? selectedConnection ?? connections[0];
		if (!a) {
			showToast("请先新建一个连接", false);
			return;
		}
		if (isEndpointConnection(a)) {
			showToast("Webhook 目标由系统自动托管，无需手动新建", false);
			return;
		}
		setTargetDraft({ mode: "add", value: makeEmptyTarget(a, "") });
	}

	function startEditTarget(t: PushTarget): void {
		setError(null);
		if (t.kind === "endpoint" && t.managedBy === "connection") {
			showToast("Webhook 目标由系统自动托管，请在连接里修改 URL", false);
			return;
		}
		setTargetDraft({ mode: "edit", value: t });
	}

	const selectedConnectionStatus =
		selectedConnection && isEndpointConnection(selectedConnection) && selectedManagedWebhookTarget
			? targetStatusFor(selectedManagedWebhookTarget)
			: selectedConnection
				? connectionStatusFor(selectedConnection)
				: "pending";
	// webhook 一族的连接头上说的是它那张托管目标的通断,别的说连接自己的探测。
	const selectedConnectionLink: LinkState =
		selectedConnection && isEndpointConnection(selectedConnection)
			? targetReachabilityOf(selectedManagedWebhookTarget ?? {})
			: selectedConnection
				? connectionProbeOf(selectedConnection)
				: { status: "pending" };
	/** 拓展列表(`extensionsQuery`)没回来时是 `undefined` —— 那时不下「没在跑」的结论。 */
	const absentOf = (connection: Connection) =>
		absentExtensionOf(connection, extensionsQuery.data?.extensions);
	const selectedAbsent = selectedConnection ? absentOf(selectedConnection) : undefined;

	const isLoading = connectionsQuery.isLoading || targetsQuery.isLoading;

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-bn-rail">
				{/* ConnectionRail 直接坐在 grid 上,中间不许夹盒子 —— SectionNav 的根在 xl 以下是
				    `display:contents`,包一层 div 就把它的包含块缩成矮格子,sticky 失去吸附
				    行程(见 packages/ui/src/section-nav.tsx 的同段注释)。导览挂点(connection-add)
				    在内部「+ 新建」按钮本体上,不需要外层盒子 —— 曾框整栏:洞大到点空态占位
				    也算「点过了」,灯白白退散(真机踩过)。 */}
				<ConnectionRail
					connections={connections}
					selectedId={selectedConnectionId}
					onPick={setSelectedConnectionId}
					onAddClick={startNewConnection}
					targetCountByConnection={targetCountByConnection}
					absentOf={absentOf}
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
							<Btn
								data-tour="connection-add"
								variant="primary"
								size="sm"
								onClick={startNewConnection}
							>
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
											background: `color-mix(in srgb, ${platformTint(face(selectedConnection))} 12%, transparent)`,
										}}
									>
										<PlatformIcon platform={face(selectedConnection)} size={22} />
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
											{platformLabel(face(selectedConnection))} ·{" "}
											{connectionEndpointSummary(selectedConnection, platformLabel)}
										</div>
										{selectedAbsent !== undefined ? (
											<div className="mt-0.5 text-bn-xs text-bn-text-tertiary">
												{selectedAbsent}没在跑 —— 这条连接现在发不出去,先去拓展页把它开起来。
											</div>
										) : null}
										{selectedConnection.settingsIssues?.[0] ? (
											<div
												className="mt-0.5 text-bn-xs"
												style={{ color: "var(--color-bn-danger-text)" }}
											>
												设置不合法：{issueTextsOf({ issues: selectedConnection.settingsIssues })[0]}
											</div>
										) : null}
										{selectedConnection.probeState?.status === "unsupported" ? (
											<div className="mt-0.5 text-bn-xs text-bn-text-tertiary">
												这种连接没有探测办法
											</div>
										) : null}
										{selectedConnectionLink.status !== "pending" ? (
											<EdgeBadge
												tone={selectedConnectionLink.status === "ok" ? "success" : "warning"}
												size="xs"
												className="mt-2 inline-block"
											>
												{selectedConnectionLink.status === "ok"
													? `上次测试 OK${
															selectedConnectionLink.latencyMs != null
																? ` · ${selectedConnectionLink.latencyMs}ms`
																: ""
														}`
													: `上次测试失败${
															selectedConnectionLink.message
																? ` — ${selectedConnectionLink.message}`
																: ""
														}`}
											</EdgeBadge>
										) : null}
									</div>
									<div className="flex shrink-0 gap-1">
										{/* 导览「测试连通性」一步的控件级灯位 */}
										<Btn
											data-tour="connection-test"
											size="sm"
											variant="ghost"
											onClick={() => testConnection(selectedConnection)}
											disabled={testing[selectedConnection.id] === "pending"}
										>
											{testing[selectedConnection.id] === "pending"
												? isEndpointConnection(selectedConnection)
													? "发送中…"
													: "测试中…"
												: testing[selectedConnection.id] === "ok"
													? isEndpointConnection(selectedConnection)
														? "已送达"
														: "已连通"
													: testing[selectedConnection.id] === "fail"
														? "失败"
														: isEndpointConnection(selectedConnection)
															? "发送测试"
															: "测试"}
										</Btn>
										<Btn
											// 导览失败链的灯位:测试失败时才亮(同 target-config)
											data-tour={
												connectionProbeOf(selectedConnection).status === "err"
													? "connection-config"
													: undefined
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
												setConfirmDelete({ kind: "connection", value: selectedConnection });
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
											{isEndpointConnection(selectedConnection) ? "Webhook 投递目标" : "推送目标"}
										</div>
										<div className="text-bn-xs text-bn-text-tertiary">
											{isEndpointConnection(selectedConnection)
												? "Webhook 是单向投递终点，保存 URL 后系统会自动创建默认投递目标。"
												: "本连接下的会话:群号 / 用户 ID 等。"}
										</div>
									</div>
									{isEndpointConnection(selectedConnection) ? null : (
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
								{isEndpointConnection(selectedConnection) ? (
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
												connection={connectionsById.get(t.connectionId)}
												onEdit={() => startEditTarget(t)}
												onDelete={() => {
													setDeleteError(null);
													setConfirmDelete({ kind: "target", value: t });
												}}
												onTest={() => testTarget(t)}
												testing={targetTesting[t.id]}
												readOnly={t.managedBy === "connection"}
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
					extensions={pushExtensions}
					saved={connectionDraft.saved}
					replacing={connectionDraft.replacing}
					onReplacingChange={(code, on) =>
						setConnectionDraft({
							...connectionDraft,
							replacing: { ...connectionDraft.replacing, [code]: on },
						})
					}
					onChange={(v) =>
						// 换了平台 = 新 id:上一条连接「已存着」的凭据与它的基线都不作数了。
						setConnectionDraft(
							v.id === connectionDraft.value.id
								? { ...connectionDraft, value: v }
								: { mode: connectionDraft.mode, value: v, saved: {}, replacing: {} },
						)
					}
					onSave={() => saveConnection.mutate(connectionDraft)}
					onCancel={() => {
						setConnectionDraft(null);
						setError(null);
					}}
					saving={saveConnection.isPending}
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
						confirmDelete.kind === "connection"
							? isEndpointConnection(confirmDelete.value)
								? "该 Webhook 的系统托管目标会一并删除，订阅路由中的引用会同步清理。"
								: "连接若仍被推送目标引用,删除会失败。请先删除这些目标。"
							: "该目标在订阅路由中的引用将变成空引用,推送会跳过它。"
					}
					onCancel={() => {
						setDeleteError(null);
						setConfirmDelete(null);
					}}
					onConfirm={() => {
						if (confirmDelete.kind === "connection") {
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
					connection={connectionsById.get(confirmTest.connectionId)}
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
