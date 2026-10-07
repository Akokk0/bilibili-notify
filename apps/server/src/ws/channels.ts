import type { WsEvents } from "@bilibili-notify/contract";
import type { Disposable, MessageBus } from "@bilibili-notify/internal";
import { toHistoryView } from "../history/view.js";
import type { LogChannel } from "./log-channel.js";
import { CHANNELS, type ChannelName, type LogEntry, type WsEventEnvelope } from "./types.js";

/**
 * Channel ↔ event wiring.
 *
 * Bus subscriptions are taken ONCE per process (not once per client).
 * When an event fires we publish a single envelope and the WS server fans it
 * out to whichever clients have subscribed to the channel. This keeps the bus
 * cheap regardless of dashboard population.
 */

type ChannelPublisher = (envelope: WsEventEnvelope) => void;

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
 * `GET /api/settings` and in the DOM, naming the threat model exactly:
 * "devtools 直接可见,屏幕共享/截图也会泄漏". It missed this path — so every
 * subscribe and every reconnect shipped unredacted provider keys and search
 * keys over the wire, straight into the browser's Network panel, for a
 * consumer that discards them.
 *
 * If the round-trip saving is ever wanted, the client must read a **redacted**
 * snapshot (see `globalConfigView` in routes/secret-view.ts) — never `getGlobals()`.
 */
export function buildStateHydrate(): WsEventEnvelope<"state"> {
	return envelope("state", "hydrate", null);
}

/**
 * 造一帧。`data` 的类型按 contract 的事件表(`WsEvents`)查 —— 频道、事件名、载荷三者对不上就
 * 编译不过。
 */
export function envelope<C extends ChannelName, E extends keyof WsEvents[C]>(
	channel: C,
	event: E,
	data: WsEvents[C][E],
): WsEventEnvelope<C> {
	// 泛型的映射联合 TS 验不了,参数那一侧已经按表钉住。
	return { type: channel, event, ts: new Date().toISOString(), data } as WsEventEnvelope<C>;
}

/**
 * All bus subscriptions taken for the lifetime of the WS server.
 *
 * 总线事件原样成帧:线上的事件名与总线同名,`data` 就是总线的载荷(没有载荷的是 `null`)。
 * 只有历史行要投影成 wire 视图。
 */
export function attachChannelWiring(deps: ChannelWiringDeps): Disposable {
	const subs: Disposable[] = [];
	const { bus, publish } = deps;

	// auth channel ----------------------------------------------------------
	subs.push(
		bus.on("login-status-report", (snapshot) =>
			publish(envelope("auth", "login-status-report", snapshot)),
		),
		bus.on("auth-lost", () => publish(envelope("auth", "auth-lost", null))),
		bus.on("auth-restored", () => publish(envelope("auth", "auth-restored", null))),
		// 总线上只有刷新的时刻(cookie 是密钥,不上总线,见 `BusEvents`)。
		bus.on("cookies-refreshed", (refreshed) =>
			publish(envelope("auth", "cookies-refreshed", refreshed)),
		),
	);

	// push-events channel ---------------------------------------------------
	// 历史那一行的 wire view(与 GET /api/history 同一投影),面板的小卡不用二次 fetch。
	// `history-recorded` 是建行(本体落地),`history-updated` 是同一行追加了消息 ——
	// 前端按 id 换缓存、小卡同 id 换字。图片留 `image: <图库引用>`,客户端对着
	// /api/images/<引用> 解析。
	for (const event of ["history-recorded", "history-updated"] as const) {
		subs.push(
			bus.on(event, (entry) => publish(envelope("push-events", event, toHistoryView(entry)))),
		);
	}
	subs.push(
		bus.on("live-state-changed", (change) =>
			publish(envelope("push-events", "live-state-changed", change)),
		),
		bus.on("live-viewers-changed", (change) =>
			publish(envelope("push-events", "live-viewers-changed", change)),
		),
		bus.on("fans-refreshed", (fans) => publish(envelope("push-events", "fans-refreshed", fans))),
		// 拓展订阅的在播表变了(ADR-0019 决策 12 / 57):不带载荷,面板让「正在直播」重取。在播表那头
		// 已经按窗口合并过,这里一发一帧。
		bus.on("extension-live-changed", () =>
			publish(envelope("push-events", "extension-live-changed", null)),
		),
	);

	// log channel -----------------------------------------------------------
	// Two sources merge here:
	//   1. engine-error events from the bus (any business engine reporting a failure)
	//   2. logger.<level> calls (via the LogChannel that NodeServiceContext feeds)
	subs.push(bus.on("engine-error", (error) => publish(envelope("log", "engine-error", error))));
	const unsubLog = deps.log.subscribe((entry: LogEntry) => {
		publish({
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
		// 只带 scope:和 hydrate 同一个理由,`globals` 那一档要是带上内容,每次写配置都会把明文密钥
		// 送上线。客户端也只读 scope。
		bus.on("config-changed", (change) => publish(envelope("state", "config-changed", change))),
		// 拓展喊「面板数据变了」:只带拓展 id,面板按 id 失效 `/api/ext/<id>/status` 与 bot 名单的缓存。
		bus.on("extension-status-changed", (change) =>
			publish(envelope("state", "extension-status-changed", change)),
		),
		// 拓展的设置写进去了:同样只带拓展 id(设置里有密钥,不进帧),面板按 id 失效设置与视图。
		bus.on("extension-settings-changed", (change) =>
			publish(envelope("state", "extension-settings-changed", change)),
		),
		// 拓展的「上报问题」新记了几条(ADR-0019 决策 60):只带拓展 id,面板让拓展表失效(那个框住在
		// 那一行上)。不借 `extension-status-changed` —— 那一帧说的是视图变了。
		bus.on("extension-report-problems-changed", (change) =>
			publish(envelope("state", "extension-report-problems-changed", change)),
		),
		// 拓展报的资料落进了资料缓存(ADR-0019 决策 7 / 62):面板重取订阅列表。那不是配置,不走
		// `config-changed` —— 那一档服务端也会惊动路由、引擎与拓展。帧里只有订阅 id。
		bus.on("subscription-profiles-changed", (change) =>
			publish(envelope("state", "subscription-profiles-changed", change)),
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
