/**
 * 单元测试 — `startHistoryRetention`(推送历史的保留:文字不删,图与重推原件按天数清)。
 *
 * 守护契约:
 *   - 到期的日子(date < UTC 截止日)只清重推原件,日文件(文字)一份都不删;今天的不动。**清扫不碰图**(⑳d):图在图库里,
 *     水位线推过去以后那几天的行不再是引用方,同一轮末尾的图库清扫按引用收走
 *   - 清到哪一天记成水位线 `history/retention.json`,只往前走
 *   - 某一天的原件目录清不动不拦别的到期日,水位线照推
 *   - 启动即跑一次 runOnce(无需等定时器)
 *   - 返回值即 serviceCtx.setInterval 的 handle
 *   - **重推原件跟着同一个 cutoff 走**(ADR-0017 决策 4:一个数管两处)
 *   - `listHistoryImageRefs`:历史这一家引用方只数水位线之后的日文件(本体行、补丁行、头像快照),读不了就抛
 *
 * runOnce 经 ./store.js 的 listDayFiles 与 ./repush-store.js 的 dropRepushDay 真实读写 tmpdir。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Disposable } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vite-plus/test";
import { distinctPng } from "../../__tests__/support/chat-images.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import { i18n } from "../../i18n/index.js";
import { IMAGE_GRACE_MS, type ImageStore } from "../../images/image-store.js";
import { createRepushStore, listRepushDays } from "../repush-store.js";
import { listHistoryImageRefs, readClearedThrough, startHistoryRetention } from "../retention.js";
import { listDayFiles } from "../store.js";

// 清一天原件目录的那一步套一层钩子:登记进 track 的测试要卡住它、失败的测试要让它抛。真的删照做。
const dropHook = vi.hoisted(() => ({
	before: undefined as undefined | ((day: string) => Promise<void>),
}));
vi.mock("../repush-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../repush-store.js")>();
	return {
		...actual,
		dropRepushDay: async (dataRoot: string, day: string) => {
			await dropHook.before?.(day);
			return actual.dropRepushDay(dataRoot, day);
		},
	};
});

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let intervalHandle: Disposable;
let setInterval_: ReturnType<typeof vi.fn>;
let ctx: TrackingContext;
/** 图库清扫的替身:记下每一轮被叫到时的此刻与当时的水位线。 */
let imageSweeps: { now: Date; clearedThrough: string | undefined }[];
let imageStore: { sweep: Mock<ImageStore["sweep"]> };

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-ret-"));
	dropHook.before = undefined;
	logger = makeLogger();
	intervalHandle = { dispose: vi.fn() };
	setInterval_ = vi.fn(() => intervalHandle);
	ctx = makeTrackingContext();
	imageSweeps = [];
	imageStore = {
		sweep: vi.fn<ImageStore["sweep"]>(async ({ now }) => {
			imageSweeps.push({ now, clearedThrough: await readClearedThrough(dataDir) });
			return { removed: [], removedBytes: 0, referenced: 0, inGrace: 0 };
		}),
	};
});
afterEach(async () => {
	vi.restoreAllMocks();
	i18n.set({ locale: "zh-CN", voice: "maid" });
	await rm(dataDir, { recursive: true, force: true });
});

function makeStore(retentionDays: number) {
	return {
		getGlobals: () => ({ history: { retentionDays } }),
	};
}

function start(
	days: number,
	intervalMs?: number,
	now?: Date,
	images: Pick<ImageStore, "sweep"> = imageStore,
) {
	return startHistoryRetention({
		serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
		store: makeStore(days) as never,
		dataRoot: dataDir,
		images,
		logger,
		intervalMs,
		now: now ? () => now : undefined,
	});
}

