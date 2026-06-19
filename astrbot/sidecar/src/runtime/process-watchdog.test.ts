import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { installParentProcessWatchdog } from "./process-watchdog.js";

describe("parent process watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("closes the sidecar when the parent process disappears", async () => {
		let parentAlive = true;
		const close = vi.fn(async (): Promise<boolean | undefined> => undefined);
		const exit = vi.fn();
		installParentProcessWatchdog({ close }, 12_345, {
			intervalMs: 1_000,
			isParentAlive: () => parentAlive,
			getCurrentParentPid: () => 12_345,
			exit,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(close).not.toHaveBeenCalled();

		parentAlive = false;
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.runAllTimersAsync();

		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith("parent-exited");
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("allows pid 1 to be watched", async () => {
		const close = vi.fn(async (): Promise<boolean | undefined> => undefined);
		const exit = vi.fn();
		installParentProcessWatchdog({ close }, 1, {
			intervalMs: 1_000,
			isParentAlive: () => false,
			getCurrentParentPid: () => 1,
			exit,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		await vi.runAllTimersAsync();

		expect(close).toHaveBeenCalledWith("parent-exited");
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("treats reparenting as parent exit even if the old pid is alive", async () => {
		let currentParentPid = 12_345;
		const close = vi.fn(async (): Promise<boolean | undefined> => undefined);
		const exit = vi.fn();
		installParentProcessWatchdog({ close }, 12_345, {
			intervalMs: 1_000,
			isParentAlive: () => true,
			getCurrentParentPid: () => currentParentPid,
			exit,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(close).not.toHaveBeenCalled();

		currentParentPid = 1;
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.runAllTimersAsync();

		expect(close).toHaveBeenCalledWith("parent-exited");
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("exits with failure when parent-exit cleanup times out", async () => {
		const close = vi.fn(() => new Promise<boolean | undefined>(() => undefined));
		const exit = vi.fn();
		installParentProcessWatchdog({ close }, 12_345, {
			intervalMs: 1_000,
			closeTimeoutMs: 2_000,
			isParentAlive: () => false,
			getCurrentParentPid: () => 12_345,
			exit,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(close).toHaveBeenCalledWith("parent-exited");
		expect(exit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2_000);

		expect(exit).toHaveBeenCalledWith(1);
	});

	it("keeps polling until cleanup becomes available", async () => {
		let cleanupReady = false;
		const close = vi.fn(async () => cleanupReady);
		const exit = vi.fn();
		installParentProcessWatchdog({ close }, 12_345, {
			intervalMs: 1_000,
			isParentAlive: () => false,
			getCurrentParentPid: () => 12_345,
			exit,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(close).toHaveBeenCalledWith("parent-exited");
		expect(exit).not.toHaveBeenCalled();

		cleanupReady = true;
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.runAllTimersAsync();

		expect(close).toHaveBeenCalledTimes(2);
		expect(exit).toHaveBeenCalledWith(0);
	});
});
