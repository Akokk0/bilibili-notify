/**
 * 粉丝曲线「对外可见」的现状钉子(㉘a):`GET /api/stats/overview` 行上的 `series` / `cumulative` /
 * `net1d` / `net7d` / `netWindow` / `followers`。
 *
 * 用途:㉘c 要把粉丝样本文件压缩(近 8 天原样、更早按小时留末值、连着的同值小时合成段)并改行的形状。
 * 定案要求「采集与显示都不变」,这份测试就是裁判 —— ㉘c 之后**只许改 {@link sampleRow} 这一个帮手**
 * (行的形状),下面的期望一个都不许动。
 *
 * 钉法:粉丝仓用真的(tmpdir 里的真文件),从路由外面看返回值;期望全是手写字面量,不用被测代码算。
 * 夹具跨 30 天(远过 8 天),同一份数据在 tz=0 / tz=-480(UTC+8)/ tz=300(UTC-5)各验一遍,
 * 形态:每 10 分钟都在变的活跃订阅、好几天不变的长平段、BN 关了两天的缺口、一天只有一两条、压在整点与本地日边界上的样本。
 *
 * 钉的是现状,包括看着别扭的几处(见各用例注释里的「现状」):
 *   - 路由只读窗口内的样本(`listSamplesSince(since)`),窗口第一天永远没有基线,净增是 null,哪怕盘上更早还有样本;
 *   - 净增是「当日末值 − 前一个有数据的日的末值」,缺口之后第一天的净增吃下整段缺口的变化,
 *     而缺口之后的平稳日是 0(不是 null)。
 *
 * 不用 `waitFor`:只假装 Date(固定「现在」),定时器是真的。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFollowersStore, FOLLOWERS_DIR } from "../followers/store.js";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

const NOW = Date.UTC(2026, 5, 30, 12, 0, 0); // 2026-06-30T12:00:00Z
const MIN = 60_000;
const D = 30;

/** ㉘c 只改这一个帮手:一条粉丝样本在盘上的行。 */
function sampleRow(atMs: number, value: number): { sampledAt: string; followers: number } {
	return { sampledAt: new Date(atMs).toISOString(), followers: value };
}

const at = (iso: string) => Date.parse(iso);

type Sample = [atMs: number, value: number];

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-followers-display-"));
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

async function writeSamples(key: string, samples: Sample[]): Promise<void> {
	await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	const body = samples.map(([ms, v]) => `${JSON.stringify(sampleRow(ms, v))}\n`).join("");
	await writeFile(join(dataDir, ...FOLLOWERS_DIR, `${key}.jsonl`), body);
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** act:06-01 00:00Z 起每 10 分钟一条、每条 +1(10000, 10001, …),一直到「现在」(最后一条 14248)。 */
const ACT: Sample[] = Array.from(
	{ length: 4249 },
	(_, i): Sample => [at("2026-06-01T00:00:00.000Z") + i * 10 * MIN, 10000 + i],
);

/** flat:窗口之前一条 6990;06-03 起 7000 一直不变到 06-12(一天两条);06-13 涨到 7010;06-14、06-15 BN 关了没样本;06-16 仍 7010;06-17 涨到 7025;之后到 06-30 11:00 才又有一条(仍 7025)。 */
const FLAT: Sample[] = [
	[at("2026-05-20T10:00:00.000Z"), 6990],
	[at("2026-06-03T10:00:00.000Z"), 7000],
	...[4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d): Sample[] => [
		[at(`2026-06-${String(d).padStart(2, "0")}T10:00:00.000Z`), 7000],
		[at(`2026-06-${String(d).padStart(2, "0")}T22:00:00.000Z`), 7000],
	]),
	[at("2026-06-13T10:00:00.000Z"), 7010],
	[at("2026-06-16T10:00:00.000Z"), 7010],
	[at("2026-06-17T09:00:00.000Z"), 7025],
	[at("2026-06-30T11:00:00.000Z"), 7025],
];

