/**
 * WS wire 契约 —— 独立端单端点 `/ws`,五个逻辑 channel 复用 JSON envelope。
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
 *   { type: 'error', code, message, issues?, ts } (bad control msg —— 与 HTTP 错误体同一个形状)
 *   { type: <channel>, event, ts, data }          (server-pushed event)
 *
 * 客户端控制帧的 zod 校验 schema 与心跳/背压参数是服务端实现细节,
 * 在 `apps/server/src/ws/types.ts`。
 */

import type { FailureCode, Issue } from "@bilibili-notify/internal";

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

export const CHANNELS = ["auth", "push-events", "log", "state", "resources"] as const;
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
	/**
	 * 仅 `error` 帧:标准码(ADR-0026)。控制帧的错误与 HTTP 错误体同一个形状 ——
	 * `{ code, message, issues? }`,只是搭在 `type: "error"` 上;现在只有 `invalid`
	 * (发来的不是合法 JSON,或不合控制消息的规矩)。
	 */
	code?: FailureCode;
	/** 仅 `error` 帧:给人看的中文原因。 */
	message?: string;
	/** 仅 `error` 帧:逐条原因,只有路径与原话(zod 自己的字段不往外甩)。 */
	issues?: Issue[];
	ts?: string;
}

export type ServerEnvelope = ServerEventEnvelope | ServerControlEnvelope;
