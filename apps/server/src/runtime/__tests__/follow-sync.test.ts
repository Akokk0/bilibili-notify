/**
 * 启动时的关注自愈 —— `syncFollows`。
 *
 * 动态走 `feed/all`(**关注流**):没关注就一条动态都收不到。独立端此前**从不** follow,
 * 所以主人现有的订阅全是废的 —— 光修「新增订阅时关注」救不了它们,得在启动时补一遍。
 *
 * 策略:先一次**批量查**关系(1 个读请求),只对确实没关注的补 follow。`relation/modify`
 * 是写接口,风控比读严得多,订阅一多还盲发 N 个写请求非常容易撞 -352。
 *
 * 但批量查询只是**优化,不是正确性依赖** —— 它失败/返回结构不符时必须降级成直接
 * follow(幂等,22014=已关注),也就是 koishi 跑了很久的那条已知可用路径。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { syncFollows } from "../follow-sync.js";

const UIDS = ["111", "222", "333"];

function makeDeps(opts?: {
	relations?: unknown;
	relationsThrows?: boolean;
	followFails?: string[];
}) {
	const fetchRelations = vi.fn(async (_fids: string[]) => {
		if (opts?.relationsThrows) throw new Error("network down");
		return (opts?.relations ?? {
			code: 0,
			// 111 已关注(2)、222 互粉(6)、333 未关注(0)
			data: { "111": { attribute: 2 }, "222": { attribute: 6 }, "333": { attribute: 0 } },
		}) as never;
	});
	const follow = vi.fn(async (fid: string) => {
		if (opts?.followFails?.includes(fid)) return { code: 22003, message: "对方已将你拉黑" };
		return { code: 0, message: "0" };
	});
	const patch = vi.fn(async () => {});

	return {
		deps: {
			api: { fetchRelations, follow } as never,
			subs: () =>
				UIDS.map((uid, i) => ({
					id: `sub-${i}`,
					identity: { sourceKey: "bilibili", externalId: uid },
				})) as never,
			rt: { patch } as never,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		},
		fetchRelations,
		follow,
		patch,
	};
}

describe("syncFollows — 启动时补齐关注", () => {
	it("只对**没关注**的那个补 follow,已关注的一个写请求都不发", async () => {
		const { deps, fetchRelations, follow } = makeDeps();

		const r = await syncFollows(deps);

		expect(fetchRelations).toHaveBeenCalledTimes(1); // 一次读问清全部
		expect(follow).toHaveBeenCalledTimes(1); // 只补缺的那个
		expect(follow).toHaveBeenCalledWith("333");
		expect(r.followed).toBe(1);
	});

	it("关注结果写进 SubRuntimeStore(前端才看得到「未关注」)", async () => {
		const { deps, patch } = makeDeps();

		await syncFollows(deps);

		// 已关注的照样落一次 followed:true —— 否则老数据永远停在 undefined,
		// 前端分不清「没关注」和「没检查过」。
		expect(patch).toHaveBeenCalledWith("sub-0", { followed: true, followError: undefined });
		expect(patch).toHaveBeenCalledWith("sub-2", { followed: true, followError: undefined });
	});

	it("补关注失败 → 如实记下原因,不中断其它订阅", async () => {
		const { deps, patch, follow } = makeDeps({ followFails: ["333"] });

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledWith("333");
		expect(patch).toHaveBeenCalledWith("sub-2", {
			followed: false,
			followError: expect.stringContaining("拉黑"),
		});
		expect(r.failed).toBe(1);
	});

	it("批量查询炸了 → 降级为对每个订阅直接 follow(幂等,不能因为一个优化接口就瘫痪)", async () => {
		const { deps, follow } = makeDeps({ relationsThrows: true });

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(UIDS.length);
		expect(r.degraded).toBe(true);
	});

	// 官方契约:`data` **只列已关注的 mid**,未关注的根本不出现。所以一个都没关注时
	// 服务端就回 `data: null` —— 这是**有效答案(空集)**,不是查询失败。
	//
	// 这一条曾经被写反:把 `{code:0, data:null}` 当成「结构不符」→ 误报失败 + 降级。
	// 讽刺的是 queryFollowed 的注释里正警告过「查不出来」与「查出来了、一个都没关注」
	// 绝不能混,然后实现和测试双双踩了进去。主人首次实跑的日志里那句
	// 「批量查询关注状态失败(code=0)」就是它 —— code=0 明明是成功码。
	it("data 为 null(一个都没关注)→ 有效答案,照常走批量路径,不是降级", async () => {
		const { deps, follow } = makeDeps({ relations: { code: 0, data: null } });

		const r = await syncFollows(deps);

		expect(r.degraded).toBe(false); // ← 查询是成功的
		expect(follow).toHaveBeenCalledTimes(UIDS.length); // 确实一个都没关注,全都要补
		expect(r.alreadyFollowed).toBe(0);
	});

	it("业务码失败(如 -101 未登录)→ 才是真失败,降级为逐个", async () => {
		const { deps, follow } = makeDeps({ relations: { code: -101, message: "账号未登录" } });

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(UIDS.length);
		expect(r.degraded).toBe(true);
	});

	it("data 是异常结构(不是对象,契约真变了)→ 降级,不是崩", async () => {
		const { deps, follow } = makeDeps({ relations: { code: 0, data: "unexpected" } });

		const r = await syncFollows(deps);

		expect(follow).toHaveBeenCalledTimes(UIDS.length);
		expect(r.degraded).toBe(true);
	});

	// 契约的核心:`data` **只列已关注的**,未关注的 mid 根本不出现在响应里。
	// 所以判定必须是「缺席即未关注」,而不能指望服务端回一个 attribute=0 的条目。
	it("data 只列已关注的(未关注的 mid 缺席)→ 缺席即未关注,照样补上", async () => {
		const { deps, follow } = makeDeps({
			relations: { code: 0, data: { "111": { mid: 111, attribute: 2 } } },
		});

		const r = await syncFollows(deps);

		expect(r.degraded).toBe(false);
		expect(r.alreadyFollowed).toBe(1); // 只有 111
		expect(follow).toHaveBeenCalledTimes(2); // 222 / 333 缺席 → 补
		expect(follow).toHaveBeenCalledWith("222");
		expect(follow).toHaveBeenCalledWith("333");
	});

	it("没有订阅 → 一个请求都不发", async () => {
		const { deps, fetchRelations, follow } = makeDeps();
		const empty = { ...deps, subs: () => [] as never };

		const r = await syncFollows(empty);

		expect(fetchRelations).not.toHaveBeenCalled();
		expect(follow).not.toHaveBeenCalled();
		expect(r.checked).toBe(0);
	});
});

/**
 * 关停(切片 ③)。一轮逐个补关注中间每个隔 300ms、订阅一多要好几分钟,登记进 `ctx.track()` 之后
 * 关停不能靠预算硬等 —— `signal` 一中止就得停在手上这一个订阅。
 */
