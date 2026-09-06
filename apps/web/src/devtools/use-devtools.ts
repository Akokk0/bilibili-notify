import type {
	DevInjection,
	DevParamValues,
	DevResetResponse,
	DevRunResponse,
	DevStatusDTO,
} from "@bilibili-notify/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";
import { findWebScenario } from "./registry";

/**
 * devtools 与服务端那半的往来。
 *
 * `GET /api/dev` 只在开发版载荷上存在 —— 404 不是错,是「这台服务端不是开发版」(面板跑在
 * dev 而后端连着一个正式镜像时就是这样),那就整个不出现。连不上也一样不出现:壳层自有
 * 错误态,devtools 不必再说一遍。
 */
export const DEV_QUERY_KEY = ["dev"] as const;

export type DevAvailability =
	| { status: "loading" }
	| { status: "absent" }
	| { status: "ready"; data: DevStatusDTO };

export function useDevStatus(): DevAvailability {
	const q = useQuery({
		queryKey: DEV_QUERY_KEY,
		queryFn: () => api.get<DevStatusDTO>("/api/dev"),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (q.data) return { status: "ready", data: q.data };
	if (q.error) return { status: "absent" };
	return { status: "loading" };
}

/** 把回执里的生效表写回缓存 —— 面板不必再 GET 一次。 */
function useApplyActive() {
	const qc = useQueryClient();
	return (active: DevInjection[]) => {
		qc.setQueryData<DevStatusDTO>(DEV_QUERY_KEY, (prev) => (prev ? { ...prev, active } : prev));
	};
}

export interface RunInput {
	id: string;
	side: "server" | "web";
	params: DevParamValues;
}

export interface RunOutcome {
	summary?: string;
}

/**
 * 跑一个场景。服务端那半走 `/api/dev/run/:id`;前端那半就地调 `run`。
 *
 * 跑完**把所有查询都作废**:造出来的状态要经各页自己的查询才看得见(更新状态那条链路就是
 * 系统页 / 概览卡 / 通知钩子各自的 `useUpdateStatus`),逐个列 key 的话,新加一个场景就得回来
 * 补一行 —— 而漏补的症状是「跑了没反应」。dev-only 的工具,多刷几个请求不算代价。
 */
export function useRunScenario() {
	const qc = useQueryClient();
	const applyActive = useApplyActive();
	return useMutation({
		mutationFn: async ({ id, side, params }: RunInput): Promise<RunOutcome> => {
			if (side === "web") {
				const scenario = findWebScenario(id);
				if (!scenario) throw new Error(`没有这个前端场景:${id}`);
				const summary = await scenario.run(params);
				return summary === undefined ? {} : { summary };
			}
			const res = await api.post<DevRunResponse>(`/api/dev/run/${id}`, { params });
			applyActive(res.active);
			return res.summary === undefined ? {} : { summary: res.summary };
		},
		onSettled: () => {
			void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== DEV_QUERY_KEY[0] });
		},
	});
}

/** 收摊:给 id 收那一条,不给全收。 */
export function useResetScenario() {
	const qc = useQueryClient();
	const applyActive = useApplyActive();
	return useMutation({
		mutationFn: async (id?: string) => {
			const path = id === undefined ? "/api/dev/reset" : `/api/dev/reset/${id}`;
			const res = await api.post<DevResetResponse>(path, {});
			applyActive(res.active);
		},
		onSettled: () => {
			void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== DEV_QUERY_KEY[0] });
		},
	});
}
