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

import type { BusEvents, FailureCode, Issue } from "@bilibili-notify/internal";
import type { ResourceSample, ResourcesHydrate } from "./resources";
import type { HistoryEntryView } from "./rest";

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

export const CHANNELS = ["auth", "push-events", "log", "state", "resources"] as const;
export type ChannelName = (typeof CHANNELS)[number];

// ---------------------------------------------------------------------------
// Log channel payload
// ---------------------------------------------------------------------------

/** 4 值 wire 日志级别(WS `log` 帧与 `/api/system/logs` 归档共用;比 3 值配置枚举宽,含 warn)。 */
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
	 * `forSubsystem("dynamic", <levelKey>)` → `"dynamic"`. Drives the Logs
	 * tab's source/subsystem filter. Optional for backward compat — entries
	 * predating this field (or hand-built in tests) simply have no source facet.
	 */
	name?: string;
}

// ---------------------------------------------------------------------------
// Server envelope types
// ---------------------------------------------------------------------------

/**
 * 服务端推给面板的事件表:频道 → 事件名 → `data`。
 *
 * 从总线转来的直接取 `BusEvents` 的载荷,线上的事件名与总线同名;总线上没有载荷的,帧里是 `null`。
 * 服务端投影过(历史行)或自己造的(`hydrate`、资源采样、日志行)写明。面板照这张表拿 `data`,
 * 不再各自手写类型断言。
 */
export interface WsEvents {
	auth: {
		/** 一个来源的登录状态变了;载荷只有来源键与状态,账号走 `GET /api/sources/:sourceKey/auth`。 */
		"subscription-auth-changed": BusEvents["subscription-auth-changed"];
	};
	"push-events": {
		/** 历史那一行的 wire 视图(与 `GET /api/history` 同一投影),图片留文件名。 */
		"history-recorded": HistoryEntryView;
		"history-updated": HistoryEntryView;
		"live-session-changed": BusEvents["live-session-changed"];
		"live-viewers-changed": BusEvents["live-viewers-changed"];
		"fans-refreshed": BusEvents["fans-refreshed"];
	};
	/** 日志行按级别当事件名发,字段是冻结格式。 */
	log: { "engine-error": BusEvents["engine-error"] } & Record<
		LogLevel,
		Pick<LogEntry, "msg" | "args" | "name">
	>;
	state: {
		/** 订阅与重连时推一帧,面板据此失效自己的查询;不带数据(配置里有密钥)。 */
		hydrate: null;
		"config-changed": BusEvents["config-changed"];
		"extension-status-changed": BusEvents["extension-status-changed"];
		"extension-settings-changed": BusEvents["extension-settings-changed"];
		"extension-report-discrepancies-changed": BusEvents["extension-report-discrepancies-changed"];
		"subscription-profiles-changed": BusEvents["subscription-profiles-changed"];
		"problems-changed": BusEvents["problems-changed"];
	};
	resources: {
		hydrate: ResourcesHydrate;
		sample: ResourceSample;
	};
}

/**
 * 一帧服务端推送的事件。按 `type`(频道)与 `event` 收窄之后,`data` 的类型就定了;`C` 限定频道。
 */
export type WsEventEnvelope<C extends ChannelName = ChannelName> = {
	[K in C]: {
		[E in keyof WsEvents[K]]: { type: K; event: E; ts: string; data: WsEvents[K][E] };
	}[keyof WsEvents[K]];
}[C];

export interface WsControlEnvelope {
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

export type WsEnvelope = WsEventEnvelope | WsControlEnvelope;
