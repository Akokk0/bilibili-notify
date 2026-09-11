import { type Connection, connectionDispatchKey } from "@bilibili-notify/internal";

/**
 * 「这条连接归矩阵里的谁管」—— 按**分发键**找,不按消息里报的平台名找。
 *
 * 直连的分发键就是它的平台名;桥接入只有一套实现、共用 `"bridge"` 这一个键(见
 * internal 的 `connectionDispatchKey`)。桥后面挂着 telegram 时,入站帧报的平台是
 * `telegram`,而认领它的 adapter 声明的是 `bridge` —— 拿平台名去问就找不到,而且是
 * **静默**找不到:症状是「群里贴了链接没回卡」,日志上却写着「连接不存在」。
 *
 * 「哪个 adapter 管这条连接」全仓只此一份 —— 推送热路径(`createMultiplexSink`)也是每次
 * 现问这个函数,不另存索引:拓展是后加载的,拨一下开关就会来去(ADR-0012 决策 29)。
 */
export function adapterForConnection<T extends { readonly platforms: readonly string[] }>(
	adapters: readonly T[],
	connection: Connection,
): T | undefined {
	const key = connectionDispatchKey(connection);
	return adapters.find((adapter) => adapter.platforms.includes(key));
}
