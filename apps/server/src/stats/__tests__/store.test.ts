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
 *   - drop:三类文件(作品 / 直播 / 「在记」)一并删;缺文件时静默
 *   - 「在记」:`{ts}` 逐行追加,按 since 读回(ADR-0020 决策 16)
 *   - 盘上的行是中立的(ADR-0020 决策 16):作品 `{id, kind, ts}`、下播帧的 `peak` 是数字
 *   - 文件按订阅 id 命名,两支一样(`statsFileKey`)
 *   - 盘上已有的行:同 id 不追加、同 id 两行只认先落盘的那条
 *   - 不认老形状:0.x 的老 B 站行(`{id, type, ts}`、字符串峰值)和 `<uid>.jsonl` 文件名由迁移器改写
 *     (`migration/__tests__/zero-generation-stats.test.ts`),这一层读到就当没带、不翻
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
	store = createStatsStore({ dataRoot: dataDir, logger });
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

describe("StatsStore — 「在记」(ADR-0020 决策 9 / 16)", () => {
	it("追加的 {ts} 按落盘顺序读回;since 之前的滤掉,空串读全部(第一条就是开始记录)", async () => {
		await store.appendSeen("s1", T(1));
		await store.appendSeen("s1", T(3));
		await store.appendSeen("s1", T(5));
		expect(await store.listSeenSince("s1", "")).toEqual([{ ts: T(1) }, { ts: T(3) }, { ts: T(5) }]);
		expect(await store.listSeenSince("s1", T(3))).toEqual([{ ts: T(3) }, { ts: T(5) }]);
		expect(await readdir(join(dataDir, "stats", "seen"))).toEqual(["s1.jsonl"]);
		// 逐字节:紧凑 JSON、一行一条、末尾换行。
		expect(await readFile(join(dataDir, "stats", "seen", "s1.jsonl"), "utf-8")).toBe(
			`{"ts":"${T(1)}"}\n{"ts":"${T(3)}"}\n{"ts":"${T(5)}"}\n`,
		);
	});

	it("写不进去只 warn、不抛(键名对上的是个目录)", async () => {
		await mkdir(join(dataDir, "stats", "seen", "s9.jsonl"), { recursive: true });
		await expect(store.appendSeen("s9", T(1))).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(String(logger.warn.mock.calls[0]?.[0])).toContain("[stats-store] append seen s9 failed");
	});

	it("没有文件 → 空;坏行跳过", async () => {
		expect(await store.listSeenSince("404", "")).toEqual([]);
		await mkdir(join(dataDir, "stats", "seen"), { recursive: true });
		await writeFile(
			join(dataDir, "stats", "seen", "s2.jsonl"),
			`{"ts":"${T(1)}"}\nnot json\n{"nope":1}\n\n{"ts":"${T(2)}"}\n`,
		);
		expect(await store.listSeenSince("s2", "")).toEqual([{ ts: T(1) }, { ts: T(2) }]);
	});

	it("drop 连「在记」一起删", async () => {
		await store.appendSeen("s3", T(1));
		await store.drop("s3");
		expect(await store.listSeenSince("s3", "")).toEqual([]);
		expect(await readdir(join(dataDir, "stats", "seen"))).toEqual([]);
	});
});

