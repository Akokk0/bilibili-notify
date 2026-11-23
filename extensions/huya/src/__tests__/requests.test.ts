import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { host, room } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

it.each(["123", "Mon, 23 Nov 2026 00:02:03 GMT"])(
	"429 的等待期限 %s 约束其他房间、搜索以及重启后的宿主",
	async (retry) => {
		const app = host(() => ({ status: 429, headers: { "Retry-After": retry } }));
		expect(await app.source.searchCreators("42", app.signal)).toMatchObject({
			ok: false,
			code: "rate_limited",
		});
		expect(await app.source.searchCreators("名字", app.signal)).toMatchObject({
			code: "rate_limited",
		});
		expect(app.fetch).toHaveBeenCalledTimes(1);
		const restarted = host(() => ({ body: room("1", "23") }), app.state);
		await vi.advanceTimersByTimeAsync(122999);
		expect(await restarted.source.searchCreators("23", restarted.signal)).toMatchObject({
			code: "rate_limited",
		});
		expect(restarted.fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await restarted.source.searchCreators("23", restarted.signal)).toMatchObject({
			ok: true,
			candidates: [{ externalId: "1" }],
		});
		expect(restarted.ctx.resolveProblem).toHaveBeenCalled();
	},
);

it("两个调用共读一个房间，取消其中一个仍能完成另一个，不同房间串行错开", async () => {
	const times: number[] = [];
	let finish!: () => void;
	const slow = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const app = host(async (url) => {
		times.push(Date.now());
		const id = url.searchParams.get("roomid") ?? "";
		if (id === "42") await slow;
		return { body: room("71", id) };
	});
	const cancel = new AbortController();
	const first = app.source.searchCreators("42", cancel.signal);
	const shared = app.source.searchCreators("42", app.signal);
	const next = app.source.searchCreators("43", app.signal);
	await vi.advanceTimersByTimeAsync(1000);
	cancel.abort();
	expect(await first).toMatchObject({ ok: false, code: "indeterminate" });
	expect(times).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(3000);
	expect(times).toHaveLength(1);
	finish();
	expect(await shared).toMatchObject({ ok: true, candidates: [{ externalId: "71" }] });
	await vi.advanceTimersByTimeAsync(3000);
	expect(await next).toMatchObject({ ok: true });
	expect(times).toHaveLength(2);
	expect(times[1] - times[0]).toBeGreaterThanOrEqual(3000);
});

it("正常房间标题里提到验证码时仍可查询", async () => {
	const app = host(() => ({
		body: room("71", "42", "ON", { introduction: "<title>安全验证</title> 教程" }),
	}));
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({
		ok: true,
		candidates: [{ externalId: "71" }],
	});
	expect(app.ctx.reportProblem).not.toHaveBeenCalled();
});

it("无效的 Retry-After 使用默认的一分钟等待时间", async () => {
	let limited = true;
	const app = host(() =>
		limited ? { status: 429, headers: { "Retry-After": "1.5" } } : { body: room("71", "42") },
	);
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({ code: "rate_limited" });
	limited = false;
	await vi.advanceTimersByTimeAsync(59999);
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({ code: "rate_limited" });
	await vi.advanceTimersByTimeAsync(1);
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({ ok: true });
});

it("等待期后只做一次试探，空白页延长冷却，真实响应才清除问题", async () => {
	let reply: import("./host").Reply = { status: 429 };
	const app = host(() => reply);
	await app.source.searchCreators("42", app.signal);
	await vi.advanceTimersByTimeAsync(60000);
	reply = { body: "<html>…</html>" };
	const first = app.source.searchCreators("42", app.signal);
	const queued = app.source.searchCreators("43", app.signal);
	expect(await first).toMatchObject({ code: "rate_limited" });
	expect(await queued).toMatchObject({ code: "rate_limited" });
	expect(app.fetch).toHaveBeenCalledTimes(2);
	expect(app.ctx.resolveProblem).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(120000);
	reply = { body: room("71", "42") };
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({ ok: true });
	expect(app.ctx.resolveProblem).toHaveBeenCalledTimes(1);
});

it.each([
	{ status: 200, body: "<html><title>虎牙安全验证</title></html>" },
	{ status: 302, headers: { location: "https://udblgn.huya.com/login" } },
])("遇到验证页或登录跳转时暂停所有入口，普通房间的 403 只影响该次请求", async (challenge) => {
	let reply: import("./host").Reply = { status: 403, body: "Forbidden" };
	const app = host(() => reply);
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({ code: "unavailable" });
	reply = challenge;
	const verify = app.source.searchCreators("43", app.signal);
	await vi.advanceTimersByTimeAsync(3000);
	expect(await verify).toMatchObject({ code: "unavailable", upstreamCode: "huya.verify" });
	expect(await app.source.searchCreators("名字", app.signal)).toMatchObject({
		upstreamCode: "huya.verify",
	});
	expect(app.fetch).toHaveBeenCalledTimes(2);
	reply = { body: room("71", "42") };
	await vi.advanceTimersByTimeAsync(300000);
	expect(await app.source.searchCreators("42", app.signal)).toMatchObject({ ok: true });
});
