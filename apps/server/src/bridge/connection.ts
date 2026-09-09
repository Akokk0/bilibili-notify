import {
	BRIDGE_EXTENSION_ID,
	type BridgeConnectionConfig,
	BridgeConnectionConfigSchema,
	type Connection,
	isExtensionConnection,
} from "@bilibili-notify/internal";

/** 一条桥接入 —— 身份那几格 + 已经解出形状的 config。 */
export interface BridgeConnection {
	id: string;
	name: string;
	enabled: boolean;
	config: BridgeConnectionConfig;
}

/**
 * 这条连接是不是桥的;是的话把 config 解出来,否则 `null`。
 *
 * **核心的 `ConnectionSchema` 不认识任何一个拓展 id**(那正是拓展化的意思),所以拓展
 * 连接的 `config` 在那一层是 `unknown` —— 形状由**消费方自己 parse**。桥现在就是这么读
 * 它的 `token` 的,而搬进拓展之后这段会原样变成「拓展用自己那份 zod 解自己的 config」
 * (ADR-0012 决策 19 / 30)。
 *
 * 解不出来就当这条不存在:配置写坏了不该让推送整条挂掉,而面板那侧会显示它没连上。
 */
export function asBridgeConnection(connection: Connection): BridgeConnection | null {
	if (!isExtensionConnection(connection, BRIDGE_EXTENSION_ID)) return null;
	const parsed = BridgeConnectionConfigSchema.safeParse(connection.config);
	if (!parsed.success) return null;
	return {
		id: connection.id,
		name: connection.name,
		enabled: connection.enabled,
		config: parsed.data,
	};
}
