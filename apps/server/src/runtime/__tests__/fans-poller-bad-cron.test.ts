/**
 * 回归测试 — FansPoller 遇到无法解析的 `app.dynamicCron` 不炸穿启动。
 *
 * dynamicCron 是 dashboard 的自由文本框,没有格式校验,且被 fans-poller 与
 * dynamic-engine 共享读取,各自 `new CronJob(...)` 一次。`cron` 包对无法解析的
 * 表达式(如漏填 minute 字段)同步抛错,此前 fans-poller.startJob() 没有
 * try/catch,未捕获的抛出会让整个独立端进程在启动期崩溃退出 —— 与
 * dynamic-engine.ts 的同款 bug 同源(见 `.bugs/sidecar.stderr.log` 复现的
 * 桌面端"升级后端起不来,清空数据才恢复"报告)。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// cron mock — 镜像真实 `cron` 包对无法解析表达式的同步抛错(同 dynamic-engine.test 套路)。
const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; onTick: () => void }> = [];
	class FakeCronJob {
		isActive = false;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			if (cronTime === "BAD CRON") {
				throw new Error("Field (minute) cannot be parsed");
			}
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
		}
		stop(): void {
			this.isActive = false;
		}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

// SUT imported AFTER vi.mock.
const { startFansPoller } = await import("../fans-poller.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = { app: { fansCron: "BAD CRON" } } as unknown as GlobalConfig;
const SUB = { id: "sub-1", uid: "12345", enabled: true };

let handle: { dispose(): void } | undefined;

beforeEach(() => {
	cronMock.instances.length = 0;
});

afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

describe("FansPoller — 无法解析的 dynamicCron", () => {
	it("启动不抛异常,记录 error 且不建 job;dispose() 也不因 job 缺失而炸", () => {
		const bus = createNodeMessageBus();
		const errorLog = vi.fn();

		expect(() => {
			handle = startFansPoller({
				bus,
				logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorLog } as never,
				configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
				subscriptionStore: { list: () => [SUB] } as never,
				subRuntimeStore: {
					get: () => undefined,
					getAll: () => ({}),
					patch: vi.fn(async () => {}),
					prune: vi.fn(async () => {}),
					load: vi.fn(async () => {}),
				} as never,
				fansStore: {
					append: vi.fn(async () => {}),
					findNearestBefore: vi.fn(async () => null),
					findEarliest: vi.fn(async () => undefined),
					dropUid: vi.fn(async () => {}),
				} as never,
				api: { getUserCardInfo: vi.fn() } as never,
				serviceCtx: {
					setTimeout: vi.fn(() => undefined),
					setInterval: vi.fn(() => undefined),
				} as never,
			});
		}).not.toThrow();

		expect(cronMock.instances).toHaveLength(0);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("BAD CRON"));

		expect(() => handle?.dispose()).not.toThrow();
	});
});
