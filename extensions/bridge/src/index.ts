/**
 * 机器人框架桥接 —— BN 的第一个拓展(ADR-0012 决策 3)。
 *
 * 从前这八个零件散在核心里,由 `apps/server/src/index.ts` 一根根接起来;现在整块住在这儿,
 * **一切副作用都从 `ctx` 过**(决策 11:那是「卸载得干净」的唯一承重条件)。搬家没有改
 * 任何协议语义 —— 帧、close code、握手次序全是原样。
 *
 * 它挂着的四样:
 *
 * - **WS 端点**(`ctx.onUpgrade`)—— 桥主动连过来的那条,地址 `ws://<BN>/ext/bridge`
 * - **HTTP 取图口**(`ctx.mount`)—— `send` 帧里那条一次性图片 URL 背后的东西
 * - **推送源**(`ctx.registerPushSource`)—— 矩阵里那个按分发键认领的 adapter
 * - **入站**(`ctx.inbound`)—— 桥驮上来的私聊 / 群消息,归一化在这一侧做完
 *
 * 两份配置(ADR-0012 决策 45):**接入**(koishi / AstrBot 实例 + token)住拓展自己的设置,
 * 面板在拓展页建;**连接**是从接入驮着的 bot 里挑出来的一个 bot,面板在推送目标页建。
 * 对账(接入被删 / 被停用 / token 换了 → 踢掉那条会话)的实现在 `adapter.ts`,设置一动
 * 就叫它;宿主按连接变更叫的那一下也对得上。
 */

import type {
	ExtensionConnectionView,
	ExtensionContext,
	PushSourceHandle,
} from "@bilibili-notify/extension";
import { createBridgeAdapter } from "./adapter.js";
import { createBridgeBlobStore } from "./blob.js";
import { createBridgeFetchHandler } from "./blob-route.js";
import {
	BRIDGE_CONFIG_FIELDS,
	type BridgeConnectionConfig,
	BridgeConnectionConfigSchema,
} from "./config.js";
import { routeBridgeInbound } from "./inbound.js";
import { createBridgeServer } from "./server.js";
import { type BridgeLink, BridgeSettingsSchema } from "./settings.js";
import { resolveBridgeToken } from "./tokens.js";

/** 面板上这一档叫什么、什么颜色。少掉 `connectors` 那一格 —— 拓展连接没有「怎么连」。 */
const DESCRIPTOR = {
	label: "机器人框架桥接",
	shortLabel: "桥接",
	tint: "#a855f7",
	targetKind: "session",
	scopes: ["private", "group"],
	addressNouns: {},
	// 桥驮上来的消息 BN 真的收得到 —— 入站那一路就是它接的。
	inbound: true,
	// 能不能 @全体是 **per-bot** 的(一条连接底下可能同时挂着 QQ 与 telegram),
	// 每个 bot 在握手时自己报;这一格是「这个平台整体上行不行」,给保守的那一侧。
	atAll: false,
} as const;

