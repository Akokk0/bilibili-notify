/**
 * 迁移回填运行记录(`migration/uptime.ts`,ADR-0033 决策 3,㉗b)。
 *
 * 两层:纯函数 `uptimeHoursFromSamples`(升序毫秒时刻 → 每小时的分钟数,期望值全部手写)与 `migrateUptime`
 * (读新代里的 `stats/followers/*.jsonl`、写 `uptime/hours.jsonl`)。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { mergeSampleTimes, migrateUptime, uptimeHoursFromSamples } from "../uptime.js";

const MIN = 60_000;
/** 2026-05-10(UTC)的 `h:m`;`day` 为 1 即次日。 */
const t = (h: number, m = 0, day = 0, s = 0) => Date.UTC(2026, 4, 10 + day, h, m, s);
/** 从 `from` 到 `to`(含)每 `step` 分钟一个样本。 */
function every(step: number, from: number, to: number): number[] {
	const out: number[] = [];
	for (let at = from; at <= to; at += step * MIN) out.push(at);
	return out;
}
const hourIso = (h: number, day = 0) => new Date(Date.UTC(2026, 4, 10 + day, h)).toISOString();
const rows = (...pairs: [string, number][]) =>
	pairs.map(([hourStartedAt, minutes]) => ({ hourStartedAt, minutes }));

describe("uptimeHoursFromSamples", () => {
	it("每 10 分钟一条、连续 3 小时:首尾两个小时按实际跑的分钟记", () => {
		expect(uptimeHoursFromSamples(every(10, t(8, 20), t(11, 20)))).toEqual(
			rows([hourIso(8), 40], [hourIso(9), 60], [hourIso(10), 60], [hourIso(11), 20]),
		);
	});

	it("中间停了 5 小时:断成两段,停着的小时没有行", () => {
		const times = [...every(10, t(8), t(9)), ...every(10, t(14), t(15))];
		expect(uptimeHoursFromSamples(times)).toEqual(rows([hourIso(8), 60], [hourIso(14), 60]));
	});

	it("孤零零一个样本:没有行", () => {
		expect(uptimeHoursFromSamples([t(10, 5)])).toEqual([]);
		expect(uptimeHoursFromSamples([])).toEqual([]);
	});

	it("每小时采一次、连续一天:自适应把它们算连着(中位数 60 分钟 × 2.5 = 150 分钟)", () => {
		// 选自适应的理由:同一份数据若用固定的 30 分钟阈值,每个间隔 60 分钟都超线,一段也连不起来、结果是空的。
		const out = uptimeHoursFromSamples(every(60, t(0), t(23)));
		expect(out).toHaveLength(23);
		expect(out[0]).toEqual({ hourStartedAt: hourIso(0), minutes: 60 });
		expect(out[22]).toEqual({ hourStartedAt: hourIso(22), minutes: 60 });
	});

	it("两分钟一次的一天里夹 20 分钟的空档:没过 25 分钟下限,仍算连着", () => {
		const times = [...every(2, t(0), t(1)), ...every(2, t(1, 20), t(2))];
		expect(uptimeHoursFromSamples(times)).toEqual(rows([hourIso(0), 60], [hourIso(1), 60]));
	});

	it("两分钟一次的一天里夹 40 分钟的空档:断开", () => {
		const times = [...every(2, t(0), t(1)), ...every(2, t(1, 40), t(2))];
		expect(uptimeHoursFromSamples(times)).toEqual(rows([hourIso(0), 60], [hourIso(1), 20]));
	});

	it("一天里只有两个样本:算不出中位数,只用 25 分钟下限(20 分钟连着、30 分钟断开)", () => {
		expect(uptimeHoursFromSamples([t(10), t(10, 20)])).toEqual(rows([hourIso(10), 20]));
		expect(uptimeHoursFromSamples([t(10), t(10, 30)])).toEqual([]);
	});

	it("跨 UTC 零点的一段:间隔起点在前一天,用前一天的中位数", () => {
		// 前一天(30 分钟一个)的间隔是 30、30、30 与跨零点的 60,中位数 30 → 阈值 75,60 分钟连着;
		// 次一天的间隔都是 2 分钟,中位数 2 → 只剩 25 分钟下限,若错用终点那天的中位数,这段会断开。
		const times = [...every(30, t(22), t(23, 30)), ...every(2, t(0, 30, 1), t(0, 40, 1))];
		expect(uptimeHoursFromSamples(times)).toEqual(
			rows([hourIso(22), 60], [hourIso(23), 60], [hourIso(0, 1), 40]),
		);
	});

	it("多个订阅的样本交错、有重复时刻:与合并去重后的单一序列结果相同", () => {
		const a = every(10, t(10), t(10, 30));
		const b = [t(10, 10), t(10, 20), t(10, 30), t(10, 40), t(10, 50)];
		const c = [t(10, 20), t(10, 20), t(12), t(12, 10)];
		const merged = mergeSampleTimes([c, a, b]);
		expect(merged).toEqual([
			t(10),
			t(10, 10),
			t(10, 20),
			t(10, 30),
			t(10, 40),
			t(10, 50),
			t(12),
			t(12, 10),
		]);
		// 10:00–10:50 连着(50 分钟),12:00–12:10(10 分钟)与前一段隔 70 分钟,断开。
		expect(uptimeHoursFromSamples(merged)).toEqual(rows([hourIso(10), 50], [hourIso(12), 10]));
	});

	it("同一个小时里的几段相加", () => {
		const times = [...every(10, t(10), t(10, 10)), ...every(10, t(10, 40), t(10, 50))];
		expect(uptimeHoursFromSamples(times)).toEqual(rows([hourIso(10), 20]));
	});

	it("按毫秒累加、最后四舍五入成整分钟:20 分 20 秒记 20,20 分 40 秒记 21,不满半分钟的不写行", () => {
		expect(uptimeHoursFromSamples([t(10), t(10, 20, 0, 20)])).toEqual(rows([hourIso(10), 20]));
		expect(uptimeHoursFromSamples([t(10), t(10, 20, 0, 40)])).toEqual(rows([hourIso(10), 21]));
		expect(uptimeHoursFromSamples([t(10), t(10, 0, 0, 20)])).toEqual([]);
	});

	it("一整年每 10 分钟一条(耗时测试的合成盘):8760 个小时、合计 525590 分钟", () => {
		const out = uptimeHoursFromSamples(
			every(10, Date.UTC(2025, 9, 1), Date.UTC(2026, 8, 30, 23, 50)),
		);
		expect(out).toHaveLength(8760);
		expect(out[0]).toEqual({ hourStartedAt: "2025-10-01T00:00:00.000Z", minutes: 60 });
		expect(out[8759]).toEqual({ hourStartedAt: "2026-09-30T23:00:00.000Z", minutes: 50 });
		expect(out.reduce((sum, row) => sum + row.minutes, 0)).toBe(525_590);
	});

	it("跑满的小时是 60,不会多", () => {
		const out = uptimeHoursFromSamples(every(1, t(10), t(12)));
		expect(out).toEqual(rows([hourIso(10), 60], [hourIso(11), 60]));
	});
});

