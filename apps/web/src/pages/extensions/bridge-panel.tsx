import {
	AddButton,
	Btn,
	ConfirmDialog,
	EmptyNote,
	HintNote,
	Icon,
	IconButton,
	Pill,
	StatusDot,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Picker, TInput } from "../../components/forms";
import { api } from "../../services/api";
import { type Connection, newId } from "../../types/domain";

/**
 * 桥接拓展那一页:接入的增删改 + 每条接入现在什么样。
 *
 * ⚠️ **这是面板里唯一一处认得某个具体拓展的地方**,而且是有意的:`/api/ext/<id>/status`
 * 交上来的是**任意 JSON**(ADR-0012 决策 36 —— 形状第一版不约束,因为「抽象要两个例子」,
 * 而我们手上只有桥这一个)。等第二个拓展也要一块面板时,再从两个真实例子里抽形状;
 * 现在就发明一套通用 schema,只会照着桥的样子编一遍。
 *
 * 所以下面这些类型是**本地的**:契约里一格桥的字都没有,也不该有。
 */

/** 桥自报的六项能力,三态。 */
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

/** 一条桥接入的 config —— 形状归拓展自己定,所以这一层读得**防着点**。 */
interface BridgeLinkConfig {
	token: string;
	bridgeKind: string;
}

const BRIDGE_KINDS: { value: string; label: string }[] = [
	{ value: "koishi", label: "Koishi" },
	{ value: "astrbot", label: "AstrBot" },
];

/** 机器词 → 说给人听的那句。顺序即显示顺序。 */
const CAPABILITIES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "atAll", label: "@全体成员" },
	{ code: "inbound", label: "接收消息" },
	{ code: "forward", label: "合并转发" },
	{ code: "miniAppCard", label: "小程序卡" },
	{ code: "shareCardLinks", label: "分享卡链接" },
	{ code: "markdown", label: "markdown" },
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

/**
 * 一把新钥匙。**128 位随机**,前端现生成 —— token 只需要「两边一样」,不需要服务端参与
 * (桥接设计定案)。而那条 WS 端点**刻意在 dashboard 鉴权之外**,所以这把钥匙的随机性
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

/**
 * token 是密钥 —— 屏幕上只留个尾巴,要用时按「复制」。明文摆着的后果是它被随手截进
 * 求助帖里,而拿着它就能连上这台 BN(那条 WS 端点在 dashboard 鉴权之外)。
 */
function TokenRow({ token }: { token: string }) {
	const [copied, setCopied] = useState(false);
	if (!token) return <HintNote tone="danger">这条接入还没有 token,重新生成一把</HintNote>;
	return (
		<div className="flex items-center gap-2 text-bn-xs text-bn-text-tertiary">
			<span className="font-mono">token ····{token.slice(-4)}</span>
			<Btn
				variant="ghost"
				size="sm"
				onClick={() => {
					// 非 secure context 里没有 clipboard —— 别炸,按钮维持原样就行。
					void navigator.clipboard
						?.writeText(token)
						.then(() => setCopied(true))
						.catch(() => setCopied(false));
				}}
			>
				{copied ? "已复制" : "复制"}
			</Btn>
		</div>
	);
}

interface LinkActions {
	setEnabled(id: string, enabled: boolean): void;
	regenerate(id: string): void;
	remove(id: string): void;
}

function LinkCard({
	connection,
	session,
	actions,
}: {
	connection: Connection;
	session: BridgeSessionView | undefined;
	actions: LinkActions;
}) {
	const config = bridgeConfigOf(connection);
	const bots = session?.bots ?? [];
	const connected = session?.connected === true;
	const kindLabel = BRIDGE_KINDS.find((k) => k.value === config.bridgeKind)?.label;

	return (
		<div className="flex flex-col gap-2 rounded-bn-card border border-bn-border p-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="flex items-center gap-1.5 text-bn-sm text-bn-text-primary">
					<StatusDot kind={connected ? "ok" : "off"} />
					{connection.name}
				</span>
				<span className="text-bn-xs text-bn-text-tertiary">{connected ? "已连接" : "未连接"}</span>
				{connected ? (
					<span className="text-bn-xs text-bn-text-tertiary">
						{[session?.kind, session?.name, session?.version ? `v${session.version}` : undefined]
							.filter(Boolean)
							.join(" · ")}
					</span>
				) : (
					<span className="text-bn-xs text-bn-text-tertiary">{kindLabel ?? config.bridgeKind}</span>
				)}
				<span className="ml-auto flex items-center gap-1.5">
					<Toggle
						size="sm"
						ariaLabel={`启用 ${connection.name}`}
						value={connection.enabled}
						onChange={(on) => actions.setEnabled(connection.id, on)}
					/>
					<IconButton
						label={`重新生成 ${connection.name} 的 token`}
						icon={<Icon.refresh size={13} />}
						size="sm"
						onClick={() => actions.regenerate(connection.id)}
					/>
					<IconButton
						label={`删除 ${connection.name}`}
						icon={<Icon.close size={13} />}
						size="sm"
						tone="danger"
						onClick={() => actions.remove(connection.id)}
					/>
				</span>
			</div>

			<TokenRow token={config.token} />

			{connected && bots.length === 0 ? (
				// 连上了却一个 bot 都没借过来 —— 桥那侧还没登录任何账号,值得单独说一句。
				<HintNote>桥连上了,但它现在一个 bot 都没有</HintNote>
			) : null}
			{bots.map((bot) => (
				<BotRow key={bot.botId} bot={bot} />
			))}
		</div>
	);
}

