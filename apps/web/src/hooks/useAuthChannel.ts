import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isWsEvent, type WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { applySourceAuthChanged } from "./use-source-auth";

/**
 * 处理 `auth` 频道的单条 envelope。提取成 export 纯函数是为了让单元测试不
 * 通过 React 渲染就能覆盖事件分发逻辑 —— hook 本体只剩 effect 调度壳。
 *
 * 频道里只有一种帧:`subscription-auth-changed`(某个来源的登录状态变了)。
 */
export function handleAuthEnvelope(env: WsEnvelope, qc: QueryClient): void {
	if (isWsEvent(env, "auth", "subscription-auth-changed")) {
		applySourceAuthChanged(qc, env.data);
	}
}

/**
 * Subscribes to the WS `auth` channel and feeds `subscription-auth-changed`
 * envelopes into the `["source-auth", sourceKey]` query cache. Mount this once near
 * the app root — the cache is the read-side for any UI (`useSourceAuth`).
 */
export function useAuthChannel(): void {
	const qc = useQueryClient();
	useEffect(() => {
		subscribeChannels(["auth"]);
		return onWsEvent((env) => handleAuthEnvelope(env, qc));
	}, [qc]);
}
