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
 * runOnce 经 ./store.js 的 listDayFiles/deleteDayFile 真实读写 tmpdir。
 */

import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Disposable } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRepushStore, listRepushDays, type RepushStore } from "../repush-store.js";
import { startHistoryRetention } from "../retention.js";
import { listDayFiles } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let intervalHandle: Disposable;
let setInterval_: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-ret-"));
	logger = makeLogger();
	intervalHandle = { dispose: vi.fn() };
	setInterval_ = vi.fn(() => intervalHandle);
});
afterEach(() => vi.restoreAllMocks());

function makeStore(historyRetentionDays: number) {
	return {
		getGlobals: () => ({ app: { historyRetentionDays } }),
		bootstrap: { dataDir },
	};
}

function start(days: number, intervalMs?: number, repush?: RepushStore) {
	return startHistoryRetention({
		serviceCtx: { setInterval: setInterval_ } as never,
		store: makeStore(days) as never,
		logger,
		intervalMs,
		repush,
	});
}

/** 造一份某一天的重推原件。 */
async function seedDraft(day: string): Promise<void> {
	const repush = createRepushStore({ dataDir, logger });
	await repush.append(`row-${day}`, day, [
		{ payload: { kind: "text", text: "x" }, role: "main", reduced: { kind: "text" } },
	]);
}

const today = new Date().toISOString().slice(0, 10);

describe("startHistoryRetention", () => {
	it("days<=0:整轮跳过,旧文件保留", async () => {
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", "2000-01-01.jsonl"), "x\n");
		start(0);
		await new Promise((r) => setTimeout(r, 20));
		expect(await listDayFiles(dataDir)).toContain("2000-01-01.jsonl");
	});

	it("仅删 date < cutoff 的日文件,今日文件保留", async () => {
		await mkdir(join(dataDir, "history"), { recursive: true });
		await writeFile(join(dataDir, "history", "2000-01-01.jsonl"), "old\n");
		await writeFile(join(dataDir, "history", `${today}.jsonl`), "fresh\n");
		start(30);
		await vi.waitFor(async () => {
			const files = await listDayFiles(dataDir);
			expect(files).not.toContain("2000-01-01.jsonl");
			expect(files).toContain(`${today}.jsonl`);
			expect(logger.info).toHaveBeenCalled(); // 删除>0 → info 汇总
		});
	});

	it("单文件删除失败(同名是目录)只 warn,不阻断其它旧文件删除", async () => {
		await mkdir(join(dataDir, "history"), { recursive: true });
		// 同名是目录 → unlink 失败(EISDIR/EPERM),应被 catch 并 warn。
		await mkdir(join(dataDir, "history", "1999-01-01.jsonl"));
		await writeFile(join(dataDir, "history", "1999-01-02.jsonl"), "old\n");
		start(30);
		await vi.waitFor(async () => {
			const files = await listDayFiles(dataDir);
			expect(files).not.toContain("1999-01-02.jsonl"); // 普通旧文件照删
		});
		expect(await listDayFiles(dataDir)).toContain("1999-01-01.jsonl"); // 目录删不掉,仍在
		expect(logger.warn).toHaveBeenCalled();
	});

	/**
	 * **一个数管两处**(ADR-0017 决策 4)。原件比历史活得久没有意义:行都不在了,
	 * 按钮无从长出来,留下的只是盘上一份谁都读不到的推送内容。所以它跟着
	 * `historyRetentionDays` 同一个 cutoff 走,不另开旋钮。
	 */
	it("旧日子的重推原件跟着日文件一起淘汰,今天的留着", async () => {
		await seedDraft("2000-01-01");
		await seedDraft(today);
		start(30, undefined, createRepushStore({ dataDir, logger }));
		await vi.waitFor(async () => {
			const days = await listRepushDays(dataDir);
			expect(days).not.toContain("2000-01-01");
			expect(days).toContain(today);
		});
	});

	it("days<=0:原件也整轮跳过", async () => {
		await seedDraft("2000-01-01");
		start(0, undefined, createRepushStore({ dataDir, logger }));
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
		const row = (id: string, ref: string, ts: string) =>
			`${JSON.stringify({
				id,
				pushId: id,
				ts,
				kind: "dynamic",
				uid: "u1",
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
	});

	// 补丁行里的图也是这一天的 —— 它们跟本体行分在两条 jsonl 行上,漏掉就是半份孤儿。
	it("补丁行引用的图也一起清掉", async () => {
		await mkdir(join(dataDir, "history", "img"), { recursive: true });
		const ID = "55555555-5555-4555-8555-555555555555";
		const base = JSON.stringify({
			id: ID,
			pushId: ID,
			ts: "2000-01-01T00:00:00.000Z",
			kind: "dynamic",
			uid: "u1",
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
			patch: ID,
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
