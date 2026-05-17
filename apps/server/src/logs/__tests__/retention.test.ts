/**
 * 守护 — `startLogRetention`(按日 log 归档保留清理)。镜像 history
 * retention 守护契约,改读 `globals.app.logRetentionDays` + `<dataDir>/logs`。
 *
 *   - logRetentionDays<=0 → 整轮跳过
 *   - 仅删 date < UTC cutoff 的日文件,今日文件保留
 *   - 启动即跑一次;返回值即 setInterval handle
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Disposable } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLogRetention } from "../retention.js";
import { listLogDayFiles } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let intervalHandle: Disposable;
let setInterval_: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-logret-"));
	logger = makeLogger();
	intervalHandle = { dispose: vi.fn() };
	setInterval_ = vi.fn(() => intervalHandle);
});
afterEach(() => vi.restoreAllMocks());

function start(days: number, intervalMs?: number) {
	return startLogRetention({
		serviceCtx: { setInterval: setInterval_ } as never,
		store: {
			getGlobals: () => ({ app: { logRetentionDays: days } }),
			bootstrap: { dataDir },
		} as never,
		logger,
		intervalMs,
	});
}

const today = new Date().toISOString().slice(0, 10);

describe("startLogRetention", () => {
	it("days<=0:整轮跳过,旧文件保留", async () => {
		await mkdir(join(dataDir, "logs"), { recursive: true });
		await writeFile(join(dataDir, "logs", "2000-01-01.jsonl"), "x\n");
		start(0);
		await new Promise((r) => setTimeout(r, 20));
		expect(await listLogDayFiles(dataDir)).toContain("2000-01-01.jsonl");
	});

	it("仅删 date < cutoff 的日文件,今日文件保留", async () => {
		await mkdir(join(dataDir, "logs"), { recursive: true });
		await writeFile(join(dataDir, "logs", "2000-01-01.jsonl"), "old\n");
		await writeFile(join(dataDir, "logs", `${today}.jsonl`), "fresh\n");
		start(7);
		await vi.waitFor(async () => {
			const files = await listLogDayFiles(dataDir);
			expect(files).not.toContain("2000-01-01.jsonl");
			expect(files).toContain(`${today}.jsonl`);
		});
	});

	it("返回值即 setInterval handle;按 intervalMs 注册", () => {
		const handle = start(7, 4321);
		expect(setInterval_).toHaveBeenCalledTimes(1);
		expect(setInterval_.mock.calls[0]?.[1]).toBe(4321);
		expect(handle).toBe(intervalHandle);
	});
});
