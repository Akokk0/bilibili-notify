/**
 * 单元测试 — QQ 官方机器人的 `connectionAuth`(扫码建连接,任务表住适配器里)。
 *
 * 上游(腾讯 lite 通道)一律用假 `fetch`;不真连。假 `fetch` 按路径应答,并记下
 * 预递给腾讯的那把钥匙,好在完成态里按腾讯的格式加密 AppSecret。
 */
import type { ConnectionAuth } from "@bilibili-notify/internal";
import { QQOfficialConnectionSettingsSchema } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createQQConnectionAuth } from "../qq-bind.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official.js";
import { encryptLikeTencent } from "./tencent-bind-crypto.js";

const SECRET = "SuperSecretValue-9f3a";
const APP_ID = "102000777";
const TTL_MS = 10 * 60_000;

function logger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 真的 `Response`:请求客户端要读头、读字节。 */
function res(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

/** 假 fetch:不回应,直到请求客户端的超时(或调用方)中止它。 */
function hangUntilAborted(init: RequestInit = {}): Promise<Response> {
	return new Promise((_resolve, reject) => {
		(init.signal as AbortSignal).addEventListener("abort", () => {
			reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
		});
	});
}

/** 假腾讯:create 记下钥匙,poll 取 `pollQueue` 队头(空了回 pending)。 */
function makeUpstream() {
	const state = {
		bindKey: "",
		upstreamTaskId: "UP-TASK-1",
		pollQueue: [] as Array<(init?: RequestInit) => Promise<Response> | Response>,
		createFails: null as null | ((init?: RequestInit) => Promise<Response> | Response),
		calls: [] as Array<{ url: string; signal?: AbortSignal | null }>,
	};
	const fetchMock = vi.fn(async (target: URL | string, init?: RequestInit) => {
		const url = String(target);
		state.calls.push({ url, signal: init?.signal });
		if (url.endsWith("/lite/create_bind_task")) {
			if (state.createFails) return state.createFails(init);
			state.bindKey = (JSON.parse(String(init?.body)) as { key: string }).key;
			return res(200, { retcode: 0, data: { task_id: state.upstreamTaskId } });
		}
		const next = state.pollQueue.shift();
		if (next) return next(init);
		return res(200, { retcode: 0, data: { status: 1 } });
	});
	const pollCalls = () => state.calls.filter((c) => c.url.endsWith("/lite/poll_bind_result"));
	const createdResponse = () =>
		res(200, {
			retcode: 0,
			data: {
				status: 2,
				bot_appid: APP_ID,
				bot_encrypt_secret: encryptLikeTencent(SECRET, state.bindKey),
			},
		});
	return { state, fetchMock, pollCalls, createdResponse };
}

let up: ReturnType<typeof makeUpstream>;
const signal = () => new AbortController().signal;

beforeEach(() => {
	up = makeUpstream();
	vi.stubGlobal("fetch", up.fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	delete process.env.BN_QQ_BIND_HOST;
});

function make() {
	const log = logger();
	const { http } = integrationIo();
	const { auth, clear } = createQQConnectionAuth({ logger: log, http: () => http });
	return { auth, clear, log };
}

async function begun(auth: ConnectionAuth) {
	const r = await auth.begin(signal());
	if (!r.ok) throw new Error(`begin failed: ${r.message}`);
	return r;
}

describe("createQQConnectionAuth.begin", () => {
	it("回自己发的任务号(不是腾讯的)、带二维码的 awaiting-scan、2 秒间隔;钥匙不出门", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
		const { auth } = make();
		const r = await begun(auth);
		expect(r.taskId).not.toBe(up.state.upstreamTaskId);
		expect(r.taskId).toBeTruthy();
		expect(r.pollIntervalSeconds).toBe(2);
		expect(r.state.status).toBe("awaiting-scan");
		if (r.state.status !== "awaiting-scan") throw new Error("unreachable");
		expect(r.state.qr.dataUrl.startsWith("data:image/")).toBe(true);
		expect(r.state.qr.expiresAt).toBe(new Date(Date.now() + TTL_MS).toISOString());
		const wire = JSON.stringify(r);
		expect(wire).not.toContain(up.state.bindKey);
		expect(wire).not.toContain(up.state.upstreamTaskId);
	});

	it("上游 retcode 非 0 → unavailable,话里带上游原话;不建任务", async () => {
		up.state.createFails = () => res(200, { retcode: 1001, msg: "系统繁忙" });
		const { auth } = make();
		const r = await auth.begin(signal());
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		if (!r.ok) expect(r.message).toContain("系统繁忙");
	});

	it("上游一直不回:满 10 秒由请求客户端掐断 → timeout", async () => {
		vi.useFakeTimers();
		up.state.createFails = hangUntilAborted;
		const { auth } = make();
		const pending = auth.begin(signal());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await pending).toMatchObject({ ok: false, code: "timeout" });
	});

	it("调用方中止了在途的请求 → unavailable(不是 timeout)", async () => {
		const ac = new AbortController();
		up.state.createFails = hangUntilAborted;
		const { auth } = make();
		const pending = auth.begin(ac.signal);
		await vi.waitFor(() => expect(up.state.calls).toHaveLength(1));
		ac.abort();
		expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("BN_QQ_BIND_HOST 逃生口:请求打到那个主机", async () => {
		process.env.BN_QQ_BIND_HOST = "mirror.example.com";
		const { auth } = make();
		await begun(auth);
		expect(up.state.calls[0]?.url).toBe("https://mirror.example.com/lite/create_bind_task");
	});
});

describe("createQQConnectionAuth.state", () => {
	it("还没扫完:awaiting-scan,二维码与发起时同一张", async () => {
		const { auth } = make();
		const b = await begun(auth);
		const s = await auth.state(b.taskId, signal());
		expect(s).toEqual({ ok: true, state: b.state });
	});

	it("成功:logged-in;回包里没有 AppSecret 也没有草稿;终态钉住不再问上游", async () => {
		const { auth } = make();
		const b = await begun(auth);
		up.state.pollQueue.push(up.createdResponse);
		const s = await auth.state(b.taskId, signal());
		expect(s).toMatchObject({ ok: true, state: { status: "logged-in" } });
		const wire = JSON.stringify(s);
		expect(wire).not.toContain(SECRET);
		expect(wire).not.toContain("settings");
		expect(wire).not.toContain("draft");
		expect(up.pollCalls()).toHaveLength(1);
		const again = await auth.state(b.taskId, signal());
		expect(again).toMatchObject({ ok: true, state: { status: "logged-in" } });
		expect(JSON.stringify(again)).not.toContain(SECRET);
		expect(up.pollCalls()).toHaveLength(1);
	});

	it("码过期:error 带人话(不是 expired),之后不再问上游", async () => {
		const { auth } = make();
		const b = await begun(auth);
		up.state.pollQueue.push(() => res(200, { retcode: 0, data: { status: 3 } }));
		expect(await auth.state(b.taskId, signal())).toMatchObject({
			ok: true,
			state: { status: "error", message: "二维码已过期，请重新生成" },
		});
		await auth.state(b.taskId, signal());
		expect(up.pollCalls()).toHaveLength(1);
	});

	it("凭据缺 / 解不开:error,话对;之后 takeDraft 回 conflict", async () => {
		const { auth } = make();
		const b1 = await begun(auth);
		up.state.pollQueue.push(() => res(200, { retcode: 0, data: { status: 2, bot_appid: "" } }));
		expect(await auth.state(b1.taskId, signal())).toMatchObject({
			ok: true,
			state: { status: "error", message: "扫码成功但腾讯未返回完整机器人凭据" },
		});
		expect(await auth.takeDraft(b1.taskId)).toMatchObject({ ok: false, code: "conflict" });

		const b2 = await begun(auth);
		up.state.pollQueue.push(() =>
			res(200, {
				retcode: 0,
				data: {
					status: 2,
					bot_appid: APP_ID,
					// 用另一把钥匙加密 → GCM 校验失败
					bot_encrypt_secret: encryptLikeTencent(SECRET, Buffer.alloc(32, 7).toString("base64")),
				},
			}),
		);
		const s2 = await auth.state(b2.taskId, signal());
		expect(s2).toMatchObject({ ok: true, state: { status: "error" } });
		if (s2.ok && s2.state.status === "error") {
			expect(s2.state.message).toContain("机器人凭据解密失败");
			expect(s2.state.message).not.toContain(SECRET);
		}
		expect(await auth.takeDraft(b2.taskId)).toMatchObject({ ok: false, code: "conflict" });
	});

	it("上游这一轮抛:unavailable,任务还在,下一轮能问出结果", async () => {
		const { auth, log } = make();
		const b = await begun(auth);
		up.state.pollQueue.push(() => res(502, {}));
		const bad = await auth.state(b.taskId, signal());
		expect(bad).toMatchObject({ ok: false, code: "unavailable" });
		if (!bad.ok) expect(bad.message).toContain("查询绑定结果失败");
		expect(log.warn).toHaveBeenCalled();
		up.state.pollQueue.push(up.createdResponse);
		expect(await auth.state(b.taskId, signal())).toMatchObject({
			ok: true,
			state: { status: "logged-in" },
		});
	});

	it("上游超时:满 10 秒由请求客户端掐断 → timeout", async () => {
		const { auth } = make();
		const b = await begun(auth);
		vi.useFakeTimers();
		up.state.pollQueue.push(hangUntilAborted);
		const pending = auth.state(b.taskId, signal());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await pending).toMatchObject({ ok: false, code: "timeout" });
	});

	it("不认识的任务号:not_found", async () => {
		const { auth } = make();
		expect(await auth.state("nope", signal())).toMatchObject({ ok: false, code: "not_found" });
	});

	it("对上游的那次问询不跟调用方的取消信号(面板断开不丢在途的成功)", async () => {
		const { auth } = make();
		const b = await begun(auth);
		up.state.pollQueue.push(up.createdResponse);
		const ac = new AbortController();
		const p = auth.state(b.taskId, ac.signal);
		ac.abort();
		await p;
		const pollSignal = up.pollCalls()[0]?.signal;
		expect(pollSignal?.aborted).toBe(false);
		expect(await auth.state(b.taskId, signal())).toMatchObject({
			ok: true,
			state: { status: "logged-in" },
		});
	});

	it("在途的问询回来之前任务已被取走:回来后不把这一项写回表里", async () => {
		const { auth } = make();
		const b = await begun(auth);
		// 先让任务到 logged-in 之前被取走不可能;改用「被清扫」:拨时钟到过期再放行
		vi.useFakeTimers({ toFake: ["Date"] });
		let release: (r: Response) => void = () => {};
		up.state.pollQueue.push(() => new Promise<Response>((r) => (release = r)));
		const inflight = auth.state(b.taskId, signal());
		await vi.waitFor(() => expect(up.pollCalls()).toHaveLength(1));
		vi.setSystemTime(Date.now() + TTL_MS + 1000);
		// 另一个调用进门触发惰性清扫
		expect(await auth.state("other", signal())).toMatchObject({ ok: false, code: "not_found" });
		release(up.createdResponse());
		expect(await inflight).toMatchObject({ ok: false, code: "not_found" });
		expect(await auth.state(b.taskId, signal())).toMatchObject({ ok: false, code: "not_found" });
		expect(await auth.takeDraft(b.taskId)).toMatchObject({ ok: false, code: "not_found" });
	});
});

describe("createQQConnectionAuth.takeDraft", () => {
	it("还没扫完:conflict", async () => {
		const { auth } = make();
		const b = await begun(auth);
		expect(await auth.takeDraft(b.taskId)).toMatchObject({ ok: false, code: "conflict" });
	});

	it("没状态就直接取(从没问过):conflict,不会白拿到东西", async () => {
		const { auth } = make();
		const b = await begun(auth);
		up.state.pollQueue.push(up.createdResponse); // 上游已成功,但没人问过
		expect(await auth.takeDraft(b.taskId)).toMatchObject({ ok: false, code: "conflict" });
	});

	it("成功:settings 带完整扫码草稿,覆盖私域与沙箱,并上默认值过得了 schema;再取一次 not_found;再问状态也 not_found", async () => {
		const { auth } = make();
		const b = await begun(auth);
		up.state.pollQueue.push(up.createdResponse);
		await auth.state(b.taskId, signal());
		const d = await auth.takeDraft(b.taskId);
		expect(d).toEqual({
			ok: true,
			settings: { appId: APP_ID, appSecret: SECRET, botType: "public", sandbox: false },
		});
		if (d.ok) {
			expect(
				QQOfficialConnectionSettingsSchema.safeParse({
					sandbox: false,
					botType: "public",
					...d.settings,
				}).success,
			).toBe(true);
		}
		expect(await auth.takeDraft(b.taskId)).toMatchObject({ ok: false, code: "not_found" });
		expect(await auth.state(b.taskId, signal())).toMatchObject({ ok: false, code: "not_found" });
	});

	it("过了时限:未完成的与完成但没取的都回 not_found", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { auth } = make();
		const pending = await begun(auth);
		const done = await begun(auth);
		up.state.pollQueue.push(() => res(200, { retcode: 0, data: { status: 1 } }));
		up.state.pollQueue.push(up.createdResponse);
		await auth.state(pending.taskId, signal());
		await auth.state(done.taskId, signal());
		vi.setSystemTime(Date.now() + TTL_MS + 1000);
		expect(await auth.takeDraft(done.taskId)).toMatchObject({ ok: false, code: "not_found" });
		expect(await auth.state(pending.taskId, signal())).toMatchObject({
			ok: false,
			code: "not_found",
		});
	});

	it("clear() 之后任务都不在", async () => {
		const { auth, clear } = make();
		const b = await begun(auth);
		clear();
		expect(await auth.state(b.taskId, signal())).toMatchObject({ ok: false, code: "not_found" });
	});
});

