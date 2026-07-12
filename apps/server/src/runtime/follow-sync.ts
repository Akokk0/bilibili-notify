import type { BilibiliAPI } from "@bilibili-notify/api";
import { ensureFollowed, FOLLOWED_ATTRIBUTES } from "@bilibili-notify/api";
import type { Logger, Subscription } from "@bilibili-notify/internal";
import type { SubRuntimeStore } from "./sub-runtime-store.js";

/**
 * 启动时(以及 auth-restored 后)确保每个订阅的 UP 都已关注。
 *
 * **为什么非做不可**:动态是从 `feed/all`(**关注流**)拉的,只会返回你已关注的人的动态。
 * 订阅一个 UP 却不关注他 = 订阅了个寂寞。koishi 端一直在 subscription-loader 里 follow,
 * 独立端**从来没做过** —— 所以存量订阅全是收不到动态的,光修「新增订阅时关注」救不回来。
 *
 * **为什么先查后补**:`relation/modify` 是**写**接口,风控比读严得多。订阅一多还对每个
 * 盲发一次 follow,非常容易撞 -352。所以先一次批量查关系(1 个读),只对真正缺的补。
 * 稳态下(都已关注)写请求数为 **0**。
 *
 * **降级**:批量查询只是优化,**不是正确性依赖**。它失败、或返回结构不是预期的样子
 * (接口改版 / 契约记错),一律降级为对每个订阅直接 `follow()` —— 幂等,22014=已关注,
 * 正是 koishi 跑了很久的那条已知可用路径。功能永远不会因为这个优化而瘫痪。
 */

export interface FollowSyncDeps {
	api: BilibiliAPI;
	subs: () => Subscription[];
	rt: SubRuntimeStore;
	logger: Logger;
}

export interface FollowSyncResult {
	/** 检查了多少个订阅。 */
	checked: number;
	/** 本轮**补**关注成功的数量。已经关注过的不计在内 —— 稳态下这里是 0。 */
	followed: number;
	/** 本轮之前就已经关注了的数量(没为它们发过写请求)。 */
	alreadyFollowed: number;
	/** 补关注失败的数量 —— 这些订阅收不到动态。 */
	failed: number;
	/** 是否走了降级路径(批量查询不可用,只能逐个盲 follow)。 */
	degraded: boolean;
}

/** 补关注之间的间隔 —— 写接口连发最招风控。 */
const FOLLOW_GAP_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 批量查出「已经关注了的 uid」。
 *
 * 返回 `null` 表示**查不出来**(请求炸 / 业务码失败 / 结构真的变了),调用方据此降级。
 *
 * **「查不出来」与「查出来了,一个都没关注」是两回事,绝不能混**:后者说明确实要补 N 个
 * (返回空集),前者说明我们对现状一无所知,只能靠 follow 的幂等性兜底。
 *
 * 而官方契约里,`data` **只列已关注的 mid** —— 未关注的根本不出现。所以一个都没关注时
 * 服务端回的就是 `data: null`,这是**有效答案**。曾经把它当成「结构不符」,于是一个全新
 * 的、一个都还没关注的实例每次启动都误报「批量查询失败(code=0)」并降级 —— code=0 明明
 * 是成功码。功能没坏(降级路径兜住了),但白发一次查询、还骗人说接口挂了。
 */
async function queryFollowed(
	api: BilibiliAPI,
	uids: string[],
	logger: Logger,
): Promise<Set<string> | null> {
	try {
		const res = await api.getRelations(uids);
		if (res.code !== 0) {
			// 真失败:-101 未登录、-400 请求错误…
			logger.warn(
				`[follow] 批量查询关注状态失败(code=${res.code}: ${res.message ?? ""}) —— 降级为逐个关注`,
			);
			return null;
		}
		// code=0 且 data 缺席 = 一个都没关注(契约:data 只列已关注的)。有效答案,不是失败。
		if (res.data == null) return new Set();
		if (typeof res.data !== "object" || Array.isArray(res.data)) {
			// data 在、却不是对象 —— 契约真的变了,这才该降级。
			logger.warn("[follow] 批量查询关注状态返回了预期外的结构 —— 降级为逐个关注");
			return null;
		}
		const followed = new Set<string>();
		for (const [mid, rel] of Object.entries(res.data)) {
			if (typeof rel?.attribute === "number" && FOLLOWED_ATTRIBUTES.has(rel.attribute)) {
				followed.add(mid);
			}
		}
		return followed;
	} catch (e) {
		logger.warn(
			`[follow] 批量查询关注状态抛错(${e instanceof Error ? e.message : String(e)}) —— 降级为逐个关注`,
		);
		return null;
	}
}

export async function syncFollows(deps: FollowSyncDeps): Promise<FollowSyncResult> {
	const subs = deps.subs();
	if (subs.length === 0) {
		return { checked: 0, followed: 0, alreadyFollowed: 0, failed: 0, degraded: false };
	}

	const uids = [...new Set(subs.map((s) => s.uid))];
	const alreadyFollowed = await queryFollowed(deps.api, uids, deps.logger);
	const degraded = alreadyFollowed === null;

	// 降级时对现状一无所知 → 每个都得 follow 一遍(幂等)。
	const needFollow = subs.filter((s) => degraded || !alreadyFollowed?.has(s.uid));

	if (needFollow.length === 0) {
		deps.logger.debug(`[follow] ${subs.length} 个订阅的 UP 均已关注,无需补关注`);
		// 已关注的也要落一次状态 —— 否则老数据永远停在 undefined,前端分不清
		// 「没关注」和「没检查过」。
		await Promise.all(
			subs.map((s) => deps.rt.patch(s.id, { followed: true, followError: undefined })),
		);
		return {
			checked: subs.length,
			followed: 0, // 一个写请求都没发
			alreadyFollowed: subs.length,
			failed: 0,
			degraded,
		};
	}

	deps.logger.info(
		`[follow] ${subs.length} 个订阅中 ${needFollow.length} 个尚未关注,开始补关注${degraded ? "(降级:逐个)" : ""}`,
	);

	let followed = 0;
	let failed = 0;
	const followingIds = new Set(needFollow.map((s) => s.id));

	for (const [i, sub] of needFollow.entries()) {
		if (i > 0) await sleep(FOLLOW_GAP_MS); // 写接口连发最招风控
		const outcome = await ensureFollowed(deps.api, sub.uid);
		if (outcome.ok) {
			followed++;
		} else {
			failed++;
			deps.logger.warn(
				`[follow] 关注 UID ${sub.uid} 失败(code=${outcome.code}): ${outcome.message} —— 该订阅收不到动态`,
			);
		}
		await deps.rt.patch(sub.id, {
			followed: outcome.ok,
			followError: outcome.ok ? undefined : outcome.message || `code=${outcome.code}`,
		});
	}

	// 批量查询说「已关注」的那些,也把状态落一遍。
	await Promise.all(
		subs
			.filter((s) => !followingIds.has(s.id))
			.map((s) => deps.rt.patch(s.id, { followed: true, followError: undefined })),
	);

	if (failed > 0) {
		deps.logger.warn(`[follow] 补关注完成:${followed} 成功、${failed} 失败(失败的收不到动态)`);
	} else {
		deps.logger.info(`[follow] 补关注完成:${followed} 个`);
	}

	return {
		checked: subs.length,
		followed,
		alreadyFollowed: subs.length - needFollow.length,
		failed,
		degraded,
	};
}
