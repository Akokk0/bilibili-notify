import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import {
	type ExtensionContext,
	type ExtensionSourceContext,
	type FetchOptions,
	ok,
	type SourceDef,
	type WebSocketOptions,
} from "@bilibili-notify/extension";
import { expect, it, vi } from "vite-plus/test";
import { activate } from "../index";
import { testCookieSession } from "./support/cookie-session";

it("registers Douyin and reads a creator, explicit live status and new works through the host HTTP interface", async () => {
	const signal = new AbortController().signal;
	const author = {
		sec_uid: "MS4wLjABAAAA123",
		unique_id: "account_12",
		nickname: "阿青",
		live_status: 0,
	};
	let works: unknown[] = [];
	let source!: SourceDef;
	let tick!: () => Promise<void>;
	const paths: string[] = [];
	const fetch = vi.fn(async (input: URL | string, options: FetchOptions) => {
		const url = new URL(input);
		paths.push(url.pathname);
		expect(options.bare).toBe(true);
		expect(options.maxRedirects).toBe(0);
		let body: object;
		switch (url.pathname) {
			case "/web/api/v2/user/info/":
				expect(url.searchParams.get("unique_id")).toBe("account_12");
				body = { status_code: 0, user_info: author };
				break;
			case "/aweme/v1/web/user/profile/other/":
				expect(url.searchParams.get("sec_user_id")).toBe(author.sec_uid);
				expect(url.searchParams.has("a_bogus")).toBe(true);
				body = { status_code: 0, user: author };
				break;
			case "/aweme/v1/web/aweme/post/":
				expect(url.searchParams.get("sec_user_id")).toBe(author.sec_uid);
				body = { status_code: 0, aweme_list: works, has_more: 0 };
				break;
			default:
				throw new Error(`Unexpected URL ${url.pathname}`);
		}
		return ok({
			status: 200,
			isSuccess: true,
			headers: new Headers(),
			text: () => JSON.stringify(body),
			json: () => ok({ value: body }),
		});
	});
	activate({
		createCookieSession: testCookieSession,
		signal,
		i18n: { t: (k: string) => k },
		onDispose: vi.fn(),
		logger: { warn: vi.fn() },
		secrets: { get: () => undefined },
		setInterval(fn: () => Promise<void>) {
			tick = fn;
			return { dispose() {} };
		},
		registerSource(value: SourceDef) {
			source = value;
		},
		http: { fetch },
	} as unknown as ExtensionContext);
	expect(await source.searchCreators("account_12", signal)).toEqual({
		ok: true,
		candidates: [{ externalId: author.sec_uid, displayId: "account_12", name: "阿青" }],
	});
	const host = {
		signal,
		subscriptions: () => [
			{ externalId: author.sec_uid, features: new Set(["post", "liveEnd"]), monitorsLive: true },
		],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		onDispose: vi.fn(),
		reportProfile: vi.fn(),
		reportLive: vi.fn(),
		reportPost: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
	};
	await source.start(host as unknown as ExtensionSourceContext);
	await tick();
	expect(host.reportProfile).toHaveBeenCalledWith(author.sec_uid, {
		name: "阿青",
		displayId: "account_12",
	});
	expect(host.reportLive).toHaveBeenCalledWith(author.sec_uid, {
		kind: "status",
		isLive: false,
		details: {},
	});
	works = [
		{
			aweme_id: "7520000000000000032",
			create_time: 1700000000,
			desc: "新作品",
			author,
			video: { duration: 1200 },
		},
	];
	await tick();
	expect(host.reportPost).toHaveBeenCalledWith(
		author.sec_uid,
		expect.objectContaining({
			postId: "7520000000000000032",
			url: "https://www.douyin.com/video/7520000000000000032",
		}),
	);
	await source.stop();
	expect(paths).toHaveLength(6);
});

const roomId = "7490000000000000001";
const viewerId = "7480000000000000021";
const webRid = "4387654";
const liveAuthor = {
	sec_uid: "MS4wLjABAAAAlive",
	nickname: "小鱼",
	room_id_str: roomId,
	room_data: { owner: { web_rid: webRid } },
};

function varint(value: bigint): number[] {
	const bytes: number[] = [];
	while (value > 127n) {
		bytes.push(Number(value & 127n) | 128);
		value >>= 7n;
	}
	return [...bytes, Number(value)];
}

function integer(field: number, value: string | number): number[] {
	return [...varint(BigInt(field * 8)), ...varint(BigInt(value))];
}

function data(field: number, value: string | readonly number[] | Uint8Array): number[] {
	const content = typeof value === "string" ? Buffer.from(value) : value;
	return [...varint(BigInt(field * 8 + 2)), ...varint(BigInt(content.length)), ...content];
}

