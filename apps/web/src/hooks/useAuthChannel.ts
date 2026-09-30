import { useEffect } from "react";
import { isWsEvent, type WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus, type LoginSnapshot } from "../types/auth";

/**
 * 处理 `auth` 频道的单条 envelope。提取成 export 纯函数是为了让单元测试不
 * 通过 React 渲染就能覆盖事件分发逻辑 —— hook 本体只剩 effect 调度壳。
 */
export function handleAuthEnvelope(env: WsEnvelope): void {
	if (isWsEvent(env, "auth", "login-status-report") && env.data) {
		// 唯一留下的断言:表里的 `status` 是 `number`(internal 不认 api 的登录状态枚举),面板侧把它
		// 收窄成已知的几个值(`BiliLoginStatusValue`)。不在这里加运行时校验 —— 未知状态码照旧存进去。
		useAuthStore.getState().setSnapshot(env.data as LoginSnapshot);
		return;
	}
	if (isWsEvent(env, "auth", "cookies-refreshed")) {
		const refreshedAt = env.data?.refreshedAt;
		useAuthStore
			.getState()
			.setCookiesRefreshed(typeof refreshedAt === "string" ? refreshedAt : env.ts);
		return;
	}
	if (isWsEvent(env, "auth", "auth-lost")) {
		// P2:保留既有 snapshot.data(用户卡片)。瞬时 lost→restored 抖动若清掉
		// data,卡片会闪没;restored 后端通常不立刻重发完整 card,体验更差。
		const prev = useAuthStore.getState().snapshot;
		useAuthStore
			.getState()
			.setSnapshot({ status: BiliLoginStatus.NOT_LOGIN, msg: "auth-lost", data: prev?.data });
		return;
	}
}

/**
 * Subscribes to the WS `auth` channel and feeds `login-status-report` /
 * `cookies-refreshed` envelopes into the auth store. Mount this once near the
 * app root — the store is the read-side for any UI.
 */
export function useAuthChannel(): void {
	useEffect(() => {
		subscribeChannels(["auth"]);
		return onWsEvent(handleAuthEnvelope);
	}, []);
}
