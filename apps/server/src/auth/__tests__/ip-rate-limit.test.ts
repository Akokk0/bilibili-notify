import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createIpRateLimiter, type IpRateLimitEvent } from "../ip-rate-limit.js";

/**
 * Invariants carried over from the removed `basic-auth-rate-limited.test.ts`
 * (P0-5), now exercised on the extracted limiter that guards
 * `POST /api/session/login`.
 */
describe("createIpRateLimiter", () => {
	it("blocks an IP after maxFailures and reports retry-after", () => {
		const rl = createIpRateLimiter({ maxFailures: 3, blockMs: 60_000 });
		expect(rl.blocked("1.2.3.4")).toBeNull();
		expect(rl.fail("1.2.3.4")).toEqual({ failures: 1, blocked: false });
		expect(rl.fail("1.2.3.4")).toEqual({ failures: 2, blocked: false });
		expect(rl.fail("1.2.3.4")).toEqual({ failures: 3, blocked: true });
		const remaining = rl.blocked("1.2.3.4");
		expect(remaining).not.toBeNull();
		expect(remaining as number).toBeGreaterThan(0);
		expect(remaining as number).toBeLessThanOrEqual(60_000);
	});

	it("a success clears the failure count (occasional typo not punished)", () => {
		const rl = createIpRateLimiter({ maxFailures: 3 });
		rl.fail("ip");
		rl.fail("ip");
		rl.succeed("ip");
		// Back to zero: two more fails must not trip the block.
		expect(rl.fail("ip")).toEqual({ failures: 1, blocked: false });
		expect(rl.fail("ip")).toEqual({ failures: 2, blocked: false });
		expect(rl.blocked("ip")).toBeNull();
	});

	it("buckets are per-IP", () => {
		const rl = createIpRateLimiter({ maxFailures: 2 });
		rl.fail("a");
		rl.fail("a");
		expect(rl.blocked("a")).not.toBeNull();
		expect(rl.blocked("b")).toBeNull();
	});

	it("emits events; `blocked` is edge-triggered from fail(), not blocked()", () => {
		const events: string[] = [];
		const rl = createIpRateLimiter({
			maxFailures: 2,
			onEvent: (e) => events.push(e.type),
		});
		rl.fail("ip"); // failure
		rl.fail("ip"); // failure + blocked (transition)
		rl.blocked("ip"); // pure query — emits nothing
		rl.blocked("ip");
		rl.succeed("ip"); // success
		expect(events).toEqual(["failure", "failure", "blocked", "success"]);
	});

	it("blocked() is a pure query and never emits (anti log/disk-DoS)", () => {
		const events: string[] = [];
		const rl = createIpRateLimiter({
			maxFailures: 1,
			blockMs: 60_000,
			onEvent: (e) => events.push(e.type),
		});
		rl.fail("ip"); // failure + blocked
		for (let i = 0; i < 50; i++) rl.blocked("ip"); // hammer while blocked
		expect(events).toEqual(["failure", "blocked"]);
	});

	it("fail() re-emits `blocked` only on a fresh transition, not every call past the threshold", () => {
		const events: IpRateLimitEvent[] = [];
		const rl = createIpRateLimiter({
			maxFailures: 2,
			blockMs: 60_000,
			onEvent: (e) => events.push(e),
		});
		rl.fail("ip"); // failure
		rl.fail("ip"); // failure + blocked (transition #1)
		rl.fail("ip"); // failure only — still inside the same active block
		rl.fail("ip"); // failure only
		const blockedCount = events.filter((e) => e.type === "blocked").length;
		expect(blockedCount).toBe(1);
		expect(events.filter((e) => e.type === "failure").length).toBe(4);
	});

	// ---- Block-expiry edge (the previously untested re-block path) ----------
	describe("block expiry / re-block edge", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("blocked() auto-unblocks once blockMs elapses (entry kept, not cleared)", () => {
			vi.useFakeTimers();
			const rl = createIpRateLimiter({ maxFailures: 1, blockMs: 1_000 });
			rl.fail("ip"); // blocked
			expect(rl.blocked("ip")).not.toBeNull();
			vi.advanceTimersByTime(1_001);
			// Entry is intentionally NOT deleted on expiry; blocked() must still
			// report "not blocked" purely from the stale blockedUntil being past.
			expect(rl.blocked("ip")).toBeNull();
		});

		it("a fresh fail() AFTER the block expires re-emits `blocked` exactly once (re-block edge fires)", () => {
			vi.useFakeTimers();
			const events: IpRateLimitEvent[] = [];
			const rl = createIpRateLimiter({
				maxFailures: 2,
				blockMs: 1_000,
				onEvent: (e) => events.push(e),
			});
			rl.fail("ip"); // failure
			rl.fail("ip"); // failure + blocked (transition #1)
			vi.advanceTimersByTime(1_001); // block lapses
			expect(rl.blocked("ip")).toBeNull();
			rl.fail("ip"); // failures=3 → re-enters a block (transition #2)
			// `wasActivelyBlocked` is false (stale blockedUntil is in the past),
			// so the edge re-fires — NOT a "never blocks again" bug.
			expect(events.map((e) => e.type)).toEqual([
				"failure",
				"failure",
				"blocked",
				"failure",
				"blocked",
			]);
		});

		it("calling fail() repeatedly DURING an active block never re-emits `blocked` even across the expiry boundary until it lapses", () => {
			vi.useFakeTimers();
			const events: IpRateLimitEvent[] = [];
			const rl = createIpRateLimiter({
				maxFailures: 1,
				blockMs: 10_000,
				onEvent: (e) => events.push(e),
			});
			rl.fail("ip"); // failure + blocked
			// Contract-violating caller that keeps hammering fail() while blocked:
			for (let i = 0; i < 20; i++) {
				vi.advanceTimersByTime(100); // total +2s, still well within the 10s block
				rl.fail("ip");
			}
			// Exactly one blocked across 21 fail() calls inside the same window.
			expect(events.filter((e) => e.type === "blocked").length).toBe(1);
			expect(events.filter((e) => e.type === "failure").length).toBe(21);
		});

		it("succeed() clears state so the NEXT breach is a clean fresh `blocked` (not suppressed by a stale entry)", () => {
			const events: IpRateLimitEvent[] = [];
			const rl = createIpRateLimiter({
				maxFailures: 2,
				blockMs: 60_000,
				onEvent: (e) => events.push(e),
			});
			rl.fail("ip");
			rl.fail("ip"); // blocked #1
			rl.succeed("ip"); // clears entry entirely
			rl.fail("ip");
			rl.fail("ip"); // blocked #2 — fresh, since succeed() wiped the bucket
			expect(events.filter((e) => e.type === "blocked").length).toBe(2);
		});
	});
});
