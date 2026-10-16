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
 * - **入站**(适配器上下文的 `ctx.inbound`,`start(ctx)` 时存在适配器里)—— 桥驮上来的私聊 / 群消息,归一化在这一侧做完
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
import { type BridgeConnectionConfig, BridgeConnectionConfigSchema } from "./config.js";
import { createBridgeServer } from "./server.js";
import { type BridgeLink, BridgeSettingsSchema } from "./settings.js";
import { resolveBridgeToken } from "./tokens.js";
import { bridgeView } from "./view.js";

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
	 * 这是**逐帧**那一路(每条入站消息一次);候选那一排(适配器的 `listConnectionCandidates`)一次要问一整份名单,
	 * 所以它自己建一张查表,别改成叫这个。
	 */
	const boundConnection = (
		linkId: string,
		botId: string,
	): ExtensionConnectionView<BridgeConnectionConfig> | undefined =>
		connections().find((c) => c.config.link === linkId && c.config.botId === botId);

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
		// 要等它自己重连才恢复。要不要解析在本地判(link-previewer 自己会看开关)。
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
			// 入站口只在适配器的 `start(ctx)` 里拿得到:经适配器交进去,宿主核归属、按连接补平台。
			adapter.deliverInbound(frame, { connectionId: bound.id, bots: session.bots });
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
	// 面板上这一档叫什么、什么颜色,写在清单的 `contributes.push.display` 里(ADR-0019 决策 16);
	// 连接是从 bot 里挑出来的,没有一栏要人填,所以清单里也没有连接配置项。
	source = ctx.registerPushSource({
		adapter,
		configSchema: BridgeConnectionConfigSchema,
	});
	// 接入动了(删 / 停用 / 换 token)→ 该踢的踢掉。宿主只在**连接**动了时才经 `ctx` 叫它对账,
	// 而桥的对账看的是接入名单(设置,现读),所以设置动了这里直接叫。
	settings.onChange(() => adapter.reconcile());

	// 面板照着画的视图(ADR-0019 决策 20 / 39):四种样子、「对不上」、bot 表都由这里算好交出去。
	// 走 `publishView`,回调要同步交回 —— 会话表是现成的内存,本来就不用等。
	// 设置一动也喊一声 —— 停用 / 换种类之后卡上的话要当场跟着变。
	ctx.publishView(() => bridgeView(links(), (linkId) => server.getSession(linkId)));
	settings.onChange(() => ctx.statusChanged());
}
