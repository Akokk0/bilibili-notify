import { EmptyNote, HintNote, Pill, StatusDot } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";
import type { Connection } from "../../types/domain";

/**
 * 桥接拓展的接入状态面板。
 *
 * ⚠️ **这是面板里唯一一处认得某个具体拓展的地方**,而且是有意的:`/api/ext/<id>/status`
 * 交上来的是**任意 JSON**(ADR-0012 决策 36 —— 形状第一版不约束,因为「抽象要两个例子」,
 * 而我们手上只有桥这一个)。等第二个拓展也要一块面板时,再从两个真实例子里抽形状;
 * 现在就发明一套通用 schema 只会照着桥的样子编一遍。
 *
 * 所以下面这些类型是**本地的**:契约里一格桥的字都没有,也不该有。
 */

/** 桥自报的五项能力,三态。 */
type CapabilityState = "supported" | "unsupported" | "unknown";

interface BridgeBotView {
	botId: string;
	platform: string;
	name?: string;
	selfId?: string;
	capabilities?: Partial<Record<string, CapabilityState>>;
}

interface BridgeSessionView {
	connectionId: string;
	connected: boolean;
	kind?: string;
	name?: string;
	version?: string;
	connectedAt?: number;
	bots?: BridgeBotView[];
}

interface BridgeStatusView {
	sessions?: BridgeSessionView[];
}

/** 机器词 → 说给人听的那句。顺序即显示顺序。 */
const CAPABILITIES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "atAll", label: "@全体成员" },
	{ code: "inbound", label: "接收消息" },
	{ code: "forward", label: "合并转发" },
	{ code: "miniAppCard", label: "小程序卡" },
	{ code: "shareCardLinks", label: "分享卡链接" },
];

/**
 * 三态各自的说法与画法。
 *
 * 🔴 **「不支持」与「还不知道」不许并成一档**(桥接设计定案):前者是结论,后者是
 * 「试试看,可能行」—— 桥对没见过的平台会真的不知道。混成一个叉号,主人会以为那条
 * 平台永远做不到,于是再也不试。
 */
const CAPABILITY_STATE: Record<
	CapabilityState,
	{ text: string; dot: "ok" | "off" | "pending"; className: string }
> = {
	supported: { text: "支持", dot: "ok", className: "text-bn-text-secondary" },
	unsupported: { text: "不支持", dot: "off", className: "text-bn-text-disabled line-through" },
	unknown: { text: "还不知道", dot: "pending", className: "text-bn-text-tertiary" },
};

function CapabilityChip({ label, state }: { label: string; state: CapabilityState }) {
	const meta = CAPABILITY_STATE[state];
	return (
		<span
			// 三态在颜色之外**还有一层字面说明** —— 色觉差异与截图压缩都吃不掉 title。
			title={`${label}:${meta.text}`}
			className="inline-flex items-center gap-1 text-bn-xs"
		>
			<StatusDot kind={meta.dot} size="sm" />
			<span className={meta.className}>{label}</span>
			{state === "unknown" ? <span className="text-bn-text-tertiary">?</span> : null}
		</span>
	);
}

function BotRow({ bot }: { bot: BridgeBotView }) {
	return (
		<div className="flex flex-col gap-1.5 rounded-bn-card bg-bn-surface px-3 py-2">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span className="text-bn-sm text-bn-text-primary">{bot.name ?? bot.botId}</span>
				<Pill subtle color="var(--color-bn-pink)">
					{bot.platform}
				</Pill>
				{bot.selfId ? (
					<span className="font-mono text-bn-xs text-bn-text-tertiary">{bot.selfId}</span>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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

function SessionCard({ session, name }: { session: BridgeSessionView; name: string }) {
	const bots = session.bots ?? [];
	return (
		<div className="flex flex-col gap-2 rounded-bn-card border border-bn-border p-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="flex items-center gap-1.5 text-bn-sm text-bn-text-primary">
					<StatusDot kind={session.connected ? "ok" : "off"} />
					{name}
				</span>
				<span className="text-bn-xs text-bn-text-tertiary">
					{session.connected ? "已连接" : "未连接"}
				</span>
				{session.connected ? (
					<span className="text-bn-xs text-bn-text-tertiary">
						{[session.kind, session.name, session.version ? `v${session.version}` : undefined]
							.filter(Boolean)
							.join(" · ")}
					</span>
				) : null}
			</div>
			{session.connected && bots.length === 0 ? (
				// 连上了却一个 bot 都没借过来 —— 桥那侧还没登录任何账号,值得单独说一句。
				<HintNote>桥连上了,但它现在一个 bot 都没有</HintNote>
			) : null}
			{bots.map((bot) => (
				<BotRow key={bot.botId} bot={bot} />
			))}
		</div>
	);
}

/**
 * 从**配置那一头**看起,不是从活着的会话:最需要看见的恰恰是「配了但没连上」那一条,
 * 而它在会话表里根本不存在。桥交上来的那份 status 已经是这么排的,这里只负责把
 * `connectionId` 换成主人认得的名字。
 */
export function BridgeSessions({ extensionId }: { extensionId: string }) {
	const status = useQuery({
		queryKey: ["extension-status", extensionId],
		queryFn: () => api.get<BridgeStatusView>(`/api/ext/${extensionId}/status`),
		retry: false,
	});
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});

	if (status.isError) {
		return <HintNote>这个拓展现在没跑起来,拿不到接入状态。</HintNote>;
	}

	const sessions = status.data?.sessions ?? [];
	if (sessions.length === 0) {
		return <EmptyNote>还没有配过接入</EmptyNote>;
	}

	const nameOf = new Map((connections.data ?? []).map((c) => [c.id, c.name]));
	return (
		<div className="flex flex-col gap-3">
			{sessions.map((session) => (
				<SessionCard
					key={session.connectionId}
					session={session}
					// 连接刚被删掉、而 status 还是上一拍的 —— 退回 id,总比一行空白强。
					name={nameOf.get(session.connectionId) ?? session.connectionId}
				/>
			))}
		</div>
	);
}
