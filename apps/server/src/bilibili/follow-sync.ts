import {
	type Disposable,
	isLoggedIn,
	type Logger,
	type SourceAuth,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { errorMessageOf } from "../util/error-message.js";
import type { Api } from "./api/index.js";
import { ensureFollowed, FOLLOWED_ATTRIBUTES } from "./api/index.js";
import type { ProblemLayers } from "./problem-layers.js";
import { PROBLEM_TEXTS } from "./problem-texts.js";

/**
 * 在开机、登录恢复、关注范围变化后补齐关注。
 *
 * **为什么非做不可**:动态是从 `feed/all`(**关注流**)拉的,只会返回你已关注的人的动态。
 * 订阅一个 UP 却不关注他 = 订阅了个寂寞。存量订阅全是收不到动态的,光修「新增订阅时关注」救不回来。
 *
 * **为什么先查后补**:`relation/modify` 是**写**接口,风控比读严得多。订阅一多还对每个人
 * 盲发一次 follow,非常容易撞 -352。所以先一次批量查关系(1 个读),只对真正缺的补。
 * 稳态下(都已关注)写请求数为 **0**。
 *
 * **降级**:批量查询只是优化,**不是正确性依赖**。它失败、或返回结构不是预期的样子
 * (接口改版 / 契约记错),一律降级为对每个人直接 `follow()` —— 幂等,22014=已关注。
 * 唯一例外是 `unauthorized`:没登录时逐个写只会把整批都撞成 -101,等登录恢复再全量补。
 */

export interface FollowSyncDeps {
	api: Api;
	/** 来源自己的名单视图;只处理作品开着的人。 */
	subscriptions: () => readonly SourceSubscriptionView[];
	/** 只处理这几个外部 id(名单里刚新进的人)。不给就是全量。 */
	only?: ReadonlySet<string>;
	problems: Pick<ProblemLayers, "reportFailure" | "resolveFailure">;
	logger: Logger;
	/**
	 * 关停信号。中止之后停在手上这一个:已经发出去的那个关注照样按结果清问题,
	 * 但不再发下一个 —— 一轮逐个补关注要好几分钟,关停不能靠预算硬等。
	 */
	signal?: AbortSignal;
}

export interface FollowSyncResult {
	/** 检查了多少个人。 */
	checked: number;
	/** 本轮**补**关注成功的人数。已经关注过的不计在内 —— 稳态下这里是 0。 */
	followed: number;
	/** 本轮之前就已经关注了的人数(没为他们发过写请求)。 */
	alreadyFollowed: number;
	/** 补关注失败的人数 —— 这些人收不到动态。 */
	failed: number;
	/** 是否走了降级路径(批量查询不可用,只能逐个盲 follow)。 */
	degraded: boolean;
	/**
	 * 这一轮没处理完的外部 id:批量查撞风控 / 未登录时的整批,逐个写撞风控时撞上的与后面没轮到的,
	 * 撞 `unauthorized` 停下时没轮到的。名单里还开着的,随下一次关注同步一起补。
	 */
	pending: string[];
}

export interface WatchFollowsDeps {
	api: Api;
	auth: Pick<SourceAuth, "state" | "onChange">;
	subscriptions: SourceContext["subscriptions"];
	onSubscriptionsChanged: SourceContext["onSubscriptionsChanged"];
	problems: Pick<ProblemLayers, "reportFailure" | "resolveFailure">;
	logger: Logger;
	signal: AbortSignal;
}

/** 补关注之间的间隔 —— 写接口连发最招风控。 */
const FOLLOW_GAP_MS = 300;

/** 睡 `ms` 毫秒;`signal` 中止就提前醒。 */
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const wake = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", wake);
			resolve();
		};
		const timer = setTimeout(wake, ms);
		signal?.addEventListener("abort", wake, { once: true });
	});

/**
 * 批量查出「已经关注了的 uid」。
 *
 * 返回 `null` 表示**查不出来**(请求炸 / 业务码失败 / 结构真的变了),调用方据此降级。
 * `"unauthorized"`(等登录恢复)与 `"rate_limited"`(撞风控,不降级成逐个写)单独分出:整批跳过、不动问题。
 *
 * **「查不出来」与「查出来了,一个都没关注」是两回事,绝不能混**:后者说明确实要补 N 个
 * (返回空集),前者说明我们对现状一无所知,只能靠 follow 的幂等性兜底。
 *
 * 而官方契约里,`data` **只列已关注的 mid** —— 未关注的根本不出现。所以一个都没关注时
 * 服务端回的就是 `data: null`,这是**有效答案**。曾经把它当成「结构不符」,于是一个全新
 * 的、一个都还没关注的实例每次启动都误报「批量查询失败(code=0)」并降级。
 */
