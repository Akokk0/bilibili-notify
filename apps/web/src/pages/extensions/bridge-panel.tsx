import { EXTENSION_MOUNT_PREFIX } from "@bilibili-notify/contract";
import {
	AddButton,
	Btn,
	ConfirmDialog,
	EmptyNote,
	HintNote,
	Icon,
	IconButton,
	Pill,
	PlatformIcon,
	StatusDot,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Picker, TInput } from "../../components/forms";
import { api } from "../../services/api";
import { type Connection, newId } from "../../types/domain";
import { copyToClipboard } from "../../utils/clipboard";

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
		mark: "border border-bn-text-disabled",
		label: "text-bn-inactive",
	},
	unknown: {
		text: "还不知道",
		mark: "border border-dashed border-bn-text-tertiary",
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
			className="inline-flex items-center gap-1.5 text-bn-xs"
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
				<li key={state} className="flex items-center gap-1.5">
					<CapabilityMark state={state} size={12} />
					{CAPABILITY_STATE[state].text}
				</li>
			))}
		</ul>
	);
}

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

function BotRow({ bot }: { bot: BridgeBotView }) {
	return (
		<div data-bot-row className="flex gap-2.5 rounded-bn-card bg-bn-surface px-3 py-2">
			{/*
			 * 平台标识走库里那件:认得的画真图标,认不得的退首字方章 —— 桥后面挂着哪些
			 * 平台是**握手时才知道**的开放词表,「退得下去」这件事在这一页是刚需。
			 */}
			<span data-bot-mark className="mt-0.5 flex shrink-0">
				<PlatformIcon platform={bot.platform} size={26} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
		</div>
	);
}

/**
 * 接入卡左边那枚方块 —— 两个字母认出「这条是哪一种桥」。
 *
 * 🔴 印的是**配置里那一种**,不是桥自报的那一种:两者对不上正是要看见的事(token 填到
 * 另一头的插件里去了),而把自报的印在这儿会把那个错悄悄抹平。
 *
 * 走 `--color-bn-inactive` 一档中性色:桥的种类**不是语义状态**,给它一档语义色的话,
 * 这张卡上真正的状态(连没连上)就得跟它抢注意力。
 */
function LinkMark({ kind }: { kind: string }) {
	return (
		<span
			role="img"
			aria-label={`${kind} 接入`}
			className="grid size-8 shrink-0 place-items-center rounded-bn-card bg-bn-surface-muted font-bold text-bn-base text-bn-inactive lowercase"
		>
			{kind.slice(0, 2)}
		</span>
	);
}

/**
 * 「复制」这一颗。**两处共用** —— token 与 BN 地址是插件那头必须原样填进去的一对,
 * 谁抄错都是「连不上」。
 *
 * 🔴 走 `copyToClipboard` 而不是裸 `navigator.clipboard`:BN 常经
 * `http://<内网 IP>:8787` 打开,那是**非安全上下文**,`navigator.clipboard` 根本不存在 ——
 * 裸写法在那里按下去静默无事,而这一页恰恰最常从内网 IP 打开。
 */
function CopyButton({ label, text }: { label: string; text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Btn
			variant="outline"
			size="sm"
			aria-label={label}
			onClick={() => {
				void copyToClipboard(text).then(setCopied);
			}}
		>
			{copied ? "已复制" : "复制"}
		</Btn>
	);
}

/**
 * token 是密钥 —— 屏幕上只留头尾,要用时按「复制」。明文摆着的后果是它被随手截进
 * 求助帖里,而拿着它就能连上这台 BN(那条 WS 端点在 dashboard 鉴权之外)。
 *
 * **头尾各留四位**,不是只留尾巴:主人配了两条接入时,这一行是唯一能对上「插件里填的
 * 是哪一把」的东西,只剩四位撞得太容易。
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
		<div data-token-row className="flex flex-wrap items-center gap-2">
			<span className="w-9 shrink-0 text-bn-xs text-bn-text-tertiary">token</span>
			<span className="min-w-0 flex-1 truncate rounded-bn-card bg-bn-surface-muted px-2 py-1 font-mono text-bn-xs text-bn-text-secondary">
				{`${token.slice(0, 4)}${"•".repeat(Math.max(4, token.length - 8))}${token.slice(-4)}`}
			</span>
			<CopyButton label={`复制 ${linkName} 的 token`} text={token} />
			<Btn
				variant="danger-outline"
				size="sm"
				aria-label={`重新生成 ${linkName} 的 token`}
				onClick={onRegenerate}
			>
				<Icon.refresh size={13} />
				重新生成
			</Btn>
		</div>
	);
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
 * 地址块。它与 token 那一行是**一对**:插件那头两样都要填,少一样连不上。
 */
