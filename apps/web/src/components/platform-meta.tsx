/**
 * 把平台注册表喂给组件库。
 *
 * `packages/ui` 只会**画**一个平台(有图标画图标、没有画首字方章、色可被 tone 盖),
 * 画谁由这里注入 —— 库是纯展示件库,不该认识 onebot 或飞书,更不该在桥驮进来一个新
 * 平台时被迫改一次。内置平台那份事实住 `@bilibili-notify/internal` 的 `PLATFORM_REGISTRY`。
 *
 * 注册表里的 `shortLabel` 就是库要的 `label`:胶囊与方章里写的是短名(「飞书」),
 * 平台选择器那一排写的才是全名(「飞书机器人」)。
 *
 * 🔴 **拓展那一档不在注册表里,也不许在这儿手抄** —— 它的短名与标识色是拓展自己在
 * `activate` 里报的(`ExtensionDescriptor`),经 `/api/ext` 下来。这里一度躺着一行手抄的
 * 桥接粉紫,它的毛病不是丑,是**会跟拓展报的悄悄漂开**:改了拓展、面板还是旧色,而
 * 类型、测试、门禁全绿,只有真机上眼睛看得出来。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import type { Connection } from "@bilibili-notify/internal";
import { PLATFORM_REGISTRY } from "@bilibili-notify/internal/constants";
import { type PlatformMeta, PlatformMetaProvider, usePlatformMeta } from "@bilibili-notify/ui";
import { type ReactNode, useMemo } from "react";
import { useExtensions } from "../hooks/useExtensions";

const BUILT_IN: Record<string, PlatformMeta> = Object.fromEntries(
	Object.entries(PLATFORM_REGISTRY).map(([platform, meta]) => [
		platform,
		{ tint: meta.tint, label: meta.shortLabel, icon: meta.icon },
	]),
);

/**
 * 「画谁」那张表。键是**分发键**(`connectionDispatchKey`),不是平台名 —— 拓展那一档的
 * 取值正是拓展 id。
 *
 * 没跑起来的拓展没有 descriptor(那是 `activate` 里报的),**不进表**:退成灰方章是诚实的,
 * 而塞一份空壳进去等于面板自己编了一张脸。
 */
export function buildPlatformTable(
	extensions: readonly ExtensionDTO[],
): (platform: string) => PlatformMeta | undefined {
	const table: Record<string, PlatformMeta> = { ...BUILT_IN };
	for (const ext of extensions) {
		const descriptor = ext.descriptor;
		// 图标是清单里那段 SVG(服务端过过白名单,决策 20)—— 没有就退首字方章。
		if (descriptor)
			table[ext.id] = { tint: descriptor.tint, label: descriptor.shortLabel, svg: ext.icon };
	}
	return (platform: string) => table[platform];
}

/**
 * 一条连接**画成谁的脸**(图标 / 标识色 / 短名)。
 *
 * 直连就是它的平台。拓展连接是一个 bot(ADR-0012 决策 45):它的平台认得(桥借来的 QQ /
 * telegram)就画那个平台的脸;认不得(桥驮来的 kook 这种)退回拓展自己那张脸 —— 灰方章
 * 不如「这是桥接来的」有用。⚠️ 与分发键(`connectionDispatchKey`,决定哪个 adapter 认领)
 * 是两回事:那个在拓展这一支恒是拓展 id。
 */
export function useConnectionFace(): (connection: Connection) => string {
	const lookup = usePlatformMeta();
	return (connection) => {
		if (connection.kind === "direct") return connection.platform;
		return lookup(connection.platform) ? connection.platform : connection.extensionId;
	};
}

export function PlatformMetaRoot({ children }: { children: ReactNode }) {
	// 与拓展页共用同一张表:那一页刷新之后,推送目标卡上的脸跟着换。
	// 没登录 / 老服务端拿不到就退回内置那份 —— 那时也没有拓展卡片要画。
	const listed = useExtensions({ retry: false });
	const lookup = useMemo(
		() => buildPlatformTable(listed.data?.extensions ?? []),
		[listed.data?.extensions],
	);
	return <PlatformMetaProvider value={lookup}>{children}</PlatformMetaProvider>;
}
