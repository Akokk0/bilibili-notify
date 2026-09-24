/**
 * 统计页的 B 站数字**与改之前逐字一致**(ADR-0020 S1:统计仓改中立、B 站走适配)。
 *
 * 两条路径各钉一份,期望值全部是**改之前的 route + store + aggregate + recorder** 对同一份
 * 数据真跑出来的(S1 施工时从 git 取出老代码并排跑过,响应逐字节相同),不是按新代码抄的:
 *   A. 盘上的老数据(`<uid>.jsonl`、`{id, type, ts}` 行、字符串峰值)经开机迁移改成按订阅 id
 *      命名(ADR-0020 决策 2 的 🔗),行本身不改写,读的时候翻 —— 升级后数字不变;
 *   B. 同一串 B 站总线事件经新的 B 站适配(uid → 订阅 id)落盘,再读出来 —— 新数据与老版本
 *      记的同口径。
 *
 * 要紧的几个角都在夹具里:只有开播公告、没有场次的 UP(直播推送全关)—— 它的「最后活动」
 * 只能来自开播公告,计数是 0 不是 null(ADR-0020 决策 5 的第二个 🔗);开播公告比场次晚
 * 几分钟的「最后活动」;接回的场次、解析不出的老峰值、孤立的 end、窗口外的老行、坏行。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFansStore } from "../fans/store.js";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";
import { migrateStatsFileKeys } from "../stats/migrate-file-keys.js";
import { createStatsRecorder } from "../stats/recorder.js";
import { createStatsStore } from "../stats/store.js";

const NOW = Date.UTC(2026, 4, 16, 12, 0, 0);
const H = 3_600_000;
const D = 86_400_000;
const at = (daysAgo: number, hoursAgo = 0, minutesLater = 0) =>
	new Date(NOW - daysAgo * D - hoursAgo * H + minutesLater * 60_000).toISOString();
const jsonl = (rows: unknown[]) =>
	`${rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const FIELDS = [
	"archives",
	"dynamics",
	"liveSessions",
	"liveHours",
	"liveTimedSessions",
	"peakViewers",
	"avgPeakViewers",
	"lastActivityAt",
	"activity",
] as const;

function bilibili(uids: string[]) {
	return uids.map((uid) => ({ kind: "bilibili", id: `s${uid}`, uid }));
}

function makeDeps(dataDir: string, uids: string[], liveUids: string[]): RouteDeps {
	return {
		runtime: {
			fansStore: createFansStore({ dataDir, logger }),
			statsStore: createStatsStore({ dataDir, logger }),
			engines: {
				listLiveRooms: () => uids.map((uid) => ({ uid, isLive: liveUids.includes(uid) })),
			},
			fansPoller: null,
		},
		store: { getSubscriptions: () => bilibili(uids) },
		puppeteer: null,
		wsTicketStore: null,
		qqSessionRegistry: null,
	} as unknown as RouteDeps;
}

async function overview(
	deps: RouteDeps,
	qs: string,
	fields: readonly string[] = FIELDS,
): Promise<Record<string, Record<string, unknown>>> {
	const res = await createStatsRoute(deps).request(`/overview${qs}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as StatsOverviewResponse;
	return Object.fromEntries(
		body.rows.map((r) => [
			r.uid,
			Object.fromEntries(fields.map((f) => [f, (r as unknown as Record<string, unknown>)[f]])),
		]),
	);
}

let dataDir: string;

beforeEach(async () => {
	// 只假 Date:store 是真 fs 流,假掉 setImmediate 会把读盘卡死。
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	dataDir = await mkdtemp(join(tmpdir(), "bn-stats-overview-legacy-"));
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

describe("A. 盘上的老 B 站数据 → /overview 与改之前一致", () => {
	async function writeLegacyFixture() {
		await mkdir(join(dataDir, "stats", "dyn"), { recursive: true });
		await mkdir(join(dataDir, "stats", "live"), { recursive: true });
		await mkdir(join(dataDir, "fans"), { recursive: true });
		await writeFile(join(dataDir, "stats", "since"), at(3, 2));
		const w = (p: string, rows: unknown[]) => writeFile(join(dataDir, p), jsonl(rows));
		// 101:直播推送全关(没有场次),最近的动静是一条开播公告。
		await w("stats/dyn/101.jsonl", [
			{ id: "a", type: "DYNAMIC_TYPE_AV", ts: at(5) },
			{ id: "b", type: "DYNAMIC_TYPE_WORD", ts: at(2) },
			{ id: "c", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(1) },
			{ id: "d", type: "DYNAMIC_TYPE_DRAW", ts: at(40) },
		]);
		await w(
			"fans/101.jsonl",
			Array.from({ length: 12 }, (_, i) => ({ ts: at(11 - i, 2), value: 1000 + 10 * i })),
		);
		// 102:窗口里只有开播公告,没有粉丝采样、没有场次 —— 计数该是 0,不是 null。
		await w("stats/dyn/102.jsonl", [
			{ id: "l1", type: "DYNAMIC_TYPE_LIVE", ts: at(2) },
			{ id: "l2", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(0, 3) },
		]);
		// 103:场次(含关服截断后接回、仍在播的一场)+ 比开播晚 5 分钟的开播公告。
		await w("stats/live/103.jsonl", [
			{ k: "start", ts: at(4, 5) },
			{ k: "end", ts: at(4, 2), peak: "1.2万" },
			{ k: "start", ts: at(1, 6) },
			{ k: "end", ts: at(1, 5) },
			{ k: "start", ts: at(1, 6) },
			{ k: "end", ts: at(1, 1), peak: "9000" },
			{ k: "start", ts: at(0, 2) },
		]);
		await w("stats/dyn/103.jsonl", [
			{ id: "p", type: "DYNAMIC_TYPE_DRAW", ts: at(3) },
			{ id: "r", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(0, 2, 5) },
		]);
		await w(
			"fans/103.jsonl",
			Array.from({ length: 4 }, (_, i) => ({ ts: at(3 - i, 1), value: 50_000 + 300 * i })),
		);
		// 104:一无所知。105:窗口外的老开播公告、坏行、孤立的 end、解析不出的峰值、亿。
		await w("stats/dyn/105.jsonl", [
			{ id: "old", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(95) },
			{ id: "v", type: "DYNAMIC_TYPE_AV", ts: at(20) },
			'{"bad',
			{ id: "x" },
			{ id: "n", type: "DYNAMIC_TYPE_SOMETHING_NEW", ts: at(6) },
		]);
		await w("stats/live/105.jsonl", [
			{ k: "end", ts: at(12), peak: "1万" },
			{ k: "start", ts: at(10, 5) },
			{ k: "end", ts: at(10, 3), peak: "看不懂" },
			{ k: "start", ts: at(8, 5) },
			{ k: "end", ts: at(8, 1), peak: "1.5亿" },
		]);
		const uids = ["101", "102", "103", "104", "105"];
		// 老数据按 uid 命名;开机迁移把它们改成订阅 id(`s101` …),路由按订阅 id 读。
		const moved = await migrateStatsFileKeys({
			dataDir,
			subscriptions: bilibili(uids) as never,
			logger,
		});
		expect(moved).toEqual({ renamed: 8, merged: 0, copied: 0 });
		return makeDeps(dataDir, uids, ["103"]);
	}

	it("近 7 日(UTC+8)", async () => {
		const deps = await writeLegacyFixture();
		expect(await overview(deps, "?days=7&tz=-480")).toEqual({
			"101": {
				archives: 1,
				dynamics: 1,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-15T12:00:00.000Z",
				activity: [null, null, null, 0, 1, 0, 0],
			},
			"102": {
				archives: 0,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-16T09:00:00.000Z",
				activity: [null, null, null, 0, 0, 0, 0],
			},
			"103": {
				archives: 0,
				dynamics: 1,
				liveSessions: 3,
				liveHours: 10,
				liveTimedSessions: 3,
				peakViewers: 12000,
				avgPeakViewers: 10500,
				lastActivityAt: "2026-05-16T10:05:00.000Z",
				activity: [null, null, null, 1, 0, 1, 1],
			},
			"104": {
				archives: null,
				dynamics: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
				activity: [null, null, null, null, null, null, null],
			},
			"105": {
				archives: 0,
				dynamics: 1,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-10T12:00:00.000Z",
				activity: [null, null, null, 0, 0, 0, 0],
			},
		});
	});

	it("近 1 日(UTC)—— 只有开播公告的那位计数是 0 不是 null", async () => {
		const deps = await writeLegacyFixture();
		expect(await overview(deps, "?days=1&tz=0")).toEqual({
			"101": {
				archives: 0,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
			"102": {
				archives: 0,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-16T09:00:00.000Z",
				activity: [0],
			},
			"103": {
				archives: 0,
				dynamics: 0,
				liveSessions: 1,
				liveHours: 2,
				liveTimedSessions: 1,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-16T10:05:00.000Z",
				activity: [1],
			},
			"104": {
				archives: null,
				dynamics: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
				activity: [null],
			},
			"105": {
				archives: null,
				dynamics: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
				activity: [null],
			},
		});
	});

	it("近 90 日(UTC-5)—— 窗口外的老行、孤立的 end、解析不出的峰值", async () => {
		const deps = await writeLegacyFixture();
		expect(
			await overview(
				deps,
				"?days=90&tz=300",
				FIELDS.filter((f) => f !== "activity"),
			),
		).toEqual({
			"101": {
				archives: 1,
				dynamics: 2,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-15T12:00:00.000Z",
			},
			"102": {
				archives: 0,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-16T09:00:00.000Z",
			},
			"103": {
				archives: 0,
				dynamics: 1,
				liveSessions: 3,
				liveHours: 10,
				liveTimedSessions: 3,
				peakViewers: 12000,
				avgPeakViewers: 10500,
				lastActivityAt: "2026-05-16T10:05:00.000Z",
			},
			"104": {
				archives: null,
				dynamics: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
			},
			"105": {
				archives: 1,
				dynamics: 1,
				liveSessions: 2,
				liveHours: 6,
				liveTimedSessions: 2,
				peakViewers: 150000000,
				avgPeakViewers: 150000000,
				lastActivityAt: "2026-05-10T12:00:00.000Z",
			},
		});
	});
});

describe("B. B 站总线事件经 B 站适配落盘 → /overview 与改之前一致", () => {
	async function recordEvents() {
		let clock = NOW - 3 * D;
		const now = () => new Date(clock);
		const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
		const bus = {
			on: (ev: string, h: (...a: unknown[]) => void) => {
				handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
				return { dispose() {} };
			},
			emit() {},
		} as never;
		const store = createStatsStore({ dataDir, logger, now });
		const uids = ["201", "202", "203", "204"];
		const recorder = createStatsRecorder({
			bus,
			store,
			fans: createFansStore({ dataDir, logger }),
			fansCron: () => "*/10 * * * *",
			logger,
			now,
			subscriptions: () => bilibili(uids) as never,
		});
		// 落盘是 fire-and-forget,每条事件之后让它写完,免得同一文件的「先读再追加」互相踩。
		const fire = async (ev: string, ...a: unknown[]) => {
			for (const h of handlers.get(ev) ?? []) h(...a);
			await new Promise((r) => setTimeout(r, 15));
		};
		const dyn = (uid: string, id: string, type: string, ts: string) =>
			fire("dynamic-detected", { uid, id, type, ts });

		// 201:直播推送全关,只有一条视频 + 开播公告(重放一次)。
		await dyn("201", "v1", "DYNAMIC_TYPE_AV", at(2, 5));
		await dyn("201", "lr1", "DYNAMIC_TYPE_LIVE_RCMD", at(1, 3));
		await dyn("201", "lr1", "DYNAMIC_TYPE_LIVE_RCMD", at(1, 3));
		// 202:各种类型 + 重放。
		for (const [id, type, ts] of [
			["a", "DYNAMIC_TYPE_AV", at(2)],
			["b", "DYNAMIC_TYPE_DRAW", at(2, 1)],
			["c", "DYNAMIC_TYPE_WORD", at(1)],
			["d", "DYNAMIC_TYPE_FORWARD", at(1, 2)],
			["e", "DYNAMIC_TYPE_SOMETHING_NEW", at(0, 5)],
			["f", "DYNAMIC_TYPE_LIVE", at(0, 4)],
			["a", "DYNAMIC_TYPE_AV", at(2)],
		] as const) {
			await dyn("202", id, type, ts);
		}
		// 203:一场完整直播,观看数有万、有裸数字、有解析不出的;下播带真实时刻。
		clock = NOW - 2 * D;
		await fire("live-state-changed", "203", "live", at(2, 1));
		await dyn("203", "r1", "DYNAMIC_TYPE_LIVE_RCMD", at(2, 1, 1));
		await fire("live-viewers-changed", "203", "8000");
		await fire("live-viewers-changed", "203", "1.2万");
		await fire("live-viewers-changed", "203", "9500");
		await fire("live-viewers-changed", "203", "看不懂");
		clock = NOW - 2 * D + 2 * H;
		await fire("live-state-changed", "203", "idle", at(2, -1, 58));
		// 204:开播时刻解析不出 → 回退此刻;auth-lost 之后再开一场;关服收尾。
		clock = NOW - D;
		await fire("live-state-changed", "204", "live", "不是时间");
		await fire("live-viewers-changed", "204", "3万");
		await fire("auth-lost");
		clock = NOW - 5 * H;
		await fire("live-state-changed", "204", "live", "还是不是时间");
		await fire("live-viewers-changed", "204", "1.5亿");
		clock = NOW - H;
		await recorder.closeOpenSessions();

		await mkdir(join(dataDir, "fans"), { recursive: true });
		for (const uid of ["201", "202", "203"]) {
			await writeFile(
				join(dataDir, "fans", `s${uid}.jsonl`),
				jsonl(Array.from({ length: 4 }, (_, i) => ({ ts: at(3 - i, 1), value: 10 * i }))),
			);
		}
		return makeDeps(dataDir, uids, ["204"]);
	}

	it("近 7 日(UTC+8)", async () => {
		const deps = await recordEvents();
		expect(await overview(deps, "?days=7&tz=-480")).toEqual({
			"201": {
				archives: 1,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-15T09:00:00.000Z",
				activity: [null, null, null, 0, 1, 0, 0],
			},
			"202": {
				archives: 1,
				dynamics: 4,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-16T08:00:00.000Z",
				activity: [null, null, null, 0, 2, 2, 1],
			},
			"203": {
				archives: 0,
				dynamics: 0,
				liveSessions: 1,
				liveHours: 2.966666666666667,
				liveTimedSessions: 1,
				peakViewers: 12000,
				avgPeakViewers: 12000,
				lastActivityAt: "2026-05-14T11:01:00.000Z",
				activity: [null, null, null, 0, 1, 0, 0],
			},
			"204": {
				archives: 0,
				dynamics: 0,
				liveSessions: 2,
				liveHours: 4,
				liveTimedSessions: 1,
				peakViewers: 150000000,
				avgPeakViewers: 150000000,
				lastActivityAt: "2026-05-16T07:00:00.000Z",
				activity: [null, null, null, 0, 0, 1, 1],
			},
		});
	});

	it("近 1 日(UTC)", async () => {
		const deps = await recordEvents();
		expect(await overview(deps, "?days=1&tz=0")).toEqual({
			"201": {
				archives: 0,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
			"202": {
				archives: 0,
				dynamics: 1,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: "2026-05-16T08:00:00.000Z",
				activity: [1],
			},
			"203": {
				archives: 0,
				dynamics: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				peakViewers: null,
				avgPeakViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
			"204": {
				archives: 0,
				dynamics: 0,
				liveSessions: 1,
				liveHours: 4,
				liveTimedSessions: 1,
				peakViewers: 150000000,
				avgPeakViewers: 150000000,
				lastActivityAt: "2026-05-16T07:00:00.000Z",
				activity: [1],
			},
		});
	});
});
