import type { Disposable, ExtensionContext } from "@bilibili-notify/extension";
import {
	BinBuffer,
	List,
	TarsInputStream,
	TarsOutputStream,
	String as TarsString,
} from "@tars/stream";

export type RoomNotice =
	| { kind: "live" | "offline"; sessionId?: string }
	| { kind: "change" }
	| { kind: "heatScore" | "vipViewers"; value: number };

function register(uid: string) {
	const groups = new List(TarsString);
	groups.push(`live:${uid}`);
	groups.push(`chat:${uid}`);
	const join = new TarsOutputStream();
	join.writeList(0, groups);
	join.writeString(1, "");
	const packet = new TarsOutputStream();
	packet.writeInt32(0, 16);
	packet.writeBytes(1, join.getBinBuffer());
	return packet.getBinBuffer().toNodeBuffer();
}

class PushItem {
	constructor(
		readonly uri: number,
		readonly payload: BinBuffer,
	) {}
	static _read(input: TarsInputStream, tag: number) {
		return input.readStruct(tag, true, PushItem);
	}
	static _readFrom(input: TarsInputStream) {
		return new PushItem(input.readInt64(0, true), input.readBytes(1, true, BinBuffer));
	}
}

function roomNotice(uid: string, item: PushItem): RoomNotice | undefined {
	const data = new TarsInputStream(item.payload);
	if (item.uri === 8006) {
		const value = data.readInt32(0, true);
		if (value >= 0) return { kind: "heatScore", value };
		return;
	}
	if (
		![8000, 8001, 8004, 6211].includes(item.uri) ||
		String(data.readInt64(0, true, undefined, true)) !== uid
	)
		return;
	switch (item.uri) {
		case 8000: {
			const sessionId = String(data.readInt64(7, false, "0", true));
			return {
				kind: data.readInt32(39, false, 0) === 0 ? "live" : "offline",
				sessionId: sessionId === "0" ? undefined : sessionId,
			};
		}
		case 8001:
			return { kind: "offline" };
		case 8004:
			return { kind: "change" };
		case 6211: {
			const value = data.readInt32(1, true);
			if (value >= 0) return { kind: "vipViewers", value };
		}
	}
}

// 7 是单条推送，22 是同一房间组的批量推送。
function decode(bytes: Uint8Array, uid: string) {
	const input = new TarsInputStream(
		new BinBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
	);
	const cmd = input.readInt32(0, true);
	if (cmd === 21) return "heartbeat";
	if (cmd !== 17 && cmd !== 7 && cmd !== 22) return;
	const data = new TarsInputStream(input.readBytes(1, true, BinBuffer));
	if (cmd === 17) return data.readInt32(0, true) === 0 ? "joined" : "rejected";
	let items: PushItem[];
	const matches = (group: string) => group === `live:${uid}` || group === `chat:${uid}`;
	if (cmd === 7) {
		const item = new PushItem(data.readInt64(1, true), data.readBytes(2, true, BinBuffer));
		if (!matches(data.readString(4, false, ""))) return;
		items = [item];
	} else {
		if (!matches(data.readString(0, true))) return;
		items = data.readList(1, true, List(PushItem)).value;
	}
	const notices: RoomNotice[] = [];
	for (const item of items) {
		const notice = roomNotice(uid, item);
		if (notice) notices.push(notice);
	}
	return notices;
}

export function listen(
	ctx: ExtensionContext,
	uid: string,
	signal: AbortSignal,
	callbacks: {
		ready(): void;
		heartbeat(): void;
		notice(event: RoomNotice): void;
		disconnected(): void;
	},
): Disposable | undefined {
	const result = ctx.http.websocket("wss://cdnws.api.huya.com/", {
		bare: true,
		headers: { Origin: "https://www.huya.com" },
		signal,
	});
	if (!result.ok) return;
	const { socket } = result;
	let alive = true,
		joined = false,
		awaitingHeartbeat = false;
	let timer: Disposable;
	function dispose() {
		if (!alive) return;
		alive = false;
		timer.dispose();
		signal.removeEventListener("abort", dispose);
		if (socket.readyState < 2) socket.close();
	}
	function disconnect() {
		if (!alive) return;
		dispose();
		if (!signal.aborted) callbacks.disconnected();
	}
	function sendHeartbeat() {
		if (awaitingHeartbeat) return disconnect();
		awaitingHeartbeat = true;
		try {
			socket.send(Buffer.from("ABQdAAwsNgBM", "base64"));
		} catch {
			return disconnect();
		}
		timer = ctx.setTimeout(sendHeartbeat, 45000);
	}
	timer = ctx.setTimeout(disconnect, 15000);
	signal.addEventListener("abort", dispose, { once: true });
	socket.binaryType = "nodebuffer";
	socket.on("error", disconnect);
	socket.on("close", disconnect);
	socket.on("open", () => {
		if (!alive) return;
		try {
			socket.send(register(uid));
		} catch {
			disconnect();
		}
	});
	socket.on("message", (bytes) => {
		if (!alive || !(bytes instanceof Uint8Array) || bytes.byteLength > 2 * 1024 * 1024) return;
		let message: ReturnType<typeof decode>;
		try {
			message = decode(bytes, uid);
		} catch {
			return;
		}
		if (message === "heartbeat") {
			if (awaitingHeartbeat) callbacks.heartbeat();
			awaitingHeartbeat = false;
		} else if (message === "rejected") {
			disconnect();
		} else if (message === "joined" && !joined) {
			joined = true;
			timer.dispose();
			timer = ctx.setTimeout(sendHeartbeat, 45000);
			callbacks.ready();
		} else if (joined && Array.isArray(message)) {
			for (const event of message) callbacks.notice(event);
		}
	});
	return { dispose };
}
