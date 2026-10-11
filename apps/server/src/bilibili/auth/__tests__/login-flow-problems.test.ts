/**
 * **没有会话可丢时,请求客户端报上来的 `-101` 不算「登录失效」**:真 `LoginFlow` + 真分层上报器 + 真问题表 + 真问题通知器,
 * 假件只有 `Api`(不外连)、计时器(只记)、`notifyMaster`(记下每次调用)。
 *
 * 主人定的两件事:对外的 `expired` 只指「已经登着的登录失效了」;只有登录失效才私聊,从没登录过、主动退出只进问题表。
 * 没有这道门时,有 B 站订阅的未登录实例开机后第一个回 `-101` 的请求就把「没登录」改写成「失效」并私聊。
 */

import {
	type Disposable,
	type Logger,
	type MessageBus,
	ok,
	type Result,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeProblemPipeline } from "../../__tests__/problem-pipeline.js";
import type { Api } from "../../api/api";
import { PROBLEM_TEXTS } from "../../problem-texts.js";
import { LoginFlow } from "../login-flow";

function makeHarness() {
	const api = {
		fetchMyselfInfo: vi.fn(),
		fetchUserCard: vi.fn(async () => ({ code: 0, data: { card: { name: "n", face: "" } } })),
		fetchLoginQrCode: vi.fn(async () => ({
			code: 0,
			data: { url: "https://example.com/qr", qrcode_key: "key" },
		})),
		fetchLoginStatus: vi.fn(),
		getCookiesJson: vi.fn(() => '[{"key":"SESSDATA","value":"x"}]'),
		loginGeneration: 0,
		commitScannedLogin: vi.fn(async (): Promise<Result> => ok()),
		holdLoginSaves: vi.fn((): Disposable => ({ dispose() {} })),
	};
	const intervals: Array<{ disposed: boolean }> = [];
	const logger: Logger = { debug: vi.fn(), info() {}, warn() {}, error() {} };
	const serviceCtx = {
		logger,
		setInterval() {
			const handle = {
				disposed: false,
				dispose() {
					handle.disposed = true;
				},
			};
			intervals.push(handle);
			return handle;
		},
		setTimeout() {
			return { dispose() {} };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track() {},
	} as unknown as ServiceContext;
	const events: string[] = [];
	const bus = {
		emit(event: string) {
			events.push(event);
		},
		on: () => ({ dispose() {} }),
	} as unknown as MessageBus;
	const flow = new LoginFlow({
		serviceCtx,
		api: api as unknown as Api,
		bus,
		healthCheckMs: 0,
	});
	const pipeline = makeProblemPipeline({
		state: () => flow.authState(),
		onChange: (fn) => flow.onChange(fn),
	});
	return { flow, api, intervals, events, ...pipeline };
}

type Harness = ReturnType<typeof makeHarness>;

const codesOf = (h: Harness) => h.table.list().map((p) => p.code);

/** 摆成已登录(走真的开机探活)。 */
async function loggedIn(h: Harness): Promise<void> {
	h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
	await h.flow.reportAccountInfo();
	expect(h.flow.authState().status).toBe("logged-in");
}

describe("没有会话可丢时,-101 什么都不改", () => {
	// 验红:去掉 handleAuthLost 里「没有会话可丢就返回」的那道门,下面四条里「从没登录过」「主动退出」「登录失效之后」「扫码途中」红。
	it("从没登录过:来一个 -101 → 状态仍是 logged-out,表里仍是不带私聊的那一句,私聊 0 次", async () => {
		const h = makeHarness();
		h.flow.reportLoggedOut("notLogin");
		expect(codesOf(h)).toEqual(["auth_lost"]);

		await h.flow.handleAuthLost();

		expect(h.flow.authState()).toEqual({ status: "logged-out" });
		expect(h.table.list()).toHaveLength(1);
		expect(h.table.list()[0]?.message).toBe(PROBLEM_TEXTS.loginMissing.text);
		expect(h.notifyMaster).not.toHaveBeenCalled();
	});

	it("主动退出之后:再来 -101 同样不改,私聊 0 次", async () => {
		const h = makeHarness();
		await loggedIn(h);
		h.flow.reportLoggedOut("notLogin");
		expect(h.table.list()[0]?.message).toBe(PROBLEM_TEXTS.loginMissing.text);

		await h.flow.handleAuthLost();

		expect(h.flow.authState()).toEqual({ status: "logged-out" });
		expect(h.table.list()[0]?.message).toBe(PROBLEM_TEXTS.loginMissing.text);
		expect(h.notifyMaster).not.toHaveBeenCalled();
	});

	it("没登录过、正在扫码时来 -101:扫码不被打断", async () => {
		const h = makeHarness();
		h.flow.reportLoggedOut("notLogin");
		const began = await h.flow.beginLogin(async () => "data:image/png;base64,AA");
		expect(began.ok).toBe(true);
		expect(h.flow.authState().status).toBe("awaiting-scan");
		const pollTimer = h.intervals[h.intervals.length - 1];
		expect(pollTimer?.disposed).toBe(false);

		await h.flow.handleAuthLost();

		expect(h.flow.authState().status).toBe("awaiting-scan");
		expect(pollTimer?.disposed).toBe(false);
		expect(h.notifyMaster).not.toHaveBeenCalled();
	});

	it("没登录过、扫码失败停在 failed 时,手动探活回 -101:不算失效", async () => {
		const h = makeHarness();
		h.flow.reportLoggedOut("notLogin");
		h.api.fetchLoginQrCode.mockResolvedValueOnce({ code: -1, data: { url: "", qrcode_key: "" } });
		await h.flow.beginLogin(async () => "x");
		expect(h.flow.authState().status).toBe("error");
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101 });

		expect(await h.flow.healthCheckNow()).toBe(true);

		expect(h.flow.authState().status).toBe("error");
		expect(h.notifyMaster).not.toHaveBeenCalled();
	});

	it("登录失效之后再来 -101:不重复处理(状态与扫码都不动)", async () => {
		const h = makeHarness();
		await loggedIn(h);
		await h.flow.handleAuthLost();
		expect(h.flow.authState().status).toBe("expired");
		await h.flow.beginLogin(async () => "data:image/png;base64,AA");
		const pollTimer = h.intervals[h.intervals.length - 1];

		await h.flow.handleAuthLost();

		expect(h.flow.authState().status).toBe("awaiting-scan");
		expect(pollTimer?.disposed).toBe(false);
	});
});

