/**
 * B 站关注自愈 —— `syncFollows`。
 *
 * 动态走 `feed/all`(**关注流**):没关注就一条动态都收不到。策略仍是先一次批量查关系,
 * 只对确实没关注的补 follow,因为 `relation/modify` 是写接口,风控比读严得多。
 *
 * 关注结果现在是 B 站来源的问题表条目,不再写订阅运行态:失败报 `follow_failed`,成功清。
 */

import { fail, ok, type Result, type SourceSubscriptionView } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { syncFollows } from "../follow-sync.js";

const UIDS = ["111", "222", "333"];

const view = (externalId: string, post = true): SourceSubscriptionView => ({
	externalId,
	features: new Set(post ? (["post"] as const) : []),
	monitorsLive: false,
});

type RelationsResult = Result<{
	data: Record<string, { attribute?: number }> | null;
}>;

function makeDeps(opts?: {
	relationsData?: unknown;
	relationsResult?: RelationsResult;
	relationsThrows?: boolean;
	followResults?: Result[];
	views?: readonly SourceSubscriptionView[];
}) {
	const fetchRelations = vi.fn(async (_fids: string[]) => {
		if (opts?.relationsThrows) throw new Error("network down");
		if (opts?.relationsResult !== undefined) return opts.relationsResult;
		return ok({
			// 111 已关注(2)、222 互粉(6)、333 未关注(0)
			data:
				opts?.relationsData === undefined
					? { "111": { attribute: 2 }, "222": { attribute: 6 }, "333": { attribute: 0 } }
					: opts.relationsData,
		});
	});
	let followIndex = 0;
	const follow = vi.fn(async (_fid: string) => {
		const queued = opts?.followResults?.[followIndex++];
		return queued ?? ok();
	});
	const reportFailure = vi.fn();
	const resolveFailure = vi.fn();
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

	return {
		deps: {
			api: { fetchRelations, follow } as never,
			subscriptions: () => opts?.views ?? UIDS.map((externalId) => view(externalId)),
			problems: { reportFailure, resolveFailure } as never,
			logger: logger as never,
		},
		fetchRelations,
		follow,
		reportFailure,
		resolveFailure,
		logger,
	};
}

