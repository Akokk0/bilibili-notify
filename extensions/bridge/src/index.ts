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
 * ⚠️ 配置对账(接入被删 / 被停用 / token 换了 → 踢掉那条会话)**不在这里接** ——
 * 宿主在配置动过之后会挨个叫 `adapter.reconcile(connections)`,桥那份实现在 `adapter.ts`。
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

	// `source` 与 `server` 互相要对方:端点靠连接名单认 token,adapter 靠端点发消息。
	// 现读的闭包把这个环拆开 —— 两者都只在**运行时**才碰对方,那时早就都建好了。
	let source: PushSourceHandle<BridgeConnectionConfig> | undefined;
	const connections = (): readonly ExtensionConnectionView<BridgeConnectionConfig>[] =>
		source?.connections() ?? [];

	const server = createBridgeServer({
		logger: ctx.logger,
		serverVersion: ctx.hostVersion,
		// 现读配置:面板上重新生成 token,下一次连接立刻按新的判。
		resolveToken: (token) => resolveBridgeToken(connections(), token),
		// 认得这个 token 不等于现在收它:这条接入停用了回 503(退避重连),而不是 401
		// (配置错了别重连)。拓展的总开关不在这儿判 —— 关着的拓展根本不会被加载。
		accepts: (connectionId) =>
			connections().some((connection) => connection.id === connectionId && connection.enabled),
		// 群消息**恒要含链接的那些**,不跟着链接解析的开关走:订阅只在握手时下发一次,
		// 跟着开关走的话主人开完链接解析,已经连着的那条桥仍然一条群消息都不发,而且
		// 要等它自己重连才恢复。要不要解析在本地判(link-parser 自己会看开关)。
		inbound: () => ({ private: true, group: "with-links" }),
		onInbound: (session, frame) =>
			routeBridgeInbound(
				frame,
				{ connectionId: session.connectionId, bots: session.bots },
				ctx.inbound,
			),
		onSessionChange: (connectionId, connected) =>
			ctx.logger.info(`${connectionId} ${connected ? "已连接" : "已断开"}`),
	});
	ctx.onDispose(() => server.dispose());
	ctx.onUpgrade(server.upgrade);

	source = ctx.registerPushSource({
		adapter: createBridgeAdapter({ server, connections, mountPath, blobs }),
		descriptor: DESCRIPTOR,
		configSchema: BridgeConnectionConfigSchema,
		configFields: BRIDGE_CONFIG_FIELDS,
	});

	// 面板要的活口状态。**从配置那一头看起**,不是从活着的会话:最需要看见的恰恰是
	// 「配了但没连上」那条,而它在会话表里根本不存在。
	ctx.publishStatus(() => ({
		sessions: connections().map((connection) => {
			const live = server.getSession(connection.id);
			if (!live) return { connectionId: connection.id, connected: false, bots: [] };
			return {
				connectionId: connection.id,
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
