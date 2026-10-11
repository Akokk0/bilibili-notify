/**
 * 入口接的统计登录读口(3a-29 复审 A5):`confirming` 不算登录、统计不记「在跑」;`logged-in` 才记。
 *
 * 为什么不是起整台服务:统计读口接的是 `authSystem.auth` 本身(不是 devtools 的壳),开机后的登录态要靠真的联网探活
 * 才到得了 `logged-in`,e2e 里造不出来。所以接线抽成了 `bindStatsLoginState`,这里用**真的**统计记录器 + 假的登录口
 * 钉它的行为,再扫 `index.ts` 钉「入口真的用它、没自己手写一份」。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthState, MessageBus } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BILI_SOURCE_CHECK_MS } from "../bili-source.js";
import { bindStatsLoginState } from "../login-binding.js";
import { createStatsRecorder } from "../recorder.js";
import type { StatsStore } from "../store.js";

const T0 = Date.parse("2026-05-16T10:00:00.000Z");

function setup(initial: AuthState) {
	let state = initial;
	const bus = { emit: () => {}, on: () => ({ dispose() {} }) } as unknown as MessageBus;
	const store = {
		appendRecording: vi.fn(async () => {}),
		listRecording: vi.fn(async () => []),
		appendPost: vi.fn(async () => {}),
		drop: vi.fn(async () => {}),
	} as unknown as StatsStore & { appendRecording: ReturnType<typeof vi.fn> };
	const handle = createStatsRecorder({
		isEnabled: () => true,
		bus,
		store,
		fans: {} as never,
		fansCron: () => "*/10 * * * *",
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		now: () => new Date(Date.now()),
		subscriptions: () =>
			[
				{
					id: "s1",
					identity: { sourceKey: "bilibili", externalId: "1" },
					enabled: true,
					recordsPosts: true,
					recordsLive: true,
				},
			] as never,
	});
	return {
		handle,
		store,
		auth: { state: () => state },
		set: (next: AuthState) => {
			state = next;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("bindStatsLoginState —— 入口把统计的登录读口接到登录口上", () => {
	it("confirming(开机没确认上 / 已扫等确认)不记「在跑」", async () => {
		const w = setup({ status: "confirming", message: "正在向 B 站确认登录状态" });
		bindStatsLoginState(w.handle, w.auth);
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS * 2);
		await w.handle.flush();
		expect(w.store.appendRecording).not.toHaveBeenCalled();
		w.handle.dispose();
	});

	it("logged-in 才记;读口每次现读,从 confirming 变成 logged-in 之后下一次定时就记", async () => {
		const w = setup({ status: "confirming" });
		bindStatsLoginState(w.handle, w.auth);
		await w.handle.flush();
		expect(w.store.appendRecording).not.toHaveBeenCalled();

		w.set({ status: "logged-in", loggedInAt: "2026-05-16T10:00:00.000Z" });
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS);
		await w.handle.flush();
		expect(
			w.store.appendRecording.mock.calls
				.map((c) => `${c[0]}/${(c[1] as { kind: string }).kind}`)
				.sort(),
		).toEqual(["s1/live", "s1/posts"]);
		w.handle.dispose();
	});

	it("其余状态(未登录 / 等扫码 / 失效 / 出错)也不记", async () => {
		const states: AuthState[] = [
			{ status: "logged-out" },
			{ status: "awaiting-scan", qr: { dataUrl: "data:x", expiresAt: "2026-05-16T10:03:00.000Z" } },
			{ status: "expired", message: "m" },
			{ status: "error", message: "m" },
		];
		for (const s of states) {
			const w = setup(s);
			bindStatsLoginState(w.handle, w.auth);
			vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS);
			await w.handle.flush();
			expect(w.store.appendRecording).not.toHaveBeenCalled();
			w.handle.dispose();
		}
	});
});

describe("index.ts 的接线", () => {
	// 验红:把 `index.ts` 里那一行改回手写的 `bindLoginState(() => true)`(或随便另一种读口),这条红。
	it("统计的登录读口经 bindStatsLoginState 接到 authSystem.auth,入口里没有手写的第二份", () => {
		const src = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../../index.ts"),
			"utf8",
		);
		expect(src).toContain("bindStatsLoginState(runtime.statsRecorder, authSystem.auth)");
		expect(src).not.toMatch(/statsRecorder\.bindLoginState\(/);
	});
});
