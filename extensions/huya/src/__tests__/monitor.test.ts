import type {
	ExtensionLiveSignalReport,
	ExtensionSourceContext,
	SourceDef,
} from "@bilibili-notify/extension";
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

it("首次建基线，间歇失败不中断在播场次，转入轮播只报一次下播", async () => {
	let reply: Reply = { body: room("71", "42") };
	const app = host(() => reply);
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(3000);
	for (const next of [
		{ body: room("71", "42", "ON", { liveId: "81" }) },
		{ status: 503 },
		{ body: room("71", "42", "ON", { liveId: "81" }) },
		{ body: room("71", "42", "REPLAY") },
		{ body: room("71", "42") },
	]) {
		reply = next;
		await vi.advanceTimersByTimeAsync(61000);
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
	await vi.advanceTimersByTimeAsync(3000);
	await app.source.fetchLiveStatus?.(identity, app.signal);
	await vi.advanceTimersByTimeAsync(60000);
	expect(watched.reportLive).toHaveBeenCalledWith(
		"71",
		expect.objectContaining({ kind: "end", endedAt: firstOffline }),
	);
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
	await app.source.searchCreators("42", app.signal);
	const watched = monitor(app.source);
	await vi.advanceTimersByTimeAsync(3000);
	session = undefined;
	title = "下半场";
	await vi.advanceTimersByTimeAsync(60000);
	session = second;
	title = "下一场";
	await vi.advanceTimersByTimeAsync(60000);
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
			await vi.advanceTimersByTimeAsync(1);
			expect(watched.reportLive.mock.calls.map(([, e]) => e.kind)).toEqual(["status"]);
		}
		await app.source.stop();
	},
);