describe("接线", () => {
	function qqAdapter() {
		const log = logger();
		const hooks: Array<() => void> = [];
		const serviceCtx = {
			logger: log,
			setTimeout: () => ({ dispose() {} }),
			setInterval: () => ({ dispose() {} }),
			onDispose(fn: () => void) {
				hooks.push(fn);
			},
			signal: new AbortController().signal,
			track: () => {},
		};
		const adapter = createQQOfficialAdapter({
			logger: log,
			serviceCtx,
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		return { adapter };
	}

	it("适配器上有 connectionAuth;登记表视图上仍在,且不靠 this 也能调通", async () => {
		const { adapter } = qqAdapter();
		expect(adapter.connectionAuth).toBeDefined();
		const base = createPlatformAdapterRegistry();
		await base.register(adapter, fakeAdapterContext().ctx);
		const view = base.list().find((a) => a.adapterKey === "qq-official");
		expect(view?.connectionAuth).toBeDefined();
		const { begin } = view?.connectionAuth ?? ({} as ConnectionAuth); // 解构 = 脱离 this
		const r = await begin(signal());
		expect(r).toMatchObject({ ok: true });
	});

	it("adapter.stop() 之后原来的任务号回 not_found", async () => {
		const { adapter } = qqAdapter();
		adapter.start(fakeAdapterContext().ctx);
		const b = await begun(adapter.connectionAuth as ConnectionAuth);
		adapter.stop?.();
		expect(await adapter.connectionAuth?.state(b.taskId, signal())).toMatchObject({
			ok: false,
			code: "not_found",
		});
	});

	it("start 之前(或 stop 之后)begin / state → unavailable「适配器还没启动」,一个请求都不发", async () => {
		const { adapter } = qqAdapter();
		const auth = adapter.connectionAuth as ConnectionAuth;
		const expected = { ok: false, code: "unavailable", message: "适配器还没启动" };
		expect(await auth.begin(signal())).toEqual(expected);
		adapter.start(fakeAdapterContext().ctx);
		const b = await begun(auth);
		adapter.stop?.();
		expect(await auth.begin(signal())).toEqual(expected);
		expect(await auth.state(b.taskId, signal())).toMatchObject({ ok: false, code: "not_found" });
		expect(up.fetchMock).toHaveBeenCalledTimes(1);
	});
});
