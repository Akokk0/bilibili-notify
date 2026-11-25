import { EventEmitter } from "node:events";
import type {
	ExtensionLiveSignalReport,
	ExtensionSourceContext,
	SourceDef,
} from "@bilibili-notify/extension";
import { ok } from "@bilibili-notify/extension";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { host, type Reply, room } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function monitor(source: SourceDef) {
	let watching = true;
	let changed = () => {};
	const reportLive = vi.fn<(id: string, report: ExtensionLiveSignalReport) => void>();
	const ctx = {
		signal: new AbortController().signal,
		onDispose: vi.fn(),
		reportLive,
		reportProfile: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		subscriptions: () => [
			{ externalId: "71", features: new Set(["liveStart"]), monitorsLive: watching },
		],
		onSubscriptionsChanged(fn: () => void) {
			changed = fn;
			return { dispose: () => {} };
		},
	};
	void source.start(ctx as unknown as ExtensionSourceContext);
	return {
		...ctx,
		disable() {
			watching = false;
			changed();
		},
		enable() {
			watching = true;
			changed();
		},
	};
}

class RoomSocket extends EventEmitter {
	binaryType = "nodebuffer";
	readyState = 1;
	send = vi.fn();
	close = vi.fn();
	frame(hex: string) {
		this.emit("message", Buffer.from(hex, "hex"), true);
	}
}

// 房间 71 的普通推送帧；两个字节的 URI 变动，其余内容相同。
function push(uri: number, uid = 71) {
	const payload = Buffer.from("00071d0000140c111f402d00000200473c46076c6976653a3731", "hex");
	payload.writeUInt16BE(uri, 8);
	payload[15] = uid;
	return payload.toString("hex");
}
function connected(app: ReturnType<typeof host>) {
	const socket = new RoomSocket();
	app.websocket.mockImplementation(() => {
		setTimeout(() => {
			socket.emit("open");
			socket.frame("00111d0000010c");
		}, 1);
		return ok({ socket });
	});
	socket.send.mockImplementation((data: Uint8Array) => {
		if (data[1] === 20) setTimeout(() => socket.frame("00151d0000010c"), 1);
	});
	return socket;
}

it("首次建基线，间歇失败不中断在播场次，转入轮播只报一次下播", async () => {
	let reply: Reply = { body: room("71", "42") };
	const app = host(() => reply);
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(6500);
	for (const next of [
		{ body: room("71", "42", "ON", { liveId: "81" }) },
		{ status: 503 },
		{ body: room("71", "42", "ON", { liveId: "81" }) },
		{ body: room("71", "42", "REPLAY") },
		{ body: room("71", "42") },
	]) {
		reply = next;
		socket.frame(push(8004));
		await vi.advanceTimersByTimeAsync(65000);
	}
	expect(watched.reportLive.mock.calls.map(([uid, event]) => [uid, event.kind])).toEqual([
		["71", "status"],
		["71", "start"],
		["71", "end"],
	]);
	expect(watched.reportProfile).toHaveBeenCalledWith("71", { name: "阿虎", displayId: "42" });
	expect(watched.reportProblem).toHaveBeenCalled();
	await app.source.stop();
});

it("平台未给开播时间时，下播带上宿主第一次核实离线的时刻", async () => {
	let status = "ON";
	const app = host(() => ({ body: room("71", "42", status) }));
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(9000);
	status = "OFF";
	const firstOffline = new Date().toISOString();
	const identity = { sourceKey: "huya", externalId: "71" };
	expect(await app.source.fetchLiveStatus?.(identity, app.signal)).toEqual({
		ok: true,
		kind: "offline",
	});
	// 宿主收到 offline 后就结束场次，须先把本场最后的数据随下播交给宿主。
	expect(watched.reportLive.mock.calls.at(-1)?.[1]).toMatchObject({
		kind: "end",
		endedAt: firstOffline,
	});
	await vi.advanceTimersByTimeAsync(3000);
	const again = app.source.fetchLiveStatus?.(identity, app.signal);
	await vi.advanceTimersByTimeAsync(9000);
	await again;
	expect(watched.reportLive).toHaveBeenCalledWith(
		"71",
		expect.objectContaining({ kind: "end", endedAt: firstOffline }),
	);
	await app.source.stop();
});