describe("syncFollows — 补齐关注", () => {
	it("只对没关注的补 follow,批量查说已关注的也清掉旧问题", async () => {
		const { deps, fetchRelations, follow, reportFailure, resolveFailure } = makeDeps();

		const r = await syncFollows(deps);

		expect(fetchRelations).toHaveBeenCalledTimes(1);
		expect(fetchRelations).toHaveBeenCalledWith(UIDS);
		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).toHaveBeenCalledWith("333");
		expect(reportFailure).not.toHaveBeenCalled();
		expect(resolveFailure).toHaveBeenCalledWith({ externalId: "111", code: "follow_failed" });
		expect(resolveFailure).toHaveBeenCalledWith({ externalId: "222", code: "follow_failed" });
		expect(resolveFailure).toHaveBeenCalledWith({ externalId: "333", code: "follow_failed" });
		expect(r.followed).toBe(1);
	});

	it("关注回 22003 → 按 follow_failed 报原话;之后成功 → 清掉", async () => {
		const { deps, follow, reportFailure, resolveFailure } = makeDeps({
			views: [view("333")],
			relationsData: null,
			followResults: [fail("unknown", "对方已将你拉黑", { upstreamCode: 22003 }), ok()],
		});

		await syncFollows(deps);

		expect(reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "333",
				code: "follow_failed",
				notify: false,
				lasting: true,
			}),
		);
		const failure = reportFailure.mock.calls[0]?.[0] as { message: () => string };
		expect(failure.message()).toContain("对方已将你拉黑");

		await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(2);
		expect(resolveFailure).toHaveBeenCalledWith({ externalId: "333", code: "follow_failed" });
	});

	it("批量查 unauthorized → 整批跳过,不发关注、不碰问题", async () => {
		const { deps, follow, reportFailure, resolveFailure, fetchRelations } = makeDeps({
			relationsResult: fail("unauthorized", "账号未登录", { upstreamCode: -101 }),
		});

		const r = await syncFollows(deps);

		expect(fetchRelations).toHaveBeenCalledTimes(1);
		expect(follow).not.toHaveBeenCalled();
		expect(reportFailure).not.toHaveBeenCalled();
		expect(resolveFailure).not.toHaveBeenCalled();
		expect(r.degraded).toBe(false);
		// 这一轮谁都没处理:整批欠着,等登录恢复或下一次名单变化。
		expect(r.pending).toEqual(UIDS);
	});

	it("批量查撞风控 → 整批跳过,不降级、不发关注、不碰问题", async () => {
		const { deps, follow, reportFailure, resolveFailure, logger } = makeDeps({
			relationsResult: fail("rate_limited", "请求过于频繁", { upstreamCode: -352 }),
		});

		const r = await syncFollows(deps);

		expect(follow).not.toHaveBeenCalled();
		expect(reportFailure).not.toHaveBeenCalled();
		expect(resolveFailure).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith("批量关注查询被限流，整批跳过，不回退逐个写入", {
			code: "rate_limited",
			upstreamCode: -352,
			message: "请求过于频繁",
		});
		expect(r).toEqual({
			checked: UIDS.length,
			followed: 0,
			alreadyFollowed: 0,
			failed: 0,
			degraded: false,
			pending: UIDS,
		});
	});

	it("单个关注 unauthorized → 这一批停下,不报也不清", async () => {
		const { deps, follow, reportFailure, resolveFailure } = makeDeps({
			views: [view("111"), view("222")],
			relationsData: null,
			followResults: [fail("unauthorized", "账号未登录", { upstreamCode: -101 })],
		});

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).toHaveBeenCalledWith("111");
		expect(reportFailure).not.toHaveBeenCalled();
		expect(resolveFailure).not.toHaveBeenCalled();
		// 撞上的与没轮到的都欠着。
		expect(r.pending).toEqual(["111", "222"]);
	});

	it("逐个关注撞风控 → 报当前一位失败,后面的不再写", async () => {
		const { deps, follow, reportFailure } = makeDeps({
			relationsData: null,
			followResults: [ok(), fail("rate_limited", "请求过于频繁", { upstreamCode: -352 })],
		});

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(2);
		expect(follow).toHaveBeenLastCalledWith("222");
		expect(reportFailure).toHaveBeenCalledTimes(1);
		expect(reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "222", code: "follow_failed" }),
		);
		expect(r.failed).toBe(1);
		expect(r.followed).toBe(1);
		// 撞上的那位与后面没轮到的都欠着,随下一次名单变化一起补。
		expect(r.pending).toEqual(["222", "333"]);
	});

	it("批量查询炸了 → 降级为对每个人直接 follow(幂等,不能因为一个优化接口就瘫痪)", async () => {
		const { deps, follow } = makeDeps({ relationsThrows: true });

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(UIDS.length);
		expect(r.degraded).toBe(true);
	});

	it("data 为 null(一个都没关注)→ 有效答案,照常走批量路径,不是降级", async () => {
		const { deps, follow } = makeDeps({ relationsData: null });

		const r = await syncFollows(deps);

		expect(r.degraded).toBe(false);
		expect(follow).toHaveBeenCalledTimes(UIDS.length);
		expect(r.alreadyFollowed).toBe(0);
	});

	it("data 是异常结构 → 降级,不是崩", async () => {
		const { deps, follow } = makeDeps({ relationsData: "unexpected" });

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(UIDS.length);
		expect(r.degraded).toBe(true);
	});

	it("没有作品开着的人 → 一个请求都不发", async () => {
		const { deps, fetchRelations, follow } = makeDeps({ views: [view("111", false)] });

		const r = await syncFollows(deps);

		expect(fetchRelations).not.toHaveBeenCalled();
		expect(follow).not.toHaveBeenCalled();
		expect(r.checked).toBe(0);
	});

	it("only 只处理指定的人,查询也不带别人", async () => {
		const { deps, fetchRelations, follow } = makeDeps({ relationsData: null });

		const r = await syncFollows({ ...deps, only: new Set(["222"]) });

		expect(fetchRelations).toHaveBeenCalledWith(["222"]);
		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).toHaveBeenCalledWith("222");
		expect(r.checked).toBe(1);
	});

	it("同一个人只发一次关注", async () => {
		const { deps, follow } = makeDeps({
			views: [view("111"), view("111")],
			relationsData: null,
		});

		await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).toHaveBeenCalledWith("111");
	});
});

