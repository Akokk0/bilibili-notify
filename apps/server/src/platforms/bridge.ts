/**
 * 桥 adapter —— 矩阵里唯一一个**方言不是自己写的**实现。
 *
 * 别的 adapter 要懂对面的报文长什么样;这一个只要把 {@link NotificationPayload} 译成
 * 协议帧交出去,编解码全在桥那一侧(它借的是 koishi / AstrBot 已经写好的适配器)。所以
 * 这里没有任何平台名 —— 桥后面挂着 telegram 还是 discord,BN 一概不预设。
 *
 * 它按**分发键** `"bridge"` 认领:一条桥连接没有 `platform`,`connectionDispatchKey`
 * 给它的就是这个键。协议规范在 `docs/protocol/bridge.md`。
 */

import {
	BRIDGE_CLOSE_CODES,
	type BridgeBot,
	type BridgeMessage,
	type BridgeSegment,
} from "@bilibili-notify/contract";
import type { PlatformAdapter, ProbeResult } from "@bilibili-notify/internal";
import {
	BRIDGE_DISPATCH_KEY,
	type Connection,
	connectionDispatchKey,
	type DeliveryResult,
	type Logger,
	type NotificationPayload,
	type PayloadSegment,
	type PushTarget,
} from "@bilibili-notify/internal";
import { BRIDGE_BLOB_PATH, type BridgeBlobStore } from "../bridge/blob.js";
import { asBridgeConnection, type BridgeConnection } from "../bridge/connection.js";
import type { BridgeSendRequest, BridgeServer, BridgeSession } from "../bridge/server.js";

export interface BridgeAdapterOptions {
	server: BridgeServer;
	/**
	 * 图片仓库 —— 只用得着「存进去」那一半(取图是路由的事)。
	 *
	 * ⚠️ 拼出来的 URL **只保证桥自己可达**:桥要把图交给平台去拉必须先自己下载(协议
	 * 文档 §9 那条大写的警告)。BN 常在 NAS 上,外网进不来,而平台拉不到是**静默失败**。
	 * 所以 URL 拿的是**那条桥自己连进来时用的地址**({@link BridgeSession.origin})。
	 */
	blobs: Pick<BridgeBlobStore, "put">;
	logger: Logger;
}

/** 「把这张图存起来,给我一条**这条桥**取得到的 URL」。 */
type BlobUrl = (buffer: Buffer, mime: string) => string;

type SessionTarget = Extract<PushTarget, { kind: "session" }>;

type Resolved =
	| { ok: true; bot: BridgeBot; target: SessionTarget; session: BridgeSession }
	| { ok: false; err: string };

function toSegment(segment: PayloadSegment, blobUrl: BlobUrl): BridgeSegment {
	switch (segment.type) {
		case "text":
			return { type: "text", text: segment.text };
		case "image":
			return {
				type: "image",
				url: blobUrl(segment.buffer, segment.mime),
				mime: segment.mime,
			};
		case "link":
			return { type: "link", href: segment.href, title: segment.title };
		case "at-all":
			// 桥按 `atAll` 能力决定翻成真 @全体还是降级成一句文字 —— 那是它那侧的事。
			return { type: "at-all" };
	}
}

/**
 * `NotificationPayload` → wire。**穷尽的 switch,没有 default** —— payload 加一个 kind
 * 而这里没跟上,函数就少一条 return 路径、编译不过。有 default 的话那个新 kind 会在
 * 运行时静默发不出去。
 *
 * 唯一的实质转换是**图**:`Buffer` 过不了 JSON,换成一次性取图 URL。已经是远端 URL 的
 * (图廊、小程序卡封面)原样透传 —— 它们本来就公网可达,再倒一手只是白占内存。
 */
function toBridgeMessage(payload: NotificationPayload, blobUrl: BlobUrl): BridgeMessage {
	switch (payload.kind) {
		case "text":
			return { kind: "text", text: payload.text };
		case "image":
			return {
				kind: "image",
				url: blobUrl(payload.image.buffer, payload.image.mime),
				mime: payload.image.mime,
				caption: payload.caption,
			};
		case "composite":
			return {
				kind: "composite",
				segments: payload.segments.map((segment) => toSegment(segment, blobUrl)),
			};
		case "forward-images":
			return {
				kind: "forward-images",
				images: payload.images.map((image) => ({
					url: image.url,
					width: image.width,
					height: image.height,
				})),
				forward: payload.forward,
			};
		case "miniapp-card":
			return {
				kind: "miniapp-card",
				title: payload.title,
				desc: payload.desc,
				picUrl: payload.picUrl,
				path: payload.path,
				jumpUrl: payload.jumpUrl,
			};
	}
}