it("开播与宿主取卡时查询贵宾，同场连接与下播省去这次请求", async () => {
	let status = "OFF";
	const stats = vi.fn(() => ({ status: 503 }));
	const app = host((url) =>
		url.hostname === "cdn.wup.huya.com" ? stats() : { body: room("71", "42", status) },
	);
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(6000);
	expect(stats).toHaveBeenCalledTimes(0);
	status = "ON";
	socket.frame(push(8000));
	await vi.advanceTimersByTimeAsync(185000);
	expect(stats).toHaveBeenCalledTimes(1);
	expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status", "start"]);
	const card = app.source.fetchLiveStatus?.({ sourceKey: "huya", externalId: "71" }, app.signal);
	await vi.advanceTimersByTimeAsync(6000);
	expect(await card).toMatchObject({ ok: true, kind: "live" });
	expect(stats).toHaveBeenCalledTimes(2);
	status = "OFF";
	socket.frame(push(8001));
	await vi.advanceTimersByTimeAsync(65000);
	expect(stats).toHaveBeenCalledTimes(2);
	expect(watched.reportLive.mock.calls.at(-1)?.[1].kind).toBe("end");
	await app.source.stop();
});

it("同一场改标题只更新状态，中途缺场次号后仍能识别两场不同的大整数 ID", async () => {
	const first = "9223372036854775801",
		second = "9223372036854775802";
	let session: string | undefined = first;
	let title = "上半场";
	const app = host(() => {
		const live = room("71", "42", "ON", { liveId: session, introduction: title });
		return { body: JSON.stringify(live).replace(/"liveId":"(\d+)"/, '"liveId":$1') };
	});
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(6000);
	session = undefined;
	title = "下半场";
	socket.frame(push(8004));
	await vi.advanceTimersByTimeAsync(60000);
	session = second;
	title = "下一场";
	socket.frame(push(8000));
	await vi.advanceTimersByTimeAsync(63000);
	await vi.advanceTimersByTimeAsync(60000);
	expect(watched.reportLive.mock.calls.map(([, e]) => [e.kind, e.details?.title])).toEqual([
		["status", "上半场"],
		["status", "下半场"],
		["end", "下半场"],
		["start", "下一场"],
	]);
	await app.source.stop();
});

it.each(["stop", "unsubscribe"])(
	"订阅在请求途中 %s，取消传输，迟到的结果不会上报",
	async (action) => {
		let finish!: () => void;
		const slow = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let hold = false;
		const app = host(async () => {
			if (hold) await slow;
			return { body: room("71", "42", "ON") };
		});
		await app.source.searchCreators("42", app.signal);
		hold = true;
		const watched = monitor(app.source);
		await vi.advanceTimersByTimeAsync(3000);
		const transport = app.fetch.mock.calls.at(-1)?.[1]?.signal;
		expect(transport?.aborted).toBe(false);
		if (action === "stop") await app.source.stop();
		else watched.disable();
		await vi.advanceTimersByTimeAsync(1);
		expect(transport?.aborted).toBe(true);
		finish();
		await vi.advanceTimersByTimeAsync(120000);
		expect(watched.reportLive).not.toHaveBeenCalled();
		expect(watched.reportProfile).not.toHaveBeenCalled();
		expect(app.fetch).toHaveBeenCalledTimes(2);
		if (action === "unsubscribe") {
			watched.enable();
			await vi.advanceTimersByTimeAsync(3001);
			expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status"]);
		}
		await app.source.stop();
	},
);

