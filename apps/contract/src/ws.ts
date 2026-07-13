/**
 * WS wire 契约 —— 独立端单端点 `/ws`,四个逻辑 channel 复用 JSON envelope。
 *
 * Wire format
 * ----------
 * Client → Server (control messages):
 *   { type: 'subscribe',   channels: ['auth', 'state', ...] }
 *   { type: 'unsubscribe', channels: [...] }
 *   { type: 'ping' }
 *   { type: 'pong' }                              (response to server ping)
 *
 * Server → Client:
 *   { type: 'subscribed',   channels: [...] }     (ACK after subscribe)
 *   { type: 'unsubscribed', channels: [...] }
 *   { type: 'pong', ts }                          (response to client ping)
 *   { type: 'ping' }                              (heartbeat)
 *   { type: 'error', message, issues? }           (bad control msg)
 *   { type: <channel>, event, ts, data }          (server-pushed event)
 *
 * 客户端控制帧的 zod 校验 schema 与心跳/背压参数是服务端实现细节,
 * 在 `apps/server/src/ws/types.ts`。
 */

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

export const CHANNELS = ["auth", "push-events", "log", "state"] as const;
export type ChannelName = (typeof CHANNELS)[number];

// ---------------------------------------------------------------------------
// Log channel payload
// ---------------------------------------------------------------------------

/** 4 值 wire 日志级别(WS `log` 帧与 `/api/logs` 归档共用;比 3 值配置枚举宽,含 warn)。 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Plain-data log entry forwarded onto the `log` WS channel. */
export interface LogEntry {
	level: LogLevel;
	msg: string;
	args: unknown[];
	ts: string;
	/**
	 * Emitting subsystem name. Base serviceCtx → `"core"`;
	 * `forSubsystem("dynamic")` → `"dynamic"`. Drives the Logs
	 * tab's source/subsystem filter. Optional for backward compat — entries
	 * predating this field (or hand-built in tests) simply have no source facet.
	 */
	name?: string;
}

// ---------------------------------------------------------------------------
// Server envelope types
// ---------------------------------------------------------------------------

/** Envelope used for every server-pushed channel event. */
export interface ServerEventEnvelope<TData = unknown> {
	type: ChannelName;
	event: string;
	ts: string;
	data: TData;
}

export interface ServerControlEnvelope {
	type: "subscribed" | "unsubscribed" | "ping" | "pong" | "error";
	channels?: ChannelName[];
	message?: string;
	issues?: unknown;
	ts?: string;
}

export type ServerEnvelope = ServerEventEnvelope | ServerControlEnvelope;
