import type { ExtensionDTO, ExtensionView } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { extensionStatusKey } from "../../../hooks/useExtensions";
import { api } from "../../../services/api";

/**
 * 状态那一口的键住在 `hooks/useExtensions.ts`(WS 那条失效也从那儿取,为什么见那里);
 * 这里转出去,声明式视图里读它的几处照旧从这儿拿。
 */
export { extensionStatusKey };

/**
 * 读一个 v2 拓展交上来的视图(ADR-0019 决策 20 / 26)。宿主交出来之前校验过:不合规矩的
 * 那份会换成一条说清哪里不对的错误提示,照样是一份视图。
 *
 * **不重试**:没跑 / 没交过视图时这一口是 404,那是一个要当场说出来的状态,不是一次网络
 * 抖动。`enabled` 为假时干脆不问 —— 关着的拓展问了也是 404,还会在开关刚拨下去的那一秒
 * 闪一下「没跑起来」。
 */
export function useExtensionView(extensionId: string, enabled: boolean) {
	return useQuery({
		queryKey: extensionStatusKey(extensionId),
		queryFn: () => api.get<ExtensionView>(`/api/ext/${extensionId}/status`),
		retry: false,
		enabled,
	});
}

/**
 * 这份视图现在还作不作数 —— 头卡、列表那一节、拓展列表上那一行**共用这一把尺子**。跑着、这一口
 * 也没出错才算。
 *
 * 🔴 出错之后 react-query 还攥着上一份:那是出错之前的样子,照着画就是在说一件已经不知道还成不成
 * 立的事(「3 个 bot 在线」)。404(没交过视图)同样不算 —— 没有就是没有。关着 / 没跑时缓存里
 * 也可能躺着之前那一份,同理不算。
 */
export function liveViewOf(
	running: boolean,
	view: { isError: boolean; data: ExtensionView | undefined },
): ExtensionView | undefined {
	return running && !view.isError ? view.data : undefined;
}

/**
 * **只在「开着且跑着」时问状态**:关着的问了也是 404;没跑起来的(加载失败 / 自动停用 / 版本
 * 不合)同理,而那两件事拓展表里的 `state` 已经说清楚了,用不着再拿一次 404 去猜。
 */
export function isRunning(ext: ExtensionDTO): boolean {
	return ext.enabled && ext.state === "running";
}

/**
 * 这一发失败是不是 404 —— 面板的 `ApiError` 带着状态码。跑着却 404 = **还没交过视图**
 * (只有设置项的拓展一辈子都这样),不是出错。
 */
export function isNotFound(err: unknown): boolean {
	return (err as { status?: unknown } | null)?.status === 404;
}
