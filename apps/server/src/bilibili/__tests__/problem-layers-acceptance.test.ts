/**
 * **登录失效的验收,走装配层**:真问题表、真问题通知器、真来源上下文、真分层上报器、真 B 站来源、真登记,
 * 假件只有三样 —— 假的 `Api`(不外连)、假的登录口(状态可拨、`onChange` 手动叫)、假的 `notifyMaster`(记下每次调用)。
 *
 * 定案的验收是「失效登录开机,私聊恰好一条」;而且私聊不能因为开机那一下主人的连接还没连上而丢。
 * 每条验收都先做**对照**:同一套假件在「登录正常、没有根问题」时,下层的问题确实会进表 ——
 * 才证明后面的「恰好一条」不是因为什么都没接上。
 */

import {
	type AuthState,
	type DeliveryResult,
	fail,
	ok,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createProblemNotifier } from "../../problems/problem-notifier.js";
import { createProblemTable } from "../../problems/problem-table.js";
import {
	makeIntegration,
	makeLogger,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "../../subscriptions/__tests__/fixtures.js";
import { registerBuiltinSource } from "../../subscriptions/builtin-sources.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import type { Api } from "../api/index.js";
import { failureFromBili } from "../error-codes.js";
import { createBiliSource } from "../source.js";
import { LOGIN_EXPIRED_TEXT, LOGIN_MISSING_TEXT, LOGIN_RECOVERED_TEXT } from "./problem-harness.js";
import { fakeLoginDeps, fakeLoginSystem } from "./support/fake-login-system.js";

const IN: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
const EXPIRED: AuthState = { status: "expired", message: "失效" };
const OUT: AuthState = { status: "logged-out" };

// 登录那一套换成假系统(`deps.context` 带着它,见 `support/fake-login-system.ts`):状态由下面的 `makeAuth` 拨。
vi.mock("../auth/index.js", () => ({
	createAuthSystem: (o: { context: { login: unknown } }) => o.context.login,
}));

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** 假登录口:状态由测试拨,拨完叫 `onChange` 的订阅者。 */
function makeAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<() => void>();
	const auth: SourceAuth = {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => state,
		onChange: (fn) => {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
	};
	return {
		auth,
		set(next: AuthState) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
	};
}

/** 起一整套:返回表、记录用的 notifyMaster、来源、拨登录口与撤登记的把手。 */
async function boot(
	initial: AuthState,
	notifyImpl?: (text: string) => Promise<DeliveryResult>,
	fetchAllDynamic: () => Promise<unknown> = async () => ok({ data: { items: [] } }),
) {
	// 一条 UP 7 的订阅:订阅级的问题(房间停监)要有订阅可挂
	const world = makeWorld([makeSub("sub-7", "7")]);
	const logger = makeLogger();
	const authed = makeAuth(initial);
	const table = createProblemTable({ logger });
	const notifyMaster = vi.fn<(text: string) => Promise<DeliveryResult>>(
		notifyImpl ?? (async () => ok({ latencyMs: 1 })),
	);
	createProblemNotifier({
		table,
		notify: notifyMaster,
		serviceCtx: {
			track: () => {},
			setTimeout: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(timer) };
			},
		},
		logger,
	});
	const login = fakeLoginSystem({
		api: {
			fetchAllDynamic,
			fetchRelations: async () => ok({ data: null }),
			follow: async () => ok(),
		} as unknown as Api,
		auth: authed.auth,
	});
	const source = createBiliSource({
		...fakeLoginDeps(login, logger),
		locale: fixedLocale(),
		setTimeout: () => ({ dispose() {} }),
		liveContext: {
			logger,
			signal: new AbortController().signal,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
			track: () => {},
		},
	});
	const registration = await registerBuiltinSource({
		registry: createSourceRegistry(),
		linkResolvers: createLinkResolverRegistry(),
		aiToolProviders: createAiToolProviderRegistry(),
		source,
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue: () => {},
		liveSignals: () => {},
		liveInteractions: () => {},
		profiles: () => {},
		problems: table,
	});
	return { source, table, notifyMaster, registration, ...authed };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const codes = (table: ReturnType<typeof createProblemTable>) => table.list().map((p) => p.code);

describe("失效登录开机", () => {
	it("对照:登录正常时,下层的问题(请求失败)确实会进表、私聊一条", async () => {
		const { source, table, notifyMaster } = await boot(IN, undefined, async () =>
			failureFromBili(-352, "risk"),
		);
		await source.dynamic()?.detectNow();
		await flush();
		expect(codes(table)).toEqual(["risk_controlled"]);
		expect(notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉上报器里「未登录开着时低层不存」的判断(reportFailure / reportRisk 开头的 login 判断),这条红。
	it("登录口是 expired:表里恰好一条 auth_lost(来源级),私聊恰好一次,下层的失败与风控压在底下", async () => {
		const { source, table, notifyMaster } = await boot(EXPIRED, undefined, async () =>
			failureFromBili(-352, "risk"),
		);
		await source.dynamic()?.detectNow();
		await flush();

		expect(table.list()).toHaveLength(1);
		expect(table.list()[0]).toMatchObject({ reporter: SOURCE_KEY, code: "auth_lost" });
		expect(table.list()[0]?.about).toBeUndefined();
		expect(notifyMaster).toHaveBeenCalledTimes(1);
		expect(notifyMaster).toHaveBeenCalledWith(LOGIN_EXPIRED_TEXT);
	});

	it("私聊不因开机那一下没连上而丢:头一次 unavailable,10 秒后再送,恰好送到一条;登录好了补一条「已恢复」", async () => {
		const results: DeliveryResult[] = [fail("unavailable", "连接还没上线"), ok({ latencyMs: 1 })];
		const { table, notifyMaster, set } = await boot(
			EXPIRED,
			async () => results.shift() ?? ok({ latencyMs: 1 }),
		);
		await flush();
		expect(notifyMaster).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(notifyMaster).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(notifyMaster).toHaveBeenCalledTimes(2);

		set(IN);
		await flush();
		expect(table.list()).toEqual([]);
		expect(notifyMaster).toHaveBeenCalledTimes(3);
		expect(notifyMaster).toHaveBeenLastCalledWith(LOGIN_RECOVERED_TEXT);
	});

	it("从没登录过 / 主动退出(logged-out):进表,不私聊", async () => {
		const { table, notifyMaster } = await boot(OUT);
		await flush();
		expect(codes(table)).toEqual(["auth_lost"]);
		expect(table.list()[0]?.message).toBe(LOGIN_MISSING_TEXT);
		expect(notifyMaster).not.toHaveBeenCalled();
	});

	it("来源停下(撤登记):表清空,不补「已恢复」,私聊次数不变", async () => {
		const { table, notifyMaster, registration } = await boot(EXPIRED);
		await flush();
		expect(notifyMaster).toHaveBeenCalledTimes(1);

		registration.dispose();
		await flush();
		expect(table.list()).toEqual([]);
		expect(notifyMaster).toHaveBeenCalledTimes(1);
	});
});