function AddLinkForm({
	onCancel,
	onCreate,
}: {
	onCancel: () => void;
	onCreate: (draft: { name: string; bridgeKind: string }) => void;
}) {
	const [name, setName] = useState("");
	const [bridgeKind, setBridgeKind] = useState("koishi");
	return (
		<div className="flex flex-col items-start gap-2 rounded-bn-card border border-bn-border p-3">
			<TInput
				ariaLabel="接入名字"
				value={name}
				onChange={setName}
				placeholder="给它起个名字,比如「家里那台 koishi」"
				full
			/>
			<Picker value={bridgeKind} onChange={setBridgeKind} options={BRIDGE_KINDS} />
			<div className="flex items-center gap-2">
				{/* 名字空着也让建 —— 先建个壳回头再改,是这仓里一贯的用法。 */}
				<Btn size="sm" onClick={() => onCreate({ name: name.trim() || "新接入", bridgeKind })}>
					建好了
				</Btn>
				<Btn variant="ghost" size="sm" onClick={onCancel}>
					取消
				</Btn>
			</div>
		</div>
	);
}

/**
 * 从**配置那一头**看起,不是从活着的会话。
 *
 * 🔴 两个理由:① 最需要看见的恰恰是「配了但没连上」那一条,而它在会话表里根本不存在;
 * ② 拓展没跑起来时 `/status` 是 404,而主人正是那个时候要来这一页把接入改对 —— 从会话
 * 那头看起的话,这一页在最需要它的时刻恰好是空的。
 */
export function BridgeConnections({ extensionId }: { extensionId: string }) {
	const qc = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<Connection | null>(null);

	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	const status = useQuery({
		queryKey: ["extension-status", extensionId],
		queryFn: () => api.get<BridgeStatusView>(`/api/ext/${extensionId}/status`),
		retry: false,
	});

	const refresh = () => {
		void qc.invalidateQueries({ queryKey: ["connections"] });
		void qc.invalidateQueries({ queryKey: ["extension-status", extensionId] });
	};

	const create = useMutation({
		mutationFn: (draft: { name: string; bridgeKind: string }) =>
			api.post("/api/connections", {
				id: newId(),
				name: draft.name,
				enabled: true,
				kind: "extension",
				extensionId,
				config: { token: newBridgeToken(), bridgeKind: draft.bridgeKind },
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
		regenerate: (id) => {
			const current = links.find((c) => c.id === id);
			if (!current) return;
			patch.mutate({
				id,
				// config 整份发 —— 它的形状归拓展自己定,这一层做不了「只改一格」的合并。
				body: { config: { ...bridgeConfigOf(current), token: newBridgeToken() } },
			});
		},
		remove: (id) => setRemoving(links.find((c) => c.id === id) ?? null),
	};

	return (
		<div className="flex flex-col gap-3">
			{status.isError ? (
				<HintNote>这个拓展现在没跑起来,底下只有配置、没有连接状态。</HintNote>
			) : null}

			{links.length === 0 && !adding ? <EmptyNote>还没有配过接入</EmptyNote> : null}

			{links.map((connection) => (
				<LinkCard
					key={connection.id}
					connection={connection}
					session={sessions.get(connection.id)}
					actions={actions}
				/>
			))}

			{adding ? (
				<AddLinkForm onCancel={() => setAdding(false)} onCreate={(d) => create.mutate(d)} />
			) : (
				<AddButton block onClick={() => setAdding(true)}>
					<Icon.plus size={13} />
					添加接入
				</AddButton>
			)}

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
		</div>
	);
}
