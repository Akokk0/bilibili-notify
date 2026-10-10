/**
 * 造连接夹具用的平台快照 —— 连接上那份 `platformSnapshot`。
 *
 * 按平台名取 `PLATFORM_REGISTRY` 的那一行、去掉 `adapterKey`(正是新建连接时宿主从候选抄的那一份);
 * 认不出的平台(桥借来的)用中性快照。别在各测试文件里抄字面量。
 */

import {
	neutralPlatformSnapshot,
	PLATFORM_REGISTRY,
	type PlatformSnapshot,
} from "@bilibili-notify/internal";

export function snapshotFor(platform: string): PlatformSnapshot {
	if (!Object.hasOwn(PLATFORM_REGISTRY, platform)) return neutralPlatformSnapshot(platform);
	const { adapterKey: _adapterKey, ...snapshot } =
		PLATFORM_REGISTRY[platform as keyof typeof PLATFORM_REGISTRY];
	return snapshot;
}
