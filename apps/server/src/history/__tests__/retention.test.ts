/**
 * 单元测试 — `startHistoryRetention`(按日 history 文件保留清理)。
 *
 * 守护契约:
 *   - historyRetentionDays<=0 → 整轮跳过(不删任何文件)
 *   - 仅删除 date < UTC cutoff 的日文件,cutoff 内/今日文件保留
 *   - 单个文件删除失败(如同名是目录)只 warn,不终止整轮,其它旧文件照删
 *   - 启动即跑一次 runOnce(无需等定时器)
 *   - 返回值即 serviceCtx.setInterval 的 handle
 *   - **重推原件跟着同一个 cutoff 走**(ADR-0017 决策 4:一个数管两处)
 *
 * runOnce 经 ./store.js 的 listDayFiles/deleteDayImages 真实读写 tmpdir。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Disposable } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	deferred,
	makeTrackingContext,
	stillPending,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import { createRepushStore, listRepushDays, type RepushStore } from "../repush-store.js";
import { readClearedThrough, startHistoryRetention } from "../retention.js";
import { listDayFiles } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let intervalHandle: Disposable;
let setInterval_: ReturnType<typeof vi.fn>;
let ctx: TrackingContext;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-ret-"));
	logger = makeLogger();
	intervalHandle = { dispose: vi.fn() };
	setInterval_ = vi.fn(() => intervalHandle);
	ctx = makeTrackingContext();
});
afterEach(() => vi.restoreAllMocks());

function makeStore(historyRetentionDays: number) {
	return {
		getGlobals: () => ({ app: { historyRetentionDays } }),
	};
}

function start(days: number, intervalMs?: number, repush?: RepushStore, now?: Date) {
	return startHistoryRetention({
		serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
		store: makeStore(days) as never,
		dataRoot: dataDir,
		logger,
		intervalMs,
		repush,
		now: now ? () => now : undefined,
	});
}

/** 一行带一张图的历史(图名 `ref`)。 */
function imageRow(id: string, ref: string, createdAt: string): string {
	return `${JSON.stringify({
		id,
		pushId: id,
		createdAt,
		feature: "post",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: "11111111-1111-4111-8111-111111111111",
		targetId: "22222222-2222-4222-8222-222222222222",
		status: "delivered",
		messages: [
			{
				payload: { kind: "image", text: "x", imageRef: ref },
				role: "main",
				result: { ok: true, latencyMs: 1 },
			},
		],
	})}\n`;
}

/** 造一天的历史:一行、一张图。 */
async function seedDay(day: string, ref: string): Promise<void> {
	await mkdir(join(dataDir, "history", "img"), { recursive: true });
	await writeFile(
		join(dataDir, "history", `${day}.jsonl`),
		imageRow(randomUUID(), ref, `${day}T08:00:00.000Z`),
	);
	await writeFile(join(dataDir, "history", "img", ref), "图");
}

const images = async () => (await readdir(join(dataDir, "history", "img"))).sort();

async function writeMark(text: string): Promise<void> {
	await mkdir(join(dataDir, "history"), { recursive: true });
	await writeFile(join(dataDir, "history", "retention.json"), text);
}

/** 造一份某一天的重推原件。 */
async function seedDraft(day: string): Promise<void> {
	const repush = createRepushStore({ dataRoot: dataDir, logger });
	await repush.append(`row-${day}`, day, [
		{ payload: { kind: "text", text: "x" }, role: "main", reduced: { kind: "text" } },
	]);
}

const today = new Date().toISOString().slice(0, 10);

describe("startHistoryRetention — 登记进 track", () => {
	// 清理是删盘上的文件。不登记的话,关停会在它删到一半时让各写道关门、返回 —— 返回之后数据目录还在变。
	it("开机那一轮:重推原件删完它才落定", async () => {
		await seedDraft("2000-01-01");
		const release = deferred();
		const dropped: string[] = [];
		const repush = {
			dropDay: async (day: string) => {
				await release.promise;
				dropped.push(day);
			},
		} as unknown as RepushStore;

		start(30, undefined, repush);

		expect(ctx.tracked).toHaveLength(1);
		expect(await stillPending(ctx.settled())).toBe(true);
		expect(dropped).toEqual([]);
		release.resolve();
		await ctx.settled();
		expect(dropped).toEqual(["2000-01-01"]);
	});

	it("定时那一轮:同样登记,原件删完它才落定", async () => {
		const release = deferred();
		const dropped: string[] = [];
		const repush = {
			dropDay: async (day: string) => {
				await release.promise;
				dropped.push(day);
			},
		} as unknown as RepushStore;
		// 开机那一轮盘上什么都没有,只把水位线记到 05-15;过了一天又有一天到期(05-16),定时那一轮去清它。
		let clock = new Date("2026-06-15T12:00:00.000Z");
		startHistoryRetention({
			serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
			store: makeStore(30) as never,
			dataRoot: dataDir,
			logger,
			repush,
			now: () => clock,
		});
		await ctx.settled();
		await seedDraft("2026-05-16");
		clock = new Date("2026-06-16T12:00:00.000Z");

		const tick = setInterval_.mock.calls[0]?.[0] as () => void;
		tick();

		expect(ctx.tracked).toHaveLength(2);
		const [, second] = ctx.tracked as [Promise<unknown>, Promise<unknown>];
		expect(await stillPending(second)).toBe(true);
		release.resolve();
		await second;
		expect(dropped).toEqual(["2026-05-16"]);
	});

	it("一轮抛错:登记进去的那件事不拒(失败在交进去之前就接住了),只记一条 warn", async () => {
		startHistoryRetention({
			serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
			store: {
				getGlobals: () => {
					throw new Error("boom");
				},
			} as never,
			dataRoot: dataDir,
			logger,
		});

		const [task] = ctx.tracked;
		await expect(task).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("initial retention pass failed"),
		);
	});
});

