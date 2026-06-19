/**
 * 单元测试 — `handlePushEnvelope` 纯函数(WS `push-events` 4 个子事件分发)。
 *
 * 4 个 event 的契约:
 *   - live-state-changed   → invalidate ["live","listening"](触发 dashboard refetch)
 *   - live-viewers-changed → setQueryData(["live","listening"]) patch 该房间 viewers
 *                            房间不在快照里 → 静默(返回 old,等下次 invalidate)
 *                            tuple shape 不对 → silent-drop
 *   - fans-refreshed       → setQueryData(["fans"]) 整体覆盖;data 非数组 → drop
 *   - history-recorded     → push toast + setQueryData(historyQueryKey(100)) prepend + dedup id + cap
 *
 * `handlePushEnvelope(env, qc, push)` 完全参数化,无任何外部 React state。
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type FansEntry,
	type FansResponse,
	type HistoryEntryView,
	type HistoryResponse,
	historyQueryKey,
	type LiveListenerSnapshot,
} from "../../services/dashboard";
import type { WsEnvelope } from "../../services/ws";
import type { PushEventView } from "../../store/notifications";
import { HISTORY_CACHE_CAP, handlePushEnvelope } from "../usePushEventsChannel";

function env(over: Partial<WsEnvelope> & { type: string }): WsEnvelope {
	return { ts: "2026-05-16T00:00:00.000Z", ...over };
}

function harness() {
	const qc = new QueryClient();
	const invalidate = vi.fn(qc.invalidateQueries.bind(qc));
	qc.invalidateQueries = invalidate;
	const push = vi.fn<(view: PushEventView) => void>();
	return { qc, push, invalidate };
}
type Harness = ReturnType<typeof harness>;

function pushView(id: string): PushEventView {
	return {
		id,
		ts: "2026-05-16T10:00:00.000Z",
		source: "dynamic",
		uid: "u1",
		subscriptionId: "sub1",
		targetIds: ["t1"],
		ok: true,
		text: "x",
	};
}

describe("handlePushEnvelope — push-events 4 子事件分发", () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it("非 push-events 频道:不 push,不动 qc", () => {
		handlePushEnvelope(env({ type: "state", event: "hydrate" }), h.qc, h.push);
		expect(h.push).not.toHaveBeenCalled();
		expect(h.invalidate).not.toHaveBeenCalled();
	});

	describe("live-state-changed", () => {
		it("invalidate ['live','listening']", () => {
			handlePushEnvelope(env({ type: "push-events", event: "live-state-changed" }), h.qc, h.push);
			expect(h.invalidate).toHaveBeenCalledTimes(1);
			expect(h.invalidate.mock.calls[0][0]).toEqual({ queryKey: ["live", "listening"] });
			expect(h.push).not.toHaveBeenCalled();
		});
	});

	describe("live-viewers-changed", () => {
		it("房间在快照里:patch 该 uid 的 viewers,其他不动", () => {
			const initial: LiveListenerSnapshot[] = [
				{ uid: "u1", roomId: "r1", viewers: "1.0万" },
				{ uid: "u2", roomId: "r2", viewers: "200" },
			];
			h.qc.setQueryData(["live", "listening"], initial);
			handlePushEnvelope(
				env({ type: "push-events", event: "live-viewers-changed", data: ["u1", "1.2万"] }),
				h.qc,
				h.push,
			);
			const next = h.qc.getQueryData<LiveListenerSnapshot[]>(["live", "listening"]);
			expect(next?.find((r) => r.uid === "u1")?.viewers).toBe("1.2万");
			expect(next?.find((r) => r.uid === "u2")?.viewers).toBe("200");
		});

		it("房间不在快照里:返回 old 原样不动(后续 invalidate 会补)", () => {
			const initial: LiveListenerSnapshot[] = [{ uid: "u1", roomId: "r1", viewers: "1.0万" }];
			h.qc.setQueryData(["live", "listening"], initial);
			handlePushEnvelope(
				env({ type: "push-events", event: "live-viewers-changed", data: ["uX", "999"] }),
				h.qc,
				h.push,
			);
			const next = h.qc.getQueryData<LiveListenerSnapshot[]>(["live", "listening"]);
			expect(next).toBe(initial);
		});

		it("快照不存在(undefined):返回 undefined 不创建新数组", () => {
			handlePushEnvelope(
				env({ type: "push-events", event: "live-viewers-changed", data: ["u1", "999"] }),
				h.qc,
				h.push,
			);
			expect(h.qc.getQueryData(["live", "listening"])).toBeUndefined();
		});

		it("tuple shape 不对:silent-drop,不动 qc", () => {
			const initial: LiveListenerSnapshot[] = [{ uid: "u1", roomId: "r1", viewers: "1万" }];
			h.qc.setQueryData(["live", "listening"], initial);
			handlePushEnvelope(
				env({ type: "push-events", event: "live-viewers-changed", data: ["u1"] }),
				h.qc,
				h.push,
			);
			handlePushEnvelope(
				env({ type: "push-events", event: "live-viewers-changed", data: null }),
				h.qc,
				h.push,
			);
			expect(h.qc.getQueryData(["live", "listening"])).toBe(initial);
		});
	});

	describe("fans-refreshed", () => {
		it("data 是数组:整体覆盖 ['fans']", () => {
			const entries: FansEntry[] = [
				{ uid: "u1", current: 100, ts: "t", deltaSubscribed: 10, delta24h: 5, delta7d: 20 },
			];
			handlePushEnvelope(
				env({ type: "push-events", event: "fans-refreshed", data: entries }),
				h.qc,
				h.push,
			);
			expect(h.qc.getQueryData<FansResponse>(["fans"])).toEqual({ entries });
		});

		it("data 非数组:silent-drop", () => {
			h.qc.setQueryData<FansResponse>(["fans"], { entries: [] });
			handlePushEnvelope(
				env({ type: "push-events", event: "fans-refreshed", data: { not: "array" } }),
				h.qc,
				h.push,
			);
			expect(h.qc.getQueryData<FansResponse>(["fans"])).toEqual({ entries: [] });
		});

		it("空数组:覆盖为空(表达「全部 enabled subs 已被删除」)", () => {
			h.qc.setQueryData<FansResponse>(["fans"], {
				entries: [{ uid: "u1", current: 1, ts: "t", deltaSubscribed: 0, delta24h: 0, delta7d: 0 }],
			});
			handlePushEnvelope(
				env({ type: "push-events", event: "fans-refreshed", data: [] }),
				h.qc,
				h.push,
			);
			expect(h.qc.getQueryData<FansResponse>(["fans"])).toEqual({ entries: [] });
		});
	});

	describe("history-recorded", () => {
		it("合法 entry:push toast + prepend ['history']", () => {
			const view = pushView("h1");
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: view }),
				h.qc,
				h.push,
			);
			expect(h.push).toHaveBeenCalledWith(view);
			// HI1:Dashboard(100)与 History 页(200)两份 limit-scoped 缓存都被
			// patch(且键不存在也 prime),否则拆键后任一页丢失 WS 实时更新。
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(100))).toEqual({ entries: [view] });
			expect(h.qc.getQueryData<HistoryResponse>(historyQueryKey(200))).toEqual({ entries: [view] });
		});

		it("缺 id / data:silent-drop", () => {
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: undefined }),
				h.qc,
				h.push,
			);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: { ts: "t" } }),
				h.qc,
				h.push,
			);
			expect(h.push).not.toHaveBeenCalled();
			expect(h.qc.getQueryData(historyQueryKey(100))).toBeUndefined();
		});

		it("重复 id:dedup(保留最新一份在顶部)", () => {
			const v1 = pushView("h1");
			const v1Repeat = { ...pushView("h1"), text: "updated" };
			const v2 = pushView("h2");
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: v1 }),
				h.qc,
				h.push,
			);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: v2 }),
				h.qc,
				h.push,
			);
			handlePushEnvelope(
				env({ type: "push-events", event: "history-recorded", data: v1Repeat }),
				h.qc,
				h.push,
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
				h.push,
			);
			const cache = h.qc.getQueryData<HistoryResponse>(historyQueryKey(100));
			expect(cache?.entries).toHaveLength(HISTORY_CACHE_CAP);
			expect(cache?.entries[0]).toEqual(incoming);
			// 末尾的最老 entry 被截掉(seed-${cap-1})
			expect(cache?.entries.at(-1)).toEqual(seed[HISTORY_CACHE_CAP - 2]);
		});
	});

	it("不识别的 event:不 push,不动 qc", () => {
		handlePushEnvelope(env({ type: "push-events", event: "subscribed" }), h.qc, h.push);
		expect(h.push).not.toHaveBeenCalled();
		expect(h.invalidate).not.toHaveBeenCalled();
	});
});
