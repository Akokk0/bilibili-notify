/**
 * 宿主调来源 `searchCreators` 的外壳:按键找来源、带超时的 `AbortSignal`、抛错收成 `unavailable` 并记错误日志。
 * (抛错只留给 bug,宿主在边界接住 —— failure-results 第 2 条。)
 */

import { fail, ok, type Result } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { searchSourceCreators } from "../search-source-creators.js";

type Candidates = Result<{ candidates: Array<{ externalId: string; name: string }> }>;

function depsWith(
	sources: Record<
		string,
		{ label: string; searchCreators: (q: string, s: AbortSignal) => Promise<Candidates> }
	>,
	timeoutMs?: number,
) {
	const logger = { error: vi.fn() };
	return {
		logger,
		deps: {
			logger,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			sources: {
				get: (key: string) =>
					sources[key] === undefined
						? undefined
						: {
								sourceKey: key,
								descriptor: { label: sources[key].label },
								searchCreators: sources[key].searchCreators,
							},
				list: () =>
					Object.entries(sources).map(([key, s]) => ({
						sourceKey: key,
						descriptor: { label: s.label },
						searchCreators: s.searchCreators,
					})),
			},
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("searchSourceCreators", () => {
	it("找到来源 → 把 query 原样递下去,候选原样回", async () => {
		const search = vi.fn(async () => ok({ candidates: [{ externalId: "a", name: "甲" }] }));
		const { deps } = depsWith({ acme: { label: "对拍源", searchCreators: search } });
		const out = await searchSourceCreators(deps, "acme", "甲");
		expect(search).toHaveBeenCalledWith("甲", expect.any(AbortSignal));
		expect(out).toEqual({ ok: true, candidates: [{ externalId: "a", name: "甲" }] });
	});

	it("来源回的失败原样回(码、话、upstreamCode 都不动)", async () => {
		const { deps } = depsWith({
			acme: {
				label: "对拍源",
				searchCreators: async () => fail("rate_limited", "被风控了", { upstreamCode: -352 }),
			},
		});
		expect(await searchSourceCreators(deps, "acme", "x")).toEqual({
			ok: false,
			code: "rate_limited",
			message: "被风控了",
			upstreamCode: -352,
		});
	});

	it("键不在册 → not_found,话里列出在册来源的键与平台名", async () => {
		const { deps } = depsWith({
			bilibili: { label: "B 站", searchCreators: async () => ok({ candidates: [] }) },
			acme: { label: "对拍源", searchCreators: async () => ok({ candidates: [] }) },
		});
		const out = await searchSourceCreators(deps, "nope", "x");
		expect(out).toMatchObject({ ok: false, code: "not_found" });
		if (out.ok) throw new Error("应当失败");
		expect(out.message).toContain("nope");
		expect(out.message).toContain("bilibili（B 站）");
		expect(out.message).toContain("acme（对拍源）");
	});

	// 验红:把 catch 去掉,这条红(抛错冒出去)。
	it("来源抛错 → unavailable,并记一条错误日志(原话进日志,不进回给人的话)", async () => {
		const { deps, logger } = depsWith({
			acme: {
				label: "对拍源",
				searchCreators: async () => {
					throw new Error("内部炸了 secret-detail");
				},
			},
		});
		const out = await searchSourceCreators(deps, "acme", "x");
		expect(out).toMatchObject({ ok: false, code: "unavailable" });
		if (out.ok) throw new Error("应当失败");
		expect(out.message).not.toContain("secret-detail");
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(String(logger.error.mock.calls[0]?.[0])).toContain("内部炸了 secret-detail");
	});

	// 验红:把超时那一支去掉,这条红(一直等下去)。
	it("超时 → timeout,并叫停来源手里的 signal", async () => {
		vi.useFakeTimers();
		let seen: AbortSignal | undefined;
		const { deps } = depsWith(
			{
				acme: {
					label: "对拍源",
					searchCreators: (_q, signal) => {
						seen = signal;
						return new Promise<Candidates>(() => {});
					},
				},
			},
			1000,
		);
		const pending = searchSourceCreators(deps, "acme", "x");
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({ ok: false, code: "timeout" });
		expect(seen?.aborted).toBe(true);
	});
});
