import { CHANNELS } from "@bilibili-notify/contract";
import { z } from "zod";

/**
 * WS protocol — single endpoint at /ws, four logical channels multiplexed
 * over JSON envelopes. Stage 2.3 of the standalone end. See plan §5 (BiliEvents)
 * for the channel ↔ event mapping.
 *
 * Wire 形状(channel 名 / envelope / LogEntry)的单一来源是
 * `@bilibili-notify/contract`(web 端同源消费);这里保留服务端职责的部分:
 * 客户端控制帧的 zod 校验 schema 与心跳/背压参数,并把契约类型重导出给
 * server 内部的既有 import 路径。
 */

export {
	CHANNELS,
	type ChannelName,
	LOG_LEVELS,
	type LogEntry,
	type LogLevel,
	type ServerEnvelope,
	type ServerEventEnvelope,
} from "@bilibili-notify/contract";

const ChannelNameSchema = z.enum(CHANNELS);

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
// Client-control schemas (Zod)
// ---------------------------------------------------------------------------

const SubscribeMsgSchema = z.object({
	type: z.literal("subscribe"),
	channels: z.array(ChannelNameSchema).min(1),
});

const UnsubscribeMsgSchema = z.object({
	type: z.literal("unsubscribe"),
	channels: z.array(ChannelNameSchema).min(1),
});

const PingMsgSchema = z.object({
	type: z.literal("ping"),
});

const PongMsgSchema = z.object({
	type: z.literal("pong"),
});

export const ClientControlSchema = z.discriminatedUnion("type", [
	SubscribeMsgSchema,
	UnsubscribeMsgSchema,
	PingMsgSchema,
	PongMsgSchema,
]);

export type ClientControl = z.infer<typeof ClientControlSchema>;
