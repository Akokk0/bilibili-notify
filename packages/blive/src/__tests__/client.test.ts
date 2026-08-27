/**
 * LiveClient 行为规格,经注入的假 socket 从外部观察:
 * 连接参数全注入、无内部 HTTP、无内部重连;close() 之后保证静默 ——
 * 主动关闭的回声不会再从漏斗里冒出来,上层不需要「有意关闭」记账。
 *
 * 上行包的断言用 DataView 手拆头部;下行帧喂真实录制 fixture。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { connectLiveRoom, type LiveConnectOptions, type SocketLike } from "../client.js";
import type { LiveEvent } from "../events.js";
import frames from "./fixtures/frames.json" with { type: "json" };

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

class FakeSocket implements SocketLike {
	binaryType = "";
	sent: Uint8Array[] = [];
	closeCalls = 0;
	private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

	on(event: string, fn: (...args: unknown[]) => void): void {
		const list = this.handlers.get(event) ?? [];
		list.push(fn);
		this.handlers.set(event, list);
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
	}

	close(): void {
		this.closeCalls++;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const fn of this.handlers.get(event) ?? []) fn(...args);
	}
}

function decodeSent(packet: Uint8Array): { op: number; body: unknown } {
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	return {
		op: view.getUint32(8),
		body: JSON.parse(new TextDecoder().decode(packet.subarray(16))),
	};
}

describe("connectLiveRoom", () => {
	let socket: FakeSocket;
	let urls: string[];
	let headersSeen: Record<string, string>[];
	let events: LiveEvent[];

	beforeEach(() => {
		vi.useFakeTimers();
		socket = new FakeSocket();
		urls = [];
		headersSeen = [];
		events = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function connect(overrides: Partial<LiveConnectOptions> = {}) {
		return connectLiveRoom({
			roomId: 5050,
			uid: 42,
			token: "tok",
			buvid: "buv",
			hostList: [{ host: "danmu.example.com", wssPort: 2245 }],
			cookieHeader: "SESSDATA=x",
			userAgent: "UA/1.0",
			onEvent: (ev) => events.push(ev),
			createSocket: (url, headers) => {
				urls.push(url);
				headersSeen.push(headers);
				return socket;
			},
			...overrides,
		});
	}

	it("按 host_list 首项拼 wss URL,带 Cookie / UA 头", () => {
		connect();

		expect(urls).toEqual(["wss://danmu.example.com:2245/sub"]);
		expect(headersSeen[0]).toEqual({ Cookie: "SESSDATA=x", "User-Agent": "UA/1.0" });
	});

	it("wss_port 为 443 时省略端口", () => {
		connect({ hostList: [{ host: "h.example.com", wssPort: 443 }] });

		expect(urls).toEqual(["wss://h.example.com/sub"]);
	});

	it("socket open → 发认证包并上报 open 事件", () => {
		connect();
		socket.emit("open");

		expect(events).toEqual([{ kind: "open" }]);
		expect(socket.sent).toHaveLength(1);
		const auth = decodeSent(socket.sent[0] as Uint8Array);
		expect(auth.op).toBe(7);
		expect(auth.body).toEqual({
			uid: 42,
			roomid: 5050,
			protover: 3,
			platform: "web",
			type: 2,
			key: "tok",
			buvid: "buv",
		});
	});

	it("认证回执 code=0 → auth-ok,随后立刻发首个心跳,之后每 30s 一次", () => {
		connect();
		socket.emit("open");
		socket.emit("message", b64(frames.authReply));

		expect(events).toContainEqual({ kind: "auth-ok" });
		// 认证包 + 首心跳
		expect(socket.sent).toHaveLength(2);
		expect(decodeSent(socket.sent[1] as Uint8Array).op).toBe(2);

		vi.advanceTimersByTime(30_000);
		expect(socket.sent).toHaveLength(3);
		vi.advanceTimersByTime(30_000);
		expect(socket.sent).toHaveLength(4);
	});

	it("认证回执 code≠0 → auth-failed,不起心跳", () => {
		connect();
		socket.emit("open");
		// 合成失败回执:与真实回执同构,仅 code 不同
		const body = new TextEncoder().encode('{"code":-101}');
		const reply = new Uint8Array(16 + body.length);
		const view = new DataView(reply.buffer);
		view.setUint32(0, reply.length);
		view.setUint16(4, 16);
		view.setUint16(6, 1);
		view.setUint32(8, 8);
		reply.set(body, 16);
		socket.emit("message", reply);

		expect(events).toContainEqual({ kind: "auth-failed", code: -101 });
		vi.advanceTimersByTime(60_000);
		expect(socket.sent).toHaveLength(1);
	});

	it("认证回执缺 code 字段 → 按认证失败处理(code=-1),不起心跳", () => {
		// 协议成功形态恒为 {"code":0};缺字段当成功会把认证失败伪装成 auth-ok,
		// 上层要等 3 分钟 watchdog 才自愈 —— 保守默认按失败走重连梯子。
		connect();
		socket.emit("open");
		const body = new TextEncoder().encode("{}");
		const reply = new Uint8Array(16 + body.length);
		const view = new DataView(reply.buffer);
		view.setUint32(0, reply.length);
		view.setUint16(4, 16);
		view.setUint16(6, 1);
		view.setUint32(8, 8);
		reply.set(body, 16);
		socket.emit("message", reply);

		expect(events).toContainEqual({ kind: "auth-failed", code: -1 });
		expect(events).not.toContainEqual({ kind: "auth-ok" });
		vi.advanceTimersByTime(60_000);
		expect(socket.sent).toHaveLength(1);
	});

	it("重复认证回执 → 只处理首个,不重复 auth-ok、不叠心跳定时器", () => {
		connect();
		socket.emit("open");
		socket.emit("message", b64(frames.authReply));
		socket.emit("message", b64(frames.authReply));

		expect(events.filter((ev) => ev.kind === "auth-ok")).toHaveLength(1);
		// 认证包 + 首心跳(仅一次)
		expect(socket.sent).toHaveLength(2);
		vi.advanceTimersByTime(30_000);
		// 单个定时器:每 30s 恰好多 1 个心跳,叠了定时器会多 2 个
		expect(socket.sent).toHaveLength(3);
	});

	it("buvid 为空串时认证包省略该键(与真机验证过的包形一致)", () => {
		connect({ buvid: "" });
		socket.emit("open");

		const auth = decodeSent(socket.sent[0] as Uint8Array);
		expect(auth.body).toEqual({
			uid: 42,
			roomid: 5050,
			protover: 3,
			platform: "web",
			type: 2,
			key: "tok",
		});
	});

	it("心跳回执 → heartbeat 事件带人气值", () => {
		connect();
		socket.emit("message", b64(frames.heartbeatReply));

		expect(events).toEqual([{ kind: "heartbeat", popularity: 1 }]);
	});

	it("brotli MESSAGE 帧 → 解码解析后逐条进漏斗", () => {
		connect();
		socket.emit("message", b64(frames.brotliMessage));

		// 录制时该帧含 2 条 INTERACT_WORD_V2
		expect(events).toHaveLength(2);
		for (const ev of events) expect(ev.kind).toBe("user-action");
	});

	it("socket 错误 → error 事件;非主动关闭 → closed 事件", () => {
		connect();
		socket.emit("error", new Error("boom"));
		socket.emit("close", 1006);

		expect(events[0]).toMatchObject({ kind: "error" });
		expect(events[1]).toEqual({ kind: "closed", code: 1006 });
	});

	it("close() 之后保证静默:关 socket、停心跳、任何事件不再上报", () => {
		const client = connect();
		socket.emit("open");
		socket.emit("message", b64(frames.authReply));
		const before = events.length;

		client.close();
		expect(socket.closeCalls).toBe(1);
		expect(client.closed).toBe(true);

		socket.emit("close", 1000);
		socket.emit("message", b64(frames.heartbeatReply));
		socket.emit("error", new Error("late"));
		const sentBefore = socket.sent.length;
		vi.advanceTimersByTime(120_000);

		expect(events).toHaveLength(before);
		expect(socket.sent).toHaveLength(sentBefore);
	});

	it("close() 幂等", () => {
		const client = connect();
		client.close();
		client.close();

		expect(socket.closeCalls).toBe(1);
	});
});
