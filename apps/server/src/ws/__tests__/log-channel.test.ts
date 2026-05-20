/**
 * 单元测试 — `createLogChannel`(log 频道 in-memory ring buffer)。
 *
 * 守护契约:
 *   - ring 超 cap → 淘汰最旧;cap 下限为 1(bufferSize<=0 也至少留 1)
 *   - latest() 返回快照副本(外部 mutate 不污染内部;后续 push 不改旧引用)
 *   - subscribe 收到新 entry;返回的 unsubscribe 生效后不再收到
 *   - 一个 handler 抛异常不影响其它 handler 收到该 entry
 */

import { describe, expect, it, vi } from "vitest";
import { createLogChannel } from "../log-channel.js";
import type { LogEntry } from "../types.js";

function entry(msg: string): LogEntry {
	return { level: "info", msg, args: [], ts: `2026-05-16T00:00:00.000Z` };
}

describe("createLogChannel — ring buffer", () => {
	it("初始 latest() 为空", () => {
		expect(createLogChannel().latest()).toEqual([]);
	});

	it("超过 cap 淘汰最旧", () => {
		const ch = createLogChannel({ bufferSize: 2 });
		ch.push(entry("a"));
		ch.push(entry("b"));
		ch.push(entry("c"));
		expect(ch.latest().map((e) => e.msg)).toEqual(["b", "c"]);
	});

	it("bufferSize<=0 时 cap 下限为 1", () => {
		const ch = createLogChannel({ bufferSize: 0 });
		ch.push(entry("a"));
		ch.push(entry("b"));
		expect(ch.latest().map((e) => e.msg)).toEqual(["b"]);
	});

	it("latest() 是副本:外部 mutate 不污染内部,后续 push 不改旧引用", () => {
		const ch = createLogChannel();
		ch.push(entry("a"));
		const snap = ch.latest();
		// latest() 返回 readonly 视图;强制 mutate 验证它是脱离内部的副本。
		(snap as LogEntry[]).push(entry("injected"));
		ch.push(entry("b"));
		expect(snap.map((e) => e.msg)).toEqual(["a", "injected"]); // 旧快照不被后续 push 改动
		expect(ch.latest().map((e) => e.msg)).toEqual(["a", "b"]); // 内部未被外部 mutate 污染
	});
});

describe("createLogChannel — subscribe", () => {
	it("subscribe 收到新 entry;unsubscribe 后停止", () => {
		const ch = createLogChannel();
		const seen: string[] = [];
		const off = ch.subscribe((e) => seen.push(e.msg));
		ch.push(entry("a"));
		off();
		ch.push(entry("b"));
		expect(seen).toEqual(["a"]);
	});

	it("一个 handler 抛异常不阻断其它 handler", () => {
		const ch = createLogChannel();
		const good = vi.fn();
		ch.subscribe(() => {
			throw new Error("bad subscriber");
		});
		ch.subscribe(good);
		expect(() => ch.push(entry("x"))).not.toThrow();
		expect(good).toHaveBeenCalledTimes(1);
		expect(good.mock.calls[0]?.[0]).toMatchObject({ msg: "x" });
	});
});