/**
 * 关停:一轮逐个补关注中间每个隔 300ms,`signal` 一中止就得停在手上这一个。
 */
describe("syncFollows — signal 中止", () => {
	it("补完手上这一个就停,后面的不再发关注", async () => {
		const shutdown = new AbortController();
		const { deps, follow, resolveFailure } = makeDeps({ relationsData: null });
		follow.mockImplementationOnce(async () => {
			shutdown.abort();
			return ok();
		});

		const r = await syncFollows({ ...deps, signal: shutdown.signal });

		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).toHaveBeenCalledWith("111");
		expect(resolveFailure).toHaveBeenCalledTimes(1);
		expect(r.followed).toBe(1);
	});

	it("两个关注之间的间隔里中止:马上醒,不把 300ms 睡满", async () => {
		const shutdown = new AbortController();
		const { deps, follow } = makeDeps({ relationsData: null });

		const running = syncFollows({ ...deps, signal: shutdown.signal });
		await vi.waitFor(() => expect(follow).toHaveBeenCalledTimes(1), { interval: 2 });
		const abortedAt = Date.now();
		shutdown.abort();
		await running;

		expect(Date.now() - abortedAt).toBeLessThan(150);
		expect(follow).toHaveBeenCalledTimes(1);
	});

	it("开始之前信号就已经中止:一个关注都不发", async () => {
		const shutdown = new AbortController();
		shutdown.abort();
		const { deps, follow, reportFailure, resolveFailure } = makeDeps({ relationsData: null });

		await syncFollows({ ...deps, signal: shutdown.signal });

		expect(follow).not.toHaveBeenCalled();
		expect(reportFailure).not.toHaveBeenCalled();
		expect(resolveFailure).not.toHaveBeenCalled();
	});
});

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

it("关注查询异常诊断跟随当前语言，保留原Error/cause并继续既有逐个关注回退", async () => {
	const w = makeDeps({ views: [view("333")] });
	const error = new Error("raw upstream failure", { cause: new Error("connection lost") });
	w.fetchRelations.mockRejectedValue(error);
	for (const [locale, message] of [
		["zh-CN", "批量关注查询异常，回退为逐个关注"],
		["en", "Batch follow lookup failed; falling back to individual follow requests"],
		["ja", "フォローの一括確認で例外が発生したため、個別のフォローに切り替えます"],
		["zh-TW", "批次關注查詢異常，改為逐一關注"],
	] as const) {
		i18n.set({ locale, voice: "maid" });
		const result = await syncFollows(w.deps);
		expect(w.logger.warn).toHaveBeenLastCalledWith(message, { error });
		const fields = (w.logger.warn.mock.lastCall as unknown[] | undefined)?.[1] as
			| { error: Error }
			| undefined;
		expect(fields?.error).toBe(error);
		expect(result).toMatchObject({ degraded: true, followed: 1, failed: 0 });
	}
	expect(w.logger.warn).toHaveBeenCalledTimes(4);
	expect(w.fetchRelations).toHaveBeenCalledTimes(4);
	expect(w.follow).toHaveBeenCalledTimes(4);
	expect(w.reportFailure).not.toHaveBeenCalled();
});
