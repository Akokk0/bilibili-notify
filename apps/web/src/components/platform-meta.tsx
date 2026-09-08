/**
 * 把平台注册表喂给组件库。
 *
 * `packages/ui` 只会**画**一个平台(有图标画图标、没有画首字方章、色可被 tone 盖),
 * 画谁由这里注入 —— 库是纯展示件库,不该认识 onebot 或飞书,更不该在桥驮进来一个新
 * 平台时被迫改一次。事实那一份住 `@bilibili-notify/internal` 的 `PLATFORM_REGISTRY`。
 *
 * 注册表里的 `shortLabel` 就是库要的 `label`:胶囊与方章里写的是短名(「飞书」),
 * 平台选择器那一排写的才是全名(「飞书机器人」)。
 */

import { PLATFORM_REGISTRY } from "@bilibili-notify/internal/constants";
import { type PlatformMeta, PlatformMetaProvider } from "@bilibili-notify/ui";
import type { ReactNode } from "react";

const TABLE: Record<string, PlatformMeta> = {
	...Object.fromEntries(
		Object.entries(PLATFORM_REGISTRY).map(([platform, meta]) => [
			platform,
			{ tint: meta.tint, label: meta.shortLabel, icon: meta.icon },
		]),
	),
	/**
	 * 桥接入不是平台,所以它不在注册表里 —— 但界面上要给它一张脸,不然那些卡片会退成
	 * 一个灰方章。喂给库的这张表是**「画谁」**,键是分发键(`connectionDispatchKey`),
	 * 不是平台名;桥这一档正是那个键在直连之外的取值。
	 */
	bridge: { tint: "#a855f7", label: "桥接" },
};

/** 认不出的平台回 undefined —— 库据此退静默色、拿平台名本身当短名。 */
export function lookupPlatformMeta(platform: string): PlatformMeta | undefined {
	return TABLE[platform];
}

export function PlatformMetaRoot({ children }: { children: ReactNode }) {
	return <PlatformMetaProvider value={lookupPlatformMeta}>{children}</PlatformMetaProvider>;
}
