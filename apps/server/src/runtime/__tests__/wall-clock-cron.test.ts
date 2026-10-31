import { CronJob, CronTime } from "cron";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const jobs: CronJob[] = [];
afterEach(() => {
	for (const job of jobs.splice(0)) job.stop();
	vi.useRealTimers();
});

describe("pinned cron wall-clock behavior", () => {
	it("waits for an early timer, fires once, and keeps the following slot", async () => {
		vi.useFakeTimers();
		const start = Date.parse("2026-10-31T00:00:00Z");
		vi.setSystemTime(start);
		const tick = vi.fn();
		const job = new CronJob("* * * * * *", tick, null, false, "UTC");
		jobs.push(job);
		job.start();
		// Node's monotonic timer can wake before the wall clock reaches its target.
		vi.setSystemTime(start - 2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(tick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(tick).toHaveBeenCalledTimes(2);
		job.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels the old timezone timer before starting the replacement", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-31T00:59:59Z"));
		const tick = vi.fn();
		const old = new CronJob("0 0 9 * * *", tick, null, false, "Asia/Shanghai");
		const next = new CronJob("0 0 9 * * *", tick, null, false, "UTC");
		jobs.push(old, next);
		old.start();
		old.stop();
		next.start();
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(8 * 3600_000);
		expect(tick).toHaveBeenCalledTimes(1);
		next.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([
		["0 30 2 * * *", "2026-03-08T06:59:59Z", "2026-03-08T07:00:00.000Z"],
		["0 30 1 * * *", "2026-11-01T04:59:59Z", "2026-11-01T05:30:00.000Z"],
		["0 30 1 * * *", "2026-11-01T05:30:00Z", "2026-11-02T06:30:00.000Z"],
	])("retains library DST behavior for %s from %s", (expression, from, expected) => {
		const cron = new CronTime(expression, "America/New_York");
		expect(cron.getNextDateFrom(new Date(from), "America/New_York").toUTC().toISO()).toBe(expected);
	});
});