/** 一行带一张图的历史(图库引用 `ref`)。 */
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
				payload: { kind: "image", text: "x", image: ref },
				role: "main",
				result: { ok: true, latencyMs: 1 },
			},
		],
	})}\n`;
}

/** 造一天的历史:一行,引用图库里的 `ref`(这里不真放图,只看谁引用谁)。 */
async function seedDay(day: string, ref: string): Promise<void> {
	await mkdir(join(dataDir, "history"), { recursive: true });
	await writeFile(
		join(dataDir, "history", `${day}.jsonl`),
		imageRow(randomUUID(), ref, `${day}T08:00:00.000Z`),
	);
}

/** 第 `n` 张互不相同的图库引用(摘要不同,形状对)。 */
const refOf = (n: number) => `${n.toString(16).padStart(64, "0")}.png`;

async function writeMark(text: string): Promise<void> {
	await mkdir(join(dataDir, "history"), { recursive: true });
	await writeFile(join(dataDir, "history", "retention.json"), text);
}

/** 造一份某一天的重推原件。 */
async function seedDraft(day: string): Promise<void> {
	const images = makeHistoryImages(dataDir);
	const repush = createRepushStore({
		dataRoot: dataDir,
		logger,
		images: images.repushImages,
		imageStore: images.imageStore,
	});
	await repush.append(`row-${day}`, day, [{ payload: { kind: "text", text: "x" }, role: "main" }]);
}

const today = new Date().toISOString().slice(0, 10);

describe("startHistoryRetention — 登记进 track", () => {
	// 清理是删盘上的文件。不登记的话,关停会在它删到一半时让各写道关门、返回 —— 返回之后数据目录还在变。
	it("开机那一轮:重推原件删完它才落定", async () => {
		await seedDraft("2000-01-01");
		const release = deferred();
		const dropped: string[] = [];
		dropHook.before = async (day) => {
			await release.promise;
			dropped.push(day);
		};
		start(30);

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
		dropHook.before = async (day) => {
			await release.promise;
			dropped.push(day);
		};
		// 开机那一轮盘上什么都没有,只把水位线记到 05-15;过了一天又有一天到期(05-16),定时那一轮去清它。
		let clock = new Date("2026-06-15T12:00:00.000Z");
		startHistoryRetention({
			serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
			store: makeStore(30) as never,
			dataRoot: dataDir,
			images: imageStore,
			logger,
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
			images: imageStore,
			logger,
		});

		const [task] = ctx.tracked;
		await expect(task).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			"历史留存清理失败",
			expect.objectContaining({ stage: "startup", error: expect.any(Error) }),
		);
	});
});

describe("留存诊断", () => {
	it("同一个清扫任务按输出时语言记录平实说明，并保留原错误与 cause", async () => {
		const cause = new Error("disk unavailable");
		const error = new Error("raw sweep failure", { cause });
		imageStore.sweep.mockRejectedValue(error);
		start(30);
		await ctx.settled();
		expect(logger.warn).toHaveBeenLastCalledWith("图库清扫失败", { error });
		for (const [locale, text] of [
			["en", "Image library sweep failed"],
			["ja", "画像ライブラリのクリーンアップに失敗しました"],
			["zh-TW", "圖片庫清理失敗"],
		] as const) {
			i18n.set({ locale, voice: "maid" });
			setInterval_.mock.calls[0]?.[0]();
			await ctx.settled();
			expect(logger.warn).toHaveBeenLastCalledWith(text, { error });
			expect(logger.warn.mock.calls.at(-1)?.[1]?.error).toBe(error);
		}
		expect(imageStore.sweep).toHaveBeenCalledTimes(4);
		expect(cause.message).toBe("disk unavailable");
	});
});

describe("图库清扫挂在同一个活上", () => {
	// ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗:先推水位线、紧接着清图库 —— 过期的行不再算引用方,图才清得掉。
	it("水位线推完才清图库,用的是同一个此刻", async () => {
		const now = new Date("2026-06-15T12:00:00.000Z");
		start(30, undefined, now);
		await ctx.settled();

		expect(imageSweeps).toEqual([{ now, clearedThrough: "2026-05-15" }]);
	});

	it("定时那一轮也清", async () => {
		start(30);
		await ctx.settled();
		const tick = setInterval_.mock.calls[0]?.[0] as () => void;
		tick();
		await ctx.settled();

		expect(imageStore.sweep).toHaveBeenCalledTimes(2);
	});

	it("图库清扫抛错只记 warn,这一轮照样算完", async () => {
		imageStore.sweep.mockRejectedValueOnce(new Error("读不了盘"));
		start(30);

		const [task] = ctx.tracked;
		await expect(task).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith("图库清扫失败", {
			error: expect.objectContaining({ message: "读不了盘" }),
		});
	});

	it("历史那半抛错,图库照清:聊天附件、头像的图不该等历史修好", async () => {
		startHistoryRetention({
			serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
			store: {
				getGlobals: () => {
					throw new Error("boom");
				},
			} as never,
			dataRoot: dataDir,
			images: imageStore,
			logger,
		});
		await ctx.settled();

		expect(imageStore.sweep).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			"历史留存清理失败",
			expect.objectContaining({ stage: "startup", error: expect.any(Error) }),
		);
	});

	it("删了图就记一条 info", async () => {
		imageStore.sweep.mockResolvedValueOnce({
			removed: ["a.png", "b.png"],
			removedBytes: 20,
			referenced: 3,
			inGrace: 1,
		});
		start(30);
		await ctx.settled();

		expect(logger.info).toHaveBeenCalledWith("已清理未被引用的图片", { count: 2 });
	});
});

describe("startHistoryRetention", () => {
	// 文字不设上限(ADR-0022 决策 9):到期只清重推原件(图归图库的清扫),日文件一份都不删。
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

	// 清扫不再读日文件(从前要读它们数引用的图):日文件坏了、同名是目录,照样清原件、推水位线。
	it("日文件读不出来(同名是目录)也不碍事:到期日的原件照清", async () => {
		await mkdir(join(dataDir, "history", "1999-01-01.jsonl"), { recursive: true });
		await seedDraft("1999-01-02");
		start(30);
		await ctx.settled();
		expect(await listRepushDays(dataDir)).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("某一天的原件目录清不动:记一条 warn、不拦别的到期日,水位线照推", async () => {
		await seedDraft("1999-01-01");
		await seedDraft("1999-01-02");
		dropHook.before = async (day) => {
			if (day === "1999-01-01") throw new Error("清不动");
		};
		start(30, undefined, new Date("2026-06-15T12:00:00.000Z"));
		await ctx.settled();

		expect(await listRepushDays(dataDir)).toEqual(["1999-01-01"]);
		expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
			day: "1999-01-01",
			error: expect.any(Error),
		});
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	/**
	 * **一个数管两处**(ADR-0017 决策 4)。原件比历史活得久没有意义:行都不在了,
	 * 按钮无从长出来,留下的只是盘上一份谁都读不到的推送内容。所以它跟着
	 * `historyRetentionDays` 同一个 cutoff 走,不另开旋钮。
	 */
	it("旧日子的重推原件到期就清,今天的留着", async () => {
		await seedDraft("2000-01-01");
		await seedDraft(today);
		start(30);
		await vi.waitFor(async () => {
			const days = await listRepushDays(dataDir);
			expect(days).not.toContain("2000-01-01");
			expect(days).toContain(today);
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
 * **图清没清按一条水位线判,图本身由图库的按引用清扫收走**(ADR-0022 决策 9 下 10-04 的 🔗):
 * `history/retention.json` 的 `clearedThrough` 是 UTC 日、含当天,只往前走。文字不删以后日文件永远在,不记的话每一轮都得
 * 把所有到期的日文件重新解析一遍;面板上「图已清理」也按它判 —— 按行龄现算的话,天数一调大,已经清掉的行就会说自己还有图。
 */
describe("水位线", () => {
	// 保留 30 天、此刻 06-15:截止日是 05-16,05-15 及以前到期。
	const NOW = new Date("2026-06-15T12:00:00.000Z");
	const mark = (day: string) => JSON.stringify({ clearedThrough: day });

	it("清完把水位线记到截止日的前一天,到期那几天的原件目录没了", async () => {
		await seedDraft("2026-05-15");
		await seedDraft("2026-05-16");
		start(30, undefined, NOW);
		await ctx.settled();
		expect(await listRepushDays(dataDir)).toEqual(["2026-05-16"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("天数调大:水位线不后退,什么都不清", async () => {
		await seedDraft("2026-05-20");
		await writeMark(mark("2026-05-15"));
		start(60, undefined, NOW);
		await ctx.settled();
		expect(await listRepushDays(dataDir)).toEqual(["2026-05-20"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("天数调小:水位线往前推,新到期的那几天清掉", async () => {
		await seedDraft("2026-06-01");
		await seedDraft("2026-06-10");
		await writeMark(mark("2026-05-15"));
		// 保留 7 天:截止日 06-08,06-07 及以前到期。
		start(7, undefined, NOW);
		await ctx.settled();
		expect(await listRepushDays(dataDir)).toEqual(["2026-06-10"]);
		expect(await readClearedThrough(dataDir)).toBe("2026-06-07");
	});

	it("水位线文件读不懂:当成还没清过,清完写回好的", async () => {
		await seedDraft("2026-05-01");
		await writeMark("{坏的");
		start(30, undefined, NOW);
		await ctx.settled();
		expect(await listRepushDays(dataDir)).toEqual([]);
		expect(await readClearedThrough(dataDir)).toBe("2026-05-15");
	});

	it("没有水位线文件:读回 undefined", async () => {
		expect(await readClearedThrough(dataDir)).toBeUndefined();
	});
});

/**
 * **历史这一家图库引用方**:保留期内——水位线之后——的日文件里所有消息的 `image` 与行的 `avatarSnapshot`,本体行与
 * 补丁行都数。过了水位线的行不算,否则水位线白推、图永远清不掉。
 */
describe("listHistoryImageRefs — 历史这一家的名单", () => {
	const mark = (day: string) => JSON.stringify({ clearedThrough: day });
	const ID = "55555555-5555-4555-8555-555555555555";

	it("只数水位线之后的日文件:水位线及以前的行不算引用方", async () => {
		await seedDay("2026-05-14", refOf(1));
		await seedDay("2026-05-15", refOf(2));
		await seedDay("2026-05-16", refOf(3));
		await seedDay("2026-05-17", refOf(4));
		await writeMark(mark("2026-05-15"));

		expect((await listHistoryImageRefs(dataDir)).sort()).toEqual([refOf(3), refOf(4)].sort());
	});

	it("没有水位线(或读不懂)当成没清过:全数,宁多勿少", async () => {
		await seedDay("2026-05-14", refOf(1));
		await seedDay("2026-05-16", refOf(2));
		expect((await listHistoryImageRefs(dataDir)).sort()).toEqual([refOf(1), refOf(2)].sort());
		await writeMark("{坏的");
		expect(await listHistoryImageRefs(dataDir)).toHaveLength(2);
	});

	it("补丁行里的图、行的头像快照也数", async () => {
		const base = JSON.stringify({
			id: ID,
			pushId: ID,
			createdAt: "2026-05-16T00:00:00.000Z",
			feature: "post",
			identity: { sourceKey: "douyin", externalId: "u1" },
			subscriptionId: "11111111-1111-4111-8111-111111111111",
			targetId: "22222222-2222-4222-8222-222222222222",
			status: "delivered",
			messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
			avatarSnapshot: refOf(7),
		});
		const patch = JSON.stringify({
			rowId: ID,
			status: "delivered",
			messages: [{ payload: { kind: "image", text: "词云", image: refOf(8) }, role: "extra" }],
		});
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", "2026-05-16.jsonl"), `${base}\n${patch}\n`);
		await writeMark(mark("2026-05-15"));

		expect((await listHistoryImageRefs(dataDir)).sort()).toEqual([refOf(7), refOf(8)].sort());
	});

	it("保留期内的日文件读不动(同名是目录):抛,图库清扫这一轮一张不删", async () => {
		await mkdir(join(dataDir, "history", "2026-05-16.jsonl"), { recursive: true });
		await writeMark(mark("2026-05-15"));
		await expect(listHistoryImageRefs(dataDir)).rejects.toThrow();
		// 过了水位线的那份读不动没关系:不数它。
		await rm(join(dataDir, "history", "2026-05-16.jsonl"), { recursive: true });
		await mkdir(join(dataDir, "history", "2026-05-14.jsonl"), { recursive: true });
		await expect(listHistoryImageRefs(dataDir)).resolves.toEqual([]);
	});

	it("历史目录列不出来(同名是文件):抛,不当成一天都没有", async () => {
		// 当成空名单的话,只被历史行引用的图在这一轮清扫里全成了没人引用的。
		await writeFile(join(dataDir, "history"), "不是目录");
		await expect(listHistoryImageRefs(dataDir)).rejects.toThrow();
	});

	it("没有历史目录 → 空", async () => {
		expect(await listHistoryImageRefs(dataDir)).toEqual([]);
	});
});

/**
 * **接线:水位线一推,图库的清扫才收得走只被那几天的行引用的图**(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗)。
 * 真图库 + 真登记的两家引用方(历史、重推原件),一轮 `runOnce` 先推水位线、紧接着清图库。
 */
describe("保留期 → 图库清扫", () => {
	// 保留 30 天、此刻 06-15:05-15 及以前到期。清扫的时钟拨到宽限期之后(图都是刚存的)。
	const NOW = new Date("2026-06-15T12:00:00.000Z");
	const SWEEP_NOW = new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
	let library: ReturnType<typeof makeHistoryImages>;

	beforeEach(() => {
		library = makeHistoryImages(dataDir);
	});

	/** 往图库放第 `n` 张图并让某一天的一行引用它,回引用。 */
	async function seedRowWithImage(day: string, n: number): Promise<string> {
		const stored = await library.historyImages.put(distinctPng(n));
		if (!stored.ok) throw new Error(stored.message);
		await seedDay(day, stored.ref);
		return stored.ref;
	}

	/** 跑一轮保留期清扫(历史水位线 + 图库清扫,后者的此刻拨到宽限期之后)。 */
	async function runRound(): Promise<string[]> {
		let removed: string[] = [];
		start(30, undefined, NOW, {
			sweep: async () => {
				const report = await library.imageStore.sweep({ now: SWEEP_NOW });
				removed = report.removed;
				return report;
			},
		});
		await ctx.settled();
		return removed;
	}

	it("只被过了保留期的行引用的图:水位线推过去、这一轮图库清扫就收走,行(文字)还在", async () => {
		const expired = await seedRowWithImage("2026-05-10", 1);
		const kept = await seedRowWithImage("2026-06-10", 2);

		const removed = await runRound();

		expect(removed).toEqual([expired]);
		expect(await readdir(join(dataDir, "images"))).toEqual([kept]);
		expect(await listDayFiles(dataDir)).toContain("2026-05-10.jsonl");
	});

	it("同一张图还被保留期内的另一行引用:不删", async () => {
		const stored = await library.historyImages.put(distinctPng(3));
		if (!stored.ok) throw new Error(stored.message);
		await seedDay("2026-05-10", stored.ref);
		await seedDay("2026-06-10", stored.ref);

		const removed = await runRound();

		expect(removed).toEqual([]);
		expect(await readdir(join(dataDir, "images"))).toEqual([stored.ref]);
	});

	it("同一张图还被重推原件引用(原件的日子在保留期内):不删;原件的日目录一没,下一轮才收走", async () => {
		const stored = await library.historyImages.put(distinctPng(4));
		if (!stored.ok) throw new Error(stored.message);
		await seedDay("2026-05-10", stored.ref);
		const repush = createRepushStore({
			dataRoot: dataDir,
			logger,
			images: library.repushImages,
			imageStore: library.imageStore,
		});
		await repush.append("row-in-retention", "2026-06-10T08:00:00.000Z", [
			{
				payload: { kind: "image", image: { buffer: distinctPng(4), mime: "image/png" } },
				role: "main",
			},
		]);

		// 历史那一家这一轮不再引用它(行在 05-10),留住它的只可能是「重推原件」这一家。
		expect(await runRound()).toEqual([]);
		expect(await readdir(join(dataDir, "images"))).toEqual([stored.ref]);

		await rm(join(dataDir, "history", "repush"), { recursive: true });
		expect(await library.imageStore.sweep({ now: SWEEP_NOW })).toMatchObject({
			removed: [stored.ref],
		});
	});
});
