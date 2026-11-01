import type { AdaptersResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export const ADAPTERS_QUERY_KEY = ["adapters"] as const;

/** 适配器外观、连接字段与能力,停用的拓展也保留清单描述。 */
export function useAdapters() {
	return useQuery({
		queryKey: ADAPTERS_QUERY_KEY,
		queryFn: () => api.get<AdaptersResponse>("/api/adapters"),
		retry: false,
	});
}
