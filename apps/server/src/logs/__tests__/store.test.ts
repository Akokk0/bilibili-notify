/**
 * 数据完整性守护 — `createLogStore` 缓冲写。
 *
 * 关键不变量(grilled 决策 4):缓冲批量 flush,但 serviceCtx dispose /
 * SIGINT 必须 final flush —— 优雅关停绝不丢未刷尾批。
 * 另守:floor 闸按 rank 过滤(低于 logArchiveFloor 不写盘);query 新→旧 +
 * 封顶 500 + 单日过滤 + 未刷 buffer 也可见(否则刚开页有空洞)。
 * 复发点:去掉 onDispose final flush / floor 比较写反 / query 漏 pending。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry, LogLevel } from "../../ws/types.js";
import { createLogStore } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** ServiceContext fake:捕获 onDispose 钩子 + setInterval(不自动触发)。 */
function makeCtx() {
	let disposeHook: (() => Promise<void> | void) | undefined;
	const ctx = {
		logger: makeLogger(),
		setInterval: vi.fn(() => ({ dispose: vi.fn() })),
		setTimeout: vi.fn(() => ({ dispose: vi.fn() })),
		onDispose: vi.fn((fn: () => Promise<void> | void) => {
			disposeHook = fn;
		}),
	} as unknown as ServiceContext;
	return { ctx, fireDispose: () => disposeHook?.() };
}

function entry(over: Partial<LogEntry>): LogEntry {
	return { level: "info", msg: "m", args: [], ts: new Date().toISOString(), ...over };
}

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-logstore-"));
});

async function readDay(day: string): Promise<string> {
	try {
		return await readFile(join(dataDir, "logs", `${day}.jsonl`), "utf8");
	} catch {
		return "";
	}
}

const today = new Date().toISOString().slice(0, 10);

describe("createLogStore — dispose final-flush(数据完整性)", () => {
	it("ingest 后不等定时器,dispose 钩子 final flush 写出全部尾批", async () => {
		const { ctx, fireDispose } = makeCtx();
		const store = createLogStore({
			dataDir,
			serviceCtx: ctx,
			logger: makeLogger(),
			getFloor: () => "info" as LogLevel,
		});
		store.ingest(entry({ msg: "a", ts: `${today}T01:00:00.000Z` }));
		store.ingest(entry({ msg: "b", ts: `${today}T01:00:01.000Z` }));
		expect(await readDay(today)).toBe(""); // 还没 flush

		await fireDispose(); // 模拟优雅关停
		const content = await readDay(today);
		expect(content).toContain('"msg":"a"');
		expect(content).toContain('"msg":"b"');
	});

	it("满 MAX_BATCH 立即触发一次 flush(不等 1s 定时器)", async () => {
		const { ctx } = makeCtx();
		const store = createLogStore({
			dataDir,
			serviceCtx: ctx,
			logger: makeLogger(),
			getFloor: () => "info" as LogLevel,
		});
		for (let i = 0; i < 100; i++)
			store.ingest(entry({ msg: `n${i}`, ts: `${today}T02:00:00.000Z` }));
		await vi.waitFor(async () => {
			const c = await readDay(today);
			expect(c).toContain('"msg":"n0"');
			expect(c).toContain('"msg":"n99"');
		});
	});
});

describe("createLogStore — floor 闸 + query", () => {
	it("低于 floor 的级别不写盘(floor=info → debug 丢、warn/error 留)", async () => {
		const { ctx, fireDispose } = makeCtx();
		const store = createLogStore({
			dataDir,
			serviceCtx: ctx,
			logger: makeLogger(),
			getFloor: () => "info" as LogLevel,
		});
		store.ingest(entry({ level: "debug", msg: "DBG", ts: `${today}T03:00:00.000Z` }));
		store.ingest(entry({ level: "warn", msg: "WRN", ts: `${today}T03:00:01.000Z` }));
		store.ingest(entry({ level: "error", msg: "ERR", ts: `${today}T03:00:02.000Z` }));
		await fireDispose();
		const c = await readDay(today);
		expect(c).not.toContain("DBG");
		expect(c).toContain("WRN");
		expect(c).toContain("ERR");
	});

	it("floor 实时读:改为 debug 后新条目写盘", async () => {
		const { ctx, fireDispose } = makeCtx();
		let floor: LogLevel = "error";
		const store = createLogStore({
			dataDir,
			serviceCtx: ctx,
			logger: makeLogger(),
			getFloor: () => floor,
		});
		store.ingest(entry({ level: "info", msg: "before", ts: `${today}T04:00:00.000Z` }));
		floor = "debug";
		store.ingest(entry({ level: "info", msg: "after", ts: `${today}T04:00:01.000Z` }));
		await fireDispose();
		const c = await readDay(today);
		expect(c).not.toContain("before"); // floor=error 时被闸
		expect(c).toContain("after"); // floor 改 debug 后放行
	});

	it("query 新→旧、封顶 500、未刷 buffer 也可见", async () => {
		const { ctx } = makeCtx();
		const store = createLogStore({
			dataDir,
			serviceCtx: ctx,
			logger: makeLogger(),
			getFloor: () => "debug" as LogLevel,
		});
		store.ingest(entry({ msg: "old", ts: `${today}T05:00:00.000Z` }));
		store.ingest(entry({ msg: "new", ts: `${today}T05:00:01.000Z` }));
		// 没 flush,仅在 buffer 里。
		const rows = await store.query({ limit: 10 });
		expect(rows.map((r) => r.msg)).toEqual(["new", "old"]); // 新→旧
		const capped = await store.query({ limit: 1 });
		expect(capped).toHaveLength(1);
	});

	it("query day 过滤:只回该天文件", async () => {
		const { ctx, fireDispose } = makeCtx();
		const store = createLogStore({
			dataDir,
			serviceCtx: ctx,
			logger: makeLogger(),
			getFloor: () => "debug" as LogLevel,
		});
		store.ingest(entry({ msg: "d1", ts: "2020-01-01T00:00:00.000Z" }));
		store.ingest(entry({ msg: "d2", ts: "2020-01-02T00:00:00.000Z" }));
		await fireDispose();
		const only = await store.query({ day: "2020-01-01" });
		expect(only.map((r) => r.msg)).toEqual(["d1"]);
	});
});
