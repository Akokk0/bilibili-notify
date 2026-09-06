import type {
	DevActiveDTO,
	DevInjection,
	DevParamValues,
	DevResetResponse,
	DevRunResponse,
	DevStatusDTO,
} from "@bilibili-notify/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";
import { FOLLOW_UPS } from "./follow-ups";
import { findWebScenario, type WebDevScenario } from "./registry";

/**
 * devtools 与服务端那半的往来。
 *
 * `GET /api/dev` 只在开发版载荷上存在 —— 404 不是错,是「这台服务端不是开发版」(面板跑在
 * dev 而后端连着一个正式镜像时就是这样),那就整个不出现。连不上也一样不出现:壳层自有
 * 错误态,devtools 不必再说一遍。
 */
export const DEV_QUERY_KEY = ["dev"] as const;
/** 生效表单独一个 key:它是被轮询的那份,别让轮询把整张场景表也一起搬。 */
export const DEV_ACTIVE_KEY = ["dev", "active"] as const;

export type DevAvailability =
	| { status: "loading" }
	| { status: "absent" }
	| { status: "ready"; data: DevStatusDTO };

/**
 * 有注入生效时每几秒看一眼:生效条上的话会变(截流的「拦下 N 条」随真推送涨),而这些
 * 变化发生在服务端、面板没按任何键。什么都没注入时不打扰。
 */
export function devRefetchInterval(data: DevActiveDTO | undefined): number | false {
	return data && data.active.length > 0 ? 3_000 : false;
}

/**
 * 场景表:探一次 `/api/dev`(404 = 不是开发版),拿到就不再动 —— 声明是静态的。
 * 这一份**不轮询**;轮的是下面那个只有生效表的小查询。
 */
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

/**
 * 生效表:`/api/dev/active`,几十字节。有东西生效时每 3 秒一次;首屏用场景表那次一起
 * 带回来的 `active` 垫底,不必多等一个来回。
 */
export function useDevActive(initial: DevInjection[]): DevInjection[] {
	const q = useQuery({
		queryKey: DEV_ACTIVE_KEY,
		queryFn: () => api.get<DevActiveDTO>("/api/dev/active"),
		retry: false,
		initialData: { active: initial },
		refetchInterval: (query) => devRefetchInterval(query.state.data),
		// 窗口失焦也照轮:人盯着终端 / 聊天软件看推送有没有出网时,面板正好在后台。
		refetchIntervalInBackground: true,
	});
	return q.data.active;
}

/** 把回执里的生效表写回缓存 —— 面板不必再 GET 一次。 */
function useApplyActive() {
	const qc = useQueryClient();
	return (active: DevInjection[]) => {
		qc.setQueryData<DevActiveDTO>(DEV_ACTIVE_KEY, { active });
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
 * 跑完**把所有查询都作废**(连 `/api/dev` 自己也在内,生效表顺便对一次账):造出来的状态要经
 * 各页自己的查询才看得见(更新状态那条链路就是系统页 / 概览卡 / 通知钩子各自的
 * `useUpdateStatus`),逐个列 key 的话,新加一个场景就得回来补一行 —— 而漏补的症状是「跑了
 * 没反应」。dev-only 的工具,多刷几个请求不算代价。
 *
 * 靠作废查询看不到的那几处(只在某个时机才出手的消费点),由 `FOLLOW_UPS` 在服务端那半
 * 跑完之后就地重放那个时机。
 */
export function useRunScenario(webScenarios: readonly WebDevScenario[]) {
	const qc = useQueryClient();
	const applyActive = useApplyActive();
	return useMutation({
		mutationFn: async ({ id, side, params }: RunInput): Promise<RunOutcome> => {
			if (side === "web") {
				const scenario = findWebScenario(id, webScenarios);
				if (!scenario) throw new Error(`没有这个前端场景:${id}`);
				const summary = await scenario.run(params, { qc });
				return summary === undefined ? {} : { summary };
			}
			const res = await api.post<DevRunResponse>(`/api/dev/run/${id}`, { params });
			applyActive(res.active);
			// 注入已经在服务端生效(生效表也写回去了),补做的事失败要说清楚是哪一半没成 ——
			// 不然红字像是注入没打进去。
			try {
				await FOLLOW_UPS[id]?.(qc);
			} catch (e) {
				const why = e instanceof Error ? e.message : String(e);
				throw new Error(`注入已生效,但面板这边跟着补做的那步没成:${why}`);
			}
			return res.summary === undefined ? {} : { summary: res.summary };
		},
		// 只有服务端那半要刷:造出来的状态经各页自己的查询才看得见。前端那半不刷 ——
		// 它们直接改的就是查询缓存本身,再刷一遍等于当场把自己造的东西冲掉(「后端不可达壳」
		// 就是这么秒恢复的:setState 置错误 → invalidate → 健康探测立刻重来 → 壳一闪就没)。
		onSettled: (_data, _err, variables) => {
			if (variables.side === "server") void qc.invalidateQueries();
		},
	});
}

/** 收摊:给 id 收那一条,不给全收。前端那半的场景就地收,不打服务端。 */
export function useResetScenario(webScenarios: readonly WebDevScenario[]) {
	const qc = useQueryClient();
	const applyActive = useApplyActive();
	return useMutation({
		mutationFn: async (id?: string) => {
			const web = id === undefined ? undefined : findWebScenario(id, webScenarios);
			if (web) {
				web.reset?.();
				return "web" as const;
			}
			if (id === undefined) for (const s of webScenarios) s.reset?.();
			const path = id === undefined ? "/api/dev/reset" : `/api/dev/reset/${id}`;
			const res = await api.post<DevResetResponse>(path, {});
			applyActive(res.active);
			return "server" as const;
		},
		// 同上:只在真打了服务端时刷。收一条前端场景不该顺手把别的查询冲一遍。
		onSettled: (side) => {
			if (side === "server") void qc.invalidateQueries();
		},
	});
}
