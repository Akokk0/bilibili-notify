import { LOG_LEVELS } from "@bilibili-notify/contract";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type LogLineView, type LogsResponse, logsQueryKey } from "../services/dashboard";
import { isWsEvent, type WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";

/**
 * WS `log` 频道 → `["system", "logs", {day:"live"}]` 缓存 prepend(镜像
 * usePushEventsChannel 的 setQueryData patch)。两类帧都收:
 *   - 级别帧 { type:"log", event:<level>, data:{ msg,args,name } }
 *   - pipeline-error { type:"log", event:"pipeline-error", data:{ source, message } }
 *     合成成一条 level=error / name=source 的行,让推送链路错误也进日志流。
 *
 * 提取为 export 纯函数:测试注入 `qc = new QueryClient()` 即可覆盖形状校验
 * 与 silent-drop 契约,无需渲染 hook。`useAlertChannel`(pipeline-error →
 * 右上角 AlertShell)保持独立、不受影响 —— 二者共用同一 `log` 订阅各自消费。
 *
 * 服务端 /api/system/logs 只按 day/limit 分页;level/source/文本过滤全在页面客户端
 * 做,所以 live key 稳定、WS append 不会因筛选条件漂移而 patch 错缓存。
 */
export const LOG_CACHE_CAP = 1000;

/** Parse one WS `log` envelope into a LogLineView, or null if not a log line. */
export function parseLogEnvelope(env: WsEnvelope): LogLineView | null {
	// 级别当事件名:逐个级别问一遍,判中的那个级别就是这一行的 level。
	for (const level of LOG_LEVELS) {
		if (!isWsEvent(env, "log", level)) continue;
		const d = env.data;
		if (!d || typeof d.msg !== "string") return null;
		const line: LogLineView = { ts: env.ts, level, msg: d.msg };
		if (typeof d.name === "string") line.name = d.name;
		if (Array.isArray(d.args)) line.args = d.args;
		return line;
	}

	if (isWsEvent(env, "log", "pipeline-error")) {
		const d = env.data;
		if (typeof d?.source !== "string" || typeof d.message !== "string") return null;
		return { ts: env.ts, level: "error", name: d.source, msg: d.message };
	}

	return null;
}

export function handleLogStreamEnvelope(env: WsEnvelope, qc: QueryClient): void {
	const line = parseLogEnvelope(env);
	if (!line) return;
	qc.setQueryData<LogsResponse>(logsQueryKey(), (old) => {
		const prev = old?.entries ?? [];
		return { entries: [line, ...prev].slice(0, LOG_CACHE_CAP) };
	});
}

export function useLogChannel(): void {
	const qc = useQueryClient();
	useEffect(() => {
		subscribeChannels(["log"]);
		return onWsEvent((env) => handleLogStreamEnvelope(env, qc));
	}, [qc]);
}