async function queryFollowed(
	api: Api,
	uids: string[],
	logger: Logger,
): Promise<Set<string> | "unauthorized" | "rate_limited" | null> {
	try {
		const res = await api.fetchRelations(uids);
		if (!res.ok) {
			if (res.code === "unauthorized") {
				logger.info("[follow] 账号未登录,本轮关注同步整批跳过,等登录恢复");
				return "unauthorized";
			}
			if (res.code === "rate_limited") {
				logger.warn(
					`[follow] 批量查询关注状态撞风控，本轮关注同步整批跳过、不降级(code=${res.upstreamCode ?? res.code}: ${res.message})`,
				);
				return "rate_limited";
			}
			logger.warn(
				`[follow] 批量查询关注状态失败(code=${res.upstreamCode ?? res.code}: ${res.message}) —— 降级为逐个关注`,
			);
			return null;
		}
		// code=0 且 data 缺席 = 一个都没关注(契约:data 只列已关注的)。有效答案,不是失败。
		if (res.data == null) return new Set();
		if (typeof res.data !== "object" || Array.isArray(res.data)) {
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
		logger.warn(`[follow] 批量查询关注状态抛错(${errorMessageOf(e)}) —— 降级为逐个关注`);
		return null;
	}
}

/** 名单里开着作品的每个人;同一外部 id 只留一条。 */
function followTargetIds(subscriptions: readonly SourceSubscriptionView[]): string[] {
	return [
		...new Set(
			subscriptions
				.filter((subscription) => subscription.features.has("post"))
				.map((subscription) => subscription.externalId),
		),
	];
}

const resolveFollowFailure = (problems: FollowSyncDeps["problems"], externalId: string): void => {
	problems.resolveFailure({ externalId, code: "follow_failed" });
};

export async function syncFollows(deps: FollowSyncDeps): Promise<FollowSyncResult> {
	const only = deps.only;
	const uids = followTargetIds(deps.subscriptions()).filter(
		(externalId) => only === undefined || only.has(externalId),
	);
	if (uids.length === 0 || deps.signal?.aborted) {
		return { checked: 0, followed: 0, alreadyFollowed: 0, failed: 0, degraded: false, pending: [] };
	}

	const alreadyFollowed = await queryFollowed(deps.api, uids, deps.logger);
	if (alreadyFollowed === "unauthorized" || alreadyFollowed === "rate_limited") {
		return {
			checked: uids.length,
			followed: 0,
			alreadyFollowed: 0,
			failed: 0,
			degraded: false,
			// 整批都没查成:这一轮一个人都没处理。
			pending: uids,
		};
	}
	const degraded = alreadyFollowed === null;
	const interrupted = (): boolean => deps.signal?.aborted === true;
	if (interrupted()) {
		deps.logger.info("[follow] 关停中，关注同步到此为止");
		return {
			checked: uids.length,
			followed: 0,
			alreadyFollowed: 0,
			failed: 0,
			degraded,
			pending: [],
		};
	}

	// 批量查说已关注的人,清掉上一次可能留下的失败;成功关注后也走同一句。
	if (alreadyFollowed) {
		for (const uid of alreadyFollowed) resolveFollowFailure(deps.problems, uid);
	}

	// 降级时对现状一无所知 → 每个人都 follow 一遍(幂等)。
	const needFollow = uids.filter((uid) => degraded || !alreadyFollowed?.has(uid));
	if (needFollow.length === 0) {
		deps.logger.debug(`[follow] ${uids.length} 个人均已关注,无需补关注`);
		return {
			checked: uids.length,
			followed: 0,
			alreadyFollowed: uids.length,
			failed: 0,
			degraded,
			pending: [],
		};
	}

	deps.logger.info(
		`[follow] ${uids.length} 个人中 ${needFollow.length} 个尚未关注,开始补关注${degraded ? "(降级:逐个)" : ""}`,
	);

	let followed = 0;
	let failed = 0;
	let sent = 0;
	/** 停在风控 / 未登录上时,撞上的那位与后面没轮到的都欠着。 */
	let pending: string[] = [];
	for (const [index, uid] of needFollow.entries()) {
		if (sent > 0) await sleep(FOLLOW_GAP_MS, deps.signal); // 写接口连发最招风控
		if (interrupted()) break;
		const outcome = await ensureFollowed(deps.api, uid);
		sent++;
		if (outcome.ok) {
			followed++;
			resolveFollowFailure(deps.problems, uid);
			continue;
		}
		if (outcome.code === "unauthorized") {
			pending = needFollow.slice(index);
			break;
		}
		failed++;
		const code = outcome.upstreamCode ?? outcome.code;
		deps.logger.warn(
			`[follow] 关注 UID ${uid} 失败(code=${code}): ${outcome.message} —— 该订阅收不到动态`,
		);
		deps.problems.reportFailure({
			externalId: uid,
			code: "follow_failed",
			message: () =>
				PROBLEM_TEXTS.followFailed.text(
					outcome.message.trim() || t("bilibili.response.codeOnly", { code }),
				),
			notify: PROBLEM_TEXTS.followFailed.notify,
			lasting: true,
		});
		if (outcome.code === "rate_limited") {
			pending = needFollow.slice(index);
			deps.logger.warn(
				`[follow] 撞风控，停下这一批，剩下 ${needFollow.length - sent} 位等下次关注同步`,
			);
			break;
		}
	}

	if (interrupted()) {
		deps.logger.info(`[follow] 关停中，补关注到此为止:${followed} 成功、${failed} 失败`);
	} else if (failed > 0) {
		deps.logger.warn(`[follow] 补关注完成:${followed} 成功、${failed} 失败(失败的收不到动态)`);
	} else {
		deps.logger.info(`[follow] 补关注完成:${followed} 个`);
	}

	return {
		checked: uids.length,
		followed,
		alreadyFollowed: uids.length - needFollow.length,
		failed,
		degraded,
		pending,
	};
}

/**
 * 来源自己的关注触发器:已登录开机跑全量;登录从「不算登录」变成已登录时全量;
 * 名单变化时只补新进的人,不再适用的人清掉问题。没登录时只更新集合、不发请求。
 *
 * 关停由这里自己的 controller 负责;它叠在来源的 `signal` 上,`dispose` 时中止在途那一轮。
 */
export function watchFollows(deps: WatchFollowsDeps): Disposable {
	const shutdown = new AbortController();
	const abort = (): void => shutdown.abort();
	if (deps.signal.aborted) abort();
	else deps.signal.addEventListener("abort", abort, { once: true });

	let disposed = false;
	let wasLoggedIn = isLoggedIn(deps.auth.state());
	let targets = new Set(followTargetIds(deps.subscriptions()));
	/** 撞风控 / 未登录没补上的,还欠着:下一次名单变化带上,全量那一轮之前清空。 */
	const pending = new Set<string>();

	const run = (only?: ReadonlySet<string>): void => {
		if (disposed || shutdown.signal.aborted) return;
		// 全量那一轮(开机、登录恢复)会查所有人:欠账从这一轮重新算。
		if (only === undefined) pending.clear();
		// 这一轮 `syncFollows` 会查的人:局部就是 `only`,全量是此刻名单里的全部(同一个同步读口,两边一致)。
		const queried = only ?? new Set(followTargetIds(deps.subscriptions()));
		void syncFollows({
			api: deps.api,
			subscriptions: deps.subscriptions,
			...(only === undefined ? {} : { only }),
			problems: deps.problems,
			logger: deps.logger,
			signal: shutdown.signal,
		})
			.then((result) => {
				// 这一轮查过的不再欠着;这一轮没处理完的记上。
				for (const externalId of queried) pending.delete(externalId);
				for (const externalId of result.pending) pending.add(externalId);
			})
			.catch((err) => {
				deps.logger.warn(`[follow] 关注同步失败: ${errorMessageOf(err)}`);
			});
	};

	if (wasLoggedIn) run();

	const subscriptionsWatch = deps.onSubscriptionsChanged(() => {
		if (disposed) return;
		const next = new Set(followTargetIds(deps.subscriptions()));
		const added = new Set([...next].filter((externalId) => !targets.has(externalId)));
		for (const externalId of targets) {
			if (!next.has(externalId)) {
				// 离开关注范围的人不再欠着,和清 `follow_failed` 同一处。
				pending.delete(externalId);
				deps.problems.resolveFailure({ externalId, code: "follow_failed" }, { notify: false });
			}
		}
		targets = next;
		// 新进来的 + 上一轮撞风控 / 未登录欠着的(还在名单里的)。
		const owed = [...pending].filter((externalId) => next.has(externalId));
		const toRun = new Set([...added, ...owed]);
		if (wasLoggedIn && toRun.size > 0) run(toRun);
	});

	const authWatch = deps.auth.onChange(() => {
		if (disposed) return;
		const nowLoggedIn = isLoggedIn(deps.auth.state());
		const restored = !wasLoggedIn && nowLoggedIn;
		wasLoggedIn = nowLoggedIn;
		targets = new Set(followTargetIds(deps.subscriptions()));
		if (restored) run();
	});

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			subscriptionsWatch.dispose();
			authWatch.dispose();
			deps.signal.removeEventListener("abort", abort);
			shutdown.abort();
		},
	};
}
