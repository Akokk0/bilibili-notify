import type { BiliEvents, ConfigScope, Disposable, MessageBus } from "@bilibili-notify/internal";
import { toHistoryView } from "../history/view.js";
import type { LogChannel } from "./log-channel.js";
import { CHANNELS, type ChannelName, type LogEntry, type ServerEventEnvelope } from "./types.js";

/**
 * Channel ↔ event wiring.
 *
 * Bus subscriptions are taken ONCE per process (not once per client).
 * When an event fires we publish a single envelope and the WS server fans it
 * out to whichever clients have subscribed to the channel. This keeps the bus
 * cheap regardless of dashboard population.
 */

type ChannelPublisher = (envelope: ServerEventEnvelope) => void;

export interface ChannelWiringDeps {
	bus: MessageBus;
	log: LogChannel;
	/** Called once per server-pushed event with a fully built envelope. */
	publish: ChannelPublisher;
}

/**
 * Compute a `state/hydrate` envelope. The dashboard receives one of these on
 * subscribe and after every reconnect.
 *
 * **It carries no payload, on purpose.** The original design (ba25f2a, stage
 * 2.3) packed `{ globals, subscriptions, targets }` in here "so the UI can
 * render without a separate REST round-trip" — written before the dashboard
 * existed. The dashboard that got built runs on react-query and fetches over
 * REST; `handleStateEnvelope` reads nothing from this frame, it only
 * invalidates the three queries. That intent was never realised.
 *
 * Meanwhile 25e4210 (`fix(security)`) closed the plaintext-apiKey leak on
 * `GET /api/globals` and in the DOM, naming the threat model exactly:
 * "devtools 直接可见,屏幕共享/截图也会泄漏". It missed this path — so every
 * subscribe and every reconnect shipped unredacted provider keys and search
 * keys over the wire, straight into the browser's Network panel, for a
 * consumer that discards them.
 *
 * If the round-trip saving is ever wanted, the client must read a **redacted**
 * snapshot (see `redactGlobals` in routes/globals.ts) — never `getGlobals()`.
 */
export function buildStateHydrate(): ServerEventEnvelope<null> {
	return {
		type: "state",
		event: "hydrate",
		ts: new Date().toISOString(),
		data: null,
	};
}

/**
 * Build a `state/config-changed` envelope. Carries the scope marker only.
 *
 * Same reasoning as {@link buildStateHydrate}: the client reads `.scope` and
 * nothing else, and the `globals` scope would otherwise put plaintext keys on
 * the wire on every config write. The `secrets` scope was already exempted
 * when this was first written — the other scopes just never got the same
 * treatment once redaction landed.
 */
function buildConfigChangedEnvelope(
	scope: ConfigScope,
): ServerEventEnvelope<{ scope: ConfigScope }> {
	return {
		type: "state",
		event: "config-changed",
		ts: new Date().toISOString(),
		data: { scope },
	};
}

function envelope<E extends keyof BiliEvents>(
	channel: ChannelName,
	event: E,
	args: Parameters<BiliEvents[E]>,
): ServerEventEnvelope {
	// For 0-arg events (auth-lost, auth-restored, ready, subscription-changed) data is null.
	// For single-arg events we unwrap and pass the value directly.
	// For multi-arg events (live-state-changed: uid, status) we pass the full tuple.
	let data: unknown;
	if (args.length === 0) data = null;
	else if (args.length === 1) data = args[0];
	else data = args;
	return { type: channel, event: event as string, ts: new Date().toISOString(), data };
}

/** All bus subscriptions taken for the lifetime of the WS server. */
export function attachChannelWiring(deps: ChannelWiringDeps): Disposable {
	const subs: Disposable[] = [];

	// auth channel ----------------------------------------------------------
	subs.push(
		deps.bus.on("login-status-report", (snapshot) =>
			deps.publish(envelope("auth", "login-status-report", [snapshot])),
		),
	);
	subs.push(deps.bus.on("auth-lost", () => deps.publish(envelope("auth", "auth-lost", []))));
	subs.push(
		deps.bus.on("auth-restored", () => deps.publish(envelope("auth", "auth-restored", []))),
	);
	subs.push(
		deps.bus.on("cookies-refreshed", (data) => {
			// SECURITY: the bus payload is `{ cookiesJson, refreshToken }` (see
			// packages/api → CookiesRefreshedPayload). Forwarding it verbatim to
			// every dashboard client would leak the full session cookie to anyone
			// connected. We strip to a minimal "refresh happened" signal — the
			// frontend doesn't need the cookie itself, just to know the refresh
			// occurred so it can re-fetch auth status if desired. Plan §4.2 Fix 5.
			const safe: { refreshedAt: string; ok?: boolean } = {
				refreshedAt: new Date().toISOString(),
			};
			if (
				data &&
				typeof data === "object" &&
				"ok" in data &&
				typeof (data as { ok: unknown }).ok === "boolean"
			) {
				safe.ok = (data as { ok: boolean }).ok;
			}
			deps.publish({
				type: "auth",
				event: "cookies-refreshed",
				ts: new Date().toISOString(),
				data: safe,
			});
		}),
	);

	// push-events channel ---------------------------------------------------
	// 历史那一行的 wire view(与 GET /api/history 同一投影),面板的小卡不用二次 fetch。
	// `history-recorded` 是建行(本体落地),`history-updated` 是同一行追加了消息 ——
	// 前端按 id 换缓存、小卡同 id 换字。图片留 `imageRef: <filename>`,客户端对着
	// /api/history/img 解析。
	for (const event of ["history-recorded", "history-updated"] as const) {
		subs.push(
			deps.bus.on(event, (entry) => {
				deps.publish({
					type: "push-events",
					event,
					ts: new Date().toISOString(),
					data: toHistoryView(entry),
				});
			}),
		);
	}
	subs.push(
		deps.bus.on("live-state-changed", (uid, status) =>
			deps.publish(envelope("push-events", "live-state-changed", [uid, status])),
		),
	);
	subs.push(
		deps.bus.on("live-viewers-changed", (uid, viewers) =>
			deps.publish(envelope("push-events", "live-viewers-changed", [uid, viewers])),
		),
	);
	subs.push(
		deps.bus.on("fans-refreshed", (entries) =>
			deps.publish(envelope("push-events", "fans-refreshed", [entries])),
		),
	);

	// log channel -----------------------------------------------------------
	// Two sources merge here:
	//   1. engine-error events from the bus (any business engine reporting a failure)
	//   2. logger.<level> calls (via the LogChannel that NodeServiceContext feeds)
	subs.push(
		deps.bus.on("engine-error", (source, message) =>
			deps.publish(envelope("log", "engine-error", [source, message])),
		),
	);
	const unsubLog = deps.log.subscribe((entry: LogEntry) => {
		deps.publish({
			type: "log",
			event: entry.level,
			ts: entry.ts,
			// `name` carries the emitting subsystem so the Logs tab can offer a
			// source/subsystem filter. Entry is already redacted upstream.
			data: { msg: entry.msg, args: entry.args, name: entry.name },
		});
	});
	subs.push({ dispose: unsubLog });

	// state channel ---------------------------------------------------------
	subs.push(
		deps.bus.on("config-changed", (scope) => deps.publish(buildConfigChangedEnvelope(scope))),
	);

	return {
		dispose() {
			for (const s of subs) {
				try {
					s.dispose();
				} catch {
					// Best-effort during teardown.
				}
			}
		},
	};
}

/** Re-exported for callers that need the canonical channel list. */
export const ALL_CHANNELS: readonly ChannelName[] = CHANNELS;
