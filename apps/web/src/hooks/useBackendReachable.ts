import type { HealthResponse } from "@bilibili-notify/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

/** `["health"]` 的**单一权威** queryKey(失效、devtools 造状态也认它)。 */
export const HEALTH_QUERY_KEY = ["health"] as const;
/**
 * 问 `/api/health` 的整份选项,连 queryFn 一起。App / Dashboard / 导览 / useBackendReachable
 * 四处共享同一个缓存项:选项不一致时 React Query 按挂载序合并 observer,可达性探测行为不确定、
 * 横幅闪烁(Dashboard 曾漏了 `retry: 0`)。所以四处一律直接用这一份,不各写各的。
 */
export const HEALTH_QUERY_OPTIONS = queryOptions({
	queryKey: HEALTH_QUERY_KEY,
	queryFn: () => api.get<HealthResponse>("/api/health"),
	// health 探测应 fail-fast(ECONNREFUSED <100ms 即解析);退避重试只会让
	// UI 在 error 横幅前多卡几秒 loading。
	retry: 0,
	refetchInterval: 5_000,
});

/**
 * Sticky "is the backend reachable right now" signal, shared with every
 * useQuery(["health"]) observer in the tree (App-level probe defines the
 * cache entry; this hook only reads it). After a successful fetch, tanstack
 * keeps `data` populated even when subsequent refetches fail — relying on
 * `data`/`isError` alone makes the dashboard look healthy long after the
 * backend has gone away. dataUpdatedAt vs errorUpdatedAt is the clean way to
 * ask "did the most recent attempt land or error".
 */
export function useBackendReachable(): boolean {
	const health = useQuery(HEALTH_QUERY_OPTIONS);
	if (!health.data) return false;
	return health.dataUpdatedAt >= health.errorUpdatedAt;
}
