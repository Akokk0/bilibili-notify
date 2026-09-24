/**
 * 老 B 站行读回来,与改之前算出的数一模一样(ADR-0020 决策 5 / 7 的 🔗:老数据不迁移,
 * 读的时候照原来的规矩翻成中立种类 / 数字)。
 *
 * 夹具就是改之前的 store 写出来的样子:作品行 `{id, type, ts}` 带 B 站原始类型串,
 * 下播帧的 `peak` 是 B 站压缩好的「1.2万」字符串。下面钉的每个数都拿改之前的
 * store + aggregate 对同一份夹具真跑过(档案 2 / 动态 4 / 热力 [0,3,6] / 三场 5 小时 /
 * 最高 30000 / 场均 17000)—— 升级之后统计页上的老数字一个都不许变。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { countDynamics, dailyActivityCounts, summarizeLiveSessions } from "../aggregate.js";
import { createStatsStore, type StatsStore } from "../store.js";

const LEGACY_DYN = [
	{ id: "a", type: "DYNAMIC_TYPE_AV", ts: "2026-05-15T02:00:00.000Z" },
	{ id: "b", type: "DYNAMIC_TYPE_DRAW", ts: "2026-05-15T03:00:00.000Z" },
	{ id: "c", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: "2026-05-15T12:00:00.000Z" },
	{ id: "d", type: "DYNAMIC_TYPE_WORD", ts: "2026-05-16T01:00:00.000Z" },
	{ id: "e", type: "DYNAMIC_TYPE_FORWARD", ts: "2026-05-16T02:00:00.000Z" },
	{ id: "f", type: "DYNAMIC_TYPE_AV", ts: "2026-05-16T03:00:00.000Z" },
	{ id: "g", type: "DYNAMIC_TYPE_LIVE", ts: "2026-05-16T04:00:00.000Z" },
	{ id: "h", type: "DYNAMIC_TYPE_SOMETHING_NEW", ts: "2026-05-16T05:00:00.000Z" },
];

const LEGACY_LIVE = [
	{ k: "start", ts: "2026-05-15T12:00:00.000Z" },
	{ k: "end", ts: "2026-05-15T14:00:00.000Z", peak: "1.2万" },
	{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
	{ k: "end", ts: "2026-05-16T11:00:00.000Z" }, // 关服截断
	{ k: "start", ts: "2026-05-16T10:00:00.000Z" }, // 重启后接回同一场
	{ k: "end", ts: "2026-05-16T12:30:00.000Z", peak: "9000" },
	{ k: "start", ts: "2026-05-16T13:00:00.000Z" },
	{ k: "end", ts: "2026-05-16T13:30:00.000Z", peak: "3万" },
];

const jsonl = (rows: readonly unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const SINCE = "2026-05-14T00:00:00.000Z";
const NOW = new Date("2026-05-16T20:00:00.000Z");

let dataDir: string;
let store: StatsStore;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-stats-legacy-"));
	await mkdir(join(dataDir, "stats", "dyn"), { recursive: true });
	await mkdir(join(dataDir, "stats", "live"), { recursive: true });
	await writeFile(join(dataDir, "stats", "dyn", "1.jsonl"), jsonl(LEGACY_DYN));
	await writeFile(join(dataDir, "stats", "live", "1.jsonl"), jsonl(LEGACY_LIVE));
	store = createStatsStore({ dataDir, logger });
	vi.clearAllMocks();
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe("老 B 站行 → 与改之前同样的统计数", () => {
	it("投稿 / 动态 / 热力图照原来的规矩归类:AV 算投稿,开播那两种不算作品也不加热力", async () => {
		const events = await store.listDynamics("1", SINCE);
		const sessions = await store.listLiveSessions("1", SINCE);
		expect(countDynamics(events)).toEqual({ archives: 2, dynamics: 4 });
		expect(dailyActivityCounts(events, sessions, { days: 3, tzOffsetMin: 0, now: NOW })).toEqual([
			0, 3, 6,
		]);
	});

	it("读出来的是中立种类,B 站类型串不再往上漏;开播那两种留作 live(活动证据)", async () => {
		const events = await store.listDynamics("1", SINCE);
		expect(events).toEqual([
			{ id: "a", kind: "video", ts: "2026-05-15T02:00:00.000Z" },
			{ id: "b", kind: "post", ts: "2026-05-15T03:00:00.000Z" },
			{ id: "c", kind: "live", ts: "2026-05-15T12:00:00.000Z" },
			{ id: "d", kind: "post", ts: "2026-05-16T01:00:00.000Z" },
			{ id: "e", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
			{ id: "f", kind: "video", ts: "2026-05-16T03:00:00.000Z" },
			{ id: "g", kind: "live", ts: "2026-05-16T04:00:00.000Z" },
			{ id: "h", kind: "post", ts: "2026-05-16T05:00:00.000Z" },
		]);
	});

	it("字符串峰值读成数字,场次 / 时长 / 最高 / 场均与改之前一致", async () => {
		const sessions = await store.listLiveSessions("1", SINCE);
		expect(sessions.map((s) => s.peakViewers)).toEqual([12_000, 9000, 30_000]);
		expect(summarizeLiveSessions(sessions, { now: NOW, isLive: false })).toEqual({
			sessions: 3,
			hours: 5,
			timedSessions: 3,
			peakViewers: 30_000,
			avgPeakViewers: 17_000,
		});
	});

	it("老行不迁移:读过、再往里记,盘上的老行原样还在", async () => {
		await store.listDynamics("1", SINCE);
		await store.appendDynamic("1", { id: "z", kind: "post", ts: "2026-05-16T19:00:00.000Z" });
		const raw = await readFile(join(dataDir, "stats", "dyn", "1.jsonl"), "utf-8");
		expect(raw.startsWith(jsonl(LEGACY_DYN))).toBe(true);
	});
});

describe("按 id 去重跨过新老两种行", () => {
	it("老行里已有的 id,新写一条同 id 的 → 不追加,读回只有一条", async () => {
		await store.appendDynamic("1", { id: "a", kind: "video", ts: "2026-05-15T02:00:00.000Z" });
		const raw = await readFile(join(dataDir, "stats", "dyn", "1.jsonl"), "utf-8");
		expect(raw).toBe(jsonl(LEGACY_DYN));
		const got = await store.listDynamics("1", SINCE);
		expect(got.filter((e) => e.id === "a")).toHaveLength(1);
	});

	it("老的开播伪动态也挡得住同 id 的重写", async () => {
		await store.appendDynamic("1", { id: "c", kind: "post", ts: "2026-05-15T12:00:00.000Z" });
		const raw = await readFile(join(dataDir, "stats", "dyn", "1.jsonl"), "utf-8");
		expect(raw).toBe(jsonl(LEGACY_DYN));
	});

	it("新行之间照旧去重 —— 引擎重放同一条不虚增", async () => {
		await store.appendDynamic("2", { id: "x", kind: "video", ts: "2026-05-16T01:00:00.000Z" });
		await store.appendDynamic("2", { id: "x", kind: "video", ts: "2026-05-16T01:00:00.000Z" });
		expect(await store.listDynamics("2", SINCE)).toEqual([
			{ id: "x", kind: "video", ts: "2026-05-16T01:00:00.000Z" },
		]);
	});

	it("降级期间旧版又追加了同 id 的老行 → 读的时候只认先落盘的那条,不重复计数", async () => {
		// 旧版的 append 去重只认得带 `type` 的老行,看不见新行的 id;`dynamic-detected`
		// 又不保证只发一次(投递失败走 markFail,下轮重发)。降级跑过一阵再升级回来,
		// 同一条作品在盘上就有两行 —— 不按 id 去重的话,投稿 / 动态 / 热力图全部翻倍。
		await writeFile(
			join(dataDir, "stats", "dyn", "5.jsonl"),
			jsonl([
				{ id: "n1", kind: "video", ts: "2026-05-16T01:00:00.000Z" },
				{ id: "n1", type: "DYNAMIC_TYPE_WORD", ts: "2026-05-16T01:00:00.000Z" },
				{ id: "n2", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
				{ id: "n2", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
			]),
		);
		const events = await store.listDynamics("5", SINCE);
		expect(events).toEqual([
			{ id: "n1", kind: "video", ts: "2026-05-16T01:00:00.000Z" },
			{ id: "n2", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
		]);
		expect(countDynamics(events)).toEqual({ archives: 1, dynamics: 1 });
	});
});

describe("老峰值的边角", () => {
	it("同一场被接回、后一帧 end 的老峰值解析不出 → 这场没有峰值(与改之前同口径)", async () => {
		// 改之前:后一帧的字符串原样盖掉前一帧的,aggregate 解析失败就当这场没采到。
		await writeFile(
			join(dataDir, "stats", "live", "3.jsonl"),
			jsonl([
				{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
				{ k: "end", ts: "2026-05-16T11:00:00.000Z", peak: "1万" },
				{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
				{ k: "end", ts: "2026-05-16T12:00:00.000Z", peak: "看不懂" },
			]),
		);
		const sessions = await store.listLiveSessions("3", SINCE);
		expect(sessions).toEqual([
			{ startedAt: "2026-05-16T10:00:00.000Z", endedAt: "2026-05-16T12:00:00.000Z" },
		]);
		expect(summarizeLiveSessions(sessions).peakViewers).toBeNull();
	});

	it("新老帧混在一个文件里:数字峰值与字符串峰值各自读对", async () => {
		await writeFile(
			join(dataDir, "stats", "live", "4.jsonl"),
			jsonl([
				{ k: "start", ts: "2026-05-15T10:00:00.000Z" },
				{ k: "end", ts: "2026-05-15T11:00:00.000Z", peak: "2万" },
				{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
				{ k: "end", ts: "2026-05-16T11:00:00.000Z", peak: 8000 },
			]),
		);
		const sessions = await store.listLiveSessions("4", SINCE);
		expect(sessions.map((s) => s.peakViewers)).toEqual([20_000, 8000]);
	});
});
