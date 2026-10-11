import type { SourceAuthResponse } from "@bilibili-notify/contract";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";

/**
 * 来源的登录状态(`GET|POST|DELETE /api/sources/:sourceKey/auth`)—— 面板读登录态的唯一一处。
 *
 * 住在查询缓存里,**按来源键分开**:键是 `["source-auth", sourceKey]`,读的地方各自点名要哪个来源。
 * 保鲜靠两条线,所以 `staleTime` 是无穷:
 *   - WS `auth` 频道的 `subscription-auth-changed` 帧(`handleAuthEnvelope`):按帧里的 `sourceKey` 把状态
 *     写进那一条缓存,并让它失效重取(账号与头像只走 `GET`,帧里没有);
 *   - WS 重连后 `state` 频道的 `hydrate` 帧(`useStateChannel`)让整个前缀失效 —— 断线期间错过的帧没有
 *     谁会重放。
 */
export const SOURCE_AUTH_QUERY_PREFIX = ["source-auth"] as const;

export function sourceAuthKey(sourceKey: string): readonly ["source-auth", string] {
	return ["source-auth", sourceKey];
}

function sourceAuthPath(sourceKey: string): string {
	return `/api/sources/${encodeURIComponent(sourceKey)}/auth`;
}

/** 此刻缓存里那一条登录状态里的 `state`(没取到 / 没这条缓存是 `undefined`)。 */
export type SourceAuthState = SourceAuthResponse["state"];

/**
 * 处理 `auth` 频道里的 `subscription-auth-changed` 一帧(其余帧不管)。提取成纯函数,测试不必渲染 hook。
 * 帧里只有来源键与状态:状态当场写进缓存(原有的账号留着,直到重取回来),再让这一条失效重取。
 */
export function applySourceAuthChanged(
	qc: QueryClient,
	data: { sourceKey: string; state: SourceAuthState } | null | undefined,
): void {
	if (!data || typeof data.sourceKey !== "string" || !data.state) return;
	const key = sourceAuthKey(data.sourceKey);
	qc.setQueryData<SourceAuthResponse>(key, (prev) => ({ ...prev, state: data.state }));
	void qc.invalidateQueries({ queryKey: key });
}

export function useSourceAuth(sourceKey: string) {
	const qc = useQueryClient();
	const key = sourceAuthKey(sourceKey);
	const query = useQuery({
		queryKey: key,
		queryFn: () => api.get<SourceAuthResponse>(sourceAuthPath(sourceKey)),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	/** 服务端回的就是操作之后的整份状态,直接写进缓存 —— 不必等 WS 帧。 */
	const adopt = (saved: SourceAuthResponse) => qc.setQueryData(key, saved);
	const startLogin = useMutation({
		mutationFn: () => api.post<SourceAuthResponse>(sourceAuthPath(sourceKey)),
		onSuccess: adopt,
	});
	const logout = useMutation({
		mutationFn: () => api.delete<SourceAuthResponse>(sourceAuthPath(sourceKey)),
		onSuccess: adopt,
	});
	return {
		/** `undefined` = 还没取到(或取失败了,看 `isError`)。 */
		state: query.data?.state,
		account: query.data?.account,
		raw: query.data,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		startLogin,
		logout,
	};
}
