import type { BiliEvents, ConfigScope, Disposable, MessageBus } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
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

export type ChannelPublisher = (envelope: ServerEventEnvelope) => void;

export interface ChannelWiringDeps {
	bus: MessageBus;
	store: ConfigStore;
	log: LogChannel;
	/** Called once per server-pushed event with a fully built envelope. */
	publish: ChannelPublisher;
}

/** Compute a fresh `state/hydrate` envelope. The dashboard receives one of these immediately on subscribe. */
export function buildStateHydrate(store: ConfigStore): ServerEventEnvelope<{
	globals: ReturnType<ConfigStore["getGlobals"]>;
	subscriptions: ReturnType<ConfigStore["getSubscriptions"]>;
	targets: ReturnType<ConfigStore["getTargets"]>;
}> {
	return {
		type: "state",
		event: "hydrate",
		ts: new Date().toISOString(),
		data: {
			globals: store.getGlobals(),
			subscriptions: store.getSubscriptions(),
			targets: store.getTargets(),
		},
	};
}

/** Build a `state/config-changed` envelope including the fresh snapshot for that scope. */
function buildConfigChangedEnvelope(
	store: ConfigStore,
	scope: ConfigScope,
): ServerEventEnvelope<{ scope: ConfigScope; snapshot: unknown }> {
	let snapshot: unknown;
	switch (scope) {
		case "globals":
			snapshot = store.getGlobals();
			break;
		case "subscriptions":
			snapshot = store.getSubscriptions();
			break;
		case "targets":
			snapshot = store.getTargets();
			break;
		case "secrets":
			// Secrets snapshots are NOT pushed over WS — clients must hit a dedicated
			// REST endpoint that does the redacted shape. Send only the scope marker.
			snapshot = null;
			break;
	}
	return {
		type: "state",
		event: "config-changed",
		ts: new Date().toISOString(),
		data: { scope, snapshot },
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
	// Carry the full HistoryEntry view (id, ts, source, uid, ok, text) so the
	// dashboard's toast can render without a second fetch. Image refs stay as
	// `imageRef: <filename>` — clients resolve those against /api/history/img.
	subs.push(
		deps.bus.on("history-recorded", (entry) => {
			const view = {
				id: entry.id,
				ts: entry.ts,
				source: entry.source,
				uid: entry.uid,
				subscriptionId: entry.subscriptionId,
				targetIds: entry.targetIds,
				ok: entry.result.ok,
				text: entry.payload.text,
				imageRef: entry.payload.imageRef,
			};
			deps.publish({
				type: "push-events",
				event: "history-recorded",
				ts: new Date().toISOString(),
				data: view,
			});
		}),
	);
	subs.push(
		deps.bus.on("live-state-changed", (uid, status) =>
			deps.publish(envelope("push-events", "live-state-changed", [uid, status])),
		),
	);

	// log channel -----------------------------------------------------------
	// Two sources merge here:
	//   1. plugin-error events from the bus (any sub-engine reporting a failure)
	//   2. logger.<level> calls (via the LogChannel that NodeServiceContext feeds)
	subs.push(
		deps.bus.on("plugin-error", (source, message) =>
			deps.publish(envelope("log", "plugin-error", [source, message])),
		),
	);
	const unsubLog = deps.log.subscribe((entry: LogEntry) => {
		deps.publish({
			type: "log",
			event: entry.level,
			ts: entry.ts,
			data: { msg: entry.msg, args: entry.args },
		});
	});
	subs.push({ dispose: unsubLog });

	// state channel ---------------------------------------------------------
	subs.push(
		deps.bus.on("config-changed", (scope) =>
			deps.publish(buildConfigChangedEnvelope(deps.store, scope)),
		),
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
