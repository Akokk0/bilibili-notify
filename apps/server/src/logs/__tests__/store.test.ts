/**
 * 数据完整性守护 — `createLogStore` 缓冲写。
 *
 * 关键不变量(grilled 决策 4):缓冲批量 flush,但 serviceCtx dispose /
 * SIGINT 必须 final flush —— 优雅关停绝不丢未刷尾批。
 * 另守:ingest 无条件入缓冲(等级过滤已上移到 service-context.ts `fanOut`
 * 的 `isLevelEnabled` 守卫,store 不再有 floor);query 新→旧 + 封顶 500 +
 * 单日过滤 + 未刷 buffer 也可见(否则刚开页有空洞)。
 * 复发点:去掉 onDispose final flush / store 又长出第二道 floor / query 漏 pending。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LogEntry } from "../../ws/types.js";
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
		const store = createLogStore({ dataDir, serviceCtx: ctx, logger: makeLogger() });
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
		const store = createLogStore({ dataDir, serviceCtx: ctx, logger: makeLogger() });
		for (let i = 0; i < 100; i++)
			store.ingest(entry({ msg: `n${i}`, ts: `${today}T02:00:00.000Z` }));
		await vi.waitFor(async () => {
			const c = await readDay(today);
			expect(c).toContain('"msg":"n0"');
			expect(c).toContain('"msg":"n99"');
		});
	});
});

describe("createLogStore — ingest 无条件 + query", () => {
	it("store 不再有 floor:debug/info/warn/error 全部照写(过滤已上移 fanOut)", async () => {
		const { ctx, fireDispose } = makeCtx();
		const store = createLogStore({ dataDir, serviceCtx: ctx, logger: makeLogger() });
		store.ingest(entry({ level: "debug", msg: "DBG", ts: `${today}T03:00:00.000Z` }));
		store.ingest(entry({ level: "info", msg: "INF", ts: `${today}T03:00:01.000Z` }));
		store.ingest(entry({ level: "warn", msg: "WRN", ts: `${today}T03:00:02.000Z` }));
		store.ingest(entry({ level: "error", msg: "ERR", ts: `${today}T03:00:03.000Z` }));
		await fireDispose();
		const c = await readDay(today);
		// 关键:debug 也写盘 —— 证明 store 不再自带 floor。能不能产生 debug
		// 由上游各模块 pino level 决定,store 拿到什么就落什么。
		expect(c).toContain("DBG");
		expect(c).toContain("INF");
		expect(c).toContain("WRN");
		expect(c).toContain("ERR");
	});

	it("query 新→旧、封顶 500、未刷 buffer 也可见", async () => {
		const { ctx } = makeCtx();
		const store = createLogStore({ dataDir, serviceCtx: ctx, logger: makeLogger() });
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
		const store = createLogStore({ dataDir, serviceCtx: ctx, logger: makeLogger() });
		store.ingest(entry({ msg: "d1", ts: "2020-01-01T00:00:00.000Z" }));
		store.ingest(entry({ msg: "d2", ts: "2020-01-02T00:00:00.000Z" }));
		await fireDispose();
		const only = await store.query({ day: "2020-01-01" });
		expect(only.map((r) => r.msg)).toEqual(["d1"]);
	});
});
