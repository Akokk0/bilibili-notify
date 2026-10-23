import { ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { callSource, createSourceGates, fetchSourceProfile } from "../call-source.js";

/**
 * 宿主调来源的公共外壳(搜人、查直播状态与查资料共用):超时叫停来源手里的 signal、来源抛了收成约定的失败并记 error,
 * 同一来源键的调用一个接一个串行。
 */

const logger = { error: vi.fn() };

beforeEach(() => {
	vi.useFakeTimers();
	logger.error.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("callSource", () => {
	it("超过期限:叫停来源手里的 signal,回超时的那份失败", async () => {
		let seen: AbortSignal | undefined;
		const pending = callSource({
			logger,
			sourceKey: "acme",
			member: "fetchLiveStatus",
			timeoutMs: 1000,
			call: (signal) => {
				seen = signal;
				return new Promise<string>(() => {});
			},
			onTimeout: () => "timeout",
			onThrow: () => "thrown",
		});
		await vi.advanceTimersByTimeAsync(1001);
		await expect(pending).resolves.toBe("timeout");
		expect(seen?.aborted).toBe(true);
	});

	it("来源抛了:回抛错的那份失败,原话只进错误日志", async () => {
		const result = await callSource({
			logger,
			sourceKey: "acme",
			member: "fetchLiveStatus",
			timeoutMs: 1000,
			call: async () => {
				throw new Error("boom-detail");
			},
			onTimeout: () => "timeout",
			onThrow: () => "thrown",
		});
		expect(result).toBe("thrown");
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(String(logger.error.mock.calls[0]?.[0])).toContain("boom-detail");
	});

	it("调用方撤销:叫停来源手里的 signal,立刻回 onAbort 那份;来源因此抛的中止错误不记日志", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const pending = callSource({
			logger,
			sourceKey: "acme",
			member: "fetchLiveStatus",
			timeoutMs: 60_000,
			signal: controller.signal,
			call: (signal) => {
				seen = signal;
				return new Promise<string>((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted by host")));
				});
			},
			onTimeout: () => "timeout",
			onThrow: () => "thrown",
			onAbort: () => "aborted",
		});
		controller.abort();
		await expect(pending).resolves.toBe("aborted");
		expect(seen?.aborted).toBe(true);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("调用方在调之前就撤销了:不去问来源", async () => {
		const controller = new AbortController();
		controller.abort();
		const call = vi.fn(async () => "fine");
		const result = await callSource({
			logger,
			sourceKey: "acme",
			member: "fetchLiveStatus",
			timeoutMs: 1000,
			signal: controller.signal,
			call,
			onTimeout: () => "timeout",
			onThrow: () => "thrown",
			onAbort: () => "aborted",
		});
		expect(result).toBe("aborted");
		expect(call).not.toHaveBeenCalled();
	});

	it("来源正常回:原样回,不记日志", async () => {
		const result = await callSource({
			logger,
			sourceKey: "acme",
			member: "fetchLiveStatus",
			timeoutMs: 1000,
			call: async () => "fine",
			onTimeout: () => "timeout",
			onThrow: () => "thrown",
		});
		expect(result).toBe("fine");
		expect(logger.error).not.toHaveBeenCalled();
	});
});

describe("createSourceGates", () => {
	it("同一来源键的活一个接一个跑;不同来源键互不排队", async () => {
		const gates = createSourceGates();
		const order: string[] = [];
		let releaseFirst: () => void = () => {};
		const first = gates.run("a", async () => {
			order.push("a1 start");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push("a1 end");
		});
		const second = gates.run("a", async () => {
			order.push("a2");
		});
		const other = gates.run("b", async () => {
			order.push("b1");
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["a1 start", "b1"]);
		releaseFirst();
		await Promise.all([first, second, other]);
		expect(order).toEqual(["a1 start", "b1", "a1 end", "a2"]);
	});
});

describe("fetchSourceProfile", () => {
	const identity = { sourceKey: "acme", externalId: "alice" };
	const sources = (fetchProfile: (asked: typeof identity, signal: AbortSignal) => unknown) => ({
		get: (key: string) =>
			key === identity.sourceKey ? { fetchProfile: fetchProfile as never } : undefined,
	});

	it("超时 → timeout,并中止来源手里的 signal", async () => {
		let seen: AbortSignal | undefined;
		const pending = fetchSourceProfile(
			{
				logger,
				gates: createSourceGates(),
				timeoutMs: 1000,
				sources: sources((_identity, signal) => {
					seen = signal;
					return new Promise(() => {});
				}) as never,
			},
			identity,
		);
		await vi.advanceTimersByTimeAsync(1001);
		await expect(pending).resolves.toMatchObject({ ok: false, code: "timeout" });
		expect(seen?.aborted).toBe(true);
	});

	it("来源抛了 → unavailable,原话只进日志", async () => {
		const out = await fetchSourceProfile(
			{
				logger,
				gates: createSourceGates(),
				sources: sources(() => {
					throw new Error("profile-boom-detail");
				}) as never,
			},
			identity,
		);
		expect(out).toMatchObject({ ok: false, code: "unavailable" });
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("profile-boom-detail"));
	});

	it("同一来源两发串行", async () => {
		const order: string[] = [];
		let resolve: () => void = () => {};
		const firstGate = new Promise<void>((done) => {
			resolve = done;
		});
		let calls = 0;
		const source = {
			get: () => ({
				async fetchProfile(_identity: typeof identity) {
					calls += 1;
					const call = calls;
					order.push(`start-${call}`);
					if (call === 1) await firstGate;
					order.push(`end-${call}`);
					return ok({ name: "爱丽丝" });
				},
			}),
		};
		const deps = { logger, gates: createSourceGates(), sources: source as never };
		const first = fetchSourceProfile(deps, identity);
		const second = fetchSourceProfile(deps, identity);
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["start-1"]);
		resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
	});
});
