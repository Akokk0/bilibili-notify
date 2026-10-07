import type { ConnectionView, GlobalConfigView } from "@bilibili-notify/contract";
import {
	type Connection,
	ConnectionSchema,
	type GlobalConfig,
	GlobalConfigSchema,
	type MapMarkedHandlers,
	mapMarked,
	maskCell,
} from "@bilibili-notify/internal";

/**
 * 下发给浏览器前把密钥格换成 {@link MaskedSecret}(ADR-0021 决策 44)。判据是 schema 上的 `secret`
 * 标记(`markSecret`),按值走 schema —— 不按键名猜,新字段标了就跟着遮。
 *
 * 只遮 `secret` 那一档:`backupOnly`(OneBot 地址、AI baseUrl、请求头的值)面板照常显示。空串 / 没配
 * 照旧(`maskCell` 保证),面板要分得开「没配」与「配了」。
 */
const MASK_SECRETS: MapMarkedHandlers = {
	onMark: (value, mark) => ("secret" in mark ? maskCell(value) : value),
	onUntyped: (value) => value,
};

/** 一条连接下发时的样子。 */
export function connectionView(connection: Connection): ConnectionView {
	return mapMarked(ConnectionSchema, connection, MASK_SECRETS) as ConnectionView;
}

/** 核心设置下发时的样子(AI 各实例的两把 key 与联网搜索 key 换成遮挡)。 */
export function globalConfigView(globals: GlobalConfig): GlobalConfigView {
	return mapMarked(GlobalConfigSchema, globals, MASK_SECRETS) as GlobalConfigView;
}