it("订阅轮播房间后停止例行查询，收到开播通知即核实房间并上报", async () => {
	let status = "REPLAY";
	const app = host(() => ({ body: room("71", "42", status) }));
	const socket = new RoomSocket();
	app.websocket.mockReturnValue(ok({ socket }));
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(6000);
	expect(app.websocket).toHaveBeenCalledTimes(1);
	socket.emit("open");
	expect(Buffer.from(socket.send.mock.calls[0]?.[0]).includes(Buffer.from("live:71"))).toBe(true);
	socket.frame("00111d0000010c"); // 注册成功
	await vi.advanceTimersByTimeAsync(6000);
	const requests = app.fetch.mock.calls.length;
	for (let i = 0; i < 3; i++) {
		await vi.advanceTimersByTimeAsync(40000);
		socket.frame("00151d0000010c"); // 心跳应答
	}
	expect(app.fetch).toHaveBeenCalledTimes(requests);
	status = "ON";
	socket.frame(push(8000));
	await vi.advanceTimersByTimeAsync(9000);
	expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status", "start"]);
	await app.source.stop();
});

it("同一场取卡使用房间批量推送的热度与贵宾零值，断线后重新查询", async () => {
	const stats = vi.fn(() => ({ status: 503 }));
	const app = host((url) =>
		url.hostname === "cdn.wup.huya.com"
			? stats()
			: { body: room("71", "42", "ON", { liveId: "81", totalCount: 17 }) },
	);
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	monitor(app.source);
	await vi.advanceTimersByTimeAsync(15000);
	// WSMsgItem vector: 8006 (heat 42), 6211 (UID 71, zero VIPs).
	socket.frame(
		"00161d00002306076c6976653a37311900020a011f461d000002002a0b0a0118431d00000300471c0b",
	);
	const before = stats.mock.calls.length;
	const id = { sourceKey: "huya", externalId: "71" };
	const card = app.source.fetchLiveStatus?.(id, app.signal);
	await vi.advanceTimersByTimeAsync(6000);
	expect(await card).toMatchObject({ ok: true, details: { heatScore: 42, vipViewers: 0 } });
	expect(stats).toHaveBeenCalledTimes(before);
	socket.emit("close");
	const disconnected = app.source.fetchLiveStatus?.(id, app.signal);
	await vi.advanceTimersByTimeAsync(6000);
	expect(await disconnected).toMatchObject({ ok: true, details: { heatScore: 17 } });
	expect(stats).toHaveBeenCalledTimes(before + 1);
	await app.source.stop();
});

it("半开连接丢失心跳时保留在播；重连确认漏掉的下播，忽略旧连接的迟到帧", async () => {
	let status = "ON";
	const app = host(() => ({ body: room("71", "42", status) }));
	const first = new RoomSocket(),
		second = new RoomSocket();
	app.websocket
		.mockReturnValueOnce(ok({ socket: first }))
		.mockReturnValueOnce(ok({ socket: second }));
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(9000);
	first.emit("open");
	first.frame("00111d0000010c");
	await vi.advanceTimersByTimeAsync(91000);
	expect(first.close).toHaveBeenCalledOnce();
	expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status"]);
	status = "REPLAY";
	await vi.advanceTimersByTimeAsync(6000);
	second.emit("open");
	second.frame("00111d0000010c");
	await vi.advanceTimersByTimeAsync(6000);
	first.frame(push(8000));
	second.frame(push(8001, 72));
	const requests = app.fetch.mock.calls.length;
	await vi.advanceTimersByTimeAsync(10000);
	expect(app.fetch).toHaveBeenCalledTimes(requests);
	expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status", "end"]);
	watched.disable();
	expect(second.close).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(180000);
	expect(app.websocket).toHaveBeenCalledTimes(2);
	await app.source.stop();
});

