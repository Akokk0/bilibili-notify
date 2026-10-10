/**
 * 面板测试用的平台快照取法 —— 连接上存的 `platformSnapshot` 在真实数据里由服务端按适配器的候选填;
 * 面板测试里没有服务端,就从平台表取那一行(去掉 `adapterKey`),认不出的平台落中性快照。
 *
 * 只给测试用,产物里没有任何地方 import 它。
 */

import { neutralPlatformSnapshot, type PlatformSnapshot } from "@bilibili-notify/internal";
import { platformDescriptor } from "@bilibili-notify/internal/constants";

/** 平台由哪个内置适配器管;认不出的(桥借来的)回平台名自己,当它的拓展 id 用。 */
export function adapterKeyFor(platform: string): string {
	return platformDescriptor(platform)?.adapterKey ?? platform;
}

export function snapshotFor(platform: string): PlatformSnapshot {
	const row = platformDescriptor(platform);
	if (!row) return neutralPlatformSnapshot(platform);
	const { adapterKey: _adapterKey, ...snapshot } = row;
	return snapshot;
}