/** edge:样本正好压在三个时区的本地日边界与整点上(都在 8 天之前)。 */
const EDGE: Sample[] = [
	[at("2026-06-10T00:00:00.000Z"), 100], // UTC 日首;UTC+8 的 08:00;UTC-5 的 06-09 19:00
	[at("2026-06-10T05:00:00.000Z"), 105], // UTC-5 的 06-10 00:00 整
	[at("2026-06-10T15:59:59.999Z"), 110], // UTC+8 的 23:59:59.999,还算 06-10
	[at("2026-06-10T16:00:00.000Z"), 120], // UTC+8 的 06-11 00:00 整
	[at("2026-06-10T23:59:59.999Z"), 130], // UTC 的 06-10 最后一毫秒
	[at("2026-06-11T00:00:00.000Z"), 140], // UTC 的 06-11 00:00 整
	[at("2026-06-11T04:59:59.999Z"), 150], // UTC-5 的 06-10 23:59:59.999
	[at("2026-06-12T13:00:00.000Z"), 160], // 整点
	[at("2026-06-12T13:59:59.999Z"), 165], // 同一小时的最后一毫秒
	[at("2026-06-12T14:00:00.000Z"), 170], // 下一个整点
];

/** sparse:一天只有一两条,中间隔着几天,最后一条是 06-25(今天没有样本)。 */
const SPARSE: Sample[] = [
	[at("2026-06-20T08:00:00.000Z"), 900],
	[at("2026-06-20T20:00:00.000Z"), 905],
	[at("2026-06-21T09:30:00.000Z"), 905],
	[at("2026-06-25T03:00:00.000Z"), 880],
];

/** 拓展订阅:每隔几天一条,中间一段 19 天的缺口,今天 09:00Z 有一条。 */
const EXT1: Sample[] = [
	[at("2026-06-05T12:00:00.000Z"), 300],
	[at("2026-06-06T12:00:00.000Z"), 310],
	[at("2026-06-10T12:00:00.000Z"), 330],
	[at("2026-06-29T12:00:00.000Z"), 340],
	[at("2026-06-30T09:00:00.000Z"), 345],
];
const EXT2: Sample[] = [
	[at("2026-06-28T12:00:00.000Z"), 50],
	[at("2026-06-29T12:00:00.000Z"), 60],
];
const EXT3: Sample[] = [[at("2026-06-29T12:00:00.000Z"), 70]];

const bili = (id: string, uid: string): Subscription =>
	({ id, identity: { sourceKey: "bilibili", externalId: uid }, enabled: true }) as never;

const SUBS: Subscription[] = [
	bili("b-act", "1001"),
	bili("b-flat", "1002"),
	bili("b-edge", "1003"),
	bili("b-sparse", "1004"),
	makeExtensionSubscription({ id: "e-1", extensionId: "douyin", externalId: "s1", enabled: true }),
	makeExtensionSubscription({ id: "e-2", extensionId: "douyin", externalId: "s2", enabled: true }),
	makeExtensionSubscription({ id: "e-3", extensionId: "douyin", externalId: "s3", enabled: false }),
];

async function seedAll(): Promise<void> {
	await writeSamples("b-act", ACT);
	await writeSamples("b-flat", FLAT);
	await writeSamples("b-edge", EDGE);
	await writeSamples("b-sparse", SPARSE);
	await writeSamples("e-1", EXT1);
	await writeSamples("e-2", EXT2);
	await writeSamples("e-3", EXT3);
}

function makeDeps(): RouteDeps {
	return {
		store: { getSubscriptions: () => SUBS },
		runtime: {
			engines: null,
			// B 站的当前粉丝数取轮询快照;只有 b-flat 在快照里(8888),其余回落到样本末值。
			fansPoller: {
				getLastEntries: () => [{ subscriptionId: "b-flat", uid: "1002", current: 8888 }],
			},
			fansStore: createFollowersStore({
				dataRoot: dataDir,
				logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
			}),
			statsStore: {
				listPosts: async () => [],
				listLiveSessions: async () => [],
				listRecording: async () => [],
			},
			// 拓展的当前粉丝数取它最近报的资料;e-3 停用着,资料里的 5 不算。
			subRuntimeStore: {
				get: (id: string) =>
					id === "e-1"
						? { cachedProfile: { fans: 999 } }
						: id === "e-3"
							? { cachedProfile: { fans: 5 } }
							: undefined,
			},
			serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
		},
	} as unknown as RouteDeps;
}

