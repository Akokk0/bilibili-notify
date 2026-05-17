import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

interface HealthSnapshot {
	status: string;
	uptime: number;
}

/**
 * `["health"]` 的**单一权威** queryKey + 行为选项。App / Dashboard /
 * useBackendReachable 三处都注册了 `useQuery(["health"])`,但各自传不一致的
 * `retry` / `refetchInterval`(Dashboard 此前漏了 `retry:0`)—— 共享同一
 * 缓存项时 React Query 按挂载序合并 observer,可达性探测行为不确定、横幅闪烁。
 * 三处统一 spread 这组选项(各自仍保留自己的 typed queryFn / HealthSnapshot
 * 形态,不强行收敛类型,零爆破半径)。
 */
export const HEALTH_QUERY_KEY = ["health"] as const;
export const HEALTH_QUERY_OPTIONS = {
	// health 探测应 fail-fast(ECONNREFUSED <100ms 即解析);退避重试只会让
	// UI 在 error 横幅前多卡几秒 loading。
	retry: 0,
	refetchInterval: 5_000,
} as const;

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
	const health = useQuery({
		queryKey: HEALTH_QUERY_KEY,
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		...HEALTH_QUERY_OPTIONS,
	});
	if (!health.data) return false;
	return health.dataUpdatedAt >= health.errorUpdatedAt;
}
