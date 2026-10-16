/**
 * 适配器拿到的上下文 —— 集成上下文加「现读的自己的连接名单」与「变了叫我」。
 *
 * 「哪些连接归它」的算法全仓只有一个(按连接的 `adapterKey` 认领),内置与拓展两边共用这一个函数,
 * 免得写两遍。递出去的连接 `settings` 都按适配器的规则解过;过不了规则的被隔离,原因记一行 warn。
 */

import type { Connection, Disposable } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { createIntegrationContext } from "../../integrations/context.js";
import { createPlatformAdapterContext } from "../adapter-context.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function connectionOf(
	id: string,
	adapterKey: string,
	platform: string,
	settings: unknown = {},
): Connection {
	return {
		id,
		name: id,
		enabled: true,
		adapterKey,
		platform,
		settings,
		platformSnapshot: snapshotFor(platform),
	};
}

/** 内置的:平台名对应哪个适配器键,照注册表的归属。 */
function direct(id: string, platform: string): Connection {
	const adapterKey = platform === "onebot" || platform === "qq-official" ? platform : "webhook";
	return connectionOf(id, adapterKey, platform);
}

function extensionConn(id: string, extensionId: string): Connection {
	return connectionOf(id, extensionId, "telegram");
}

function build(
	key: string,
	list: () => readonly Connection[],
	on = () => ({ dispose() {} }),
	settingsSchema: z.ZodType = z.unknown(),
	logger = silentLogger,
) {
	const handle = createIntegrationContext({
		logger,
		stopReason: "测试",
		...memoryStores(),
		problems: ignoredProblems,
		reporter: key,
		rejectedProblemLevel: "error",
	});
	const ctx = createPlatformAdapterContext({
		integration: handle.ctx,
		adapterKey: key,
		settingsSchema,
		connections: list,
		onConnectionsChanged: on,
	});
	return { handle, ctx };
}

describe("createPlatformAdapterContext", () => {
	const all: Connection[] = [
		direct("a", "onebot"),
		direct("b", "qq-official"),
		direct("c", "feishu"),
		direct("d", "dingtalk"),
		direct("e", "wecom"),
		direct("f", "generic"),
		extensionConn("g", "bridge"),
		extensionConn("h", "matrix"),
	];

	it("connections() 只回 adapterKey 等于它的连接 —— onebot", () => {
		const { ctx } = build("onebot", () => all);
		expect(ctx.connections().map((c) => c.id)).toEqual(["a"]);
	});

	it('webhook 那一族四个平台都归 "webhook"', () => {
		const { ctx } = build("webhook", () => all);
		expect(ctx.connections().map((c) => c.id)).toEqual(["c", "d", "e", "f"]);
	});

	it("拓展连接归拓展 id", () => {
		const { ctx } = build("bridge", () => all);
		expect(ctx.connections().map((c) => c.id)).toEqual(["g"]);
	});

	it("现读:名单改了,下一次读到的就是新的", () => {
		let list: readonly Connection[] = [direct("a", "onebot")];
		const { ctx } = build("onebot", () => list);
		expect(ctx.connections().map((c) => c.id)).toEqual(["a"]);
		list = [direct("a", "onebot"), direct("z", "onebot")];
		expect(ctx.connections().map((c) => c.id)).toEqual(["a", "z"]);
		list = [];
		expect(ctx.connections()).toEqual([]);
	});

	it("logger / signal / onDispose / state / secrets 就是 integration 上的那五个", () => {
		const { handle, ctx } = build("onebot", () => all);
		expect(ctx.logger).toBe(handle.ctx.logger);
		expect(ctx.signal).toBe(handle.ctx.signal);
		expect(ctx.onDispose).toBe(handle.ctx.onDispose);
		expect(ctx.state).toBe(handle.ctx.state);
		expect(ctx.secrets).toBe(handle.ctx.secrets);
	});

	it("onConnectionsChanged 原样转交 —— 回调与交回的把手都是传进去的那一份", () => {
		const handle: Disposable = { dispose: vi.fn() };
		const on = vi.fn(() => handle);
		const { ctx } = build("onebot", () => all, on);
		const fn = () => {};
		const returned = ctx.onConnectionsChanged(fn);
		expect(on).toHaveBeenCalledWith(fn);
		expect(returned).toBe(handle);
	});
});

describe("createPlatformAdapterContext — settings 先按适配器的规则解", () => {
	const schema = z.object({ url: z.string(), retries: z.number().default(2) });
	const ok = (id: string) => connectionOf(id, "webhook", "generic", { url: "https://x" });
	const broken = (id: string, settings: unknown = { url: 7 }) =>
		connectionOf(id, "webhook", "generic", settings);

	function warnLogger() {
		return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	}

	it("递出去的 settings 是解过的输出(补了默认值),不改盘上的原连接", () => {
		const original = ok("a");
		const { ctx } = build("webhook", () => [original], undefined, schema);
		expect(ctx.connections().map((c) => c.settings)).toEqual([{ url: "https://x", retries: 2 }]);
		expect(original.settings).toEqual({ url: "https://x" });
	});

	it("过不了规则的连接不给适配器,合法的照给", () => {
		const { ctx } = build("webhook", () => [ok("a"), broken("b"), ok("c")], undefined, schema);
		expect(ctx.connections().map((c) => c.id)).toEqual(["a", "c"]);
	});

	it("隔离的原因记一行 warn,同一条连接同一条原因反复读也只记一次", () => {
		const logger = warnLogger();
		const { ctx } = build("webhook", () => [broken("b")], undefined, schema, logger);
		ctx.connections();
		ctx.connections();
		ctx.connections();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const line = String(logger.warn.mock.calls[0]?.[0]);
		expect(line).toContain("b");
		expect(line).toContain("设置不合法");
		expect(line).toContain("url");
	});

	it("原因变了再记一次;改好之后再坏,也再记一次", () => {
		const logger = warnLogger();
		let list: readonly Connection[] = [broken("b", { url: 7 })];
		const { ctx } = build("webhook", () => list, undefined, schema, logger);
		ctx.connections();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		list = [broken("b", { url: "https://x", retries: "many" })]; // 另一条原因
		ctx.connections();
		expect(logger.warn).toHaveBeenCalledTimes(2);
		list = [ok("b")]; // 好了
		expect(ctx.connections().map((c) => c.id)).toEqual(["b"]);
		expect(logger.warn).toHaveBeenCalledTimes(2);
		list = [broken("b", { url: "https://x", retries: "many" })]; // 又坏回同一条原因
		ctx.connections();
		expect(logger.warn).toHaveBeenCalledTimes(3);
	});

	it("别的适配器的连接坏了与我无关:不记、不给", () => {
		const logger = warnLogger();
		const { ctx } = build(
			"webhook",
			() => [connectionOf("x", "onebot", "onebot", { nonsense: true })],
			undefined,
			schema,
			logger,
		);
		expect(ctx.connections()).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