export function createBridgeAdapter(opts: BridgeAdapterOptions): PlatformAdapter {
	const { server, blobs } = opts;
	/**
	 * 上一轮对账时每条桥接入的 token。**只为了发现「token 被重新生成了」** —— 会话本身
	 * 不带 token,而重新生成 token 却踢不掉旧连接的话,那个动作就等于没做。
	 */
	const lastTokens = new Map<string, string>();

	/**
	 * 「这条推送现在发得出去吗」的**唯一**判据,`isAvailable` 与 `send` 共用一份。
	 *
	 * 里头那句 bot 名单检查是关键:一条桥连接后面挂着好几个 bot,**bot 掉了连接还在**。
	 * 不看名单就发,等于把推送扔进黑洞再等 30 秒超时,用户看到的是「发了一半才失败」。
	 */
	function resolve(connection: Connection, target: PushTarget): Resolved {
		const bridge = asBridgeConnection(connection);
		if (!bridge) {
			return { ok: false, err: `不是桥接入(${connectionDispatchKey(connection)})` };
		}
		if (target.kind !== "session") return { ok: false, err: "桥只发会话目标" };
		if (!bridge.enabled) return { ok: false, err: "这条桥接入已停用" };
		if (!target.enabled) return { ok: false, err: "这个推送目标已停用" };
		if (!target.botId) return { ok: false, err: "这个目标没记是哪个 bot" };
		const session = server.getSession(bridge.id);
		if (!session) return { ok: false, err: "桥没连着" };
		const bot = session.bots.find((candidate) => candidate.botId === target.botId);
		if (!bot) return { ok: false, err: `桥上现在没有这个 bot(${target.botId})` };
		return { ok: true, bot, target, session };
	}

	return {
		platforms: [BRIDGE_DISPATCH_KEY],

		isAvailable(connection: Connection, target: PushTarget): boolean {
			return resolve(connection, target).ok;
		},

		async probe(connection: Connection): Promise<ProbeResult> {
			// 不打网络:桥是**自己连过来的**,连着就是通,没连上就是不通。
			const connected = server.getSession(connection.id) !== undefined;
			return {
				ok: connected,
				latencyMs: 0,
				err: connected ? undefined : "桥没连过来",
			};
		},

		async send(
			connection: Connection,
			target: PushTarget,
			payload: NotificationPayload,
			pushOpts: { private?: boolean } = {},
		): Promise<DeliveryResult> {
			const t0 = Date.now();
			const resolved = resolve(connection, target);
			if (!resolved.ok) return { ok: false, latencyMs: 0, err: resolved.err };
			// `private` 是**覆盖标志**,不是「这一发是不是私聊」:调用方恒传
			// `{ private: false }`,所以只能读 `=== true`。onebot 上把它当后者读、拿
			// `??` 兜底,结果 scope 本来就是 private 的目标永远走了群那一支。
			const scope = pushOpts.private === true ? ("private" as const) : resolved.target.scope;
			// 取图 URL 拿**这条桥自己连进来时用的地址**拼 —— BN 猜不出别人从哪儿找得到它。
			const blobUrl: BlobUrl = (buffer, mime) =>
				`${resolved.session.origin}${BRIDGE_BLOB_PATH}/${blobs.put(buffer, mime)}`;
			const request: BridgeSendRequest = {
				botId: resolved.bot.botId,
				platform: resolved.target.platform,
				target: {
					scope,
					address: resolved.target.address,
					parentAddress: resolved.target.parentAddress,
				},
				message: toBridgeMessage(payload, blobUrl),
			};
			const outcome = await server.send(connection.id, request);
			return { ok: outcome.ok, latencyMs: Date.now() - t0, err: outcome.err };
		},

		/**
		 * 配置对账。桥是自己连过来的,所以这里没有「去建连」那一半 —— 只有**该踢的踢掉**:
		 * 接入没了、被停用了、token 被重新生成了。
		 *
		 * 从**活着的会话**看起而不是从配置看起:配置里那条早就删了,能告诉我们「还有谁连着」
		 * 的只有会话表。
		 */
		reconcile(connections: readonly Connection[]): void {
			const bridges = new Map<string, BridgeConnection>();
			for (const raw of connections) {
				const connection = asBridgeConnection(raw);
				if (connection) bridges.set(connection.id, connection);
			}
			for (const session of server.listSessions()) {
				const connection = bridges.get(session.connectionId);
				if (!connection) {
					server.disconnect(session.connectionId, BRIDGE_CLOSE_CODES.revoked);
					continue;
				}
				if (!connection.enabled) {
					// 停用不是吊销:配置全留、重开即恢复,所以给的是「可以退避重连」那个码。
					server.disconnect(session.connectionId, BRIDGE_CLOSE_CODES.disabled);
					continue;
				}
				const before = lastTokens.get(session.connectionId);
				if (before !== undefined && before !== connection.config.token) {
					server.disconnect(session.connectionId, BRIDGE_CLOSE_CODES.revoked);
				}
			}
			lastTokens.clear();
			for (const [id, connection] of bridges) lastTokens.set(id, connection.config.token);
		},

		/**
		 * `capabilities` / `probeCapabilities` **刻意不实现**。
		 *
		 * 桥报的能力是 **per-bot** 的(一条 koishi 连接底下可能同时挂着 QQ 与 telegram),
		 * 而这两个方法的入参只有连接。跨 bot 合并出来的答案对谁都不对,所以宁可不答 ——
		 * 调用方按「没实现 = 什么都不支持」处理,那是保守的一侧。
		 *
		 * 要答得准,得先把 `MultiplexSink.connectionCapabilities` 与契约那张两级 Map
		 * 再扩一级到 bot。那是独立的一片活。
		 */
	};
}
