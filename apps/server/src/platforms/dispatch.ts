import { type Connection, connectionDispatchKey } from "@bilibili-notify/internal";

/**
 * 「这条连接归矩阵里的谁管」—— 按**分发键**找,不按消息里报的平台名找。
 *
 * 直连的分发键就是它的平台名;桥接入只有一套实现、共用 `"bridge"` 这一个键(见
 * internal 的 `connectionDispatchKey`)。桥后面挂着 telegram 时,入站帧报的平台是
 * `telegram`,而认领它的 adapter 声明的是 `bridge` —— 拿平台名去问就找不到,而且是
 * **静默**找不到:症状是「群里贴了链接没回卡」,日志上却写着「连接不存在」。
 *
 * 推送热路径不走这里:{@link createMultiplexSink} 把同一个关系预先索引成 Map(它还要
 * 在重复认领时告警)。这个函数是给那些「一次一条、手里已经有连接」的口用的。
 */
export function adapterForConnection<T extends { readonly platforms: readonly string[] }>(
	adapters: readonly T[],
	connection: Connection,
): T | undefined {
	const key = connectionDispatchKey(connection);
	return adapters.find((adapter) => adapter.platforms.includes(key));
}
