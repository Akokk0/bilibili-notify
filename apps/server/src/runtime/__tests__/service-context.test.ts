/**
 * fanOut 等级守卫(Bug 2 修复的核心不变量)。
 *
 * 契约:`logger.<lvl>()` 能否经 fanOut 喂给 logHook(→ WS Tab + 落盘),
 * 完全等价于「该 pino 实例当前 `.level` 是否放行该 lvl」—— 即与控制台
 * 完全一致,逐实例(base 与每个 forSubsystem 子模块)各算各的。
 * `setLevel` 热改后下一条立即按新阈值生效(config-changed 语义)。
 * 复发点:fanOut 又变成无条件触发 / 子模块误用 base 阈值 / 热改不生效。
 *
 * pino 约定(升序严重度):debug=20 info=30 warn=40 error=50 fatal=60。
 * 阈值 = 最低放行严重度,放行「≥ 阈值」,丢弃更轻的(含等号)。
 */

import { describe, expect, it } from "vite-plus/test";
import type { LogEntry } from "../../ws/types.js";
import { createNodeServiceContext } from "../service-context.js";

function harness(level: string) {
	const seen: LogEntry[] = [];
	const ctx = createNodeServiceContext({
		name: "svc",
		level,
		pretty: false,
		onLog: (e) => seen.push(e),
	});
	return { ctx, seen, levels: () => seen.map((e) => e.level) };
}

describe("createNodeServiceContext — fanOut 按 live pino level 守卫", () => {
	it('level="info":debug 被压,info/warn/error 放行', () => {
		const { ctx, levels } = harness("info");
		ctx.logger.debug("d");
		ctx.logger.info("i");
		ctx.logger.warn("w");
		ctx.logger.error("e");
		expect(levels()).toEqual(["info", "warn", "error"]); // 无 debug
	});

	it('level="warn":debug/info 被压,warn/error 放行', () => {
		const { ctx, levels } = harness("warn");
		ctx.logger.debug("d");
		ctx.logger.info("i");
		ctx.logger.warn("w");
		ctx.logger.error("e");
		expect(levels()).toEqual(["warn", "error"]);
	});

	it('level="error":仅 error 放行', () => {
		const { ctx, levels } = harness("error");
		ctx.logger.debug("d");
		ctx.logger.info("i");
		ctx.logger.warn("w");
		ctx.logger.error("e");
		expect(levels()).toEqual(["error"]);
	});

	it("setLevel 热改:下一条立即按新阈值(config-changed 语义)", () => {
		const { ctx, seen, levels } = harness("error");
		ctx.logger.debug("before"); // error 阈值 → 压
		expect(seen).toHaveLength(0);
		ctx.setLevel("debug"); // 热改
		ctx.logger.debug("after"); // debug 阈值 → 放行
		expect(levels()).toEqual(["debug"]);
		expect(seen[0]?.msg).toBe("after");
	});

	it("entry 形状:level/msg/args/ts/name 透传,name=组件名", () => {
		const { ctx, seen } = harness("debug");
		ctx.logger.info("hello", { k: 1 }, 2);
		expect(seen).toHaveLength(1);
		const e = seen[0];
		if (!e) throw new Error("expected one entry");
		expect(e.level).toBe("info");
		expect(e.msg).toBe("hello");
		expect(e.args).toEqual([{ k: 1 }, 2]);
		expect(e.name).toBe("svc");
		expect(typeof e.ts).toBe("string");
	});
});

describe("createNodeServiceContext — forSubsystem 各算各的阈值", () => {
	it("base 与子模块共用同一 logHook 但按各自 pino 实例 level 独立 gate", () => {
		const seen: LogEntry[] = [];
		const ctx = createNodeServiceContext({
			name: "bilibili-notify",
			level: "error", // base = core 桶,只放 error
			pretty: false,
			onLog: (e) => seen.push(e),
		});
		const dyn = ctx.forSubsystem("dynamic", "debug"); // 子模块放到 debug

		ctx.logger.info("base-info"); // base@error → 压
		dyn.logger.debug("dyn-debug"); // dynamic@debug → 放行

		expect(seen.map((e) => [e.name, e.level, e.msg])).toEqual([
			["bilibili-notify:dynamic", "debug", "dyn-debug"],
		]);
	});

	it("子模块 setLevel 热改独立于 base", () => {
		const seen: LogEntry[] = [];
		const ctx = createNodeServiceContext({
			name: "bilibili-notify",
			level: "error",
			pretty: false,
			onLog: (e) => seen.push(e),
		});
		const dyn = ctx.forSubsystem("dynamic", "error");
		dyn.logger.debug("d1"); // dynamic@error → 压
		expect(seen).toHaveLength(0);
		dyn.setLevel("debug"); // 只调 dynamic
		dyn.logger.debug("d2"); // 放行
		ctx.logger.debug("base-d"); // base 仍 error → 压
		expect(seen.map((e) => e.msg)).toEqual(["d2"]);
	});
});