function pushFrame(method: string, payload: number[], id = "7490000000000000042") {
	const message = data(1, [...data(1, method), ...data(2, payload), ...integer(3, id)]);
	const reply = gzipSync(Buffer.from([...message, ...data(5, "receipt"), ...integer(9, 1)]));
	return Buffer.from([...integer(2, "7490000000000000003"), ...data(8, reply)]);
}

async function liveFixture() {
	const signal = new AbortController().signal;
	let source!: SourceDef;
	let tick!: () => void | Promise<void>;
	let broadcasting = false;
	let activeRoom = roomId;
	const sockets: Array<ReturnType<typeof socketFixture>> = [];
	function socketFixture() {
		return Object.assign(new EventEmitter(), {
			binaryType: "",
			readyState: 0,
			send: vi.fn(),
			close: vi.fn(function (this: { readyState: number }) {
				this.readyState = 3;
			}),
		});
	}
	const websocket = vi.fn((_url: string | URL, _options: WebSocketOptions) => {
		const socket = socketFixture();
		sockets.push(socket);
		return ok({ socket });
	});
	const fetch = vi.fn(async (input: URL | string) => {
		const url = new URL(input);
		const body =
			url.pathname === "/webcast/room/web/enter/"
				? {
						status_code: 0,
						data: {
							data: [
								{
									id_str: activeRoom,
									status: broadcasting ? 2 : 3,
									start_time: activeRoom === roomId ? 1700000000 : 1700000060,
								},
							],
							user: { id_str: viewerId },
						},
					}
				: {
						status_code: 0,
						user: { ...liveAuthor, room_id_str: activeRoom, live_status: Number(broadcasting) },
					};
		return ok({
			status: 200,
			isSuccess: true,
			headers: new Headers({
				"set-cookie": "ttwid=fixture; Domain=douyin.com; Path=/; Secure",
			}),
			text: () => JSON.stringify(body),
			json: () => ok({ value: body }),
		});
	});
	activate({
		createCookieSession: testCookieSession,
		signal,
		i18n: { t: (k: string) => k },
		onDispose: vi.fn(),
		logger: { warn: vi.fn() },
		secrets: { get: () => undefined },
		setInterval(fn: () => void | Promise<void>) {
			tick = fn;
			return { dispose() {} };
		},
		setTimeout(fn: () => void, delay: number) {
			const timer = setTimeout(fn, delay);
			return { dispose: () => clearTimeout(timer) };
		},
		registerSource(value: SourceDef) {
			source = value;
		},
		http: { fetch, websocket },
		redact: vi.fn(),
	} as unknown as ExtensionContext);
	const host = {
		signal,
		subscriptions: () => [
			{ externalId: liveAuthor.sec_uid, features: new Set(["liveEnd"]), monitorsLive: true },
		],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		onDispose: vi.fn(),
		reportProfile: vi.fn(),
		reportLive: vi.fn(),
		reportLiveInteraction: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
	};
	await source.start(host as unknown as ExtensionSourceContext);
	await tick();
	return {
		...host,
		source,
		websocket,
		socket(index: number) {
			const socket = sockets[index];
			if (!socket) throw new Error(`Expected socket ${index}`);
			return socket;
		},
		changeRoom: (id: string) => {
			activeRoom = id;
		},
		broadcast: async (value: boolean) => {
			broadcasting = value;
			await tick();
		},
	};
}

it("connects after a poll discovers a live room and reports that room's end without waiting for a poll", async () => {
	const fixture = await liveFixture();
	try {
		expect(fixture.websocket).not.toHaveBeenCalled();
		await fixture.broadcast(true);
		expect(fixture.websocket).toHaveBeenCalledTimes(1);
		const call = fixture.websocket.mock.calls[0];
		if (!call) throw new Error("Expected a room handshake");
		const [input, options] = call;
		const url = new URL(input);
		expect(url.protocol).toBe("wss:");
		expect(url.searchParams.get("room_id")).toBe(roomId);
		expect(url.searchParams.get("user_unique_id")).toBe(viewerId);
		expect(url.searchParams.get("signature")).toMatch(/^.{16}$/);
		expect(new Headers(options.headers).get("cookie")).toBe("ttwid=fixture");

		const socket = fixture.socket(0);
		socket.readyState = 1;
		socket.emit("open");
		expect(socket.send).toHaveBeenCalledWith(Buffer.from("3a026862", "hex"));
		socket.emit(
			"message",
			pushFrame("WebcastControlMessage", [...data(1, integer(3, roomId)), ...integer(2, 3)]),
		);
		expect(fixture.reportLive.mock.calls.map(([, report]) => report.kind)).toEqual([
			"status",
			"start",
			"end",
		]);
		expect(socket.send).toHaveBeenCalledWith(
			Buffer.from("108380b4bd8feaf4f8673a0361636b420772656365697074", "hex"),
		);
		expect(socket.close).toHaveBeenCalledTimes(1);
		await fixture.broadcast(true);
		expect(fixture.reportLive).toHaveBeenCalledTimes(3);
		expect(fixture.websocket).toHaveBeenCalledTimes(1);
		expect(
			await fixture.source.fetchLiveStatus?.(
				{ sourceKey: "douyin", externalId: liveAuthor.sec_uid },
				fixture.signal,
			),
		).toEqual({ ok: true, kind: "offline" });
	} finally {
		await fixture.source.stop();
	}
});

