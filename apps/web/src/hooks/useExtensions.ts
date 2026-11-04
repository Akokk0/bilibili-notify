/**
 * 拓展生命周期与相关查询键。拓展变化同时作废来源、适配器描述；
 * 名称、字段和外观由各自读口提供，是否在场仍读拓展生命周期。
 */

import type { ExtensionDTO, ExtensionsResponse } from "@bilibili-notify/contract";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "../services/api";
import { ADAPTERS_QUERY_KEY } from "./useAdapters";
import { SOURCES_QUERY_KEY } from "./useSources";

export const EXTENSIONS_QUERY_KEY = ["extensions"] as const;

/**
 * 拓展表过期了,来源表(`/api/sources`)与适配器表(`/api/adapters`)跟着一起过期:来源表里拓展的那几行与拓展表照的是同一份清单,装 / 卸 /
 * 开关 / 换上新版都一起变。只失效拓展表的话,订阅页的平台名与颜色还停在旧的那一份。
 */
export function invalidateExtensionTables(qc: QueryClient): Promise<void> {
	return Promise.all([
		qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY }),
		qc.invalidateQueries({ queryKey: SOURCES_QUERY_KEY }),
		qc.invalidateQueries({ queryKey: ADAPTERS_QUERY_KEY }),
	]).then(() => undefined);
}

/**
 * 这个拓展此刻在不在场 —— 要它本人在的事只给在场的:新建它的连接、挑 bot(`/api/adapters/:adapterKey/candidates`
 * 停着回 503)、订阅页的平台选择与解析门(`/api/ext/:id/lookup` 同理)。
 *
 * ⚠️ 清单里的外观(适配器与来源读口的描述符)**不看这个**:它照清单给、停着也有(ADR-0019
 * 决策 41)。两件事别混 —— 「有外观」当「在场」的话,点进去就是一个问不到的拓展。
 */
export function isExtensionPresent(ext: ExtensionDTO): boolean {
	return ext.state === "running";
}

/**
 * 一个拓展的状态那一口(`/api/ext/:id/status`,v2 拓展交上来的视图)。
 *
 * 🔴 **与 WS 那条失效是同一个键**:拓展喊 `ctx.statusChanged()` 时,`useStateChannel` 按它失效
 * (`extension-status-changed` 那一支),重连时按整个前缀失效。换一个键的话,页面照样画得出来,只是
 * 再也不跟着拓展刷新 —— 而且不会有任何报错。
 */
export const EXTENSION_STATUS_QUERY_PREFIX = ["extension-status"] as const;
export function extensionStatusKey(extensionId: string) {
	return [...EXTENSION_STATUS_QUERY_PREFIX, extensionId] as const;
}

/** 一个拓展眼下借得到的 bot(`/api/adapters/:adapterKey/candidates`)。与 WS 那条失效同一个键,理由同上。 */
export const EXTENSION_BOTS_QUERY_PREFIX = ["extension-bots"] as const;
export function extensionBotsKey(extensionId: string) {
	return [...EXTENSION_BOTS_QUERY_PREFIX, extensionId] as const;
}

/**
 * 一个拓展的设置(`/api/ext/:id/settings`,ADR-0019 决策 35):设置表单与列表那一节读它,写成之后
 * 把回应收进它;WS 的 `extension-settings-changed` 按它失效、重连时按整个前缀失效。键对不上的
 * 症状同上:别处改了设置,这一页照旧画着旧的,直到下一发撞 409。
 */
export const EXTENSION_SETTINGS_QUERY_PREFIX = ["ext-settings"] as const;
export function extensionSettingsKey(extensionId: string) {
	return [...EXTENSION_SETTINGS_QUERY_PREFIX, extensionId] as const;
}

/**
 * 拓展市场那一口(`/api/ext/marketplace`)。市场那一节读它;装 / 更新成功、改源之后按它失效;
 * 「重新拉索引」把强制重拉的那一份写进它 —— 哪一处对不上,市场就停在旧的那份,不报错。
 */
export const MARKETPLACE_QUERY_KEY = ["marketplace"] as const;

export interface UseExtensionsOptions {
	/**
	 * 读不到时要不要重试。**四个调用点本来就不一致**,这里原样带着、不替它们统一:
	 * 拓展页与详情页整页只画这一张表,读不到就是读不到,重试有意义;推送目标页与平台
	 * 注册表只是拿它锦上添花(多几档可选连接 / 多几张脸),没登录 / 老服务端那一口就是
	 * 404,重试三遍只是把 404 打三遍。真要统一得先定「哪一档才对」,那是另一件事。
	 *
	 * 不填就跟 QueryClient 的默认值走 —— 别塞一个 `undefined` 进去,`Object.assign`
	 * 会拿它把默认值覆盖掉。
	 */
	retry?: boolean;
	enabled?: boolean;
}

export function useExtensions({ retry, enabled }: UseExtensionsOptions = {}) {
	return useQuery({
		queryKey: EXTENSIONS_QUERY_KEY,
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
		...(retry === undefined ? {} : { retry }),
		...(enabled === undefined ? {} : { enabled }),
	});
}
