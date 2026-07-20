/**
 * 场景测试 —— 服务器在 UP 已开播时启动。
 *
 * 这条串起 recorder → store → aggregate 三层,守的是一个**跨层**约定:开播时刻
 * 由事件带进来、落盘时原样保留、聚合时按「到现在」现算。三层各自的单测都覆盖了
 * 自己那一段,但没有一条能证明接起来还成立 —— 而这正是主人报过的那个故障
 * (「15 分钟前启动服务器,显示 15 分钟前直播中,直播时长 Top 空着」)。
 *
 * 事件本身带不带真实开播时刻,由 `packages/live` 那侧的 bootstrap 测试守。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { summarizeLiveSessions } from "../aggregate.js";
import { createStatsRecorder } from "../recorder.js";
import { createStatsStore } from "../store.js";

/** 北京 20:00 真实开播。 */
const REAL_START = "2026-05-16T12:00:00.000Z";
/** 北京 22:00 我们才启动服务器 —— 比开播晚 2 小时。 */
const BOOT = new Date("2026-05-16T14:00:00.000Z");
const hoursLater = (h: number) => new Date(BOOT.getTime() + h * 3_600_000);

describe("服务器在 UP 已开播时启动", () => {
	let dir: string;
	const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
	const handlers = new Map<string, (...a: never[]) => void>();
	const bus = {
		on: (ev: string, h: (...a: never[]) => void) => {
			handlers.set(ev, h);
			return { dispose() {} };
		},
	} as never;
	/** 直接触发 recorder 注册的 handler,替代真实 bus。 */
	const emit = (ev: string, ...args: unknown[]) =>
		(handlers.get(ev) as ((...a: unknown[]) => void) | undefined)?.(...args);

	beforeEach(async () => {
		handlers.clear();
		dir = await mkdtemp(join(tmpdir(), "bn-stats-midstream-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** 建一套 recorder + store,并把「已在播」那条 bootstrap 事件喂进去。 */
	async function bootWhileLive() {
		const store = createStatsStore({ dataDir: dir, logger });
		createStatsRecorder({ bus, store, logger, now: () => BOOT });
		emit("live-state-changed", "1", "live", REAL_START);
		// 落盘是 fire-and-forget,让出一轮事件循环等它写完。
		await new Promise((r) => setTimeout(r, 20));
		return store;
	}

	it("开播时刻记的是 B 站的真实时间,不是我们启动的时间", async () => {
		const store = await bootWhileLive();
		expect(await store.listLiveSessions("1", "2026-05-01T00:00:00.000Z")).toEqual([
			{ startedAt: REAL_START, current: true },
		]);
	});

	it("启动那一刻就已经算出 2 小时,而不是从 0 开始数", async () => {
		const store = await bootWhileLive();
		const sessions = await store.listLiveSessions("1", "2026-05-01T00:00:00.000Z");
		expect(summarizeLiveSessions(sessions, { now: BOOT, isLive: true }).hours).toBeCloseTo(2, 5);
	});

	it("时长随时间推进 —— 不下播也能一直涨", async () => {
		const store = await bootWhileLive();
		const sessions = await store.listLiveSessions("1", "2026-05-01T00:00:00.000Z");
		const at = (h: number) =>
			summarizeLiveSessions(sessions, { now: hoursLater(h), isLive: true }).hours;
		expect(at(1)).toBeCloseTo(3, 5);
		expect(at(3)).toBeCloseTo(5, 5);
	});

	it("下播后定格在真实总时长,不再随时间变", async () => {
		const store = await bootWhileLive();
		emit("live-state-changed", "1", "idle");
		await new Promise((r) => setTimeout(r, 20));
		const sessions = await store.listLiveSessions("1", "2026-05-01T00:00:00.000Z");
		// 下播帧用的是 recorder 的注入时钟(BOOT),所以这一场是 20:00→22:00 共 2h。
		const a = summarizeLiveSessions(sessions, { now: hoursLater(1), isLive: false });
		const b = summarizeLiveSessions(sessions, { now: hoursLater(9), isLive: false });
		expect(a.hours).toBeCloseTo(2, 5);
		expect(b.hours).toBe(a.hours);
	});

	it("直播中再次重启服务器 → 仍是一场,时长不翻倍", async () => {
		// 重启后从 B 站拿到的还是同一个 live_time,于是又发了一条开播事件。
		const store = await bootWhileLive();
		emit("live-state-changed", "1", "live", REAL_START);
		await new Promise((r) => setTimeout(r, 20));
		const sessions = await store.listLiveSessions("1", "2026-05-01T00:00:00.000Z");
		const got = summarizeLiveSessions(sessions, { now: hoursLater(1), isLive: true });
		expect(got.sessions).toBe(1);
		expect(got.hours).toBeCloseTo(3, 5);
	});
});

describe("采集水位线钉在采集起点", () => {
	const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
	const bus = { on: () => ({ dispose() {} }) } as never;
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-stats-watermark-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("采集跑了几天之后才第一次读 → 水位线仍是采集开始那天", async () => {
		// 回归:水位线曾是惰性创建的,谁也不读就不存在。升级后过几天才点开
		// 统计页,盖下的是「打开那一刻」,于是这几天真采到的活动全被判成
		// 「无记录」—— 数据在盘上却永远显示不出来。
		const START = new Date("2026-05-10T00:00:00.000Z");
		const store = createStatsStore({ dataDir: dir, logger, now: () => START });
		createStatsRecorder({ bus, store, logger, now: () => START });
		await new Promise((r) => setTimeout(r, 20));

		// 五天后才第一次有人打开统计页。
		const later = createStatsStore({
			dataDir: dir,
			logger,
			now: () => new Date("2026-05-15T00:00:00.000Z"),
		});
		expect(await later.recordingSince()).toBe(START.toISOString());
	});
});