async function overview(days: number, tz: number) {
	const res = await createStatsRoute(makeDeps()).request(`/overview?days=${days}&tz=${tz}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as StatsOverviewResponse;
	const rows = new Map(body.rows.map((r) => [r.subscriptionId, r]));
	return (id: string) => {
		const row = rows.get(id);
		if (!row) throw new Error(`没有 ${id} 这一行`);
		return row;
	};
}

/** 30 个 null,把「日号 − 1」处换成给定的值(下标 0 = 06-01,29 = 06-30)。手写位置与值,不是算出来的。 */
function days30(cells: Record<number, number | undefined>, length = D): Array<number | null> {
	return Array.from({ length }, (_, i) => cells[i] ?? null);
}

// ── 期望(手写字面量) ─────────────────────────────────────────────────────────

/** act 的 cumulative:各时区的本地日末值。 */
const ACT_CUM: Record<number, number[]> = {
	0: [
		10143, 10287, 10431, 10575, 10719, 10863, 11007, 11151, 11295, 11439, 11583, 11727, 11871,
		12015, 12159, 12303, 12447, 12591, 12735, 12879, 13023, 13167, 13311, 13455, 13599, 13743,
		13887, 14031, 14175, 14248,
	],
	[-480]: [
		10095, 10239, 10383, 10527, 10671, 10815, 10959, 11103, 11247, 11391, 11535, 11679, 11823,
		11967, 12111, 12255, 12399, 12543, 12687, 12831, 12975, 13119, 13263, 13407, 13551, 13695,
		13839, 13983, 14127, 14248,
	],
	300: [
		10173, 10317, 10461, 10605, 10749, 10893, 11037, 11181, 11325, 11469, 11613, 11757, 11901,
		12045, 12189, 12333, 12477, 12621, 12765, 12909, 13053, 13197, 13341, 13485, 13629, 13773,
		13917, 14061, 14205, 14248,
	],
};
/** act 的最后一天只走了一部分(现在是 12:00Z),所以净增各时区不同。 */
const ACT_LAST_NET: Record<number, number> = { 0: 73, [-480]: 121, 300: 43 };
const ACT_NET7D: Record<number, number> = { 0: 937, [-480]: 985, 300: 907 };
const ACT_NETWINDOW: Record<number, number> = { 0: 4105, [-480]: 4153, 300: 4075 };

const TZS = [0, -480, 300] as const;

describe("GET /api/stats/overview — 粉丝曲线(同一份数据三个时区各验一遍,窗口 30 天)", () => {
	// 验红:把 dailyFansSeries 的日末值改成日首值(`lastByDay.set` 只在该日第一次出现时写),act 的
	// cumulative 全部错成各日 00:00 附近的值(tz=0 第一天 10000 ≠ 10143)。
	it.each(TZS)("每 10 分钟都在变的订阅:每个本地日取末值,净增 = 末值差 [tz=%i]", async (tz) => {
		await seedAll();
		const row = (await overview(D, tz))("b-act");
		expect(row.cumulative).toEqual(ACT_CUM[tz]);
		// 第一天没有基线(盘上窗口之前没有被读进来),之后每天 +144,最后一天只走了一部分。
		expect(row.series).toEqual([null, ...Array(28).fill(144), ACT_LAST_NET[tz]]);
		expect(row.net1d).toBe(ACT_LAST_NET[tz]);
		expect(row.net7d).toBe(ACT_NET7D[tz]);
		expect(row.netWindow).toBe(ACT_NETWINDOW[tz]);
		// 没有轮询快照 → 当前粉丝回落到样本末值。
		expect(row.followers).toBe(14248);
	});

	// 验红:把 dailyFansSeries 里「整天没有样本」的 `net: null` 改成 `net: 0`,缺口那几天 series 变 0,这条红。
	// 另一处验红:把「有样本但没变」的 net 改成 null(`value === base ? null : …`),平稳日变 null,这条红。
	it.each(TZS)(
		"长平段 + 两天缺口:缺的日子是 null,平稳的日子是 0,缺口之后的净增吃下整段缺口 [tz=%i]",
		async (tz) => {
			await seedAll();
			const row = (await overview(D, tz))("b-flat");
			// 现状:06-03 是窗口里第一个有样本的日,它前面的 05-20 在窗口之外、路由不读,所以 06-03 的净增是 null 而不是 +10。
			// 06-04..06-12 一天两条同值 → 0;06-13 涨 10;06-14、06-15 缺;06-16 仍 7010 → 0;06-17 涨 15;
			// 06-18..06-29 缺;06-30 的样本 7025 与 06-17 的末值比 → 0(吃下 13 天缺口,仍是 0)。
			expect(row.series).toEqual(
				days30({
					3: 0,
					4: 0,
					5: 0,
					6: 0,
					7: 0,
					8: 0,
					9: 0,
					10: 0,
					11: 0,
					12: 10,
					15: 0,
					16: 15,
					29: 0,
				}),
			);
			expect(row.cumulative).toEqual(
				days30({
					2: 7000,
					3: 7000,
					4: 7000,
					5: 7000,
					6: 7000,
					7: 7000,
					8: 7000,
					9: 7000,
					10: 7000,
					11: 7000,
					12: 7010,
					15: 7010,
					16: 7025,
					29: 7025,
				}),
			);
			expect(row.net1d).toBe(0);
			expect(row.net7d).toBe(0);
			expect(row.netWindow).toBe(25);
			// 当前粉丝取轮询快照(8888),不是样本末值 7025。
			expect(row.followers).toBe(8888);
		},
	);

	// 验红:把 localKey 的时区符号写反(`utcMs + tz * 60_000`),edge 的日归属整个错位,tz=-480 与 tz=300 红(tz=0 没有符号之分)。
	it.each([
		{ tz: 0, series: { 10: 20, 11: 20 }, cum: { 9: 130, 10: 150, 11: 170 }, netWindow: 40 },
		{ tz: -480, series: { 10: 40, 11: 20 }, cum: { 9: 110, 10: 150, 11: 170 }, netWindow: 60 },
		{ tz: 300, series: { 9: 50, 11: 20 }, cum: { 8: 100, 9: 150, 11: 170 }, netWindow: 70 },
	])(
		"压在本地日边界与整点上的样本归到该归的那天 [tz=$tz]",
		async ({ tz, series, cum, netWindow }) => {
			await seedAll();
			const row = (await overview(D, tz))("b-edge");
			// 例:UTC+8 下 06-10T15:59:59.999Z 还是 06-10(110),06-10T16:00:00.000Z 已经是 06-11;
			// UTC-5 下 06-10T05:00:00.000Z 恰好是 06-10 的第一毫秒,06-11T04:59:59.999Z 是它的最后一毫秒。
			expect(row.series).toEqual(days30(series));
			expect(row.cumulative).toEqual(days30(cum));
			// 今天没有样本 → 近 1 日、近 7 日都是 null(不是 0)。
			expect(row.net1d).toBeNull();
			expect(row.net7d).toBeNull();
			expect(row.netWindow).toBe(netWindow);
			expect(row.followers).toBe(170);
		},
	);

	// 验红:把 `netWindow: sumTail(series, days)` 改成 `sumTail(series, 7)`,tz=-480 的 netWindow 从 -20 变 -25,红。
	it.each([
		{ tz: 0, series: { 20: 0, 24: -25 }, cum: { 19: 905, 20: 905, 24: 880 }, netWindow: -25 },
		{ tz: -480, series: { 20: 5, 24: -25 }, cum: { 19: 900, 20: 905, 24: 880 }, netWindow: -20 },
		{ tz: 300, series: { 20: 0, 23: -25 }, cum: { 19: 905, 20: 905, 23: 880 }, netWindow: -25 },
	])(
		"一天只有一两条样本、中间隔几天:近 7 日算得出、近 1 日是 null [tz=$tz]",
		async ({ tz, series, cum, netWindow }) => {
			await seedAll();
			const row = (await overview(D, tz))("b-sparse");
			expect(row.series).toEqual(days30(series));
			expect(row.cumulative).toEqual(days30(cum));
			expect(row.net1d).toBeNull();
			expect(row.net7d).toBe(-25);
			expect(row.netWindow).toBe(netWindow);
			expect(row.followers).toBe(880);
		},
	);

	// 验红:把 `currentFans` 里拓展那支改成只认样本末值(`undefined`),e-1 的 followers 变 345,红。
	it.each(TZS)("拓展订阅:曲线只看样本,当前粉丝取它最近报的资料 [tz=%i]", async (tz) => {
		await seedAll();
		const get = await overview(D, tz);
		const e1 = get("e-1");
		// 现状:06-10 的净增 20 是和 06-06 比的(中间缺 3 天),06-29 的 10 是和 06-10 比的(缺 18 天)。
		expect(e1.series).toEqual(days30({ 5: 10, 9: 20, 28: 10, 29: 5 }));
		expect(e1.cumulative).toEqual(days30({ 4: 300, 5: 310, 9: 330, 28: 340, 29: 345 }));
		expect(e1.net1d).toBe(5);
		expect(e1.net7d).toBe(15);
		expect(e1.netWindow).toBe(45);
		expect(e1.followers).toBe(999);

		// 资料没带粉丝数(没有这条资料)→ 样本末值;今天没样本 → net1d null。
		const e2 = get("e-2");
		expect(e2.series).toEqual(days30({ 28: 10 }));
		expect(e2.cumulative).toEqual(days30({ 27: 50, 28: 60 }));
		expect(e2.net1d).toBeNull();
		expect(e2.net7d).toBe(10);
		expect(e2.netWindow).toBe(10);
		expect(e2.followers).toBe(60);

		// 停用着的拓展:资料里的 5 不算(停用的曲线停了,右端点不往前走),回落到样本末值;窗口里只有一条样本 → 净增全 null。
		const e3 = get("e-3");
		expect(e3.series).toEqual(days30({}));
		expect(e3.cumulative).toEqual(days30({ 28: 70 }));
		expect(e3.net1d).toBeNull();
		expect(e3.net7d).toBeNull();
		expect(e3.netWindow).toBeNull();
		expect(e3.followers).toBe(70);
	});
});

describe("GET /api/stats/overview — 窗口长度对 net7d / netWindow 的影响", () => {
	const ACT7 = {
		0: { cum: [13455, 13599, 13743, 13887, 14031, 14175, 14248], last: 73, sum: 793 },
		[-480]: { cum: [13407, 13551, 13695, 13839, 13983, 14127, 14248], last: 121, sum: 841 },
		300: { cum: [13485, 13629, 13773, 13917, 14061, 14205, 14248], last: 43, sum: 763 },
	} as const;

	// 验红:把 `net7d: days >= 7 ? …` 的门槛改成 `days >= 3`,下面「3 天窗口」那条的 net7d 不再是 null,红。
	it.each(TZS)("7 天窗口:net7d 与 netWindow 同值,窗口首日没有基线 [tz=%i]", async (tz) => {
		await seedAll();
		const row = (await overview(7, tz))("b-act");
		const want = ACT7[tz];
		expect(row.cumulative).toEqual(want.cum);
		expect(row.series).toEqual([null, 144, 144, 144, 144, 144, want.last]);
		expect(row.net1d).toBe(want.last);
		expect(row.net7d).toBe(want.sum);
		expect(row.netWindow).toBe(want.sum);
	});

	it.each([
		{ tz: 0, cum: [14031, 14175, 14248], last: 73, window: 217 },
		{ tz: -480, cum: [13983, 14127, 14248], last: 121, window: 265 },
		{ tz: 300, cum: [14061, 14205, 14248], last: 43, window: 187 },
	])(
		"3 天窗口:net7d 为 null(窗口装不下 7 天),netWindow 照给 [tz=$tz]",
		async ({ tz, cum, last, window }) => {
			await seedAll();
			const row = (await overview(3, tz))("b-act");
			expect(row.cumulative).toEqual(cum);
			expect(row.series).toEqual([null, 144, last]);
			expect(row.net7d).toBeNull();
			expect(row.netWindow).toBe(window);
		},
	);

	// 现状:窗口前的样本不进来。sparse 在 06-21 有一条 905,但 7 天窗口从 06-24(tz=0)起,
	// 路由不读窗口之前的样本,于是 06-25 的 880 没有基线,净增是 null 而不是 -25 —— 与 30 天窗口里同一天的 -25 不一样。
	// 验红:让路由把 since 往前放宽一天(`listSamplesSince(key, since - 1 天)`),这条红。
	it.each([
		{ tz: 0, cum: { 1: 880 } },
		{ tz: -480, cum: { 1: 880 } },
		{ tz: 300, cum: { 0: 880 } },
	])("窗口之前盘上还有样本也不拿来当基线:窗口首日的净增恒为 null [tz=$tz]", async ({ tz, cum }) => {
		await seedAll();
		const row = (await overview(7, tz))("b-sparse");
		expect(row.cumulative).toEqual(days30(cum, 7));
		expect(row.series).toEqual(days30({}, 7));
		expect(row.net7d).toBeNull();
		expect(row.netWindow).toBeNull();
	});
});
