import type {
	ExtensionItemView,
	ExtensionRichRun,
	ExtensionTableCell,
	ExtensionView,
} from "@bilibili-notify/extension";
import {
	BRIDGE_CAPABILITIES,
	type BridgeCapability,
	type BridgeCapabilityState,
} from "./contract.js";
import { platformIcon } from "./platform-icons.js";
import type { BridgeSession } from "./server.js";
import type { BridgeLink } from "./settings.js";

/**
 * 桥交给面板的视图(ADR-0019 决策 20 / 26–31)—— 面板照着画,一句桥的字都不认得。
 *
 * 今天面板里为桥手写的那些派生(四种样子、「对不上」、bot 表、没连上的提示)都搬到这里:
 * **派生由拓展算好交来**,BN 不发明表达式语言。**从接入名单那一头看起**,不是从活着的会话:
 * 最需要看见的恰恰是「配了但没连上」那条,而它在会话表里根本不存在。
 *
 * 停用的项状态由 BN 盖成「已停用」(决策 26),这里只管把那张卡上的话说对。
 */

/** 能力项在面板上的叫法。顺序即显示顺序。 */
const CAPABILITY_LABELS: Readonly<Record<BridgeCapability, string>> = {
	atAll: "@全体",
	inbound: "收私聊指令",
	forward: "合并转发",
	miniAppCard: "小程序卡",
	shareCardLinks: "分享卡链接",
	markdown: "markdown",
};

/**
 * 三态搬到表格的那三个字。🔴「不支持」与「还不知道」不许并成一档(ADR-0009 决策 10):前者是
 * 结论,后者是「试试看,可能行」—— 桥对没见过的平台会真的不知道。
 */
const TRISTATE: Readonly<Record<BridgeCapabilityState, "yes" | "no" | "unknown">> = {
	supported: "yes",
	unsupported: "no",
	unknown: "unknown",
};

/** 两种桥在面板上的叫法(「改成 AstrBot」那颗钮)。 */
const KIND_LABELS: Readonly<Record<string, string>> = { koishi: "koishi", astrbot: "AstrBot" };

/**
 * 视图 schema 的上限 —— 照抄 `packages/internal/src/schema/extension-view.ts`。桥只准从
 * `@bilibili-notify/extension` 进 BN 的东西,够不到那份 schema,只能抄数;那头调了要跟着改。
 *
 * 🔴 对端报什么这里就画什么(bot 名、账号、平台、会话名 / 版本、来源地址、bot 个数),而
 * 视图一格超限,宿主就把**整份视图**换成一条错误提示 —— 一个对端报一个超长名字,所有接入的
 * 状态、bot 表、列表页那句「N 个 bot 在线」一起没了。所以对端报来的一律在这里截。
 */
const VIEW_LIMITS = {
	/** 表格 text 列的字与第二行。 */
	tableText: 200,
	/** 一张表的行数。 */
	tableRows: 200,
	/** 一段字(副标题)里的每一片。 */
	richRun: 2000,
} as const;

/** 超长就截,末尾换一个省略号。不把代理对劈成半个 —— 半个 emoji 画出来是一个问号方块。 */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	let head = text.slice(0, max - 1);
	const last = head.charCodeAt(head.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
	return `${head}…`;
}

/** 片段之间的分隔 —— 今天副标题就是拿 ` · ` 拼的。 */
function joined(parts: readonly (ExtensionRichRun | undefined)[]): ExtensionRichRun[] {
	const present = parts.filter((part): part is ExtensionRichRun => part !== undefined);
	return present.flatMap((part, i) => (i === 0 ? [part] : [" · ", part]));
}

/** bot 那一行的方块:插件报的图标 → 桥自己带的平台小表 → 平台名头两个字(决策 31)。 */
function iconCell(platform: string, icon: string | undefined): ExtensionTableCell {
	const image = icon ?? platformIcon(platform);
	const fallback = platform.slice(0, 2) || "?";
	return image === undefined ? { fallback } : { image, fallback };
}

