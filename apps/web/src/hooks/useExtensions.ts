/**
 * `/api/ext` —— 装了哪些拓展。
 *
 * 四处要这张表(拓展页、拓展详情页、推送目标页的「新建连接」那一排、平台注册表),
 * 而它们共用 `["extensions"]` 这个 key **是承重的**:装完一个拓展只 invalidate 一次,
 * 四处就都跟着换了脸。各起各的 `useQuery` 时那个 key 是靠手抄对齐的,抄错一处的症状
 * 是「装好了但那一页还是旧的」—— 类型、测试、构建全绿。
 *
 * 单个拓展的状态 / bot 名单、拓展市场那几个键也住这儿,理由相同:读的那处与失效的那几处
 * (包括 WS 那条 `useStateChannel`)都从这儿取。放在 hooks 而不是拓展页底下 —— hooks 不反向
 * import pages;市场那个键放在市场那一节里的话,改源的弹窗与市场那一节还会互相 import。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export const EXTENSIONS_QUERY_KEY = ["extensions"] as const;

/**
 * 一个拓展的状态那一口(`/api/ext/:id/status`,v2 拓展交上来的视图)。
 *
 * 🔴 **与 WS 那条失效是同一个键**:拓展喊 `ctx.statusChanged()` 时,`useStateChannel` 按它失效
 * (`extension-changed` 那一支),重连时按整个前缀失效。换一个键的话,页面照样画得出来,只是
 * 再也不跟着拓展刷新 —— 而且不会有任何报错。
 */
export const EXTENSION_STATUS_QUERY_PREFIX = ["extension-status"] as const;
export function extensionStatusKey(extensionId: string) {
	return [...EXTENSION_STATUS_QUERY_PREFIX, extensionId] as const;
}

/** 一个拓展眼下借得到的 bot(`/api/ext/:id/bots`)。与 WS 那条失效同一个键,理由同上。 */
export const EXTENSION_BOTS_QUERY_PREFIX = ["extension-bots"] as const;
export function extensionBotsKey(extensionId: string) {
	return [...EXTENSION_BOTS_QUERY_PREFIX, extensionId] as const;
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
}

export function useExtensions({ retry }: UseExtensionsOptions = {}) {
	return useQuery({
		queryKey: EXTENSIONS_QUERY_KEY,
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
		...(retry === undefined ? {} : { retry }),
	});
}
