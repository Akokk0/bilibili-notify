import { EXTENSION_MOUNT_PREFIX } from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	GlassBox,
	HintNote,
	Icon,
	IconButton,
	ModalShell,
	Pill,
	SELECTED_LANGUAGE,
	StatusDot,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { TInput } from "../../components/forms";
import { api } from "../../services/api";
import { type Connection, newId } from "../../types/domain";
import { copyToClipboard } from "../../utils/clipboard";
import { relativeTime } from "../up/helpers";
import {
	type BridgeBotView,
	type BridgeSessionView,
	type CapabilityState,
	useBridgeStatus,
} from "./bridge-status";

/**
 * 桥接拓展那一页的正文:接入的增删改 + 每条接入现在什么样。
 *
 * 版式照设计稿 V1 的三块画板:「BridgeDetail」(头卡的地址行、「桥接入」那一节、连上 /
 * 没连上两张卡)、「BridgeStates」(一条都没有 / 拓展关着 / 桥自报的种类对不上)、
 * 「NewBridge」(新建弹窗)。状态形状读的是 `bridge-status.ts` 那一份 —— 契约里一格桥的字
 * 都没有(ADR-0012 决策 36),这里是面板里唯一认得它的地方。
 */

/** 一条桥接入的 config —— 形状归拓展自己定,所以这一层读得**防着点**。 */
interface BridgeLinkConfig {
	token: string;
	bridgeKind: string;
}

/** 桥的两种。`label` 是面板上的叫法,`value` 是配置里的字。 */
const BRIDGE_KINDS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "koishi", label: "koishi" },
	{ value: "astrbot", label: "AstrBot" },
];

function kindLabel(kind: string): string {
	return BRIDGE_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** 机器词 → 设计稿上那几个字。顺序即显示顺序。 */
const CAPABILITIES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "atAll", label: "@全体" },
	{ code: "inbound", label: "收私聊指令" },
	{ code: "forward", label: "合并转发" },
	{ code: "miniAppCard", label: "小程序卡" },
	{ code: "shareCardLinks", label: "分享卡链接" },
	{ code: "markdown", label: "markdown" },
];

// ── 小件 ────────────────────────────────────────────────────────────────────

/** 中性灰的「12% 底 + 同色字」—— 设计稿上所有「哪一种」方块与「哪一种」徽章都是这一档。 */
const MUTED_TINT: CSSProperties = {
	background: "color-mix(in srgb, var(--color-bn-inactive) 12%, transparent)",
	color: "var(--color-bn-inactive)",
};

/**
 * 「哪一种」那枚方块:两个字母,灰底灰字。接入卡左上(32)、bot 行(26)、新建弹窗里的
 * 选项(28)三处同一件,尺寸不同。
 *
 * 走中性灰而不是语义色:种类**不是状态**,给它一档语义色的话,卡上真正的状态(连没连上)
 * 就得跟它抢注意力。
 */
function KindMark({
	text,
	size,
	label,
	style,
}: {
	text: string;
	size: 26 | 28 | 32;
	label?: string;
	style?: CSSProperties;
}) {
	const shape =
		size === 32
			? "size-8 rounded-bn-sm text-bn-base"
			: size === 28
				? "size-7 rounded-md text-bn-sm"
				: "size-[26px] rounded-md text-bn-xs";
	const className = `grid shrink-0 place-items-center font-bold lowercase ${shape}`;
	const tint = style ?? MUTED_TINT;
	// 有名字的是一枚「图」(读屏器念 label);没名字的是旁边那行字的装饰,读屏器跳过。
	return label ? (
		<span role="img" aria-label={label} className={className} style={tint}>
			{text.slice(0, 2)}
		</span>
	) : (
		<span aria-hidden="true" className={className} style={tint}>
			{text.slice(0, 2)}
		</span>
	);
}

/** 等宽小字的那种底 —— 地址、token 都装在这里面。 */
function MonoChip({ children, className }: { children: string; className?: string }) {
	return (
		<span
			className={`rounded-bn-xs bg-bn-surface-muted px-[7px] py-[3px] font-mono text-bn-xs text-bn-text-secondary ${className ?? ""}`}
		>
			{children}
		</span>
	);
}

/** 一节的标题行左半:小标题 + 发丝线。 */
function Caption({ children }: { children: string }) {
	return (
		<span className="text-bn-xs font-bold tracking-[0.04em] text-bn-text-tertiary">{children}</span>
	);
}

