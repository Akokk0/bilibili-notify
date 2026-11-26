import { createHash } from "node:crypto";
import type {
	Disposable,
	ExtensionContext,
	ExtensionLiveInteractionReport,
	Result,
	WebSocketLike,
} from "@bilibili-notify/extension";
import { DEFAULT_ENV, xbogus } from "abogus";
import { heartbeat, readRoomFrame } from "./live-wire";
import { userAgent } from "./web";

export const liveOrigin = "https://live.douyin.com";
const socketEndpoint = "wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/";

export function roomSocketUrl(roomId: string, viewerId: string) {
	// The registered order is part of the browser handshake signature.
	// https://github.com/skmcj/dycast/blob/main/src/core/dycast.ts
	const signedFields = {
		live_id: "1",
		aid: "6383",
		version_code: "180800",
		webcast_sdk_version: "1.0.14-beta.0",
		room_id: roomId,
		sub_room_id: "",
		sub_channel_id: "",
		did_rule: "3",
		user_unique_id: viewerId,
		device_platform: "web",
		device_type: "",
		ac: "",
		identity: "audience",
	};
	const stub = createHash("md5")
		.update(
			Object.entries(signedFields)
				.map(([key, value]) => `${key}=${value}`)
				.join(","),
		)
		.digest("hex");
	const now = Date.now();
	const query = new URLSearchParams({
		...signedFields,
		app_name: "douyin_web",
		update_version_code: signedFields.webcast_sdk_version,
		compress: "gzip",
		cookie_enabled: "true",
		screen_width: String(DEFAULT_ENV.screen.width),
		screen_height: String(DEFAULT_ENV.screen.height),
		browser_language: "zh-CN",
		browser_platform: DEFAULT_ENV.platform,
		browser_name: "Mozilla",
		browser_version: userAgent.replace(/^Mozilla\//, ""),
		browser_online: "true",
		tz_name: "Asia/Shanghai",
		cursor: `h-1_t-${now}_r-1_d-1_u-1`,
		host: liveOrigin,
		endpoint: "live_pc",
		support_wrds: "1",
		im_path: "/webcast/im/fetch/",
		need_persist_msg_count: "0",
		heartbeatDuration: "0",
	});
	return new URL(`${socketEndpoint}?${query}&signature=${xbogus({ stub, counter: 1 })}`);
}

const heartbeatInterval = 10_000;
const idleTimeout = 45_000;
const openTimeout = 15_000;

function listenToRoom(
	ctx: ExtensionContext,
	socket: WebSocketLike,
	roomId: string,
	signal: AbortSignal,
	callbacks: {
		ended(): void;
		received(): void;
		interaction(key: string, report: ExtensionLiveInteractionReport): void;
		disconnected(rejected: boolean): void;
	},
): Disposable {
	let listening = true;
	let lastFrameAt = Date.now();
	let timer = ctx.setTimeout(disconnect, openTimeout);
	function dispose() {
		if (!listening) return;
		listening = false;
		timer.dispose();
		signal.removeEventListener("abort", dispose);
		if (socket.readyState < 2) socket.close();
	}
	function disconnect(rejected = false) {
		if (!listening) return;
		dispose();
		if (!signal.aborted) callbacks.disconnected(rejected);
	}
	function send(payload: Uint8Array) {
		try {
			socket.send(payload);
			return true;
		} catch {
			disconnect();
			return false;
		}
	}
	function pulse() {
		if (!listening) return;
		if (Date.now() - lastFrameAt >= idleTimeout) return disconnect();
		if (send(heartbeat)) timer = ctx.setTimeout(pulse, heartbeatInterval);
	}
	socket.binaryType = "nodebuffer";
	socket.on("error", (error) =>
		disconnect(
			error instanceof Error &&
				/Unexpected server response: (200|401|403|429)\b/.test(error.message),
		),
	);
	socket.on("close", (code) => disconnect(code === 1008));
	socket.on("open", () => {
		timer.dispose();
		lastFrameAt = Date.now();
		pulse();
	});
	socket.on("message", (bytes, isBinary) => {
		if (!listening || isBinary === false || !(bytes instanceof Uint8Array)) return;
		let frame: ReturnType<typeof readRoomFrame>;
		try {
			frame = readRoomFrame(bytes, roomId);
		} catch {
			return;
		}
		if (!frame) return;
		lastFrameAt = Date.now();
		callbacks.received();
		if (frame.ack) send(frame.ack);
		for (const { key, report } of frame.interactions) callbacks.interaction(key, report);
		if (frame.ended) callbacks.ended();
	});
	signal.addEventListener("abort", dispose, { once: true });
	if (signal.aborted) dispose();
	return { dispose };
}

export function watchRoomSocket(
	ctx: ExtensionContext,
	open: () => Result<{ socket: WebSocketLike }>,
	roomId: string,
	signal: AbortSignal,
	callbacks: {
		ended(): void;
		ready(): void;
		unavailable(): void;
		interaction(report: ExtensionLiveInteractionReport): void;
	},
): Disposable {
	let connection: Disposable | undefined;
	let retry: Disposable | undefined;
	let attempt = 0;
	let disposed = false;
	const seen = new Set<string>();

	function lost(rejected: boolean) {
		connection = undefined;
		if (disposed || signal.aborted) return;
		callbacks.unavailable();
		const delay = rejected ? 10 * 60_000 : Math.min(120_000, 15_000 * 2 ** Math.min(attempt++, 3));
		retry = ctx.setTimeout(connect, delay);
	}
	function connect() {
		retry = undefined;
		if (disposed || signal.aborted) return;
		const result = open();
		if (!result.ok) return lost(result.code === "rate_limited" || result.code === "unauthorized");
		let ready = false;
		connection = listenToRoom(ctx, result.socket, roomId, signal, {
			ended: callbacks.ended,
			disconnected: lost,
			interaction(key, report) {
				if (seen.has(key)) return;
				seen.add(key);
				if (seen.size > 8192) {
					const oldest = seen.values().next();
					if (!oldest.done) seen.delete(oldest.value);
				}
				callbacks.interaction(report);
			},
			received() {
				if (ready) return;
				ready = true;
				attempt = 0;
				callbacks.ready();
			},
		});
	}
	function dispose() {
		disposed = true;
		retry?.dispose();
		connection?.dispose();
		signal.removeEventListener("abort", dispose);
	}
	signal.addEventListener("abort", dispose, { once: true });
	connect();
	return { dispose };
}
