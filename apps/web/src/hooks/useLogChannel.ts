import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	type LogLineLevel,
	type LogLineView,
	type LogsResponse,
	logsQueryKey,
} from "../services/dashboard";
import type { WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";

/**
 * WS `log` 频道 → `["logs",{day:"live"}]` 缓存 prepend(镜像
 * usePushEventsChannel 的 setQueryData patch)。两类帧都收:
 *   - 级别帧 { type:"log", event:<level>, data:{ msg,args,name } }
 *   - engine-error { type:"log", event:"engine-error", data:[source,message] }
 *     合成成一条 level=error / name=source 的行,让引擎错误也进日志流。
 *
 * 提取为 export 纯函数:测试注入 `qc = new QueryClient()` 即可覆盖形状校验
 * 与 silent-drop 契约,无需渲染 hook。`useAlertChannel`(engine-error →
 * 右上角 AlertShell)保持独立、不受影响 —— 二者共用同一 `log` 订阅各自消费。
 *
 * 服务端 /api/logs 只按 day/limit 分页;level/source/文本过滤全在页面客户端
 * 做,所以 live key 稳定、WS append 不会因筛选条件漂移而 patch 错缓存。
 */
export const LOG_CACHE_CAP = 1000;

const WIRE_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** Parse one WS `log` envelope into a LogLineView, or null if not a log line. */
export function parseLogEnvelope(env: WsEnvelope): LogLineView | null {
	if (env.type !== "log") return null;
	const event = env.event;
	if (typeof event !== "string") return null;

	if (WIRE_LEVELS.has(event)) {
		const d = env.data as { msg?: unknown; args?: unknown; name?: unknown } | undefined;
		if (!d || typeof d.msg !== "string") return null;
		const line: LogLineView = {
			ts: env.ts,
			level: event as LogLineLevel,
			msg: d.msg,
		};
		if (typeof d.name === "string") line.name = d.name;
		if (Array.isArray(d.args)) line.args = d.args;
		return line;
	}

	if (event === "engine-error") {
		const data = env.data;
		if (!Array.isArray(data) || data.length < 2) return null;
		const [source, message] = data as [unknown, unknown];
		if (typeof source !== "string" || typeof message !== "string") return null;
		return { ts: env.ts, level: "error", name: source, msg: message };
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