describe("syncFollows — signal 中止", () => {
	/** 全都没关注:每个订阅都要补,中间隔 FOLLOW_GAP_MS。 */
	const NONE_FOLLOWED = { code: 0, data: null };

	it("补完手上这一个就停:结果照样写进 rt,后面的不再发关注,别人的状态也不再补写", async () => {
		const shutdown = new AbortController();
		const { deps, follow, patch } = makeDeps({ relations: NONE_FOLLOWED });
		follow.mockImplementationOnce(async () => {
			shutdown.abort(); // 关停正好在第一个关注在途时开始
			return { code: 0, message: "0" };
		});

		const r = await syncFollows({ ...deps, signal: shutdown.signal });

		expect(follow).toHaveBeenCalledTimes(1);
		expect(follow).toHaveBeenCalledWith("111");
		// 已经发出去的那个关注,状态照样落进去(不然和 B 站上的真相对不上)。
		expect(patch).toHaveBeenCalledTimes(1);
		expect(patch).toHaveBeenCalledWith("sub-0", { followed: true, followError: undefined });
		expect(r.followed).toBe(1);
	});

	it("两个关注之间的间隔里中止:马上醒,不把 300ms 睡满", async () => {
		const shutdown = new AbortController();
		const { deps, follow } = makeDeps({ relations: NONE_FOLLOWED });

		const running = syncFollows({ ...deps, signal: shutdown.signal });
		// 第一个补完,正睡在 300ms 的间隔里。轮询间隔压小,让中止尽量贴着间隔的开头落下 ——
		// 没接线的话中止之后还得再睡 ~290ms,和「马上醒」差出一大截,余量不靠机器快慢。
		await vi.waitFor(() => expect(follow).toHaveBeenCalledTimes(1), { interval: 2 });
		const abortedAt = Date.now();
		shutdown.abort();
		await running;

		expect(Date.now() - abortedAt).toBeLessThan(150);
		expect(follow).toHaveBeenCalledTimes(1);
	});

	it("开始之前信号就已经中止:一个关注都不发,一笔状态都不写", async () => {
		const shutdown = new AbortController();
		shutdown.abort();
		const { deps, follow, patch } = makeDeps({ relations: NONE_FOLLOWED });

		await syncFollows({ ...deps, signal: shutdown.signal });

		expect(follow).not.toHaveBeenCalled();
		expect(patch).not.toHaveBeenCalled();
	});
});
