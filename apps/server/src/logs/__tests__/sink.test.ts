/**
 * 安全守护 — `createLogSink` 单一 fan-out 点:scrub 一次,两路(WS ring +
 * 磁盘 store)拿到的都是脱敏后的同一条。
 *
 * 不变量:secret 进 → ring.push 与 store.ingest 收到的都不含明文。
 * 复发点:把 redact 移进某一路 / 漏掉某一路 / 两路各 redact 导致不一致。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { LogChannel } from "../../ws/log-channel.js";
import type { LogEntry } from "../../ws/types.js";
import { createLogSink } from "../sink.js";
import type { LogStore } from "../store.js";

describe("createLogSink — 脱敏后再 tee", () => {
	it("secret 进:ring 与 store 都拿到脱敏后的同一条", () => {
		const pushed: LogEntry[] = [];
		const ingested: LogEntry[] = [];
		const ring = { push: (e: LogEntry) => pushed.push(e) } as unknown as LogChannel;
		const store = { ingest: (e: LogEntry) => ingested.push(e) } as unknown as LogStore;

		const sink = createLogSink({ ring, store });
		sink({
			level: "info",
			msg: "cookie SESSDATA=TOPSECRET refresh_token=rt_LEAK",
			args: ["sk-DEADBEEF12345678"],
			ts: "2026-05-17T00:00:00.000Z",
			name: "bilibili-notify:dynamic",
		});

		expect(pushed).toHaveLength(1);
		expect(ingested).toHaveLength(1);
		const p = pushed[0];
		const g = ingested[0];
		if (!p || !g) throw new Error("expected both sinks to receive exactly one entry");
		for (const e of [p, g]) {
			expect(e.msg).not.toContain("TOPSECRET");
			expect(e.msg).not.toContain("rt_LEAK");
			expect(JSON.stringify(e.args)).not.toContain("sk-DEADBEEF12345678");
			expect(e.msg).toContain("SESSDATA=***");
			expect(e.name).toBe("bilibili-notify:dynamic"); // name 透传不丢
		}
		// 两路拿到的是等价内容(同一脱敏结果)。
		expect(p.msg).toBe(g.msg);
	});

	it("注入的 redact 被调用且其结果同时进两路", () => {
		const redact = vi.fn((e: LogEntry) => ({ ...e, msg: "[REDACTED]" }));
		const pushed: LogEntry[] = [];
		const ingested: LogEntry[] = [];
		const sink = createLogSink({
			ring: { push: (e: LogEntry) => pushed.push(e) } as unknown as LogChannel,
			store: { ingest: (e: LogEntry) => ingested.push(e) } as unknown as LogStore,
			redact,
		});
		sink({ level: "warn", msg: "x", args: [], ts: "t" });
		expect(redact).toHaveBeenCalledTimes(1);
		expect(pushed[0]?.msg).toBe("[REDACTED]");
		expect(ingested[0]?.msg).toBe("[REDACTED]");
	});
});
