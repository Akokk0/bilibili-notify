/**
 * 守护 — `startLogRetention`(按日 log 归档保留清理)。镜像 history
 * retention 守护契约,改读 `globals.logging.retentionDays` + `<dataDir>/logs`。
 *
 *   - retentionDays<=0 → 整轮跳过
 *   - 仅删 date < UTC cutoff 的日文件,今日文件保留
 *   - 启动即跑一次;返回值即 setInterval handle
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { startLogRetention } from "../retention.js";
import { listLogDayFiles } from "../store.js";

// 删文件前的一道闸:默认敞开,「登记进 track」那几条用例把删除停在半路。
const gate = vi.hoisted(() => ({
	holding: undefined as Promise<void> | undefined,
	arrived: undefined as (() => void) | undefined,
}));
vi.mock("../store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../store.js")>();
	return {
		...actual,
		deleteLogDayFile: async (...args: Parameters<typeof actual.deleteLogDayFile>) => {
			gate.arrived?.();
			await gate.holding;
			return actual.deleteLogDayFile(...args);
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

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-logret-"));
	logger = makeLogger();
	intervalHandle = { dispose: vi.fn() };
	setInterval_ = vi.fn(() => intervalHandle);
	ctx = makeTrackingContext();
});
afterEach(() => {
	gate.holding = undefined;
	gate.arrived = undefined;
	vi.restoreAllMocks();
});

function start(days: number, intervalMs?: number) {
	return startLogRetention({
		serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
		store: {
			getGlobals: () => ({ logging: { retentionDays: days } }),
		} as never,
		hostRoot: dataDir,
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

	// 清理是删盘上的文件。不登记的话,关停会在它删到一半时让各写道关门、返回。
	it("开机那一轮登记进 track:旧日文件删完它才落定", async () => {
		await mkdir(join(dataDir, "logs"), { recursive: true });
		await writeFile(join(dataDir, "logs", "2000-01-01.jsonl"), "old\n");
		const release = deferred();
		const reached = deferred();
		gate.holding = release.promise;
		gate.arrived = reached.resolve;

		start(7);

		expect(ctx.tracked).toHaveLength(1);
		await reached.promise; // 删除走到了闸口,文件还在盘上
		expect(await stillPending(ctx.settled())).toBe(true);
		expect(await listLogDayFiles(dataDir)).toContain("2000-01-01.jsonl");
		release.resolve();
		await ctx.settled();
		expect(await listLogDayFiles(dataDir)).not.toContain("2000-01-01.jsonl");
	});

	it("定时那一轮同样登记,旧日文件删完它才落定", async () => {
		await mkdir(join(dataDir, "logs"), { recursive: true });
		start(7); // 开机那一轮盘上什么都没有
		await ctx.settled();
		await writeFile(join(dataDir, "logs", "2000-01-02.jsonl"), "old\n");
		const release = deferred();
		const reached = deferred();
		gate.holding = release.promise;
		gate.arrived = reached.resolve;

		const tick = setInterval_.mock.calls[0]?.[0] as () => void;
		tick();

		expect(ctx.tracked).toHaveLength(2);
		const [, second] = ctx.tracked as [Promise<unknown>, Promise<unknown>];
		await reached.promise;
		expect(await stillPending(second)).toBe(true);
		release.resolve();
		await second;
		expect(await listLogDayFiles(dataDir)).not.toContain("2000-01-02.jsonl");
	});

	it("一轮抛错:登记进去的那件事不拒,只记一条 warn", async () => {
		startLogRetention({
			serviceCtx: { setInterval: setInterval_, track: ctx.track, signal: ctx.signal } as never,
			store: {
				getGlobals: () => {
					throw new Error("boom");
				},
			} as never,
			hostRoot: dataDir,
			logger,
		});

		const [task] = ctx.tracked;
		await expect(task).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith("日志保留期清理失败", {
			stage: "startup",
			error: expect.any(Error),
		});
	});
});
