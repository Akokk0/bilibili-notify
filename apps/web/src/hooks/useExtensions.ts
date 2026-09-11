/**
 * `/api/ext` —— 装了哪些拓展。
 *
 * 四处要这张表(拓展页、拓展详情页、推送目标页的「新建连接」那一排、平台注册表),
 * 而它们共用 `["extensions"]` 这个 key **是承重的**:装完一个拓展只 invalidate 一次,
 * 四处就都跟着换了脸。各起各的 `useQuery` 时那个 key 是靠手抄对齐的,抄错一处的症状
 * 是「装好了但那一页还是旧的」—— 类型、测试、构建全绿。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export const EXTENSIONS_QUERY_KEY = ["extensions"] as const;

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
