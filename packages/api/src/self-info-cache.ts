import type { MySelfInfoData } from "./types";

/**
 * `getMyselfInfo` 的短 TTL + 在途合流缓存。挂在 {@link BilibiliAPI} 客户端上,
 * 对外经 `getMyselfInfoCached()` 共享给所有「需要当前账号身份、但不需要实时」的
 * 调用方(直播弹幕建连、卡片预览发送方解析…)。
 *
 * 「自己的信息」(mid/uname/face)在一个登录会话内是常量,却被多处反复要:
 *   - **在途合流**:并发调用共享同一个 in-flight Promise,重连风暴只落一次请求;
 *   - **短 TTL 缓存**:窗口内的后续调用直接命中缓存;
 *   - **只缓存成功**:code≠0 / data 缺失不写缓存(下次仍真调)。
 *
 * **谁不该用它**:登录健康检查(`LoginFlow.runHealthCheck`)必须走裸
 * `getMyselfInfo()` —— 它靠这次请求探 -101 会话死活,缓存会掩盖会话失效。
 *
 * **失效**:登出 / 换号 / -101 会切换账号身份,`BilibiliAPI` 在
 * `clearCookies` / `loadCookies` / `terminateSession` 里调 `invalidate()` 精准清缓存,
 * 不靠 TTL 硬扛陈旧身份。TTL 仍刻意短(默认 60s)作为兜底。
 */
export interface SelfInfoCache {
	get(): Promise<MySelfInfoData>;
	invalidate(): void;
}

export const DEFAULT_SELF_INFO_TTL_MS = 60_000;

export function createSelfInfoCache(
	api: { getMyselfInfo(): Promise<MySelfInfoData> },
	opts?: { ttlMs?: number; now?: () => number },
): SelfInfoCache {
	const ttlMs = opts?.ttlMs ?? DEFAULT_SELF_INFO_TTL_MS;
	const now = opts?.now ?? (() => Date.now());
	let cached: { at: number; data: MySelfInfoData } | undefined;
	let inflight: Promise<MySelfInfoData> | undefined;

	return {
		async get(): Promise<MySelfInfoData> {
			if (cached && now() - cached.at < ttlMs) return cached.data;
			if (inflight) return inflight;
			const p = Promise.resolve()
				.then(() => api.getMyselfInfo())
				.then((res) => {
					if (res.code === 0 && res.data) cached = { at: now(), data: res };
					return res;
				})
				.finally(() => {
					if (inflight === p) inflight = undefined;
				});
			inflight = p;
			return p;
		},
		invalidate(): void {
			cached = undefined;
		},
	};
}