export function activate(ctx: ExtensionContext): void {
	const blobs = createBridgeBlobStore({ ctx });
	ctx.onDispose(() => blobs.dispose());

	// 先要挂载点:取图 URL 拿它拼,而 adapter 一注册就可能被叫去发消息。
	const mountPath = ctx.mount(createBridgeFetchHandler({ store: blobs, logger: ctx.logger }));

	// 接入名单住设置里,**现读**:面板上重新生成 token,下一次连接立刻按新的判。
	const settings = ctx.settings(BridgeSettingsSchema);
	const links = (): readonly BridgeLink[] => settings.get()?.links ?? [];

	// `source` 与 `server` 互相要对方:端点靠接入名单认 token,adapter 靠端点发消息。
	// 现读的闭包把这个环拆开 —— 两者都只在**运行时**才碰对方,那时早就都建好了。
	let source: PushSourceHandle<BridgeConnectionConfig> | undefined;
	const connections = (): readonly ExtensionConnectionView<BridgeConnectionConfig>[] =>
		source?.connections() ?? [];

	/**
	 * 这条接入上的这个 bot 绑成了哪条连接。**停用的也算绑过** —— 「绑没绑过」与「收不收它的
	 * 消息」是两问,后者在 `onInbound` 里按 `enabled` 再判一次。
	 *
	 * 这是**逐帧**那一路(每条入站消息一次);面板那一排(`listBots`)一次要问一整份名单,
	 * 所以它自己建一张查表,别改成叫这个。
	 */
	const boundConnection = (
		linkId: string,
		botId: string,
	): ExtensionConnectionView<BridgeConnectionConfig> | undefined =>
		connections().find((c) => c.config.link === linkId && c.config.botId === botId);

	/**
	 * 「这个 bot 自报的平台跟名单里的对不上」只说一次。每条入站消息都会走一遍那道比对,
	 * 记一行的话一个嘴碎的群能把日志刷穿;而这是**桥的 bug**,说一次就够查了。
	 */
	const platformMismatches = new Set<string>();
	function warnPlatformMismatch(botId: string, declared: string, actual: string): void {
		const key = `${botId}:${declared}→${actual}`;
		if (platformMismatches.has(key)) return;
		platformMismatches.add(key);
		ctx.logger.warn(`${botId} 的入站帧自报 ${declared},但名单里它是 ${actual} —— 按名单算`);
	}

	const server = createBridgeServer({
		logger: ctx.logger,
		// 心跳与看门狗那两只定时器从 ctx 走 —— 裸 `setInterval` 是禁止的(决策 11)。
		ctx,
		serverVersion: ctx.hostVersion,
		resolveToken: (token) => resolveBridgeToken(links(), token),
		// 认得这个 token 不等于现在收它:这条接入停用了回 503(退避重连),而不是 401
		// (配置错了别重连)。拓展的总开关不在这儿判 —— 关着的拓展根本不会被加载。
		accepts: (linkId) => links().some((link) => link.id === linkId && link.enabled),
		// 群消息**恒要含链接的那些**,不跟着链接解析的开关走:订阅只在握手时下发一次,
		// 跟着开关走的话主人开完链接解析,已经连着的那条桥仍然一条群消息都不发,而且
		// 要等它自己重连才恢复。要不要解析在本地判(link-parser 自己会看开关)。
		inbound: () => ({ private: true, group: "with-links" }),
		onInbound: (session, frame) => {
			// 只有绑成了连接的 bot 收到的消息才归 BN:没绑的 bot 在 BN 眼里不存在,它收到
			// 的指令也没有一条连接能拿来回。记 debug 不记 warn —— 桥驮上来的每条都会经这儿。
			const bound = boundConnection(session.linkId, frame.botId);
			if (!bound) {
				ctx.logger.debug(`${session.linkId} 上的 ${frame.botId} 没绑成连接,这条消息不收`);
				return;
			}
			// 停用的连接**进也不收**:只拦出的那一半的话,指令照跑、链接照解析、图照渲染,
			// 一路走到要发回去那步才失败。停用的意思是「这个 bot 现在跟 BN 没关系」。
			if (!bound.enabled) {
				ctx.logger.debug(`连接「${bound.name}」已停用,${frame.botId} 这条消息不收`);
				return;
			}
			routeBridgeInbound(
				frame,
				{
					connectionId: bound.id,
					bots: session.bots,
					onPlatformMismatch: (declared, actual) =>
						warnPlatformMismatch(frame.botId, declared, actual),
				},
				ctx.inbound,
			);
		},
		onBots: (linkId, bots) => {
			// 名单是**会再变的**:插件探完能力会重发一份带答案的快照,bot 上下线也会。不喊
			// 这一声的话面板上那张能力矩阵永远停在握手那一份 —— 探测结果要切一次页才看得见。
			ctx.logger.debug(`${linkId} 报了 ${bots.length} 个 bot`);
			ctx.statusChanged();
		},
		onSessionChange: (linkId, connected) => {
			ctx.logger.info(`${linkId} ${connected ? "已连接" : "已断开"}`);
			// 面板那张卡要当场变绿 / 变灰,不能等主人切页。
			ctx.statusChanged();
		},
	});
	ctx.onDispose(() => server.dispose());
	ctx.onUpgrade(server.upgrade);

	const adapter = createBridgeAdapter({ server, connections, links, mountPath, blobs });
	source = ctx.registerPushSource({
		adapter,
		descriptor: DESCRIPTOR,
		configSchema: BridgeConnectionConfigSchema,
		configFields: BRIDGE_CONFIG_FIELDS,
		// 推送目标页「新建连接」挑的那一排:每条**连着**的接入驮着的每个 bot。config 就是
		// 那条连接要存的东西;`boundTo` 让面板标出「已加过」。
		listBots: () => {
			// 查表建**一次**。`connections()` 是现读的深拷贝,逐个 bot 去查等于把整张连接表
			// 拷一遍又一遍。键里那个 `\0` 是分隔符 —— `botId` 是开放字符串(平台自己定的),
			// 拿冒号拼会和 `telegram:12345` 这种撞上。
			const boundTo = new Map(
				connections().map((c) => [`${c.config.link}\0${c.config.botId}`, c.id]),
			);
			return links().flatMap((link) => {
				const session = server.getSession(link.id);
				if (!session) return [];
				return session.bots.map((bot) => ({
					config: { link: link.id, botId: bot.botId },
					platform: bot.platform,
					name: bot.name,
					selfId: bot.selfId,
					icon: bot.icon,
					via: link.name,
					boundTo: boundTo.get(`${link.id}\0${bot.botId}`),
				}));
			});
		},
	});
	// 接入动了(删 / 停用 / 换 token)→ 该踢的踢掉。宿主只在**连接**动了时叫 reconcile,而
	// 桥的对账看的是接入名单(现读),那个参数它用不着 —— 给空表就是这个意思。
	settings.onChange(() => adapter.reconcile?.([]));

	// 面板要的活口状态。**从接入名单那一头看起**,不是从活着的会话:最需要看见的恰恰是
	// 「配了但没连上」那条,而它在会话表里根本不存在。
	ctx.publishStatus(() => ({
		sessions: links().map((link) => {
			const live = server.getSession(link.id);
			if (!live) return { linkId: link.id, connected: false, bots: [] };
			return {
				linkId: link.id,
				connected: true,
				kind: live.kind,
				name: live.name,
				version: live.version,
				connectedAt: live.connectedAt,
				remoteAddress: live.remoteAddress,
				bots: [...live.bots],
			};
		}),
	}));
}