// ── 能力三态 ─────────────────────────────────────────────────────────────────

/**
 * 三态各自的说法与画法。
 *
 * 🔴 **「不支持」与「还不知道」不许并成一档**(ADR-0009 决策 10):前者是结论,后者是
 * 「试试看,可能行」—— 桥对没见过的平台会真的不知道。混成一个记号,主人会以为那条
 * 平台永远做不到,于是再也不试。
 *
 * 🔴 **也不许拿删除线画「不支持」**:删除线在这套界面里说的是「作废 / 坏了」。
 * 2026-09-10 主人正是对着一排划掉的能力说「肯定有问题」—— 那张表其实完全正常。
 * 三档靠**形状**分(实心打勾 / 空心一横 / 虚线空圈),颜色只是第二条通道 ——
 * 色觉差异与截图压缩吃得掉颜色,吃不掉形状。
 */
const CAPABILITY_STATE: Record<CapabilityState, { text: string; mark: string; label: string }> = {
	supported: {
		text: "支持",
		mark: "bg-bn-success text-bn-on-solid",
		label: "text-bn-text-secondary",
	},
	unsupported: {
		text: "不支持",
		mark: "border-[1.5px] border-bn-text-disabled",
		label: "text-bn-inactive",
	},
	unknown: {
		text: "还不知道",
		mark: "border-[1.5px] border-dashed border-bn-text-tertiary",
		label: "text-bn-text-tertiary",
	},
};

/**
 * 那颗记号本身。**图例与正文共用这一个** —— 各画各的话,图例迟早对不上它要解释的东西,
 * 而一份对不上的图例比没有图例更糟。
 */
function CapabilityMark({ state, size = 14 }: { state: CapabilityState; size?: number }) {
	return (
		<span
			data-cap-mark={state}
			className={`grid shrink-0 place-items-center rounded-full ${CAPABILITY_STATE[state].mark}`}
			// 记号是正圆,尺寸是几何量 —— 这两样留在行内,皮肤掰不坏。
			style={{ width: size, height: size }}
		>
			{state === "supported" ? <Icon.check size={Math.round(size * 0.64)} /> : null}
			{/* 「一横」是**空心圈里的减号** —— 与虚线空圈拉开距离靠的就是它。 */}
			{state === "unsupported" ? (
				<span className="h-px w-1.5 rounded-full bg-bn-text-disabled" />
			) : null}
		</span>
	);
}

function CapabilityChip({ label, state }: { label: string; state: CapabilityState }) {
	const meta = CAPABILITY_STATE[state];
	return (
		<span
			// 三态在形状与颜色之外**还有一层字面说明** —— 读屏器与鼠标悬停都够得着。
			title={`${label}:${meta.text}`}
			className="inline-flex items-center gap-[5px] whitespace-nowrap text-bn-xs leading-[14px]"
		>
			<CapabilityMark state={state} />
			<span className={meta.label}>{label}</span>
		</span>
	);
}

/**
 * 图例。**它不是装饰**:三个记号里有两个是空心圈,不告诉人哪个是哪个,就只能猜 ——
 * 2026-09-10 主人就是这么猜错的(把一张正常的能力表读成了故障)。
 */
function CapabilityLegend() {
	return (
		<ul
			aria-label="能力图例"
			className="flex list-none items-center gap-3 p-0 text-bn-2xs text-bn-text-tertiary"
		>
			{(Object.keys(CAPABILITY_STATE) as CapabilityState[]).map((state) => (
				<li key={state} className="flex items-center gap-[5px]">
					<CapabilityMark state={state} size={12} />
					{CAPABILITY_STATE[state].text}
				</li>
			))}
		</ul>
	);
}

// ── token 与地址 ─────────────────────────────────────────────────────────────

/**
 * 一把新钥匙。**128 位随机**,前端现生成 —— token 只需要「两边一样」,不需要服务端参与
 * (ADR-0009)。而那条 WS 端点**刻意在 dashboard 鉴权之外**,所以这把钥匙的随机性
 * 就是它唯一的防线。
 *
 * 与 `newId()` 同一个理由不用 `crypto.randomUUID()`:那个只在 secure context 里有,
 * 而独立端常经 `http://<内网 IP>:8787` 访问。
 */