describe("startHistoryRetention", () => {
	it("days<=0:整轮跳过,旧文件保留", async () => {
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", "2000-01-01.jsonl"), "x\n");
		start(0);
		await new Promise((r) => setTimeout(r, 20));
		expect(await listDayFiles(dataDir)).toContain("2000-01-01.jsonl");
	});

	// 文字不设上限(ADR-0022 决策 9):到期只清图与重推原件,日文件一份都不删。
	it("到期的日子:日文件留着(文字不删),今天的也在", async () => {
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", "2000-01-01.jsonl"), "old\n");
		await writeFile(join(dataDir, "history", `${today}.jsonl`), "fresh\n");
		start(30);
		await ctx.settled();
		const files = await listDayFiles(dataDir);
		expect(files).toContain("2000-01-01.jsonl");
		expect(files).toContain(`${today}.jsonl`);
	});

	it("某一天的日文件读不出来(同名是目录):不拦别的到期日,它们的图照清", async () => {
		await mkdir(join(dataDir, "history"), { recursive: true });
		await mkdir(join(dataDir, "history", "1999-01-01.jsonl"));
		await seedDay("1999-01-02", "old.png");
		start(30);
		await ctx.settled();
		expect(await images()).toEqual([]);
	});

	/**
	 * **一个数管两处**(ADR-0017 决策 4)。原件比历史活得久没有意义:行都不在了,
	 * 按钮无从长出来,留下的只是盘上一份谁都读不到的推送内容。所以它跟着
	 * `historyRetentionDays` 同一个 cutoff 走,不另开旋钮。
	 */
	it("旧日子的重推原件到期就清,今天的留着", async () => {
		await seedDraft("2000-01-01");
		await seedDraft(today);
		start(30, undefined, createRepushStore({ dataRoot: dataDir, logger }));
		await vi.waitFor(async () => {
			const days = await listRepushDays(dataDir);
			expect(days).not.toContain("2000-01-01");
			expect(days).toContain(today);
		});
	});

	it("days<=0:原件也整轮跳过", async () => {
		await seedDraft("2000-01-01");
		start(0, undefined, createRepushStore({ dataRoot: dataDir, logger }));
		await new Promise((r) => setTimeout(r, 20));
		expect(await listRepushDays(dataDir)).toContain("2000-01-01");
	});

	/**
	 * **日文件一删,它引用的图也得走。**
	 *
	 * 从前 `deleteDayFile` 只 `unlink` 那份 jsonl —— 图留在 `history/img/` 里,而**再没有
	 * 任何人知道它们归谁**(文件名是 `<行 id>-<序号>`,行 id 不带日期,日文件没了就无从对表)。
	 * 症状是盘上那个目录只涨不消:保留期 30 天,卡片图一张几百 KB,一年下来是实打实的几个 G,
	 * 而面板上一张都看不到。
	 *
	 * 顺序是**先收集、再删 jsonl、最后删图**:中途崩了顶多剩几张孤儿图(和从前一样),
	 * 而反过来会留下一份图全裂的历史。
	 */
	it("旧日文件里引用的图跟着一起清掉,今天的图不动", async () => {
		await mkdir(join(dataDir, "history", "img"), { recursive: true });
		const row = (id: string, ref: string, createdAt: string) =>
			`${JSON.stringify({
				id,
				pushId: id,
				createdAt,
				feature: "post",
				identity: { sourceKey: "bilibili", externalId: "u1" },
				subscriptionId: "11111111-1111-4111-8111-111111111111",
				targetId: "22222222-2222-4222-8222-222222222222",
				status: "delivered",
				messages: [
					{
						payload: { kind: "image", text: "x", imageRef: ref },
						role: "main",
						result: { ok: true, latencyMs: 1 },
					},
				],
			})}\n`;
		const OLD_ID = "33333333-3333-4333-8333-333333333333";
		const NEW_ID = "44444444-4444-4444-8444-444444444444";
		await writeFile(
			join(dataDir, "history", "2000-01-01.jsonl"),
			row(OLD_ID, "old.png", "2000-01-01T00:00:00.000Z"),
		);
		await writeFile(
			join(dataDir, "history", `${today}.jsonl`),
			row(NEW_ID, "new.png", `${today}T00:00:00.000Z`),
		);
		await writeFile(join(dataDir, "history", "img", "old.png"), "旧图");
		await writeFile(join(dataDir, "history", "img", "new.png"), "新图");

		start(30);
		await vi.waitFor(async () => {
			const imgs = await readdir(join(dataDir, "history", "img"));
			expect(imgs).not.toContain("old.png");
			expect(imgs).toContain("new.png");
		});
		// 图清了,那一天的文字还在。
		expect(await listDayFiles(dataDir)).toContain("2000-01-01.jsonl");
	});

	// 补丁行里的图也是这一天的 —— 它们跟本体行分在两条 jsonl 行上,漏掉就是半份孤儿。
	it("补丁行引用的图也一起清掉", async () => {
		await mkdir(join(dataDir, "history", "img"), { recursive: true });
		const ID = "55555555-5555-4555-8555-555555555555";
		const base = JSON.stringify({
			id: ID,
			pushId: ID,
			createdAt: "2000-01-01T00:00:00.000Z",
			feature: "post",
			identity: { sourceKey: "bilibili", externalId: "u1" },
			subscriptionId: "11111111-1111-4111-8111-111111111111",
			targetId: "22222222-2222-4222-8222-222222222222",
			status: "delivered",
			messages: [
				{
					payload: { kind: "text", text: "卡片" },
					role: "main",
					result: { ok: true, latencyMs: 1 },
				},
			],
		});
		const patch = JSON.stringify({
			rowId: ID,
			status: "delivered",
			messages: [
				{
					payload: { kind: "image", text: "词云", imageRef: "cloud.png" },
					role: "extra",
					result: { ok: true, latencyMs: 1 },
				},
			],
		});
		await writeFile(join(dataDir, "history", "2000-01-01.jsonl"), `${base}\n${patch}\n`);
		await writeFile(join(dataDir, "history", "img", "cloud.png"), "词云图");

		start(30);
		await vi.waitFor(async () => {
			expect(await readdir(join(dataDir, "history", "img"))).not.toContain("cloud.png");
		});
	});

	it("返回值即 setInterval handle;按 intervalMs 注册", () => {
		const handle = start(30, 1234);
		expect(setInterval_).toHaveBeenCalledTimes(1);
		expect(setInterval_.mock.calls[0]?.[1]).toBe(1234);
		expect(handle).toBe(intervalHandle);
	});
});

