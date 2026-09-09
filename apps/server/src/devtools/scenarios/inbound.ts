import type {
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
} from "@bilibili-notify/internal";
import {
	type ChatIdentity,
	type Connection,
	connectionDispatchKey,
	type DirectConnection,
	groupAddressOf,
	isDirectConnection,
	type PushTarget,
	platformCanReceiveReply,
} from "@bilibili-notify/internal";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/**
 * A4:私聊指令 / 群链接 —— 直接调接线层的两个入站口,与 adapter 收到真帧之后调的是同一个
 * 函数(指令分发 / 链接解析),回复走真链路:指令回主人那条私聊,链接回到来源群。开着截流
 * 就都拦得住。
 */

export interface InboundHandlers {
	private?: (msg: InboundPrivateMessage, meta: InboundMeta) => void;
	group?: (msg: InboundGroupMessage, meta: InboundMeta) => void;
}

export interface InboundScenarioDeps {
	/** 入站口是引擎建好之后才接上的,现取;还没接上就 undefined。 */
	inbound: () => InboundHandlers | undefined;
	commands: () => { prefix: string; master?: ChatIdentity };
	connections: () => Connection[];
	targets: () => PushTarget[];
}

const DEFAULT_LINK_TEXT = "看看这个 https://www.bilibili.com/video/BV1GJ411x7h7";
/** 假的群成员;与真人不撞。 */
const FAKE_SENDER = "900400001";

export function inboundScenarios(deps: InboundScenarioDeps): DevScenarioDef[] {
	const command: DevScenarioDef = {
		id: "inbound.command",
		group: "event",
		title: "私聊指令",
		icon: "feather",
		desc: "当作一条私聊喂给指令分发器。正文留空 = 当前前缀 + help;userId 省略 = 配置里的主人(所以会被当真),给别人的号就能验「不是主人就不理」。回复走真链路。",
		params: [
			// 默认值不能把前缀烤进去:这张声明表在 createDevtools 那一刻就定型了,而前缀是
			// 系统页上随时能改的。改完面板还举着旧前缀,照它跑一次分发器根本不认。
			{ key: "text", label: "正文(可空 = 前缀 + help)", kind: "text", default: "" },
			{ key: "userId", label: "发信人(可空 = 主人)", kind: "text", default: "" },
		],
		run(params) {
			const handler = deps.inbound()?.private;
			if (!handler) throw new DevParamError("指令分发器还没接上(引擎没起来?)");
			const master = deps.commands().master;
			const given = typeof params.userId === "string" ? params.userId : "";
			const userId = given !== "" ? given : master?.address;
			if (!userId) throw new DevParamError("没配主人(系统页 · 主人私聊),得给一个发信人");
			// 前缀现取 —— 它随时可能被改过。
			const given2 = typeof params.text === "string" ? params.text : "";
			const text = given2 !== "" ? given2 : `${deps.commands().prefix}help`;
			// 指令分发用不上 connectionId(它回主人那条配置好的私聊),但**平台是要比对的**:
			// 鉴权换成三坐标之后,平台喂错这一枪就打不中,场景也就验不出东西来。所以按
			// 主人自己那条私聊的平台走;没配主人时(上面已经要求手填发信人)退到第一个
			// 启用的聊天连接。
			const source = deps
				.connections()
				.find(
					(a): a is DirectConnection =>
						a.enabled && isDirectChat(a) && (!master || a.platform === master.platform),
				);
			handler(
				{ userId, text },
				{ connectionId: source?.id ?? "", platform: master?.platform ?? source?.platform ?? "" },
			);
			return { summary: `已当作 ${userId} 私聊了一句「${text}」,回复走真链路。` };
		},
	};

	/**
	 * 能当聊天入口的**直连**。桥接入够不着 —— 它后面挂着哪些平台是握手时才报的运行时
	 * 知识,devtools 这张声明表在 createDevtools 那一刻就定型了。桥的入站另开场景。
	 */
	const isDirectChat = (a: Connection): a is DirectConnection =>
		isDirectConnection(a) && platformCanReceiveReply(a.platform);

	const link: DevScenarioDef = {
		id: "inbound.link",
		group: "event",
		title: "群里贴链接",
		icon: "link",
		desc: "当作群里有人发了一句话喂给链接解析。连接省略 = 第一个启用的聊天平台;群号省略 = 它名下第一个群目标。默认行 / 逐群例外照真的判 —— 那个群被例外停了解析就不会有回卡,换个群号试。",
		params: [
			{ key: "connection", label: "连接", kind: "connection" },
			{ key: "groupId", label: "群号 / 群 openid(可空)", kind: "text", default: "" },
			{ key: "text", label: "正文", kind: "text", default: DEFAULT_LINK_TEXT },
		],
		run(params) {
			const handler = deps.inbound()?.group;
			if (!handler) throw new DevParamError("链接解析还没接上(引擎没起来?)");
			const connections = deps.connections();
			const wanted = params.connection;
			const connection =
				wanted === undefined
					? connections.find((a): a is DirectConnection => a.enabled && isDirectChat(a))
					: connections.find((a) => a.id === String(wanted));
			if (!connection) {
				throw new DevParamError(
					wanted === undefined ? "没有启用的聊天平台连接(OneBot / 官机)" : `没有这个连接:${wanted}`,
				);
			}
			if (!isDirectChat(connection)) {
				throw new DevParamError(
					`${connection.name} 是 ${connectionDispatchKey(connection)},没有群这回事`,
				);
			}
			const given = typeof params.groupId === "string" ? params.groupId : "";
			const groupId =
				given !== ""
					? given
					: deps
							.targets()
							.filter((t) => t.connectionId === connection.id && t.scope === "group")
							.map((t) => groupAddressOf(t))
							.find((g): g is string => typeof g === "string" && g !== "");
			if (!groupId) throw new DevParamError(`${connection.name} 名下没有群目标,得给一个群号`);
			const text =
				typeof params.text === "string" && params.text !== "" ? params.text : DEFAULT_LINK_TEXT;
			handler(
				{ groupId, userId: FAKE_SENDER, text, cardLinks: [], miniAppCardLinks: [] },
				{ connectionId: connection.id, platform: connection.platform },
			);
			return {
				summary: `已当作 ${connection.name} 的群 ${groupId} 里有人说了「${text}」,回卡回到那个群。`,
			};
		},
	};

	return [command, link];
}
