import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createUptimeRecorder } from "../recorder.js";
import { createUptimeStore, sumUptimeByHour, type UptimeStore } from "../store.js";

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
} as unknown as Logger;

const at = (hhmmss: string) => Date.parse(`2026-10-06T${hhmmss}.000Z`);
const hour = (hh: string, minutes: number) => ({
	hourStartedAt: `2026-10-06T${hh}:00:00.000Z`,
	minutes,
});

let dataRoot: string;
let store: UptimeStore;

interface FakeTimer {
	fn: () => Promise<void>;
	ms: number;
}

/** 假时钟 + 一枚假定时器:测试自己拨时间、自己触发。 */
function harness(startAt: number) {
	let now = startAt;
	let pending: FakeTimer | undefined;
	const recorder = createUptimeRecorder({
		store,
		logger,
		now: () => now,
		timers: {
			set(fn, ms) {
				const handle: FakeTimer = { fn, ms };
				pending = handle;
				return handle;
			},
			clear(handle) {
				if (pending === handle) pending = undefined;
			},
		},
	});
	return {
		recorder,
		setNow(value: number) {
			now = value;
		},
		get pending() {
			return pending;
		},
		/** 时钟拨到 `value` 再让定时器响。 */
		async fireAt(value: number) {
			now = value;
			if (!pending) throw new Error("没有排着的定时器");
			await pending.fn();
		},
	};
}

beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-uptime-recorder-"));
	store = createUptimeStore({ dataRoot, logger });
});
afterEach(async () => {
	await rm(dataRoot, { recursive: true, force: true });
});

describe("运行记录的记录器", () => {
	it("开机在 08:20:每个整点记刚过去的那一小时,关停补当前这一小时", async () => {
		const h = harness(at("08:20:00"));
		h.recorder.start();
		expect(h.pending?.ms).toBe(40 * 60_000);

		await h.fireAt(at("09:00:00"));
		expect(await store.list()).toEqual([hour("08", 40)]);
		expect(h.pending?.ms).toBe(60 * 60_000);

		await h.fireAt(at("10:00:00"));
		expect(await store.list()).toEqual([hour("08", 40), hour("09", 60)]);

		h.setNow(at("10:25:00"));
		await h.recorder.stop();
		expect(await store.list()).toEqual([hour("08", 40), hour("09", 60), hour("10", 25)]);
		expect(h.pending).toBeUndefined();
	});

	it("定时器晚几毫秒响,那一小时仍按整点切,下一小时从整点起算", async () => {
		const h = harness(at("08:20:00"));
		h.recorder.start();
		await h.fireAt(at("09:00:00") + 700);
		await h.fireAt(at("10:00:00") + 300);
		expect(await store.list()).toEqual([hour("08", 40), hour("09", 60)]);
	});

	it("分钟数按经过的毫秒四舍五入", async () => {
		const h = harness(at("08:20:20"));
		h.recorder.start();
		await h.fireAt(at("09:00:00"));
		expect(await store.list()).toEqual([hour("08", 40)]);
	});

	it("同一小时内重启两次:两行,读时相加、封顶 60", async () => {
		const first = harness(at("08:05:00"));
		first.recorder.start();
		first.setNow(at("08:35:00"));
		await first.recorder.stop();

		const second = harness(at("08:40:00"));
		second.recorder.start();
		second.setNow(at("08:58:00"));
		await second.recorder.stop();

		const rows = await store.list();
		expect(rows).toEqual([hour("08", 30), hour("08", 18)]);
		expect(sumUptimeByHour(rows)).toEqual([hour("08", 48)]);

		await store.append(hour("08", 30));
		expect(sumUptimeByHour(await store.list())).toEqual([hour("08", 60)]);
	});

	it("休眠跨了好几个整点:只记最初那一小时到它的整点,之后从醒来时刻重新起算", async () => {
		const h = harness(at("08:20:00"));
		h.recorder.start();
		// 08:20 起睡到 11:30 才醒:09、10 两个整点都被睡过去了。
		await h.fireAt(at("11:30:00"));
		expect(await store.list()).toEqual([hour("08", 40)]);
		// 醒来之后下一枚定时器排到 12:00。
		expect(h.pending?.ms).toBe(30 * 60_000);
		await h.fireAt(at("12:00:00"));
		expect(await store.list()).toEqual([hour("08", 40), hour("11", 30)]);
	});

	it("睡过头之后直接关停:不给睡着的小时补分钟", async () => {
		const h = harness(at("08:20:00"));
		h.recorder.start();
		h.setNow(at("12:10:00"));
		await h.recorder.stop();
		expect(await store.list()).toEqual([hour("08", 40)]);
	});

	it("停了以后拒写:再响的旧定时器、再调 stop 都不写", async () => {
		const h = harness(at("08:20:00"));
		h.recorder.start();
		const stale = h.pending;
		h.setNow(at("08:50:00"));
		await h.recorder.stop();
		expect(await store.list()).toEqual([hour("08", 30)]);

		h.setNow(at("09:30:00"));
		await stale?.fn();
		await h.recorder.stop();
		expect(await store.list()).toEqual([hour("08", 30)]);
		expect(h.pending).toBeUndefined();
	});

	it("start 之前不碰盘、不排定时器;没 start 过的 stop 什么都不写", async () => {
		const h = harness(at("08:20:00"));
		expect(h.pending).toBeUndefined();
		expect(existsSync(join(dataRoot, "uptime"))).toBe(false);
		h.setNow(at("08:50:00"));
		await h.recorder.stop();
		expect(existsSync(join(dataRoot, "uptime"))).toBe(false);
	});

	it("写盘失败不抛出:记一句 warn", async () => {
		const failing: UptimeStore = {
			...store,
			append: async () => {
				throw new Error("disk full");
			},
		};
		let now = at("08:20:00");
		let cb: (() => Promise<void>) | undefined;
		const recorder = createUptimeRecorder({
			store: failing,
			logger,
			now: () => now,
			timers: {
				set: (fn) => {
					cb = fn;
					return fn;
				},
				clear: () => {},
			},
		});
		recorder.start();
		now = at("09:00:00");
		await expect(cb?.()).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalled();
	});
});
