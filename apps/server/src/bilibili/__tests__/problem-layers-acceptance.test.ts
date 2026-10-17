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
import { createProblemLayers } from "../problem-layers.js";
import { PROBLEM_TEXTS } from "../problem-texts.js";
import { createBiliSource } from "../source.js";

const IN: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
const EXPIRED: AuthState = { status: "expired", message: "失效" };
const OUT: AuthState = { status: "logged-out" };

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

/** 起一整套:返回表、记录用的 notifyMaster、层、拨登录口与撤登记的把手。 */
async function boot(initial: AuthState, notifyImpl?: (text: string) => Promise<DeliveryResult>) {
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
	const layers = createProblemLayers({ auth: authed.auth, logger });
	const source = createBiliSource({
		api: {
			fetchAllDynamic: async () => ok({ data: { items: [] } }),
		} as unknown as Api,
		bus: world.bus,
		imageFetcher: { fetchImage: async () => fail("unavailable", "不联网") } as never,
		loginCheck: { setHealthCheckMs: () => {} },
		setTimeout: () => ({ dispose() {} }),
		auth: authed.auth,
		problems: layers,
	});
	const registration = await registerBuiltinSource({
		registry: createSourceRegistry(),
		linkResolvers: createLinkResolverRegistry(),
		source,
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue: () => {},
		problems: table,
	});
	return { table, notifyMaster, layers, registration, ...authed };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const codes = (table: ReturnType<typeof createProblemTable>) => table.list().map((p) => p.code);

describe("失效登录开机", () => {
	it("对照:登录正常时,下层的问题(请求失败)确实会进表、私聊一条", async () => {
		const { table, notifyMaster, layers } = await boot(IN);
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "房间停了",
			notify: true,
			lasting: false,
		});
		await flush();
		expect(codes(table)).toEqual(["live_monitor_stopped"]);
		expect(notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉上报器里「未登录开着时低层不存」的判断(reportFailure / reportRisk 开头的 login 判断),这条红。
	it("登录口是 expired:表里恰好一条 auth_lost(来源级),私聊恰好一次,下层的失败与风控压在底下", async () => {
		const { table, notifyMaster, layers } = await boot(EXPIRED);
		// 开机后直播与动态各自撞上的下层症状(今天会各发一条私聊)
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "房间停了",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "拉动态失败",
			notify: true,
			lasting: false,
		});
		layers.reportRisk("dynamic", { notify: true });
		await flush();

		expect(table.list()).toHaveLength(1);
		expect(table.list()[0]).toMatchObject({ reporter: SOURCE_KEY, code: "auth_lost" });
		expect(table.list()[0]?.about).toBeUndefined();
		expect(notifyMaster).toHaveBeenCalledTimes(1);
		expect(notifyMaster).toHaveBeenCalledWith(PROBLEM_TEXTS.loginExpired.text);
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
		expect(notifyMaster).toHaveBeenLastCalledWith(PROBLEM_TEXTS.loginExpired.recovery);
	});

	it("从没登录过 / 主动退出(logged-out):进表,不私聊", async () => {
		const { table, notifyMaster } = await boot(OUT);
		await flush();
		expect(codes(table)).toEqual(["auth_lost"]);
		expect(table.list()[0]?.message).toBe(PROBLEM_TEXTS.loginMissing.text);
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
