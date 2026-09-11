/**
 * 桥 adapter —— 矩阵里唯一一个**方言不是自己写的**实现。
 *
 * 别的 adapter 要懂对面的报文长什么样;这一个只要把 {@link NotificationPayload} 译成
 * 协议帧交出去,编解码全在桥那一侧(它借的是 koishi / AstrBot 已经写好的适配器)。所以
 * 这里没有任何平台名 —— 桥后面挂着 telegram 还是 discord,BN 一概不预设。
 *
 * 它按**分发键**认领,而那个键**由宿主按拓展 id 填**(ADR-0012 决策 28)—— 自报的话,
 * 一个拓展可以声明 `"onebot"` 把内置那条连接的推送整个截走。归属是宿主的判断。
 * 协议规范在 `../PROTOCOL.md`。
 */

import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	ExtensionConnectionView,
	NotificationPayload,
	PayloadSegment,
	PlatformAdapter,
	ProbeResult,
	PushTarget,
} from "@bilibili-notify/extension";
import { BRIDGE_BLOB_SEGMENT, type BridgeBlobStore } from "./blob.js";
import type { BridgeConnectionConfig } from "./config.js";
import {
	BRIDGE_CLOSE_CODES,
	type BridgeBot,
	type BridgeMessage,
	type BridgeSegment,
} from "./contract.js";
import { stripMarkdown } from "./markdown.js";
import type { BridgeSendRequest, BridgeServer, BridgeSession } from "./server.js";
import type { BridgeLink } from "./settings.js";

/** 一条桥连接(一个借来的 bot)—— 宿主已经拿本拓展那份 zod 把 config 解好了(决策 30)。 */
type BridgeConnection = ExtensionConnectionView<BridgeConnectionConfig>;

export interface BridgeAdapterOptions {
	server: BridgeServer;
	/**
	 * 属于自己的连接,**现读**。别缓存 —— 缓存与真相会漂,症状是「面板上停用了它还连着」。
	 */
	connections(): readonly BridgeConnection[];
	/** 接入名单(设置里那份),**现读**,理由同上。 */
	links(): readonly BridgeLink[];
	/**
	 * 宿主分配给本拓展的挂载前缀(`ctx.mount()` 的返回值,形如 `/ext/bridge`)。
	 * **拓展不该知道自己挂在哪**(决策 12),拼绝对地址时才用得上它。
	 */
	mountPath: string;
	/**
	 * 图片仓库 —— 只用得着「存进去」那一半(取图是路由的事)。
	 *
	 * ⚠️ 拼出来的 URL **只保证桥自己可达**:桥要把图交给平台去拉必须先自己下载(协议
	 * 文档 §9 那条大写的警告)。BN 常在 NAS 上,外网进不来,而平台拉不到是**静默失败**。
	 * 所以 URL 拿的是**那条桥自己连进来时用的地址**({@link BridgeSession.origin})。
	 */
	blobs: Pick<BridgeBlobStore, "put">;
}

/** 「把这张图存起来,给我一条**这条桥**取得到的 URL」。 */
type BlobUrl = (buffer: Buffer, mime: string) => string;

/**
 * 主人写的那段文字**这一发该怎么出去** —— 认 markdown 就原样,不认就剥成纯文本
 * (ADR-0012 决策 32)。逐 bot 决定,所以它是投影的入参而不是模块级的开关。
 */
type PlainText = (text: string) => string;

type SessionTarget = Extract<PushTarget, { kind: "session" }>;

type Located =
	| {
			ok: true;
			connection: BridgeConnection;
			link: BridgeLink;
			session: BridgeSession;
			bot: BridgeBot;
	  }
	| { ok: false; err: string };

type Resolved =
	| { ok: true; bot: BridgeBot; target: SessionTarget; session: BridgeSession }
	| { ok: false; err: string };

