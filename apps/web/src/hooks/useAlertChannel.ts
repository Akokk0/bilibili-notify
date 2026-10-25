import { useEffect } from "react";
import { isWsEvent, type WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { useAlertStore } from "../store/alerts";

/**
 * 处理 `log` 频道单条 envelope:过滤 `pipeline-error` + 数据形状校验,通过则 push
 * 进 alert store。提取成 export 纯函数让单测能覆盖 envelope 形状不合法时的
 * silent-drop 契约,无需渲染 hook。
 *
 * Server contract (apps/server/src/ws/channels.ts):
 *   envelope = { type: "log", event: "pipeline-error", data: { source, message } }
 */
export function handleLogEnvelope(env: WsEnvelope): void {
	if (!isWsEvent(env, "log", "pipeline-error")) return;
	const data = env.data;
	if (typeof data?.source !== "string" || typeof data.message !== "string") return;
	useAlertStore.getState().push({ source: data.source, message: data.message });
}

export function useAlertChannel(): void {
	useEffect(() => {
		subscribeChannels(["log"]);
		return onWsEvent(handleLogEnvelope);
	}, []);
}