it("moves the socket when the host discovers a new session before the extension's next poll", async () => {
	const fixture = await liveFixture();
	try {
		await fixture.broadcast(true);
		const old = fixture.socket(0);
		fixture.changeRoom("7490000000000000810");
		expect(
			await fixture.source.fetchLiveStatus?.(
				{ sourceKey: "douyin", externalId: liveAuthor.sec_uid },
				fixture.signal,
			),
		).toMatchObject({ ok: true, kind: "live", startedAt: "2023-11-14T22:14:20.000Z" });
		expect(old.close).toHaveBeenCalledTimes(1);
		expect(fixture.websocket).toHaveBeenCalledTimes(2);
		old.emit(
			"message",
			pushFrame("WebcastControlMessage", [...data(1, integer(3, roomId)), ...integer(2, 3)]),
		);
		expect(fixture.reportLive.mock.calls.map(([, report]) => report.kind)).toEqual([
			"status",
			"start",
			"end",
			"start",
		]);
	} finally {
		await fixture.source.stop();
	}
});

it("reconnects an interrupted room, keeps polling as a fallback and closes on source stop", async () => {
	vi.useFakeTimers();
	const fixture = await liveFixture();
	try {
		await fixture.broadcast(true);
		const first = fixture.socket(0);
		first.readyState = 3;
		first.emit("close", 1006);
		expect(fixture.reportLive.mock.calls.map(([, report]) => report.kind)).toEqual([
			"status",
			"start",
		]);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(fixture.websocket).toHaveBeenCalledTimes(2);
		await fixture.broadcast(false);
		expect(fixture.reportLive).toHaveBeenLastCalledWith(
			liveAuthor.sec_uid,
			expect.objectContaining({ kind: "end" }),
		);
		expect(fixture.socket(1).close).toHaveBeenCalledTimes(1);
		await fixture.broadcast(true);
		expect(fixture.websocket).toHaveBeenCalledTimes(3);
		await fixture.source.stop();
		expect(fixture.socket(2).close).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(fixture.websocket).toHaveBeenCalledTimes(3);
	} finally {
		await fixture.source.stop();
		vi.useRealTimers();
	}
});

it("reports same-room chat and completed gifts once, including when the socket replays a frame", async () => {
	vi.useFakeTimers();
	const fixture = await liveFixture();
	try {
		await fixture.broadcast(true);
		const first = fixture.socket(0);
		first.readyState = 1;
		first.emit("open");
		const viewer = [...integer(1, viewerId), ...data(3, "小鱼")];
		const chat = (room: string, messageId: string) =>
			pushFrame(
				"WebcastChatMessage",
				[...data(1, integer(3, room)), ...data(2, viewer), ...data(3, "晚上好")],
				messageId,
			);
		const combo = (finished: number, repeat: number, messageId: string) =>
			pushFrame(
				"WebcastGiftMessage",
				[
					...data(1, integer(3, roomId)),
					...integer(2, 678),
					...integer(4, 2),
					...integer(5, repeat),
					...data(7, viewer),
					...integer(9, finished),
					...integer(11, "7490000000000000300"),
				],
				messageId,
			);
		first.emit("message", chat("7490000000000000002", "19"));
		first.emit("message", chat(roomId, "20"));
		first.emit("message", combo(0, 1, "21"));
		first.emit("message", combo(1, 3, "22"));
		first.readyState = 3;
		first.emit("close", 1006);
		await vi.advanceTimersByTimeAsync(15_000);
		const second = fixture.socket(1);
		second.readyState = 1;
		second.emit("open");
		second.emit("message", chat(roomId, "20"));
		second.emit("message", combo(1, 3, "23"));
		second.emit(
			"message",
			pushFrame(
				"WebcastControlMessage",
				[...data(1, integer(3, "7490000000000000002")), ...integer(2, 3)],
				"24",
			),
		);
		expect(fixture.reportLive).toHaveBeenCalledTimes(2);
		expect(fixture.reportLiveInteraction.mock.calls).toEqual([
			[
				liveAuthor.sec_uid,
				{ kind: "viewerChat", viewer: { id: viewerId, name: "小鱼" }, text: "晚上好" },
			],
			[liveAuthor.sec_uid, { kind: "gift", count: 6 }],
		]);
	} finally {
		await fixture.source.stop();
		vi.useRealTimers();
	}
});
