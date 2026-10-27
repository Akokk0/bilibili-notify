/**
 * `/api/sources` —— 来源表(ADR-0027 决策 6):每个来源的描述符(平台名、短名、颜色、叫法、支持的特性……)
 * 与它实现了哪些可选能力。面板只从这里拿来源的信息;拓展的那几行照清单给,停着也有。
 *
 * 读它的地方共用这一个键:拓展装卸、开关、换语言都会让它变,失效那几处跟拓展表同进退
 * (`invalidateExtensionTables`),认的就是它。各起各的键的话,拓展换了名字,有的页还画着旧的。
 */

import type { SourcesResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export const SOURCES_QUERY_KEY = ["sources"] as const;

export function useSources() {
	return useQuery({
		queryKey: SOURCES_QUERY_KEY,
		queryFn: () => api.get<SourcesResponse>("/api/sources"),
	});
}