function toSegment(segment: PayloadSegment, blobUrl: BlobUrl, plain: PlainText): BridgeSegment {
	switch (segment.type) {
		case "text":
			return { type: "text", text: plain(segment.text) };
		case "image":
			return {
				type: "image",
				url: blobUrl(segment.buffer, segment.mime),
				mime: segment.mime,
			};
		case "link":
			// `href` 不过 —— 它是地址,不是主人写的排版。标题过。
			return { type: "link", href: segment.href, title: plain(segment.title ?? "") || undefined };
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
function toBridgeMessage(
	payload: NotificationPayload,
	blobUrl: BlobUrl,
	plain: PlainText,
): BridgeMessage {
	switch (payload.kind) {
		case "text":
			return { kind: "text", text: plain(payload.text) };
		case "image":
			return {
				kind: "image",
				url: blobUrl(payload.image.buffer, payload.image.mime),
				mime: payload.image.mime,
				caption: payload.caption === undefined ? undefined : plain(payload.caption),
			};
		case "composite":
			return {
				kind: "composite",
				segments: payload.segments.map((segment) => toSegment(segment, blobUrl, plain)),
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
			// 小程序卡那几格**不过剥离**:它们是卡片的结构化字段,由平台自己渲染,
			// 从来不是一段 markdown 正文。
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
	const blobPrefix = `${opts.mountPath}${BRIDGE_BLOB_SEGMENT}`;
	/**
	 * 上一轮对账时每条桥接入的 token。**只为了发现「token 被重新生成了」** —— 会话本身
	 * 不带 token,而重新生成 token 却踢不掉旧连接的话,那个动作就等于没做。
	 *
	 * 🔴 **建 adapter 这一刻就用当前名单打底**,不能等第一次 `reconcile()`:宿主开机那趟
	 * 对账跑在拓展装载**之前**,桥根本没机会先对一次账。空表起步的话 `before === undefined`
	 * 会把「重启之后第一次重新生成 token」当成新接入静默放过 —— 旧会话拿着已经作废的
	 * token 继续收推送,而面板上一切正常。
	 */
	const lastTokens = new Map<string, string>(opts.links().map((link) => [link.id, link.token]));

	/**
	 * 「这条连接现在通到哪个 bot」—— `isAvailable` / `send` / `probe` / `capabilities` 共用
	 * **这一份**判据。
	 *
	 * 里头那句 bot 名单检查是关键:一条接入后面挂着好几个 bot,**bot 掉了接入还在**。
	 * 不看名单就发,等于把推送扔进黑洞再等 30 秒超时,用户看到的是「发了一半才失败」。
	 */
	function locate(connection: Connection): Located {
		// 从**自己那份名单**里找,而不是自己去 parse 一条来路不明的连接:宿主只把属于这个
		// 拓展、且 config 解得出形状的那些交过来(决策 30)。找不到就不是我的活。
		const mine = opts.connections().find((candidate) => candidate.id === connection.id);
		if (!mine) return { ok: false, err: "不是桥连接" };
		const link = opts.links().find((candidate) => candidate.id === mine.config.link);
		if (!link) return { ok: false, err: "这条连接绑的那条接入已经删了" };
		if (!link.enabled) return { ok: false, err: `接入「${link.name}」已停用` };
		const session = server.getSession(link.id);
		if (!session) return { ok: false, err: `接入「${link.name}」没连着` };
		const bot = session.bots.find((candidate) => candidate.botId === mine.config.botId);
		if (!bot) return { ok: false, err: `桥上现在没有这个 bot(${mine.config.botId})` };
		return { ok: true, connection: mine, link, session, bot };
	}

	function resolve(connection: Connection, target: PushTarget): Resolved {
		const located = locate(connection);
		if (!located.ok) return located;
		if (target.kind !== "session") return { ok: false, err: "桥只发会话目标" };
		if (!located.connection.enabled) return { ok: false, err: "这条连接已停用" };
		if (!target.enabled) return { ok: false, err: "这个推送目标已停用" };
		return { ok: true, bot: located.bot, target, session: located.session };
	}

	/**
	 * 桥报的能力翻成宿主那份。今天宿主只问一项(小程序卡);三态原样对应,`checkedAt`
	 * 取会话建立那一刻 —— 能力是握手时报的。
	 */
	function capabilitiesOf(located: Extract<Located, { ok: true }>): ConnectionCapabilities {
		const state = located.bot.capabilities.miniAppCard;
		const checkedAt = located.session.connectedAt;
		if (state === "supported") return { miniAppCard: { state, checkedAt } };
		if (state === "unsupported") {
			return { miniAppCard: { state, reason: "桥报的:这个 bot 发不了小程序卡", checkedAt } };
		}
		return { miniAppCard: { state: "unknown", reason: "桥没报这一项" } };
	}

	return {
		// 分发键由宿主按拓展 id 覆盖 —— 这里填什么都会被换掉(决策 28)。
		platforms: [],

		isAvailable(connection: Connection, target: PushTarget): boolean {
			return resolve(connection, target).ok;
		},

		async probe(connection: Connection): Promise<ProbeResult> {
			// 名单上通了才打网络:真打一趟 ping → pong,面板上那个「N ms」是到插件的往返,
			// 不是「查了一下名单」的 0ms。
			const located = locate(connection);
			if (!located.ok) return { ok: false, latencyMs: 0, err: located.err };
			const outcome = await server.ping(located.link.id);
			return { ok: outcome.ok, latencyMs: outcome.latencyMs, err: outcome.err };
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
				`${resolved.session.origin}${blobPrefix}/${blobs.put(buffer, mime)}`;
			// 拿不准就别发星号:只有明确报了 `supported` 才原样发(决策 32)。
			const plain: PlainText =
				resolved.bot.capabilities.markdown === "supported" ? (text) => text : stripMarkdown;
			const request: BridgeSendRequest = {
				botId: resolved.bot.botId,
				platform: resolved.bot.platform,
				target: {
					scope,
					address: resolved.target.address,
					parentAddress: resolved.target.parentAddress,
				},
				message: toBridgeMessage(payload, blobUrl, plain),
			};
			const outcome = await server.send(resolved.session.linkId, request);
			return { ok: outcome.ok, latencyMs: Date.now() - t0, err: outcome.err };
		},

		/**
		 * 配置对账。桥是自己连过来的,所以这里没有「去建连」那一半 —— 只有**该踢的踢掉**:
		 * 接入没了、被停用了、token 被重新生成了。看的是**接入名单**(设置),不是连接 ——
		 * 连接是一个 bot,删一条连接不该断谁;宿主按连接变更叫它时也无妨,一样对得上。
		 *
		 * 从**活着的会话**看起而不是从配置看起:配置里那条早就删了,能告诉我们「还有谁连着」
		 * 的只有会话表。
		 */
		reconcile(): void {
			const links = new Map<string, BridgeLink>();
			for (const link of opts.links()) links.set(link.id, link);
			for (const session of server.listSessions()) {
				const link = links.get(session.linkId);
				if (!link) {
					server.disconnect(session.linkId, BRIDGE_CLOSE_CODES.revoked);
					continue;
				}
				if (!link.enabled) {
					// 停用不是吊销:配置全留、重开即恢复,所以给的是「可以退避重连」那个码。
					server.disconnect(session.linkId, BRIDGE_CLOSE_CODES.disabled);
					continue;
				}
				const before = lastTokens.get(session.linkId);
				if (before !== undefined && before !== link.token) {
					server.disconnect(session.linkId, BRIDGE_CLOSE_CODES.revoked);
				}
			}
			lastTokens.clear();
			for (const [id, link] of links) lastTokens.set(id, link.token);
		},

		/**
		 * 能力按 bot 答 —— 一条连接就是一个 bot(决策 45),所以答得准。这两个方法曾经刻意
		 * 不实现:那时连接是「一条接入」,底下同时挂着 QQ 与 telegram,跨 bot 合并出来的答案
		 * 对谁都不对。没连着 / 没这个 bot 时答「还不知道」,带上原因。
		 */
		capabilities(connection: Connection): ConnectionCapabilities {
			const located = locate(connection);
			if (!located.ok) return { miniAppCard: { state: "unknown", reason: located.err } };
			return capabilitiesOf(located);
		},

		async probeCapabilities(connection: Connection): Promise<ConnectionCapabilities> {
			// 不打网络:能力是桥握手时报的,再问一次也是同一份。
			const located = locate(connection);
			if (!located.ok) return { miniAppCard: { state: "unknown", reason: located.err } };
			return capabilitiesOf(located);
		},
	};
}
