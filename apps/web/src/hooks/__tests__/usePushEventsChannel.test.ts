/**
 * 单元测试 — `handlePushEnvelope` 纯函数(WS `push-events` 4 个子事件分发)。
 *
 * 4 个 event 的契约:
 *   - live-state-changed   → invalidate ["live","listening"](触发 dashboard refetch)
 *   - live-viewers-changed → setQueryData(["live","listening"]) patch 该房间 viewers
 *                            房间不在快照里 → 静默(返回 old,等下次 invalidate)
 *                            data 缺 uid / viewers → silent-drop
 *   - fans-refreshed       → setQueryData(["stats", "followers"]) 整体覆盖;data.entries 非数组 → drop
 *   - history-recorded     → push toast + setQueryData(historyQueryKey(100)) prepend + dedup id + cap
 *   - history-updated      → 同 id 换缓存里那一行 + toast 同 id 换字(不在就不弹);
 *                            成败翻面时日桶的失败数 ±1,缓存里没有旧行则不动
 *
 * `handlePushEnvelope(env, qc, toast)` 完全参数化,无任何外部 React state。
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type DailyHistoryCountView,
	type FansEntry,
	type FansResponse,
	HISTORY_DAILY_QUERY_KEY,
	type HistoryDailyResponse,
	type HistoryEntryView,
	type HistoryResponse,
	historyQueryKey,
	type LiveListenerSnapshot,
	localDayKey,
} from "../../services/dashboard";
import type { WsEnvelope } from "../../services/ws";
import type { PushEventView } from "../../store/notifications";
import { HISTORY_CACHE_CAP, handlePushEnvelope } from "../usePushEventsChannel";
import { eventFrameMaker } from "./ws-frames";

const TS = "2026-05-16T00:00:00.000Z";

/** 服务端发来的一帧合法事件帧:形状按 contract 的事件表写全,缺 `ts` 补上。 */
const env = eventFrameMaker(TS);

/** 故意违反类型的坏帧(`data` 缺格 / 类型不对、事件名不存在),测 hook 的防御。 */
const malformed = (frame: object) => ({ ts: TS, ...frame }) as WsEnvelope;

function harness() {
	const qc = new QueryClient();
	const invalidate = vi.fn(qc.invalidateQueries.bind(qc));
	qc.invalidateQueries = invalidate;
	const push = vi.fn<(view: PushEventView) => void>();
	const replace = vi.fn<(view: PushEventView) => void>();
	return { qc, push, replace, toast: { push, replace }, invalidate };
}
type Harness = ReturnType<typeof harness>;

function pushView(id: string, over: Partial<PushEventView> = {}): PushEventView {
	return {
		id,
		pushId: id,
		createdAt: "2026-05-16T10:00:00.000Z",
		feature: "post",
		status: "delivered",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: "sub1",
		targetId: "t1",
		messages: [{ text: "x", kind: "text", role: "main", ok: true }],
		...over,
	};
}

const zeroCounts = (): DailyHistoryCountView["counts"] => ({
	post: 0,
	liveStart: 0,
	liveStreaming: 0,
	liveEnd: 0,
	superchat: 0,
	membership: 0,
	specialDanmaku: 0,
	specialUserEnter: 0,
});