describe("migrateUptime", () => {
	const BILI = "b0000000-0000-4000-8000-000000000001";
	const EXT = "e0000000-0000-4000-8000-000000000001";
	const iso = (ms: number) => new Date(ms).toISOString();
	const line = (ms: number, value = 1) => JSON.stringify({ ts: iso(ms), value });
	let dir: string;

	async function put(path: string, text: string) {
		const full = join(dir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, text);
	}
	const hoursFile = () => join(dir, "uptime", "hours.jsonl");

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-uptime-backfill-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("B 站订阅与拓展订阅的样本合在一起,坏行跳过,每小时一行按时间升序", async () => {
		await put(
			`stats/followers/${BILI}.jsonl`,
			[
				line(t(10)),
				"这不是 JSON",
				line(t(10, 10)),
				'{"value":1}',
				line(t(10, 20)),
				'{"ts":"不是时刻","value":1}',
				line(t(10, 50), 2),
				line(t(11, 0)),
			].join("\n"),
		);
		await put(
			`stats/followers/${EXT}.jsonl`,
			`${[line(t(10, 10)), line(t(10, 20)), line(t(10, 30)), line(t(10, 40))].join("\n")}\n`,
		);
		const written = await migrateUptime(dir);
		expect(written).toEqual([hoursFile()]);
		expect(await readFile(hoursFile(), "utf8")).toBe(
			`${[
				'{"hourStartedAt":"2026-05-10T10:00:00.000Z","minutes":60}',
				// 11:00 只有一个样本落在这个小时里、又是这一段的末尾:0 分钟,不写。
			].join("\n")}\n`,
		);
	});

	it("两段分在不同的小时:各自一行", async () => {
		await put(
			`stats/followers/${BILI}.jsonl`,
			`${[line(t(8, 20)), line(t(8, 30)), line(t(8, 40)), line(t(20), 5), line(t(20, 10))].join("\n")}\n`,
		);
		await migrateUptime(dir);
		expect(await readFile(hoursFile(), "utf8")).toBe(
			`${[
				'{"hourStartedAt":"2026-05-10T08:00:00.000Z","minutes":20}',
				'{"hourStartedAt":"2026-05-10T20:00:00.000Z","minutes":10}',
			].join("\n")}\n`,
		);
	});

	it("没有任何粉丝样本:不建文件", async () => {
		expect(await migrateUptime(dir)).toEqual([]);
		await put(`stats/followers/${BILI}.jsonl`, '{"value":1}\n坏\n');
		expect(await migrateUptime(dir)).toEqual([]);
		await expect(stat(join(dir, "uptime"))).rejects.toThrow();
	});

	it("重跑结果相同", async () => {
		await put(`stats/followers/${BILI}.jsonl`, `${[line(t(8)), line(t(8, 10))].join("\n")}\n`);
		await migrateUptime(dir);
		const first = await readFile(hoursFile(), "utf8");
		await migrateUptime(dir);
		expect(await readFile(hoursFile(), "utf8")).toBe(first);
	});
});
