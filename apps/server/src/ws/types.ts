import { z } from "zod";

/**
 * WS protocol — single endpoint at /ws, four logical channels multiplexed
 * over JSON envelopes. Stage 2.3 of the standalone end. See plan §5 (BiliEvents)
 * and §六 (WebDashboardSink) for the channel ↔ event mapping.
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
 */

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

export const CHANNELS = ["auth", "push-events", "log", "state"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export const ChannelNameSchema = z.enum(CHANNELS);

// ---------------------------------------------------------------------------
// Heartbeat / size constants — overridable per server for fast tests
// ---------------------------------------------------------------------------

/** Default interval between server-issued heartbeat pings, in ms. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * If no `pong` is received within this window after a heartbeat ping is sent,
 * the connection is terminated. Should be > DEFAULT_HEARTBEAT_INTERVAL_MS.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

/** Largest allowable client-sent control message, bytes. Excess → close 1009. */
export const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024; // 1 MiB

/** Per-client send-buffer threshold before we start dropping messages for that client. */
export const SEND_BACKPRESSURE_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MiB

// ---------------------------------------------------------------------------
// Log channel payload
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Plain-data log entry forwarded onto the `log` WS channel. */
export interface LogEntry {
	level: LogLevel;
	msg: string;
	args: unknown[];
	ts: string;
	/**
	 * Emitting subsystem name. Base serviceCtx → `"bilibili-notify"`;
	 * `forSubsystem("dynamic")` → `"bilibili-notify:dynamic"`. Drives the Logs
	 * tab's source/subsystem filter. Optional for backward compat — entries
	 * predating this field (or hand-built in tests) simply have no source facet.
	 */
	name?: string;
}

// ---------------------------------------------------------------------------
// Client-control schemas (Zod)
// ---------------------------------------------------------------------------

export const SubscribeMsgSchema = z.object({
	type: z.literal("subscribe"),
	channels: z.array(ChannelNameSchema).min(1),
});

export const UnsubscribeMsgSchema = z.object({
	type: z.literal("unsubscribe"),
	channels: z.array(ChannelNameSchema).min(1),
});

export const PingMsgSchema = z.object({
	type: z.literal("ping"),
});

export const PongMsgSchema = z.object({
	type: z.literal("pong"),
});

export const ClientControlSchema = z.discriminatedUnion("type", [
	SubscribeMsgSchema,
	UnsubscribeMsgSchema,
	PingMsgSchema,
	PongMsgSchema,
]);

export type ClientControl = z.infer<typeof ClientControlSchema>;

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