it("虎牙要求等待时，断线的房间也等匿名资料复查成功再重连", async () => {
	let limited = false;
	const app = host(() =>
		limited ? { status: 429, headers: { "Retry-After": "120" } } : { body: room("71", "42") },
	);
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(9000);
	limited = true;
	const pull = app.source.fetchLiveStatus?.({ sourceKey: "huya", externalId: "71" }, app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	expect(await pull).toMatchObject({ ok: false, code: "rate_limited" });
	socket.emit("close");
	await vi.advanceTimersByTimeAsync(90000);
	expect(app.websocket).toHaveBeenCalledTimes(1);
	limited = false;
	await vi.advanceTimersByTimeAsync(180000);
	expect(app.websocket).toHaveBeenCalledTimes(2);
	expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status"]);
	await app.source.stop();
});

it("连续两场都在播时，按开播帧的场次号等待缓存切到新场", async () => {
	let liveId = "81";
	const app = host(() => ({ body: room("71", "42", "ON", { liveId }) }));
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(12000);
	// BeginLiveNotice carries lLiveId=82 at tag 7.
	socket.frame("00071d0000160c111f402d000004004770523c46076c6976653a3731");
	await vi.advanceTimersByTimeAsync(5000);
	liveId = "82";
	await vi.advanceTimersByTimeAsync(20000);
	expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status", "end", "start"]);
	await app.source.stop();
});

it.each(["available", "absent", "unreachable"] as const)(
	"开播优先读本房间发布的静态封面，缺图回退到直播帧，直播中仍用帧（封面 %s）",
	async (posterState) => {
		let status = "OFF";
		const frame = "https://live-cover.msstatic.com/huyalive/71/frame.jpg";
		const poster = "https://anchorpost.msstatic.com/cdnimage/anchorpost/71/poster.jpg";
		const app = host((url) =>
			url.hostname === "www.huya.com"
				? {
						body: `<head><link rel="canonical" href="https://www.huya.com/42"><meta name="image" content="${posterState !== "absent" ? poster : frame}"></head>`,
					}
				: { body: room("71", "42", status, { screenshot: frame, liveId: "81" }) },
		);
		const frameRef = `${"a".repeat(64)}.jpg`,
			posterRef = `${"b".repeat(64)}.jpg`;
		app.ctx.fetchImage.mockImplementation(async (url) => {
			if (url === poster && posterState === "unreachable") throw new Error("image unavailable");
			return ok({ ref: url === poster ? posterRef : frameRef });
		});
		const socket = connected(app);
		await app.source.searchCreators("42", app.signal);
		const watched = monitor(app.source);
		await vi.advanceTimersByTimeAsync(12000);
		status = "ON";
		socket.frame(push(8000));
		await vi.advanceTimersByTimeAsync(15000);
		expect(watched.reportLive.mock.calls.at(-1)?.[1]).toMatchObject({
			kind: "start",
			details: { cover: posterState === "available" ? posterRef : frameRef },
		});
		const card = app.source.fetchLiveStatus?.({ sourceKey: "huya", externalId: "71" }, app.signal);
		await vi.advanceTimersByTimeAsync(9000);
		expect(await card).toMatchObject({ kind: "live", details: { cover: frameRef } });
		await app.source.stop();
	},
);

it("下播用本场最后的实测数，同场缺项不清零，下一场不继承", async () => {
	let status = "ON",
		liveId = "81";
	const app = host((url) =>
		url.hostname === "cdn.wup.huya.com"
			? { status: 503 }
			: { body: room("71", "42", status, { liveId }) },
	);
	const socket = connected(app);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(15000);
	socket.frame(
		"00161d00002306076c6976653a37311900020a011f461d000002002a0b0a0118431d00000300471c0b",
	);
	await vi.advanceTimersByTimeAsync(125000);
	socket.frame(push(8004));
	await vi.advanceTimersByTimeAsync(6000);
	status = "OFF";
	socket.frame(push(8001));
	await vi.advanceTimersByTimeAsync(6000);
	expect(watched.reportLive.mock.calls.at(-1)?.[1]).toMatchObject({
		kind: "end",
		details: { heatScore: 42, vipViewers: 0 },
	});
	status = "ON";
	liveId = "82";
	socket.frame(push(8000));
	await vi.advanceTimersByTimeAsync(15000);
	const next = watched.reportLive.mock.calls.at(-1)?.[1];
	expect(next?.kind).toBe("start");
	expect(next?.details?.vipViewers).toBeUndefined();
	expect(next?.details?.heatScore).toBeUndefined();
	await app.source.stop();
});