function BridgeAddress({ extensionId }: { extensionId: string }) {
	const address = bnBridgeAddress(extensionId);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-bn-card border border-bn-border p-3">
			<span className="text-bn-sm font-bold text-bn-text-secondary">BN 地址</span>
			<span className="rounded-bn-card bg-bn-surface-muted px-2 py-1 font-mono text-bn-sm text-bn-text-primary">
				{address}
			</span>
			<CopyButton label="复制 BN 地址" text={address} />
			<p className="min-w-64 flex-1 text-bn-xs leading-relaxed text-bn-text-tertiary">
				这是<strong className="text-bn-text-secondary">桥那台机器</strong>要访问得到的地址 —— BN 在
				NAS / 容器里时别填 <span className="font-mono">127.0.0.1</span>,那是桥自己。 token
				填错那头收到的是 <span className="font-mono">401</span>,拓展关着是{" "}
				<span className="font-mono">404</span>,两种都不会在这一页留下记录。
			</p>
		</div>
	);
}

interface LinkActions {
	setEnabled(id: string, enabled: boolean): void;
	regenerate(id: string): void;
	rename(id: string, name: string): void;
	remove(id: string): void;
}

/**
 * 卡片上那个名字 —— 平时是一行字,点一下「改名」就地变成输入框。
 *
 * 🔴 名字是这张卡上**唯一**能认出「这条是给谁的」的东西(token 是乱码、地址两条一模一样),
 * 而它此前只在新建那一刻能填:填错了只能删掉重配,而重配 = 换 token = 对面那个插件也得
 * 跟着改一次。所以这不是顺手加的装饰。
 *
 * 存 / 撤各一颗钮(不给共享库的 T 系列加 `onKeyDown`/`onBlur` 三个口去换回车与失焦 ——
 * 一个低频动作不值得动那份契约);**空名字当没改** —— 存下去这张卡上就什么都不剩了。
 */
function LinkName({
	connection,
	onRename,
}: {
	connection: Connection;
	onRename: (name: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(connection.name);

	function commit(): void {
		setEditing(false);
		const next = draft.trim();
		if (next === "" || next === connection.name) return;
		onRename(next);
	}

	if (!editing) {
		return (
			<span className="flex items-center gap-1">
				{connection.name}
				<IconButton
					label={`改名 ${connection.name}`}
					icon={<Icon.edit size={12} />}
					size="xs"
					onClick={() => {
						setDraft(connection.name);
						setEditing(true);
					}}
				/>
			</span>
		);
	}

	return (
		<span className="flex items-center gap-1">
			<TInput
				ariaLabel={`${connection.name} 的名字`}
				value={draft}
				onChange={setDraft}
				width={150}
			/>
			<Btn variant="ghost" size="sm" onClick={commit}>
				保存
			</Btn>
			<Btn variant="ghost" size="sm" onClick={() => setEditing(false)}>
				取消
			</Btn>
		</span>
	);
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
				<LinkMark kind={config.bridgeKind} />
				<span className="flex items-center gap-1.5 text-bn-sm text-bn-text-primary">
					<StatusDot kind={connected ? "ok" : "off"} />
					<LinkName
						connection={connection}
						onRename={(name) => actions.rename(connection.id, name)}
					/>
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
						label={`删除 ${connection.name}`}
						icon={<Icon.close size={13} />}
						size="sm"
						tone="danger"
						onClick={() => actions.remove(connection.id)}
					/>
				</span>
			</div>

			<TokenRow
				token={config.token}
				linkName={connection.name}
				onRegenerate={() => actions.regenerate(connection.id)}
			/>

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
		// 只发 name 那一格:整条发出去的话,config 里的 token 会被这一发按回旧值。
		rename: (id, name) => patch.mutate({ id, body: { name } }),
		remove: (id) => setRemoving(links.find((c) => c.id === id) ?? null),
	};

	return (
		<div className="flex flex-col gap-3">
			<BridgeAddress extensionId={extensionId} />

			{/*
			 * 接入这一节的标题行。图例挂在这儿而不是每张卡里:它解释的是整节的记号,
			 * 逐卡重复一遍只会把卡挤满,而主人要的是「进这一节时看一眼」。
			 */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<b className="text-bn-xs font-bold tracking-wide text-bn-text-tertiary">桥接入</b>
				<span className="h-px min-w-4 flex-1 bg-bn-border" />
				<CapabilityLegend />
			</div>

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
