import type { HealthDetailsResponse } from "@bilibili-notify/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

/**
 * `/api/health/details` —— 健康卡要的数据(ADR-0025 决策 12):各模块开没开、核心包版本、配置分区。
 * 短版 `/api/health` 只管存活与认新进程,见 useBackendReachable。
 *
 * 键挂在 `["health"]` 底下:顶栏「刷新」与更新那节按 `["health"]` 失效时(前缀匹配)连它一起刷,
 * 跟模块状态还住在短版里的时候一样。
 */
export const HEALTH_DETAILS_QUERY_KEY = ["health", "details"] as const;

export const HEALTH_DETAILS_QUERY_OPTIONS = queryOptions({
	queryKey: HEALTH_DETAILS_QUERY_KEY,
	queryFn: () => api.get<HealthDetailsResponse>("/api/health/details"),
	// 缓存保留完整开机进度;现有健康卡与导览只消费运行详情,开机期间沿用它们的兜底。
	// 与短版同一个节奏:首页开着时切了 AI / 卡片开关,灯 5 秒内跟上。只在有人看(首页、新手进度)
	// 的时候问,后台标签页不问(react-query 默认)。不改 WS,理由同短版(ADR-0010)。
	retry: 0,
	refetchInterval: 5_000,
});

/** 读详情口。`enabled` 留给新手进度:导览关着的人不该替它发请求。 */
export function useHealthDetails(opts?: { enabled?: boolean }) {
	return useQuery({
		...HEALTH_DETAILS_QUERY_OPTIONS,
		enabled: opts?.enabled ?? true,
		select: (details: HealthDetailsResponse) => (details.phase === "running" ? details : undefined),
	});
}