describe("StatsStore — 采集水位线", () => {
	it("首次调用落盘「此刻」,之后恒定不动", async () => {
		const s = createStatsStore({ dataRoot: dataDir, logger, now: () => new Date(T(5)) });
		expect(await s.recordingSince()).toBe(T(5));
		// 时钟往前走,水位线不该跟着漂 —— 它记的是「从哪天开始记的」。
		expect(await s.recordingSince()).toBe(T(5));
	});

	it("跨实例(重启)沿用同一条水位线,不被重启刷新", async () => {
		const first = createStatsStore({ dataRoot: dataDir, logger, now: () => new Date(T(5)) });
		await first.recordingSince();
		const restarted = createStatsStore({ dataRoot: dataDir, logger, now: () => new Date(T(9)) });
		expect(await restarted.recordingSince()).toBe(T(5));
	});

	it("水位线文件损坏 → 重新落一个,不抛错也不返回坏值", async () => {
		await mkdir(join(dataDir, "stats"), { recursive: true });
		await writeFile(join(dataDir, "stats", "since"), "不是时间", "utf-8");
		const s = createStatsStore({ dataRoot: dataDir, logger, now: () => new Date(T(7)) });
		expect(await s.recordingSince()).toBe(T(7));
	});

	it("盘上就是裸的 ISO 串:不带引号、不带换行(读的一方 trim 后 Date.parse)", async () => {
		const s = createStatsStore({ dataRoot: dataDir, logger, now: () => new Date(T(5)) });
		await s.recordingSince();
		expect(await readFile(join(dataDir, "stats", "since"), "utf-8")).toBe(T(5));
		// 目录里只有三个子目录与它,没有落下临时文件。
		expect((await readdir(join(dataDir, "stats"))).sort()).toEqual([
			"dyn",
			"live",
			"seen",
			"since",
		]);
	});

	it("水位线写不进去 → 只 warn、这次按「此刻」算,不抛、不留临时文件", async () => {
		// 占位:`since` 是个目录,读它报 EISDIR、写它也报 EISDIR。
		await mkdir(join(dataDir, "stats", "since"), { recursive: true });
		const s = createStatsStore({ dataRoot: dataDir, logger, now: () => new Date(T(7)) });
		expect(await s.recordingSince()).toBe(T(7));
		expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
			"[stats-store] write since failed",
		);
		expect((await readdir(join(dataDir, "stats"))).sort()).toEqual([
			"dyn",
			"live",
			"seen",
			"since",
		]);
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

	it("接回同一场之后那帧 end 的峰值更小 / 没带 → 留着前一帧更大的(累计观看只增不减)", async () => {
		await store.openLiveSession("1", T(9));
		await store.closeLiveSession("1", T(10), 5_000); // 关服截断,记到 5000
		await store.openLiveSession("1", T(9)); // 重启接回,从这一刻重新取
		await store.closeLiveSession("1", T(11), 3_000); // 这一段平台只报到 3000
		await store.openLiveSession("1", T(9));
		await store.closeLiveSession("1", T(12)); // 又一段,一次都没报
		expect(await store.listLiveSessions("1", T(0))).toEqual([
			{ startedAt: T(9), endedAt: T(12), peakViewers: 5_000 },
		]);
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

/** 往 `stats/<dir>/<key>.jsonl` 摆一份盘上已有的行(一行一条,末尾带换行)。 */
async function putRows(
	dir: "dyn" | "live",
	key: string,
	rows: readonly unknown[],
): Promise<string> {
	await mkdir(join(dataDir, "stats", dir), { recursive: true });
	const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await writeFile(join(dataDir, "stats", dir, `${key}.jsonl`), text);
	return text;
}

describe("StatsStore — 盘上已有的行", () => {
	it("同 id 已在盘上 → 不追加(盘上字节不变),读回只有一条", async () => {
		const text = await putRows("dyn", "1", [
			{ id: "a", kind: "video", ts: T(1) },
			{ id: "b", kind: "post", ts: T(2) },
		]);
		await store.appendDynamic("1", { id: "a", kind: "video", ts: T(1) });
		expect(await readFile(join(dataDir, "stats", "dyn", "1.jsonl"), "utf-8")).toBe(text);
		expect((await store.listDynamics("1", T(0))).filter((e) => e.id === "a")).toHaveLength(1);
	});

	it("kind: live 的开播公告行也挡得住同 id 重写", async () => {
		const text = await putRows("dyn", "1", [{ id: "c", kind: "live", ts: T(1) }]);
		await store.appendDynamic("1", { id: "c", kind: "post", ts: T(1) });
		expect(await readFile(join(dataDir, "stats", "dyn", "1.jsonl"), "utf-8")).toBe(text);
	});

	it("同 id 两行(降级期间别的版本又追加了一行)→ 读的时候只认先落盘的那条,不重复计数", async () => {
		// `dynamic-detected` 不保证只发一次(投递失败走 markFail,下轮重发);两个版本各写各的、
		// append 那头的「先读再追加」挡不住,同一条作品在盘上就有两行 —— 不按 id 去重的话计数翻倍。
		await putRows("dyn", "5", [
			{ id: "n1", kind: "video", ts: T(1) },
			{ id: "n1", kind: "post", ts: T(1) },
			{ id: "n2", kind: "post", ts: T(2) },
			{ id: "n2", kind: "post", ts: T(2) },
		]);
		expect(await store.listDynamics("5", T(0))).toEqual([
			{ id: "n1", kind: "video", ts: T(1) },
			{ id: "n2", kind: "post", ts: T(2) },
		]);
	});
});

describe("StatsStore — 不认老形状(0.x 的老行归迁移器改写,这一层不翻)", () => {
	it("盘上一行 {id, type, ts}(没有 kind)→ 读不出它,别的行照读", async () => {
		await putRows("dyn", "1", [
			{ id: "old", type: "DYNAMIC_TYPE_AV", ts: T(1) },
			{ id: "new", kind: "video", ts: T(2) },
		]);
		expect(await store.listDynamics("1", T(0))).toEqual([{ id: "new", kind: "video", ts: T(2) }]);
	});

	it("老下播帧的字符串峰值当没带:这一场没有峰值", async () => {
		await putRows("live", "1", [
			{ k: "start", ts: T(1) },
			{ k: "end", ts: T(3), peak: "1.2万" },
		]);
		expect(await store.listLiveSessions("1", T(0))).toEqual([{ startedAt: T(1), endedAt: T(3) }]);
	});

	it.each(["1.2万", "看不懂"])(
		"同一场接回之后那帧 end 的峰值是字符串 %s → 当没带,前一帧的数字峰值不被抹掉",
		async (peak) => {
			await putRows("live", "1", [
				{ k: "start", ts: T(1) },
				{ k: "end", ts: T(2), peak: 5_000 },
				{ k: "start", ts: T(1) },
				{ k: "end", ts: T(3), peak },
			]);
			expect(await store.listLiveSessions("1", T(0))).toEqual([
				{ startedAt: T(1), endedAt: T(3), peakViewers: 5_000 },
			]);
		},
	);
});

describe("StatsStore — 文件按订阅 id 命名(ADR-0020 决策 2 的 🔗 / 16)", () => {
	const BILI_SUB = {
		id: "0b1c2d3e-0000-4000-8000-000000000001",
		identity: { sourceKey: "bilibili", externalId: "12345" },
	} as const;
	const EXT_SUB = {
		id: "3f2c1a9e-8b7d-4c6e-9a1f-0b2c3d4e5f60",
		identity: { sourceKey: "douyin", externalId: "sec-1" },
	} as const;

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