function connectedItem(link: BridgeLink, session: BridgeSession): ExtensionItemView {
	// 方块与药丸印**配置里那一种**,不是桥自报的那一种:两者对不上正是要看见的事
	// (token 填到另一头的插件里去了),而把自报的印出来会把那个错悄悄抹平。
	const mismatched = session.kind !== link.bridgeKind;
	const nameAndVersion = [session.name, session.version ? `v${session.version}` : undefined]
		.filter(Boolean)
		.join(" ");
	// 表画不下的那几个不能就这么没了:表头旁的行数是画出来的行数,不说一句的话主人会以为
	// 桥就驮着这么多。
	const listed = session.bots.slice(0, VIEW_LIMITS.tableRows);
	const unlisted = session.bots.length - listed.length;
	return {
		status: mismatched ? { tone: "warn", text: "连上了,但对不上" } : { tone: "ok", text: "已连接" },
		pill: mismatched ? `配置:${link.bridgeKind}` : link.bridgeKind,
		subtitle: joined([
			nameAndVersion ? clip(nameAndVersion, VIEW_LIMITS.richRun) : undefined,
			{ time: session.connectedAt, suffix: "连上" },
			session.remoteAddress
				? clip(`来自 ${session.remoteAddress}`, VIEW_LIMITS.richRun)
				: undefined,
		]),
		buttons: mismatched
			? [
					{
						label: `改成 ${KIND_LABELS[session.kind] ?? session.kind}`,
						set: { bridgeKind: session.kind },
					},
				]
			: [],
		lead: mismatched
			? [
					{
						type: "notice",
						tone: "warn",
						text: [
							{ b: `这条接入配的是 ${link.bridgeKind},连进来的却自报 ${session.kind}。` },
							"多半是 token 填到另一头的插件里去了。收发照常能用 —— BN 对两种桥的处理完全相同 —— 但面板上的名字会一直对不上,建议改掉其中一边。",
						],
					},
				]
			: [],
		blocks: [
			{
				type: "table",
				title: "它驮着的 bot",
				count: true,
				empty: "桥连上了,但它现在一个 bot 都没有 —— 那头的框架里还没登任何账号。",
				// 名字那一列定宽:几个 bot 排下来,能力记号得在同一条竖线上起排。
				columns: [
					{ kind: "icon" },
					{ kind: "text", width: 210 },
					...BRIDGE_CAPABILITIES.map((capability) => ({
						kind: "tristate" as const,
						label: CAPABILITY_LABELS[capability],
					})),
				],
				rows: listed.map((bot) => [
					iconCell(bot.platform, bot.icon),
					{
						text: clip(bot.name ?? bot.botId, VIEW_LIMITS.tableText),
						sub: clip(
							[bot.platform, bot.selfId].filter(Boolean).join(" · "),
							VIEW_LIMITS.tableText,
						),
					},
					...BRIDGE_CAPABILITIES.map((capability) => TRISTATE[bot.capabilities[capability]]),
				]),
			},
			...(unlisted > 0
				? [
						{
							type: "notice" as const,
							tone: "info" as const,
							text: `还有 ${unlisted} 个 bot 没列出来 —— 一张表最多画 ${VIEW_LIMITS.tableRows} 行。它们照样能在推送目标页挑来当连接。`,
						},
					]
				: []),
		],
	};
}

function disconnectedItem(link: BridgeLink): ExtensionItemView {
	return {
		status: { tone: "off", text: "没连上" },
		pill: link.bridgeKind,
		subtitle: "现在没有桥用这个 token 连着。",
		// 401 / 连不上这两句放在「没连上」这张卡上 —— 那才是它们真正被需要的时刻。
		blocks: [
			{
				type: "notice",
				tone: "info",
				text: [
					"插件那头要填两样:BN 地址 ",
					{ host: "extensionUrl" },
					" 与上面这个 token。填错 token 的话插件会收到 401;地址不通则是连不上 —— 两种都不会在这里留下记录。",
				],
			},
		],
	};
}

/**
 * 停用的接入握手收到的是 **503**(桥会退避重连),不是 401 —— 迁过来之前那一页给它挂的是没连上
 * 那段排错说明,是错的(ADR-0019 决策 24 的五处之一)。
 *
 * 例外是 **token 为空**(脱敏备份恢复回来就是这样):空 token 永远不匹配(`tokens.ts`),upgrade
 * 回的是 401 而不是 503,插件按协议当成配置错、不再重连 —— 这时说「启用就回来」是假话。
 */
function pausedItem(link: BridgeLink): ExtensionItemView {
	return {
		status: { tone: "off", text: "已停用" },
		pill: link.bridgeKind,
		subtitle:
			link.token === ""
				? "停用了,而且还没有 token —— 桥连过来只会收到 401,插件会当成配置错、不再重连,光启用回不来。先生成一个 token,连同 BN 地址填进插件那头。"
				: "停用了 —— 桥用这个 token 连过来会被回 503,它会自己退避重连,启用就回来。",
	};
}

export function bridgeView(
	links: readonly BridgeLink[],
	sessionOf: (linkId: string) => BridgeSession | undefined,
): ExtensionView {
	let online = 0;
	const items: Record<string, ExtensionItemView> = {};
	for (const link of links) {
		const session = sessionOf(link.id);
		if (session) online += session.bots.length;
		// 停用了但会话还没断干净的那一瞬,照连着的画 —— 状态由 BN 盖成「已停用」。
		items[link.id] = session
			? connectedItem(link, session)
			: link.enabled
				? disconnectedItem(link)
				: pausedItem(link);
	}
	return {
		summary: { tone: "ok", text: [{ b: String(online) }, " 个 bot 在线"] },
		page: [
			{
				type: "copy",
				label: "BN 地址",
				value: { host: "extensionUrl" },
				note: [
					"这是",
					{ b: "桥那台机器" },
					"要访问得到的地址 —— BN 在 NAS 上时别填 ",
					{ mono: "127.0.0.1" },
					"。",
				],
			},
		],
		items: { links: items },
	};
}