describe("有会话可丢时,照旧是登录失效", () => {
	it("登着时来 -101:变成失效、私聊恰好一次、发一次 auth-lost", async () => {
		const h = makeHarness();
		await loggedIn(h);

		await h.flow.handleAuthLost();

		expect(h.flow.authState().status).toBe("expired");
		expect(codesOf(h)).toEqual(["auth_lost"]);
		expect(h.table.list()[0]?.message).toBe(PROBLEM_TEXTS.loginExpired.text);
		expect(h.notifyMaster).toHaveBeenCalledTimes(1);
		expect(h.notifyMaster).toHaveBeenCalledWith(PROBLEM_TEXTS.loginExpired.text);
		expect(h.events.filter((e) => e === "auth-lost")).toHaveLength(1);
	});

	it("开机存着的登录确认下来已失效(探活回 -101):照旧失效、私聊恰好一次、不发 auth-lost", async () => {
		const h = makeHarness();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101 });

		await h.flow.reportAccountInfo();

		expect(h.flow.authState().status).toBe("expired");
		expect(h.notifyMaster).toHaveBeenCalledTimes(1);
		expect(h.notifyMaster).toHaveBeenCalledWith(PROBLEM_TEXTS.loginExpired.text);
		expect(h.events).not.toContain("auth-lost");
	});

	it("开机探活的请求自己撞上 -101(请求客户端先报):同样失效、私聊恰好一次", async () => {
		const h = makeHarness();
		h.api.fetchMyselfInfo.mockImplementationOnce(async () => {
			// 请求客户端在回包被解析之前就把 -101 报上来(`Api` 的拦截器)
			await h.flow.handleAuthLost();
			return { code: -101 };
		});

		await h.flow.reportAccountInfo();

		expect(h.flow.authState().status).toBe("expired");
		expect(h.notifyMaster).toHaveBeenCalledTimes(1);
	});

	it("已登录时重扫、扫码超时(会话其实还在),再来 -101:照旧失效并私聊一次", async () => {
		const h = makeHarness();
		await loggedIn(h);
		await h.flow.beginLogin(async () => "data:image/png;base64,AA");
		expect(h.flow.authState().status).toBe("awaiting-scan");

		await h.flow.handleAuthLost();

		expect(h.flow.authState().status).toBe("expired");
		expect(h.notifyMaster).toHaveBeenCalledTimes(1);
	});

	it("失效之后重新扫码登录成功:又有会话了,再来 -101 照旧失效", async () => {
		const h = makeHarness();
		await loggedIn(h);
		await h.flow.handleAuthLost();
		// 登录成功
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		await h.flow.reportAccountInfo();
		expect(h.flow.authState().status).toBe("logged-in");

		await h.flow.handleAuthLost();

		expect(h.flow.authState().status).toBe("expired");
	});
});
