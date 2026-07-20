/**
 * 单元测试 — `createStatsStore`(真实 tmpdir FS)。
 *
 * 守护契约:
 *   - appendDynamic:按需建目录 + 追加一行;按 id 幂等(同一动态重放不重复计数)
 *   - listDynamics:只回 ts >= since 的事件;坏行/空行跳过;文件缺失 → []
 *   - 直播场次以 start/end 两种帧 append-only 落盘,读时配对:
 *       · 正常 start→end 配成一场,带 peakViewers
 *       · 未闭合的 start(仍在直播 / 崩溃丢了 end)→ endedAt 为 undefined,不算时长
 *       · 孤立的 end(没有对应 start)→ 丢弃,不产出半场
 *   - dropUid:两类文件一并删;缺文件时静默
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsStore, type StatsStore } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let store: StatsStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-stats-"));
	logger = makeLogger();
	store = createStatsStore({ dataDir, logger });
});
afterEach(() => {
	vi.restoreAllMocks();
});

/** 2026-05-16 的第 h 小时,便于构造有序时间戳。 */
const T = (h: number) => `2026-05-16T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("StatsStore — 动态事件", () => {
	it("append 后可按 since 读回", async () => {
		await store.appendDynamic("1", { id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) });
		await store.appendDynamic("1", { id: "b", type: "DYNAMIC_TYPE_WORD", ts: T(3) });
		expect(await store.listDynamics("1", T(0))).toEqual([
			{ id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) },
			{ id: "b", type: "DYNAMIC_TYPE_WORD", ts: T(3) },
		]);
	});

	it("since 之前的事件被过滤掉", async () => {
		await store.appendDynamic("1", { id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) });
		await store.appendDynamic("1", { id: "b", type: "DYNAMIC_TYPE_WORD", ts: T(5) });
		const got = await store.listDynamics("1", T(3));
		expect(got.map((e) => e.id)).toEqual(["b"]);
	});

	it("同 id 重复 append → 只保留一条(引擎重放不该虚增投稿数)", async () => {
		await store.appendDynamic("1", { id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) });
		await store.appendDynamic("1", { id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) });
		expect(await store.listDynamics("1", T(0))).toHaveLength(1);
	});

	it("坏行 / 空行跳过,不影响其余", async () => {
		await store.appendDynamic("1", { id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) });
		await writeFile(join(dataDir, "stats", "dyn", "1.jsonl"), '{"bad\n\n{"id":"c"}\n', {
			flag: "a",
		});
		await store.appendDynamic("1", { id: "d", type: "DYNAMIC_TYPE_WORD", ts: T(4) });
		const got = await store.listDynamics("1", T(0));
		expect(got.map((e) => e.id)).toEqual(["a", "d"]);
	});

	it("文件缺失 → 空数组,不 warn", async () => {
		expect(await store.listDynamics("404", T(0))).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("StatsStore — 直播场次", () => {
	it("start → end 配成一场,带峰值观看", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(4), "1.2万");
		expect(await store.listLiveSessions("1", T(0))).toEqual([
			{ startedAt: T(1), endedAt: T(4), peakViewers: "1.2万" },
		]);
	});

	it("多场按时间顺序返回", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(2));
		await store.openLiveSession("1", T(5));
		await store.closeLiveSession("1", T(7));
		const got = await store.listLiveSessions("1", T(0));
		expect(got.map((s) => [s.startedAt, s.endedAt])).toEqual([
			[T(1), T(2)],
			[T(5), T(7)],
		]);
	});

	it("未闭合的 start → endedAt 缺失(仍在直播),不伪造下播时间", async () => {
		await store.openLiveSession("1", T(1));
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(1), current: true }]);
	});

	it("连续两个 start → 前一场留作未闭合,不吞掉", async () => {
		await store.openLiveSession("1", T(1));
		await store.openLiveSession("1", T(5));
		await store.closeLiveSession("1", T(6));
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(1) }, { startedAt: T(5), endedAt: T(6) }]);
	});

	it("同一开播时刻被重复 start(直播中重启服务)→ 合成一场,不重复计次", async () => {
		// 重启后 live_time 拿到的还是同一个真实开播时刻,于是又写了一帧 start。
		// 这是同一场直播被重新观测到,不是第二场。
		await store.openLiveSession("1", T(1));
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(6));
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(1), endedAt: T(6) }]);
	});

	it("关服写过 end 后又被重新观测到 → 这一场重新敞开,不冻结在截断点", async () => {
		// 真实帧序:开播 → 关服时 closeOpenSessions 补一帧 end → 重启后 bootstrap
		// 拿到同一个 live_time 再写一帧 start。关服那帧 end 留在记录上(它是事实),
		// 但 `current` 必须置位 —— 曾经这里卡着 `!open.endedAt`,带 endedAt 的场次
		// 认不出还敞着,aggregate 的 inProgress 判定跟着失效,时长永远冻结在关服
		// 那一刻,而这恰恰是「正在直播时看统计页」的常态。
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(3));
		await store.openLiveSession("1", T(1));
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(1), endedAt: T(3), current: true }]);
	});

	it("重新敞开后真下播 → end 覆盖成真实的下播时刻", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(3)); // 关服截断
		await store.openLiveSession("1", T(1)); // 重启后再观测到同一场
		await store.closeLiveSession("1", T(9)); // 真下播
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(1), endedAt: T(9) }]);
	});

	it("孤立的 end(无 start)→ 丢弃,不产出半场", async () => {
		await store.closeLiveSession("1", T(4), "9999");
		expect(await store.listLiveSessions("1", T(0))).toEqual([]);
	});

	it("since 按开播时间过滤", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(2));
		await store.openLiveSession("1", T(8));
		await store.closeLiveSession("1", T(9));
		const got = await store.listLiveSessions("1", T(5));
		expect(got.map((s) => s.startedAt)).toEqual([T(8)]);
	});

	it("文件缺失 → 空数组,不 warn", async () => {
		expect(await store.listLiveSessions("404", T(0))).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("StatsStore — dropUid", () => {
	it("删掉该 uid 的动态与直播两类文件", async () => {
		await store.appendDynamic("1", { id: "a", type: "DYNAMIC_TYPE_AV", ts: T(1) });
		await store.openLiveSession("1", T(1));
		await store.dropUid("1");
		expect(await store.listDynamics("1", T(0))).toEqual([]);
		expect(await store.listLiveSessions("1", T(0))).toEqual([]);
	});

	it("缺文件时静默,不抛也不 warn", async () => {
		await expect(store.dropUid("404")).resolves.toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("StatsStore — 采集水位线", () => {
	it("首次调用落盘「此刻」,之后恒定不动", async () => {
		const s = createStatsStore({ dataDir, logger, now: () => new Date(T(5)) });
		expect(await s.recordingSince()).toBe(T(5));
		// 时钟往前走,水位线不该跟着漂 —— 它记的是「从哪天开始记的」。
		expect(await s.recordingSince()).toBe(T(5));
	});

	it("跨实例(重启)沿用同一条水位线,不被重启刷新", async () => {
		const first = createStatsStore({ dataDir, logger, now: () => new Date(T(5)) });
		await first.recordingSince();
		const restarted = createStatsStore({ dataDir, logger, now: () => new Date(T(9)) });
		expect(await restarted.recordingSince()).toBe(T(5));
	});

	it("水位线文件损坏 → 重新落一个,不抛错也不返回坏值", async () => {
		await mkdir(join(dataDir, "stats"), { recursive: true });
		await writeFile(join(dataDir, "stats", "since"), "不是时间", "utf-8");
		const s = createStatsStore({ dataDir, logger, now: () => new Date(T(7)) });
		expect(await s.recordingSince()).toBe(T(7));
	});
});

describe("StatsStore — 场次身份由 startedAt 决定", () => {
	it("下播后又出现同一开播时刻的 start → 不凭空开第二场", async () => {
		// 真实数据里出现过:一场直播闭合之后,重启又写了一帧同时刻的 start。
		// 旧规则只认「当前敞开的那场」,于是这帧凭空开出了第二场。
		//
		// `current` 会被打上 —— 它只说「最后一次观测时这一场敞着」,并不断言此刻在播。
		// 这一场到底算不算进行中,由 aggregate 拿引擎的 isLive 拍板:UP 早就下播了的话
		// isLive 为假,照旧按 endedAt 计时长。
		await store.openLiveSession("1", T(9));
		await store.closeLiveSession("1", T(11), "751");
		await store.openLiveSession("1", T(9));
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(9), endedAt: T(11), peakViewers: "751", current: true }]);
	});

	it("关服写了 end,重启后同一场接续 → 下播时间取最后一次观测到的", async () => {
		await store.openLiveSession("1", T(9));
		await store.closeLiveSession("1", T(10)); // 关服,截断在这里
		await store.openLiveSession("1", T(9)); // 重启,还是这一场
		await store.closeLiveSession("1", T(13), "1.2万"); // 真正下播
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(9), endedAt: T(13), peakViewers: "1.2万" }]);
	});

	it("不同开播时刻仍是不同场次", async () => {
		await store.openLiveSession("1", T(9));
		await store.closeLiveSession("1", T(10));
		await store.openLiveSession("1", T(12));
		await store.closeLiveSession("1", T(14));
		const got = await store.listLiveSessions("1", T(0));
		expect(got.map((s) => s.startedAt)).toEqual([T(9), T(12)]);
	});
});
