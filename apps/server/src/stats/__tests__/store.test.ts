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
 *   - drop:两类文件一并删;缺文件时静默
 *   - 盘上的行是中立的(ADR-0020 决策 16):作品 `{id, kind, ts}`、下播帧的 `peak` 是数字
 *   - 文件按订阅 id 命名,两支一样(`statsFileKey`);老的 B 站 `<uid>.jsonl` 由开机迁移改名,
 *     见 migrate-file-keys.test.ts
 *
 * 老 B 站行(`type` 串 / 字符串峰值)的读法见 legacy-rows.test.ts。
 */

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { statsFileKey } from "../file-key.js";
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
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		await store.appendDynamic("1", { id: "b", kind: "post", ts: T(3) });
		expect(await store.listDynamics("1", T(0))).toEqual([
			{ id: "a", kind: "video", ts: T(1) },
			{ id: "b", kind: "post", ts: T(3) },
		]);
	});

	it("since 之前的事件被过滤掉", async () => {
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		await store.appendDynamic("1", { id: "b", kind: "post", ts: T(5) });
		const got = await store.listDynamics("1", T(3));
		expect(got.map((e) => e.id)).toEqual(["b"]);
	});

	it("同 id 重复 append → 只保留一条(引擎重放不该虚增投稿数)", async () => {
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		expect(await store.listDynamics("1", T(0))).toHaveLength(1);
	});

	it("坏行 / 空行跳过,不影响其余", async () => {
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		await writeFile(join(dataDir, "stats", "dyn", "1.jsonl"), '{"bad\n\n{"id":"c"}\n', {
			flag: "a",
		});
		await store.appendDynamic("1", { id: "d", kind: "post", ts: T(4) });
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
		await store.closeLiveSession("1", T(4), 12_000);
		expect(await store.listLiveSessions("1", T(0))).toEqual([
			{ startedAt: T(1), endedAt: T(4), peakViewers: 12_000 },
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

	it("跨窗口起始但仍在播的那场留得住 —— 它正是徽章指的那一场", async () => {
		// 30 小时的挂机直播,用户选「近 1 日」。单按 startedAt 滤会把它整场滤掉,
		// 而 hasCoverage 仍为真 → 同一行里「直播中」徽章亮着、旁边写「场次 0 /
		// 时长 0.0h」,AI 锐评也被告知这位 UP 一场没播。窗口之前的那段时长由
		// aggregate 的 sinceMs 夹掉,不会记到本窗口头上。
		await store.openLiveSession("1", T(1));
		expect(await store.listLiveSessions("1", T(5))).toEqual([{ startedAt: T(1), current: true }]);
	});

	it("跨窗口起始且**已闭合**的那场照旧滤掉 —— 只有在播的才破例", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(2));
		expect(await store.listLiveSessions("1", T(5))).toEqual([]);
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
		await store.closeLiveSession("1", T(4), 9999);
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

describe("StatsStore — drop", () => {
	it("删掉该 uid 的动态与直播两类文件", async () => {
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		await store.openLiveSession("1", T(1));
		await store.drop("1");
		expect(await store.listDynamics("1", T(0))).toEqual([]);
		expect(await store.listLiveSessions("1", T(0))).toEqual([]);
	});

	it("缺文件时静默,不抛也不 warn", async () => {
		await expect(store.drop("404")).resolves.toBeUndefined();
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
		await store.closeLiveSession("1", T(11), 751);
		await store.openLiveSession("1", T(9));
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(9), endedAt: T(11), peakViewers: 751, current: true }]);
	});

	it("关服写了 end,重启后同一场接续 → 下播时间取最后一次观测到的", async () => {
		await store.openLiveSession("1", T(9));
		await store.closeLiveSession("1", T(10)); // 关服,截断在这里
		await store.openLiveSession("1", T(9)); // 重启,还是这一场
		await store.closeLiveSession("1", T(13), 12_000); // 真正下播
		const got = await store.listLiveSessions("1", T(0));
		expect(got).toEqual([{ startedAt: T(9), endedAt: T(13), peakViewers: 12_000 }]);
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

describe("StatsStore — 盘上的行是中立的", () => {
	it("作品行只写 {id, kind, ts},不带任何平台类型", async () => {
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		await store.appendDynamic("1", { id: "b", kind: "post", ts: T(2) });
		const raw = await readFile(join(dataDir, "stats", "dyn", "1.jsonl"), "utf-8");
		expect(raw).toBe(
			`${JSON.stringify({ id: "a", kind: "video", ts: T(1) })}\n${JSON.stringify({ id: "b", kind: "post", ts: T(2) })}\n`,
		);
	});

	it("下播帧的 peak 存数字,不存压缩好的字符串", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(3), 12_000);
		const raw = await readFile(join(dataDir, "stats", "live", "1.jsonl"), "utf-8");
		expect(raw).toBe(
			`${JSON.stringify({ k: "start", ts: T(1) })}\n${JSON.stringify({ k: "end", ts: T(3), peak: 12_000 })}\n`,
		);
	});

	it("没有峰值 / 峰值不是有限数 → end 帧不带 peak(不落一个 null 进盘)", async () => {
		await store.openLiveSession("1", T(1));
		await store.closeLiveSession("1", T(2));
		await store.closeLiveSession("1", T(3), Number.NaN);
		const lines = (await readFile(join(dataDir, "stats", "live", "1.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.slice(1)).toEqual([
			{ k: "end", ts: T(2) },
			{ k: "end", ts: T(3) },
		]);
	});

	it("开播公告记成 live,原样读回", async () => {
		await store.appendDynamic("1", { id: "l", kind: "live", ts: T(1) });
		expect(await store.listDynamics("1", T(0))).toEqual([{ id: "l", kind: "live", ts: T(1) }]);
	});

	it("种类不认识的新行跳过,不猜", async () => {
		await mkdir(join(dataDir, "stats", "dyn"), { recursive: true });
		await writeFile(
			join(dataDir, "stats", "dyn", "1.jsonl"),
			`${JSON.stringify({ id: "a", kind: "reel", ts: T(1) })}\n`,
		);
		expect(await store.listDynamics("1", T(0))).toEqual([]);
	});
});

describe("StatsStore — 文件按订阅 id 命名(ADR-0020 决策 2 的 🔗 / 16)", () => {
	const BILI_SUB = {
		kind: "bilibili",
		id: "0b1c2d3e-0000-4000-8000-000000000001",
		uid: "12345",
	} as const;
	const EXT_SUB = { kind: "extension", id: "3f2c1a9e-8b7d-4c6e-9a1f-0b2c3d4e5f60" } as const;

	it("statsFileKey:两支都是订阅 id —— B 站不再用 uid,拓展不再加 ext- 前缀", () => {
		expect(statsFileKey(BILI_SUB)).toBe(BILI_SUB.id);
		expect(statsFileKey(EXT_SUB)).toBe(EXT_SUB.id);
	});

	it("订阅 id 那一格就是文件名,两类文件落在同一套目录里", async () => {
		const key = statsFileKey(BILI_SUB);
		await store.appendDynamic(key, { id: "w1", kind: "video", ts: T(1) });
		await store.openLiveSession(key, T(2));
		await store.closeLiveSession(key, T(3), 500);
		expect(await readdir(join(dataDir, "stats", "dyn"))).toEqual([`${BILI_SUB.id}.jsonl`]);
		expect(await readdir(join(dataDir, "stats", "live"))).toEqual([`${BILI_SUB.id}.jsonl`]);
		expect(await store.listDynamics(key, T(0))).toEqual([{ id: "w1", kind: "video", ts: T(1) }]);
		expect(await store.listLiveSessions(key, T(0))).toEqual([
			{ startedAt: T(2), endedAt: T(3), peakViewers: 500 },
		]);
	});

	it("drop 只删这条订阅的两类文件,别的订阅的不动", async () => {
		const mine = statsFileKey(EXT_SUB);
		const other = statsFileKey(BILI_SUB);
		await store.appendDynamic(mine, { id: "w1", kind: "video", ts: T(1) });
		await store.openLiveSession(mine, T(2));
		await store.appendDynamic(other, { id: "a", kind: "post", ts: T(1) });
		await store.drop(mine);
		expect(await readdir(join(dataDir, "stats", "dyn"))).toEqual([`${other}.jsonl`]);
		expect(await readdir(join(dataDir, "stats", "live"))).toEqual([]);
	});
});