export function newBridgeToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bridgeConfigOf(connection: Connection): BridgeLinkConfig {
	const config = (connection as { config?: unknown }).config;
	const bag = (typeof config === "object" && config !== null ? config : {}) as Record<
		string,
		unknown
	>;
	return {
		token: typeof bag.token === "string" ? bag.token : "",
		bridgeKind: typeof bag.bridgeKind === "string" ? bag.bridgeKind : "koishi",
	};
}

/** 屏幕上只留头尾各四位 —— 两条接入才分得出谁是谁,而全文不上屏。 */
function maskToken(token: string): string {
	return `${token.slice(0, 4)}${"•".repeat(Math.max(4, token.length - 8))}${token.slice(-4)}`;
}

/**
 * 插件那头要填的 BN 地址 —— **面板不给,主人只能去翻文档**。
 *
 * 从浏览器地址栏现算:主人此刻正是**经这个地址**看着这一页,所以它至少是一条通到 BN 的
 * 真路。服务端算不了这件事(它只知道自己绑在哪个口上,不知道外面怎么访问得到它),
 * 而写死 `127.0.0.1` 是最坏的那个答案 —— 桥常在另一台机器上。
 */
function bnBridgeAddress(extensionId: string): string {
	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${window.location.host}${EXTENSION_MOUNT_PREFIX}/${extensionId}`;
}

/**
 * 「复制」那一颗,只有图标。
 *
 * 🔴 走 `copyToClipboard` 而不是裸 `navigator.clipboard`:BN 常经
 * `http://<内网 IP>:8787` 打开,那是**非安全上下文**,`navigator.clipboard` 根本不存在 ——
 * 裸写法在那里按下去静默无事,而这一页恰恰最常从内网 IP 打开。
 */
function CopyIconButton({ label, text }: { label: string; text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<IconButton
			label={copied ? `${label}(已复制)` : label}
			icon={copied ? <Icon.check size={13} /> : <Icon.copy size={13} />}
			size="sm"
			onClick={() => {
				void copyToClipboard(text).then(setCopied);
			}}
		/>
	);
}

/** 带字的那一颗(接入卡 token 行上的「复制」)。 */
function CopyButton({ label, text }: { label: string; text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Btn
			variant="ghost"
			size="sm"
			aria-label={label}
			icon={copied ? <Icon.check size={13} /> : <Icon.copy size={13} />}
			onClick={() => {
				void copyToClipboard(text).then(setCopied);
			}}
		>
			{copied ? "已复制" : "复制"}
		</Btn>
	);
}

/**
 * 头卡正文那一行:BN 地址 + 复制 | 该填哪个地址。
 *
 * 只留「填哪个地址」这一句。401 / 连不上那两句在**「没连上」那张卡**上 ——
 * 那才是它们真正被需要的时刻,摆在这儿等于人人都要先读一遍排错说明。
 */
export function BridgeAddressRow({ extensionId }: { extensionId: string }) {
	const address = bnBridgeAddress(extensionId);
	return (
		<div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-0.5">
			<div className="flex items-center gap-[7px] text-bn-xs text-bn-text-secondary">
				<span className="text-bn-text-tertiary">BN 地址</span>
				<MonoChip>{address}</MonoChip>
				<CopyIconButton label="复制 BN 地址" text={address} />
			</div>
			<span className="h-4 w-px bg-bn-border-subtle" />
			<span className="text-bn-xs text-bn-text-tertiary">
				这是<strong className="font-bold text-bn-text-secondary">桥那台机器</strong>
				要访问得到的地址 —— BN 在 NAS 上时别填 <span className="font-mono">127.0.0.1</span>。
			</span>
		</div>
	);
}

/**
 * token 是密钥 —— 屏幕上只留头尾,要用时按「复制」。明文摆着的后果是它被随手截进
 * 求助帖里,而拿着它就能连上这台 BN(那条 WS 端点在 dashboard 鉴权之外)。
 *
 * 「重新生成」跟在同一行:它讲的就是这把 token。摆去卡片标题栏的话,那一栏里
 * 「停用 / 换钥匙 / 删除」三颗轻重完全不同的钮挨在一起,手一抖就换掉了对面正用着的钥匙。
 */
function TokenRow({
	token,
	linkName,
	onRegenerate,
}: {
	token: string;
	linkName: string;
	onRegenerate: () => void;
}) {
	if (!token) return <HintNote tone="danger">这条接入还没有 token,重新生成一把</HintNote>;
	return (
		<div data-token-row className="flex flex-wrap items-center gap-2.5">
			<span className="w-9 shrink-0 text-bn-xs text-bn-text-tertiary">token</span>
			<MonoChip className="min-w-0 flex-1 truncate px-[9px] py-[5px]">{maskToken(token)}</MonoChip>
			<CopyButton label={`复制 ${linkName} 的 token`} text={token} />
			<Btn
				variant="danger-outline"
				size="sm"
				aria-label={`重新生成 ${linkName} 的 token`}
				icon={<Icon.refresh size={13} />}
				onClick={onRegenerate}
			>
				重新生成
			</Btn>
		</div>
	);
}

// ── bot 行 ───────────────────────────────────────────────────────────────────

/**
 * 一个 bot 一行 —— 照设计稿:平台方块 + **定宽的名字/平台列** + 能力横排。
 *
 * 定宽那一列是版式的承重件:多个 bot 排下来,能力记号得在同一条竖线上起排,不然一列
 * 「@全体」有的在左有的在右,整张表就读不成表了。
 *
 * 方块印的是平台名的头两个字母:桥后面挂着哪些平台是**握手时才知道**的开放词表,
 * 两个字母对任何平台都画得出来。
 */
function BotRow({ bot }: { bot: BridgeBotView }) {
	return (
		<div data-bot-row className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-[9px]">
			<span data-bot-mark className="flex shrink-0">
				<KindMark text={bot.platform} size={26} />
			</span>
			<div className="w-[210px] min-w-0">
				<div className="truncate text-bn-sm font-bold text-bn-text-primary">
					{bot.name ?? bot.botId}
				</div>
				<div className="mt-px truncate font-mono text-bn-2xs text-bn-text-tertiary">
					{[bot.platform, bot.selfId].filter(Boolean).join(" · ")}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
				{CAPABILITIES.map((cap) => (
					<CapabilityChip
						key={cap.code}
						label={cap.label}
						// 桥少报的那些按「还不知道」算 —— 缺席不是「不支持」。
						state={bot.capabilities?.[cap.code] ?? "unknown"}
					/>
				))}
			</div>
		</div>
	);
}

// ── 接入卡 ───────────────────────────────────────────────────────────────────

interface LinkActions {
	setEnabled(id: string, enabled: boolean): void;
	/** 把配置里的种类改成桥自报的那一种 —— 「对不上」那一档唯一的出口。 */
	setKind(id: string, kind: string): void;
	regenerate(id: string): void;
	remove(id: string): void;
}

/** 卡上那句状态:点 + 字,颜色跟状态走。 */
function LinkStatus({
	dot,
	className,
	children,
}: {
	dot: "ok" | "warn" | "off";
	className: string;
	children: string;
}) {
	return (
		<span className={`inline-flex items-center gap-[5px] text-bn-xs font-bold ${className}`}>
			<StatusDot kind={dot} />
			{children}
		</span>
	);
}

/**
 * 一条接入一张卡。四种样子(ADR-0009 决策 20):连上了 / 连上了但对不上 / 没连上 / 停用了。
 *
 * 🔴 方块印的是**配置里那一种**,不是桥自报的那一种:两者对不上正是要看见的事(token 填到
 * 另一头的插件里去了),而把自报的印在这儿会把那个错悄悄抹平。
 */
function LinkCard({
	connection,
	session,
	address,
	actions,
}: {
	connection: Connection;
	session: BridgeSessionView | undefined;
	address: string;
	actions: LinkActions;
}) {
	const config = bridgeConfigOf(connection);
	const connected = session?.connected === true;
	// 桥自报的种类只在**连着**的时候作数 —— 断开的会话不会再自报什么。
	const reportedKind = connected ? session?.kind : undefined;
	const mismatched = reportedKind !== undefined && reportedKind !== config.bridgeKind;
	const paused = connection.enabled === false;

	const accent = mismatched
		? "var(--color-bn-warning)"
		: connected
			? "var(--color-bn-success)"
			: "var(--color-bn-inactive)";

	const status = paused ? (
		<LinkStatus dot="off" className="text-bn-text-tertiary">
			已停用
		</LinkStatus>
	) : mismatched ? (
		<LinkStatus dot="warn" className="text-bn-warning-text">
			连上了,但对不上
		</LinkStatus>
	) : connected ? (
		<LinkStatus dot="ok" className="text-bn-success-text">
			已连接
		</LinkStatus>
	) : (
		<LinkStatus dot="off" className="text-bn-text-tertiary">
			没连上
		</LinkStatus>
	);

	// 头卡副标题:连着的印桥自报的名字 / 版本 / 连了多久 / 从哪台机器来;没连着只有一句。
	const subtitle = connected ? (
		<span className="text-bn-text-tertiary">
			{[
				[session?.name, session?.version ? `v${session.version}` : undefined]
					.filter(Boolean)
					.join(" "),
				session?.connectedAt ? `${relativeTime(session.connectedAt)}连上` : undefined,
				session?.remoteAddress ? `来自 ${session.remoteAddress}` : undefined,
			]
				.filter(Boolean)
				.join(" · ")}
		</span>
	) : (
		<span className="text-bn-text-tertiary">现在没有桥用这个 token 连着。</span>
	);

	const bots = session?.bots ?? [];

	return (
		<div data-link-card={connection.id}>
			<GlassBox
				accent={accent}
				mark={<KindMark text={config.bridgeKind} size={32} label={`${config.bridgeKind} 接入`} />}
				title={connection.name}
				aside={
					<>
						<Pill subtle size="sm" color="var(--color-bn-inactive)">
							{mismatched ? `配置:${config.bridgeKind}` : config.bridgeKind}
						</Pill>
						{status}
					</>
				}
				subtitle={subtitle}
				right={
					<div className="flex shrink-0 items-center gap-2">
						{mismatched && reportedKind ? (
							<Btn
								variant="outline"
								size="sm"
								onClick={() => actions.setKind(connection.id, reportedKind)}
							>
								改成 {kindLabel(reportedKind)}
							</Btn>
						) : null}
						<Btn
							variant="outline"
							size="sm"
							aria-label={`${paused ? "启用" : "停用"} ${connection.name}`}
							onClick={() => actions.setEnabled(connection.id, paused)}
						>
							{paused ? "启用" : "停用"}
						</Btn>
						<Btn
							variant="danger-outline"
							size="sm"
							aria-label={`删除 ${connection.name}`}
							onClick={() => actions.remove(connection.id)}
						>
							删除
						</Btn>
					</div>
				}
			>
				<div className="flex flex-col gap-3">
					{/*
					 * 🔴 得说清**它其实是能用的**。不说的话,主人会以为推送坏了,跑去拆本来好好的
					 * 配置 —— 而真正要改的只是面板上这一格叫什么。
					 */}
					{mismatched && reportedKind ? (
						<WarnNote size="sm" className="flex gap-[9px] leading-[1.7]">
							<Icon.warning size={15} className="mt-px shrink-0" />
							<div data-kind-mismatch-note>
								<strong className="font-bold">
									这条接入配的是 {config.bridgeKind},连进来的却自报 {reportedKind}。
								</strong>
								多半是 token 填到另一头的插件里去了。收发照常能用 —— BN 对两种桥的处理完全相同 ——
								但面板上的名字会一直对不上,建议改掉其中一边。
							</div>
						</WarnNote>
					) : null}

					<TokenRow
						token={config.token}
						linkName={connection.name}
						onRegenerate={() => actions.regenerate(connection.id)}
					/>

					{connected ? (
						<>
							<div className="h-px bg-bn-border-subtle" />
							<div className="flex items-center gap-2">
								<span className="text-bn-xs font-bold text-bn-text-tertiary">它驮着的 bot</span>
								<Pill subtle size="sm">
									{bots.length}
								</Pill>
							</div>
							{bots.length === 0 ? (
								<span className="text-bn-xs text-bn-text-tertiary">
									桥连上了,但它现在一个 bot 都没有 —— 那头的框架里还没登任何账号。
								</span>
							) : (
								<div className="flex flex-col divide-y divide-bn-border-subtle">
									{bots.map((bot) => (
										<BotRow key={bot.botId} bot={bot} />
									))}
								</div>
							)}
						</>
					) : (
						<HintNote className="leading-[1.65]">
							插件那头要填两样:BN 地址{" "}
							<span className="font-mono text-bn-text-secondary">{address}</span> 与上面这个
							token。填错 token 的话插件会收到 401;地址不通则是连不上 —— 两种都不会在这里留下记录。
						</HintNote>
					)}
				</div>
			</GlassBox>
		</div>
	);
}

// ── 三种要画对的状态 ──────────────────────────────────────────────────────────

/** A · 一条接入都没有 —— 讲的是接下来干什么,不是「这里是空的」。 */
function BridgeEmpty({ onAdd }: { onAdd: () => void }) {
	return (
		<EmptyNote>
			<div data-bridge-empty className="flex flex-col items-center">
				<span className="text-bn-sm text-bn-text-secondary">还没有桥接入。</span>
				<span className="mt-[5px] text-bn-xs leading-[1.7] text-bn-text-tertiary">
					在这里建一条,把生成的 <span className="font-mono">token</span> 和 BN 地址填进 koishi /
					AstrBot 的插件设置里,它就会自己连过来。
				</span>
				<div className="mt-3.5">
					<Btn variant="primary" size="md" icon={<Icon.plus size={13} />} onClick={onAdd}>
						新建第一条接入
					</Btn>
				</div>
			</div>
		</EmptyNote>
	);
}

/**
 * B · 拓展关着 —— 一句「是你关的」,底下的接入压暗成一行一条。
 *
 * ⚠️ 设计稿的黄盒里还有第三句「期间发往桥的推送一律失败并记『桥接模块已关闭』」。
 * **那个字符串今天不存在**(全仓查过),所以只写查得到的两件事。
 */
function ModuleOff({ links }: { links: Connection[] }) {
	return (
		<>
			<WarnNote size="sm" className="flex gap-[9px] leading-[1.7]">
				<Icon.warning size={15} className="mt-px shrink-0" />
				<div>
					<strong className="font-bold">拓展关着,桥都被断开了。</strong>
					配置一样不动,重新打开它们会自己退避重连回来 —— 关着的这段时间里,发往桥的推送一律失败。
				</div>
			</WarnNote>
			{links.length > 0 ? (
				<div data-links-dimmed className="flex flex-col gap-2 opacity-45 saturate-[0.6]">
					{links.map((connection) => (
						<div
							key={connection.id}
							data-link-card={connection.id}
							className="flex items-center gap-3 rounded-lg border border-bn-border-subtle px-3.5 py-[11px]"
						>
							<KindMark text={bridgeConfigOf(connection).bridgeKind} size={26} />
							<div className="min-w-0 flex-1">
								<div className="truncate text-bn-sm font-bold text-bn-text-primary">
									{connection.name}
								</div>
								<div className="mt-px font-mono text-bn-2xs text-bn-text-tertiary">
									已随拓展断开
								</div>
							</div>
							<StatusDot kind="off" />
						</div>
					))}
				</div>
			) : null}
		</>
	);
}

// ── 新建弹窗 ─────────────────────────────────────────────────────────────────

/** 表单里一格的标题 —— 设计稿的 `.label`。 */
function FieldLabel({ children }: { children: string }) {
	return (
		<span className="mb-1.5 block text-bn-xs font-bold text-bn-text-secondary">{children}</span>
	);
}

/**
 * 新建接入。**token 与地址成对交出去**(ADR-0009 决策 21):插件那头两样都要填,少一样
 * 连不上;而**屏幕上那一把就是存下去的那一把** —— 显示一把、存下另一把是这类界面的经典
 * 错法,症状是主人照着屏幕填进插件,插件收到 401,面板上一切正常。
 */
function AddLinkDialog({
	address,
	onCancel,
	onCreate,
}: {
	address: string;
	onCancel: () => void;
	onCreate: (draft: { name: string; bridgeKind: string; token: string }) => void;
}) {
	const [name, setName] = useState("");
	const [bridgeKind, setBridgeKind] = useState("koishi");
	const [token, setToken] = useState(newBridgeToken);
	return (
		<ModalShell
			width={540}
			onCancel={onCancel}
			title="新建桥接入"
			description="给这条桥起个名字,选它是哪一种。token 由这里生成 —— 填进插件,桥就会自己连过来。"
			bodyClassName="px-5 pb-[18px] pt-4"
		>
			<div className="flex flex-col gap-3.5">
				<div>
					<FieldLabel>哪一种桥</FieldLabel>
					<div className="grid grid-cols-2 gap-2.5">
						{BRIDGE_KINDS.map((kind) => {
							const active = kind.value === bridgeKind;
							return (
								<button
									key={kind.value}
									type="button"
									aria-pressed={active}
									// 与备份页的 ChoiceCard 同一种东西:一张可选的卡,不是按钮 —— 挂 option
									data-bn={active ? "option option-active" : "option"}
									onClick={() => setBridgeKind(kind.value)}
									className={`flex items-center gap-2.5 rounded-lg border px-3 py-[11px] text-left transition ${
										active
											? SELECTED_LANGUAGE
											: "border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-text-tertiary"
									}`}
								>
									<KindMark
										text={kind.value}
										size={28}
										style={
											active
												? {
														background: "color-mix(in srgb, var(--color-bn-pink) 16%, transparent)",
														color: "var(--color-bn-pink)",
													}
												: undefined
										}
									/>
									<span className={`text-bn-sm font-bold ${active ? "text-bn-text-primary" : ""}`}>
										{kind.label}
									</span>
								</button>
							);
						})}
					</div>
					<div className="mt-[7px] text-bn-2xs text-bn-text-tertiary">
						只影响面板怎么称呼它。两种桥说的是同一套协议,BN 这边的处理完全相同。
					</div>
				</div>

				<div>
					<FieldLabel>名字</FieldLabel>
					<TInput
						ariaLabel="接入名字"
						value={name}
						onChange={setName}
						placeholder="比如「家里那台 koishi」"
						full
					/>
				</div>

				<div>
					<FieldLabel>token</FieldLabel>
					<div className="flex items-center gap-2">
						<span
							data-testid="new-token"
							className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-bn-border bg-bn-surface-muted px-2.5 font-mono text-bn-xs text-bn-text-secondary"
						>
							{token}
						</span>
						<IconButton
							label="重新生成 token"
							icon={<Icon.refresh size={13} />}
							size="sm"
							onClick={() => setToken(newBridgeToken())}
						/>
					</div>
					<div className="mt-[7px] text-bn-2xs text-bn-text-tertiary">
						只在这一刻看得到全文。存下之后面板只显示头尾 —— 忘了就重新生成一个。
					</div>
				</div>

				{/*
				 * 「把这两样填进插件设置」。**成对出现**是这块的全部意义 —— 分开摆的话,
				 * 主人填完一样就走了。
				 */}
				<HintNote className="flex flex-col gap-[9px] p-3">
					<span className="text-bn-xs font-bold text-bn-text-secondary">把这两样填进插件设置</span>
					<div className="flex flex-col gap-[7px]">
						<div className="flex items-center gap-2.5">
							<span className="w-14 shrink-0 text-bn-2xs">BN 地址</span>
							<MonoChip className="min-w-0 flex-1 truncate text-bn-text-primary">
								{address}
							</MonoChip>
							<CopyIconButton label="复制 BN 地址" text={address} />
						</div>
						<div className="flex items-center gap-2.5">
							<span className="w-14 shrink-0 text-bn-2xs">token</span>
							<MonoChip className="min-w-0 flex-1 truncate text-bn-text-primary">{token}</MonoChip>
							<CopyIconButton label="复制 token" text={token} />
						</div>
					</div>
					<span className="text-bn-2xs leading-[1.7]">
						地址要填<strong className="font-bold text-bn-text-secondary">桥那台机器访问得到</strong>
						的那个 —— BN 跑在 NAS 或容器里时,127.0.0.1 对桥来说是它自己。BN 挂在 https 反代后面就写{" "}
						<span className="font-mono">wss://</span>。
					</span>
				</HintNote>

				<div className="flex justify-end gap-2 pt-1">
					<Btn variant="outline" size="md" onClick={onCancel}>
						取消
					</Btn>
					<Btn
						variant="primary"
						size="md"
						disabled={!name.trim()}
						onClick={() => onCreate({ name: name.trim(), bridgeKind, token })}
					>
						创建
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}

// ── 整节 ─────────────────────────────────────────────────────────────────────

/**
 * 「桥接入」那一节:标题行 + 三种状态 + 接入卡 + 两个弹窗。摆在详情页头卡**之外**,
 * 与设计稿一样是页面级的兄弟节点。
 */
export function BridgeConnections({
	extensionId,
	enabled,
}: {
	extensionId: string;
	/**
	 * 拓展本身开没开。**关着与崩了要分开画**:两者都拿不到状态,但要主人做的事完全相反 ——
	 * 前者是他自己刚拨的开关,后者要去查日志。
	 */
	enabled: boolean;
}) {
	const qc = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<Connection | null>(null);
	const address = bnBridgeAddress(extensionId);

	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	const status = useBridgeStatus(extensionId, enabled);

	const refresh = () => {
		void qc.invalidateQueries({ queryKey: ["connections"] });
		void qc.invalidateQueries({ queryKey: ["extension-status", extensionId] });
	};

	const create = useMutation({
		// token 由弹窗带过来 —— **屏幕上显示的就是存下去的那一把**。
		mutationFn: (draft: { name: string; bridgeKind: string; token: string }) =>
			api.post("/api/connections", {
				id: newId(),
				name: draft.name,
				enabled: true,
				kind: "extension",
				extensionId,
				config: { token: draft.token, bridgeKind: draft.bridgeKind },
			}),
		onSuccess: () => {
			setAdding(false);
			refresh();
		},
	});

	// 重新生成:服务端**现读** token,所以下一次连接立刻按新的判;还连着的那条由桥自己的
	// 对账踢下线(吊销那个断连码),不用面板操心。
	const patch = useMutation({
		mutationFn: (next: { id: string; body: Record<string, unknown> }) =>
			api.patch(`/api/connections/${next.id}`, next.body),
		onSuccess: refresh,
	});

	const remove = useMutation({
		mutationFn: (id: string) => api.delete(`/api/connections/${id}`),
		onSuccess: () => {
			setRemoving(null);
			refresh();
		},
	});

	const links = (connections.data ?? []).filter(
		(c) => c.kind === "extension" && c.extensionId === extensionId,
	);
	const sessions = new Map(
		(status.data?.sessions ?? []).map((session) => [session.connectionId, session]),
	);

	const actions: LinkActions = {
		setEnabled: (id, enabled) => patch.mutate({ id, body: { enabled } }),
		setKind: (id, kind) => {
			const current = links.find((c) => c.id === id);
			if (!current) return;
			// config 整份发 —— 与「重新生成」同一个理由:它的形状归拓展自己定,这一层
			// 做不了「只改一格」的合并。**token 要原样带上**,漏了就等于顺手换了钥匙。
			patch.mutate({ id, body: { config: { ...bridgeConfigOf(current), bridgeKind: kind } } });
		},
		regenerate: (id) => {
			const current = links.find((c) => c.id === id);
			if (!current) return;
			patch.mutate({
				id,
				body: { config: { ...bridgeConfigOf(current), token: newBridgeToken() } },
			});
		},
		remove: (id) => setRemoving(links.find((c) => c.id === id) ?? null),
	};

	return (
		<>
			{/*
			 * 这一节的标题行 —— 小标题 · 发丝线 · 图例 · 新建。只在有卡可看时才有:一条都
			 * 没有那一屏自己带着开工的钮,关着那一屏不该请人去新建。
			 */}
			{enabled && links.length > 0 ? (
				<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-2">
					<Caption>桥接入</Caption>
					<span className="h-px min-w-4 flex-1 bg-bn-border-subtle" />
					<CapabilityLegend />
					<Btn size="sm" icon={<Icon.plus size={13} />} onClick={() => setAdding(true)}>
						新建接入
					</Btn>
				</div>
			) : null}

			{enabled ? null : <ModuleOff links={links} />}

			{/* 开着却还是拿不到状态 —— 那才是「它自己出事了」,与关着要分开说。 */}
			{enabled && status.isError ? (
				<HintNote className="leading-[1.65]">
					这个拓展现在没跑起来,底下只有配置、没有连接状态 —— 去日志里看它为什么没起来。
				</HintNote>
			) : null}

			{links.length === 0 ? <BridgeEmpty onAdd={() => setAdding(true)} /> : null}

			{enabled
				? links.map((connection) => (
						<LinkCard
							key={connection.id}
							connection={connection}
							session={sessions.get(connection.id)}
							address={address}
							actions={actions}
						/>
					))
				: null}

			{adding ? (
				<AddLinkDialog
					address={address}
					onCancel={() => setAdding(false)}
					onCreate={(draft) => create.mutate(draft)}
				/>
			) : null}

			{removing ? (
				<ConfirmDialog
					title="删掉这条接入?"
					message={`「${removing.name}」删掉之后,那一头的插件会连不上,挂在它名下的推送目标也会失效。`}
					confirmLabel="删除"
					danger
					onConfirm={() => remove.mutate(removing.id)}
					onCancel={() => setRemoving(null)}
				/>
			) : null}
		</>
	);
}
