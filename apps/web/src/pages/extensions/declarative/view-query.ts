import type { ExtensionDTO, ExtensionView } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../services/api";

/**
 * 一个拓展的状态那一口(`/api/ext/:id/status`)在 react-query 里的键。
 *
 * 🔴 **与 WS 那条失效是同一个键**:拓展喊 `ctx.statusChanged()` 时,`useStateChannel` 按
 * `["extension-status", id]` 失效(`extension-changed` 那一支)。这边换一个键的话,页面
 * 照样画得出来,只是再也不跟着拓展刷新 —— 而且不会有任何报错。手写的桥页也读这个键。
 */
export function extensionStatusKey(extensionId: string) {
	return ["extension-status", extensionId] as const;
}

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
