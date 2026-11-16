import { ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import {
	callSource,
	createSourceGates,
	fetchSourceProfile,
	fetchSourceVideoViews,
} from "../call-source.js";

/**
 * 宿主调来源的公共外壳(搜人、查直播状态与查资料共用):超时叫停来源手里的 signal、来源抛了收成约定的失败并记 error,
 * 同一来源键的调用一个接一个串行。
 */

const logger = { error: vi.fn() };

it("播放量读取经过来源外壳，缺少能力时不调用，取消会中止来源", async () => {
	const identity = { sourceKey: "acme", externalId: "42" };
	const controller = new AbortController();
	let seen: AbortSignal | undefined;
	const deps = { logger, gates: createSourceGates(), sources: { get: () => undefined } as never };
	expect(await fetchSourceVideoViews(deps, identity)).toMatchObject({
		ok: false,
		code: "unsupported",
	});
	const pending = fetchSourceVideoViews(
		{
			...deps,
			sources: {
				get: () => ({
					fetchVideoViews: async (_: unknown, signal: AbortSignal) => {
						seen = signal;
						return new Promise(() => {});
					},
				}),
			} as never,
		},
		identity,
		controller.signal,
	);
	await vi.advanceTimersByTimeAsync(0);
	controller.abort();
	expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
	expect(seen?.aborted).toBe(true);
});

beforeEach(() => {
	vi.useFakeTimers();
	logger.error.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
});

it.each([
	["zh-CN", "累计视频播放量读取超时，请稍后重试。"],
	["zh-TW", "累計影片播放次數讀取逾時，請稍後再試。"],
	["en", "Reading the total video view count timed out. Try again later."],
	["ja", "動画の累計再生数の取得がタイムアウトしました。しばらくしてから再試行してください。"],
] as const)("播放量超时在出字时读取当前语言：%s", async (locale, message) => {
	const previous = i18n.state();
	try {
		i18n.set({ locale: "en", voice: "plain" });
		const pending = fetchSourceVideoViews(
			{
				logger,
				gates: createSourceGates(),
				timeoutMs: 1000,
				sources: {
					get: () => ({ fetchVideoViews: () => new Promise<never>(() => {}) }),
				} as never,
			},
			{ sourceKey: "acme", externalId: "42" },
		);
		await vi.advanceTimersByTimeAsync(0);
		i18n.set({ locale, voice: "plain" });
		await vi.advanceTimersByTimeAsync(1001);
		expect(await pending).toEqual({ ok: false, code: "timeout", message });
	} finally {
		i18n.set(previous);
	}
});

it.each([
	[
		"zh-CN",
		"此来源不支持累计视频播放量采集。",
		"来源未能返回累计视频播放量，请稍后重试。",
		"累计视频播放量读取已取消。",
	],
	[
		"zh-TW",
		"此來源不支援累計影片播放次數的收集。",
		"來源無法傳回累計影片播放次數，請稍後再試。",
		"已取消讀取累計影片播放次數。",
	],
	[
		"en",
		"This source does not support total video view collection.",
		"The source could not return the total video view count. Try again later.",
		"Reading the total video view count was cancelled.",
	],
	[
		"ja",
		"このソースは動画の累計再生数の収集に対応していません。",
		"ソースから動画の累計再生数を取得できませんでした。しばらくしてから再試行してください。",
		"動画の累計再生数の取得をキャンセルしました。",
	],
] as const)(
	"播放量宿主失败使用当前语言，原始异常不进入结果：%s",
	async (locale, missing, thrown, aborted) => {
		const previous = i18n.state();
		const identity = { sourceKey: "acme", externalId: "42" };
		const deps = {
			logger,
			gates: createSourceGates(),
			sources: {
				get: () => ({
					fetchVideoViews: async () => {
						throw new Error("upstream-diagnostic-only");
					},
				}),
			} as never,
		};
		try {
			i18n.set({ locale, voice: "plain" });
			expect(
				await fetchSourceVideoViews({ ...deps, sources: { get: () => undefined } }, identity),
			).toEqual({ ok: false, code: "unsupported", message: missing });
			expect(await fetchSourceVideoViews(deps, identity)).toEqual({
				ok: false,
				code: "unavailable",
				message: thrown,
			});
			const controller = new AbortController();
			controller.abort();
			expect(await fetchSourceVideoViews(deps, identity, controller.signal)).toEqual({
				ok: false,
				code: "unavailable",
				message: aborted,
			});
		} finally {
			i18n.set(previous);
		}
	},
);

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
		expect(logger.error).toHaveBeenCalledWith(
			expect.any(String),
			{ event: "source.call_failed", sourceKey: "acme", member: "fetchLiveStatus" },
			expect.objectContaining({ message: "boom-detail" }),
		);
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
		expect(logger.error).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ event: "source.call_failed", member: "fetchProfile" }),
			expect.objectContaining({ message: "profile-boom-detail" }),
		);
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