/**
 * **图清到哪一天,记一条水位线**(ADR-0022 决策 9 下 10-04 的 🔗):`history/retention.json` 的 `clearedThrough`
 * 是 UTC 日、含当天,只往前走。文字不删以后日文件永远在,不记的话每一轮都得把所有到期的日文件重新解析一遍;
 * 面板上「图已清理」也按它判 —— 按行龄现算的话,天数一调大,已经清掉的行就会说自己还有图。
 */
describe("水位线", () => {
	// 保留 30 天、此刻 06-15:截止日是 05-16,05-15 及以前到期。
	const NOW = new Date("2026-06-15T12:00:00.000Z");
	const mark = (day: string) => JSON.stringify({ clearedThrough: day });

	it("清完把水位线记到截止日的前一天", async () => {
		await seedDay("2026-05-15", "expired.png");
		await seedDay("2026-05-16", "kept.png");
		start(30, undefined, undefined, NOW);
		await ctx.settled();
		expect(await images()).toEqual(["kept.png"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("只扫水位线之后的日子:以前清过的那几天不重读", async () => {
		await seedDay("2026-05-08", "before-mark.png");
		await seedDay("2026-05-12", "after-mark.png");
		await writeMark(mark("2026-05-10"));
		start(30, undefined, undefined, NOW);
		await ctx.settled();
		expect(await images()).toEqual(["before-mark.png"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("天数调大:水位线不后退,什么都不删", async () => {
		await seedDay("2026-05-20", "recent.png");
		await writeMark(mark("2026-05-15"));
		start(60, undefined, undefined, NOW);
		await ctx.settled();
		expect(await images()).toEqual(["recent.png"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("天数调小:水位线往前推,新到期的那几天清掉", async () => {
		await seedDay("2026-06-01", "newly-expired.png");
		await seedDay("2026-06-10", "still-kept.png");
		await writeMark(mark("2026-05-15"));
		// 保留 7 天:截止日 06-08,06-07 及以前到期。
		start(7, undefined, undefined, NOW);
		await ctx.settled();
		expect(await images()).toEqual(["still-kept.png"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-06-07");
	});

	it("重推原件跟着同一条水位线:到期那几天的原件目录一起清", async () => {
		await seedDraft("2026-05-15");
		await seedDraft("2026-05-16");
		start(30, undefined, createRepushStore({ dataRoot: dataDir, logger }), NOW);
		await ctx.settled();
		expect(await listRepushDays(dataDir)).toEqual(["2026-05-16"]);
	});

	it("水位线文件读不懂:当成还没清过,清完写回好的", async () => {
		await seedDay("2026-05-01", "expired.png");
		await writeMark("{坏的");
		start(30, undefined, undefined, NOW);
		await ctx.settled();
		expect(await images()).toEqual([]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("没有水位线文件:读回 undefined", async () => {
		expect(await readClearedThrough(dataDir)).toBeUndefined();
	});
});