describe("handlePushEnvelope — push-events 子事件分发", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it("非 push-events 频道:不 push,不动 qc", () => {
		handlePushEnvelope(env({ type: "state", event: "hydrate", data: null }), h.qc, h.toast);
		expect(h.push).not.toHaveBeenCalled();
		expect(h.invalidate).not.toHaveBeenCalled();
	});

	describe("live-state-changed", () => {
		it("invalidate ['live','listening']", () => {
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "live-state-changed",
					data: { uid: "u1", status: "live", at: "2026-05-16T09:00:00.000Z" },
				}),
				h.qc,
				h.toast,
			);
			expect(h.invalidate).toHaveBeenCalledTimes(1);
			expect(h.invalidate.mock.calls[0][0]).toEqual({ queryKey: ["live", "listening"] });
			expect(h.push).not.toHaveBeenCalled();
		});
	});

	describe("extension-live-changed", () => {
		// 拓展订阅的在播表变了(ADR-0019 决策 12 / 57):服务端合并过、不带载荷,面板整份重取。
		it("invalidate ['live','listening']", () => {
			handlePushEnvelope(
				env({ type: "push-events", event: "extension-live-changed", data: null }),
				h.qc,
				h.toast,
			);
			expect(h.invalidate).toHaveBeenCalledTimes(1);
			expect(h.invalidate.mock.calls[0][0]).toEqual({ queryKey: ["live", "listening"] });
			expect(h.push).not.toHaveBeenCalled();
		});
	});

	describe("live-viewers-changed", () => {
		it("房间在快照里:patch 该 uid 的 viewers,其他不动", () => {
			const initial: LiveListenerSnapshot[] = [
				{ subscriptionId: "s-u1", uid: "u1", roomId: "r1", isLive: true, viewers: 10_000 },
				{ subscriptionId: "s-u2", uid: "u2", roomId: "r2", isLive: true, viewers: 200 },
			];
			h.qc.setQueryData(["live", "listening"], initial);
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "live-viewers-changed",
					data: { uid: "u1", viewers: 12_345 },
				}),
				h.qc,
				h.toast,
			);
			const next = h.qc.getQueryData<LiveListenerSnapshot[]>(["live", "listening"]);
			expect(next?.find((r) => r.uid === "u1")?.viewers).toBe(12_345);
			expect(next?.find((r) => r.uid === "u2")?.viewers).toBe(200);
		});

		it("房间不在快照里:返回 old 原样不动(后续 invalidate 会补)", () => {
			const initial: LiveListenerSnapshot[] = [
				{ subscriptionId: "s-u1", uid: "u1", roomId: "r1", isLive: true, viewers: 10_000 },
			];
			h.qc.setQueryData(["live", "listening"], initial);
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "live-viewers-changed",
					data: { uid: "uX", viewers: 999 },
				}),
				h.qc,
				h.toast,
			);
			const next = h.qc.getQueryData<LiveListenerSnapshot[]>(["live", "listening"]);
			expect(next).toBe(initial);
		});

		it("快照不存在(undefined):返回 undefined 不创建新数组", () => {
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "live-viewers-changed",
					data: { uid: "u1", viewers: 999 },
				}),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData(["live", "listening"])).toBeUndefined();
		});

		/**
		 * ㉒d:总线与 WS 上的 viewers 是精确数。旧形状(排好的字符串)与不是有限的数(NaN)当没收到,不动 qc ——
		 * 别把面板那一列写成「1.2万」字符串混进数字、或「NaN」。
		 * 验红:去掉守卫里的 `Number.isFinite`,NaN 那条红(字符串那几条也会红,除非 `typeof viewers !== "number"` 还在 ——
		 * 两道判断各挡一半,`typeof` 同时给 TS 收窄成 number)。
		 */
		it("viewers 不是数(旧形状的字符串 / NaN):silent-drop,不动 qc", () => {
			const initial: LiveListenerSnapshot[] = [
				{ subscriptionId: "s-u1", uid: "u1", roomId: "r1", isLive: true, viewers: 10_000 },
			];
			h.qc.setQueryData(["live", "listening"], initial);
			for (const viewers of ["1.2万", "999", Number.NaN]) {
				handlePushEnvelope(
					malformed({
						type: "push-events",
						event: "live-viewers-changed",
						data: { uid: "u1", viewers },
					}),
					h.qc,
					h.toast,
				);
			}
			expect(h.qc.getQueryData(["live", "listening"])).toBe(initial);
		});

		it("缺 uid / viewers:silent-drop,不动 qc", () => {
			const initial: LiveListenerSnapshot[] = [
				{ subscriptionId: "s-u1", uid: "u1", roomId: "r1", isLive: true, viewers: 10_000 },
			];
			h.qc.setQueryData(["live", "listening"], initial);
			handlePushEnvelope(
				malformed({ type: "push-events", event: "live-viewers-changed", data: { uid: "u1" } }),
				h.qc,
				h.toast,
			);
			handlePushEnvelope(
				malformed({ type: "push-events", event: "live-viewers-changed", data: null }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData(["live", "listening"])).toBe(initial);
		});
	});

	describe("fans-refreshed", () => {
		it("data.entries 是数组:整体覆盖 ['stats', 'followers']", () => {
			const entries: FansEntry[] = [
				{
					subscriptionId: "s1",
					uid: "u1",
					current: 100,
					ts: "t",
					deltaSubscribed: 10,
					delta24h: 5,
					delta7d: 20,
				},
			];
			handlePushEnvelope(
				env({ type: "push-events", event: "fans-refreshed", data: { entries } }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<FansResponse>(["stats", "followers"])).toEqual({ entries });
		});

		it("data.entries 非数组:silent-drop", () => {
			h.qc.setQueryData<FansResponse>(["stats", "followers"], { entries: [] });
			handlePushEnvelope(
				malformed({
					type: "push-events",
					event: "fans-refreshed",
					data: { entries: { not: "array" } },
				}),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<FansResponse>(["stats", "followers"])).toEqual({ entries: [] });
		});

		it("空数组:覆盖为空(表达「全部 enabled subs 已被删除」)", () => {
			h.qc.setQueryData<FansResponse>(["stats", "followers"], {
				entries: [
					{
						subscriptionId: "s1",
						uid: "u1",
						current: 1,
						ts: "t",
						deltaSubscribed: 0,
						delta24h: 0,
						delta7d: 0,
					},
				],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "fans-refreshed", data: { entries: [] } }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<FansResponse>(["stats", "followers"])).toEqual({ entries: [] });
		});
	});

	describe("history-recorded", () => {
		it("合法 entry:push toast + prepend ['history']", () => {
			const view = pushView("h1");
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			expect(h.push).toHaveBeenCalledWith(view);
			// HI1:Dashboard(100)与 History 页(200)两份 limit-scoped 缓存都被
			// patch(且键不存在也 prime),否则拆键后任一页丢失 WS 实时更新。
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(100))).toEqual({ entries: [view] });
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(200))).toEqual({ entries: [view] });
		});

		it("缺 id / data:silent-drop", () => {
			handlePushEnvelope(
				malformed({ type: "push-events", event: "history-recorded", data: undefined }),
				h.qc,
				h.toast,
			);
			handlePushEnvelope(
				malformed({ type: "push-events", event: "history-recorded", data: { ts: "t" } }),
				h.qc,
				h.toast,
			);
			expect(h.push).not.toHaveBeenCalled();
			expect(h.qc.getQueryData(historyQueryKey(100))).toBeUndefined();
		});

		it("重复 id:dedup(保留最新一份在顶部)", () => {
			const v1 = pushView("h1");
			const v1Repeat = pushView("h1", {
				messages: [{ text: "updated", kind: "text", role: "main", ok: true }],
			});
			const v2 = pushView("h2");
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: v1 }),
				h.qc,
				h.toast,
			);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: v2 }),
				h.qc,
				h.toast,
			);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: v1Repeat }),
				h.qc,
				h.toast,
			);
			const cache = h.qc.getQueryData<HistoryResponse>(historyQueryKey(100));
			expect(cache?.entries).toHaveLength(2);
			expect(cache?.entries[0]).toEqual(v1Repeat); // 最新顶部
			expect(cache?.entries[1]).toEqual(v2);
		});

		it("超过 HISTORY_CACHE_CAP:截尾保留最近 N 条", () => {
			// 先塞满 cap 条历史
			const seed: HistoryEntryView[] = Array.from({ length: HISTORY_CACHE_CAP }, (_, i) => ({
				...pushView(`seed-${i}`),
			}));
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: seed });
			const incoming = pushView("incoming-1");
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: incoming }),
				h.qc,
				h.toast,
			);
			const cache = h.qc.getQueryData<HistoryResponse>(historyQueryKey(100));
			expect(cache?.entries).toHaveLength(HISTORY_CACHE_CAP);
			expect(cache?.entries[0]).toEqual(incoming);
			// 末尾的最老 entry 被截掉(seed-${cap-1})
			expect(cache?.entries.at(-1)).toEqual(seed[HISTORY_CACHE_CAP - 2]);
		});
	});

	describe("history-updated → 同 id 换行、换字,不重弹", () => {
		it("缓存里有这一行 → 原地换成新的一行,位置不动;toast 走 replace 不走 push", () => {
			const v1 = pushView("h1");
			const v2 = pushView("h2");
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [v2, v1] });
			const updated = pushView("h1", {
				status: "partial",
				messages: [
					{ text: "x", kind: "text", role: "main", ok: true },
					{
						text: "词云",
						kind: "text",
						role: "extra",
						ok: false,
						code: "unknown",
						message: "boom",
					},
				],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "history-updated", data: updated }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(100))?.entries).toEqual([
				v2,
				updated,
			]);
			expect(h.replace).toHaveBeenCalledWith(updated);
			expect(h.push).not.toHaveBeenCalled();
		});

		it("缓存里没这一行(比自己老) → 不塞进去;日桶不动", () => {
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [pushView("h2")] });
			const daily: HistoryDailyResponse = {
				days: [{ d: localDayKey(new Date()), counts: zeroCounts(), total: 1, failures: 0 }],
			};
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, daily);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-updated", data: pushView("h1") }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(100))?.entries).toHaveLength(1);
			expect(h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)).toBe(daily);
			expect(h.invalidate).not.toHaveBeenCalled();
		});

		// 卡片先落地(已送达 → 日桶 failures+0),随后 @全体 失败把整行翻成部分失败。
		// 服务端的按日聚合数的是整行的最终状态,前端只在建行时 +1 就会一直少一条,
		// Dashboard 的「今日失败」在页面开着的时候永远是错的。
		it("已送达翻成部分失败 → 今日失败 +1,行数与分类计数不动", () => {
			const v1 = pushView("h1", { status: "delivered" });
			const today = localDayKey(new Date(v1.createdAt));
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [v1] });
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, {
				days: [{ d: today, counts: { ...zeroCounts(), post: 4 }, total: 4, failures: 1 }],
			});
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "history-updated",
					data: pushView("h1", { status: "partial" }),
				}),
				h.qc,
				h.toast,
			);
			expect(
				h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)?.days[0],
			).toMatchObject({ total: 4, failures: 2, counts: { post: 4 } });
		});

		it("翻回已送达 → 今日失败 -1;成败没翻面则日桶一动不动", () => {
			const today = localDayKey(new Date(pushView("h1").createdAt));
			const daily: HistoryDailyResponse = {
				days: [{ d: today, counts: zeroCounts(), total: 4, failures: 2 }],
			};
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), {
				entries: [pushView("h1", { status: "failed" })],
			});
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, daily);
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "history-updated",
					data: pushView("h1", { status: "delivered" }),
				}),
				h.qc,
				h.toast,
			);
			expect(
				h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)?.days[0],
			).toMatchObject({ failures: 1 });

			// 已经是「部分失败」的行再追加一条失败的附加项:还是失败,别再 +1。
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), {
				entries: [pushView("h1", { status: "partial" })],
			});
			const before = h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY);
			handlePushEnvelope(
				env({
					type: "push-events",
					event: "history-updated",
					data: pushView("h1", { status: "partial" }),
				}),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)).toBe(before);
		});
	});

	/**
	 * 被静音 / 免扰挡下的行(`silenced`):进列表(历史页照列),**不弹小卡**,不进今日推送;之后补发成功
	 * (`history-updated` 把它翻成已送达 / 失败)才计入它建行那天 —— 与服务端按日聚合重拉出来的数一致。
	 */
	/**
	 * 被过滤的作品留的那一行(`filtered`):目标那一格也是空的,可它**不是**无目标行 —— 进列表(历史页照列),
	 * 不弹任何小卡(无目标行弹的那张带「去配置」,对它是错话),不进今日推送。
	 */
	describe("被过滤的行", () => {
		const filtered = () =>
			pushView("f1", {
				status: "filtered",
				filteredBy: "blocked-keyword",
				targetId: null,
				messages: [{ text: "摘要\nhttps://example.com/p", kind: "text", role: "main" }],
			});

		it("新落的一行:进列表,不弹小卡,日桶不动", () => {
			const view = filtered();
			const day = localDayKey(new Date(view.createdAt));
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, {
				days: [{ d: day, counts: { ...zeroCounts(), post: 2 }, total: 3, failures: 1 }],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			expect(h.push).not.toHaveBeenCalled();
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(200))?.entries).toEqual([view]);
			expect(
				h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)?.days[0],
			).toMatchObject({ total: 3, failures: 1, counts: { post: 2 } });
		});

		// 对照:真的无目标行照旧弹小卡(那张卡上有「去配置」)。两种空目标的行靠状态分开。
		it("无目标行照旧弹小卡", () => {
			const view = pushView("n1", { status: "no-targets", targetId: null });
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			expect(h.push).toHaveBeenCalledTimes(1);
		});
	});

	describe("被静音 / 免扰挡下的行", () => {
		const dayOf = (view: PushEventView) => localDayKey(new Date(view.createdAt));
		const silenced = (over: Partial<PushEventView> = {}) =>
			pushView("h1", {
				status: "silenced",
				feature: "liveEnd",
				messages: [{ text: "下播了", kind: "text", role: "main", isSilenced: true }],
				...over,
			});
		const seedDaily = (view: PushEventView) =>
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, {
				days: [{ d: dayOf(view), counts: { ...zeroCounts(), liveEnd: 2 }, total: 3, failures: 1 }],
			});
		const today = () => h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)?.days[0];
		const update = (view: PushEventView) =>
			handlePushEnvelope(
				env({ type: "push-events", event: "history-updated", data: view }),
				h.qc,
				h.toast,
			);

		it("新落的一行:进列表,不弹小卡,日桶不动", () => {
			const view = silenced();
			seedDaily(view);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			expect(h.push).not.toHaveBeenCalled();
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(200))?.entries).toEqual([view]);
			expect(today()).toMatchObject({ total: 3, failures: 1, counts: { liveEnd: 2 } });
		});

		it("追加附加项后仍是被挡的:日桶不动", () => {
			const view = silenced();
			seedDaily(view);
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [view] });
			update(silenced());
			expect(today()).toMatchObject({ total: 3, failures: 1, counts: { liveEnd: 2 } });
		});

		it("补发成功(翻成已送达)→ 今日推送与分类计数 +1,失败不动", () => {
			const view = silenced();
			seedDaily(view);
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [view] });
			update(silenced({ status: "delivered" }));
			expect(today()).toMatchObject({ total: 4, failures: 1, counts: { liveEnd: 3 } });
		});

		it("补发失败(翻成失败 / 部分失败)→ 今日推送 +1,今日失败也 +1", () => {
			for (const status of ["failed", "partial"] as const) {
				const view = silenced();
				seedDaily(view);
				h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [view] });
				update(silenced({ status }));
				expect(today(), status).toMatchObject({ total: 4, failures: 2, counts: { liveEnd: 3 } });
			}
		});

		// 一趟补发会连着来好几帧:先把本体补到(已送达),再有附加项补失败(部分失败),最后补齐。
		it("一趟补发的几帧连着来:总数只加一次,失败数跟着最终状态走", () => {
			const view = silenced();
			seedDaily(view);
			h.qc.setQueryData<HistoryResponse>(historyQueryKey(100), { entries: [view] });
			update(silenced({ status: "delivered" }));
			update(silenced({ status: "partial" }));
			expect(today()).toMatchObject({ total: 4, failures: 2, counts: { liveEnd: 3 } });
			update(silenced({ status: "delivered" }));
			expect(today()).toMatchObject({ total: 4, failures: 1, counts: { liveEnd: 3 } });
		});

		it("缓存里没有旧的那一行(不知道它原先算不算)→ 日桶不动,等下次重拉", () => {
			const view = silenced();
			seedDaily(view);
			update(silenced({ status: "delivered" }));
			expect(today()).toMatchObject({ total: 3, failures: 1 });
		});
	});

	describe("history-recorded → 按日聚合缓存(趋势图/今日 KPI)", () => {
		const dayOf = (view: PushEventView) => localDayKey(new Date(view.createdAt));

		it("无目标行:进列表、弹卡,但日桶不 +1(没推到任何地方)", () => {
			const view = pushView("h1", { status: "no-targets", targetId: null });
			const today = dayOf(view);
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, {
				days: [{ d: today, counts: zeroCounts(), total: 3, failures: 1 }],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			expect(h.push).toHaveBeenCalledWith(view);
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(100))?.entries).toEqual([view]);
			expect(
				h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)?.days[0],
			).toMatchObject({ total: 3, failures: 1 });
		});

		it("部分失败也算一次失败", () => {
			const view = pushView("h1", { status: "partial", feature: "liveEnd" });
			const today = dayOf(view);
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, {
				days: [{ d: today, counts: zeroCounts(), total: 0, failures: 0 }],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			const day = h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)?.days[0];
			expect(day).toMatchObject({ total: 1, failures: 1 });
			expect(day?.counts.liveEnd).toBe(1);
		});

		it("entry 所属本地日在缓存窗口里:feature/total/failures 就地 +1,零 HTTP", () => {
			const view = pushView("h1", { status: "failed" });
			const today = dayOf(view);
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, {
				days: [
					{ d: "1999-12-31", counts: zeroCounts(), total: 0, failures: 0 },
					{ d: today, counts: { ...zeroCounts(), post: 2 }, total: 3, failures: 1 },
				],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.toast,
			);
			const cache = h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY);
			expect(cache?.days[1]).toMatchObject({ total: 4, failures: 2 });
			expect(cache?.days[1]?.counts.post).toBe(3);
			expect(cache?.days[0]).toMatchObject({ total: 0 }); // 其他日不动
			expect(h.invalidate).not.toHaveBeenCalled();
		});

		it("本地日不在窗口(跨零点):不改缓存,invalidate 整键重拉", () => {
			const stale: HistoryDailyResponse = {
				days: [{ d: "1999-12-31", counts: zeroCounts(), total: 0, failures: 0 }],
			};
			h.qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, stale);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: pushView("h1") }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY)).toBe(stale);
			expect(h.invalidate).toHaveBeenCalledTimes(1);
			expect(h.invalidate.mock.calls[0][0]).toEqual({ queryKey: HISTORY_DAILY_QUERY_KEY });
		});

		it("缓存不存在(Dashboard 未拉过):不 prime,不 invalidate", () => {
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: pushView("h1") }),
				h.qc,
				h.toast,
			);
			expect(h.qc.getQueryData(HISTORY_DAILY_QUERY_KEY)).toBeUndefined();
			expect(h.invalidate).not.toHaveBeenCalled();
		});
	});

	it("不识别的 event:不 push,不动 qc", () => {
		handlePushEnvelope(malformed({ type: "push-events", event: "subscribed" }), h.qc, h.toast);
		expect(h.push).not.toHaveBeenCalled();
		expect(h.invalidate).not.toHaveBeenCalled();
	});
});
