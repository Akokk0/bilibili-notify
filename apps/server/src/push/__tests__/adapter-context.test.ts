/**
 * 适配器拿到的上下文 —— 集成上下文加「现读的自己的连接名单」与「变了叫我」。
 *
 * 「哪些连接归它」的算法全仓只有一个(按连接的 `adapterKey` 认领),内置与拓展两边共用这一个函数,
 * 免得写两遍。递出去的连接 `settings` 都按适配器的规则解过;过不了规则的被隔离,原因记一行 warn。
 */

import type {
	Connection,
	Disposable,
	InboundGroupMessage,
	InboundHandlers,
	InboundMeta,
	InboundPrivateMessage,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { inertSettings } from "../../__tests__/support/inert-settings.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { createIntegrationContext } from "../../integrations/context.js";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
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
	extra: {
		inbound?: InboundHandlers;
		connection?: (connectionId: string) => Connection | undefined;
		onRejectedProblem?: (rejection: { externalId?: string; reason: string }) => void;
	} = {},
) {
	const problems = createProblemTable({ logger: silentLogger });
	const handle = createIntegrationContext({
		...integrationIo(),
		logger,
		stopReason: "测试",
		...memoryStores(),
		settings: inertSettings(),
		problems,
		reporter: key,
		label: () => key,
		rejectedProblemLevel: "error",
		redactValues: () => {},
	});
	const ctx = createPlatformAdapterContext({
		integration: handle.ctx,
		adapterKey: key,
		label: () => key,
		settingsSchema,
		connections: list,
		...(extra.connection ? { connection: extra.connection } : {}),
		inbound: extra.inbound ?? {},
		onConnectionsChanged: on,
		problems,
		rejectedProblemLevel: "error",
		...(extra.onRejectedProblem ? { onRejectedProblem: extra.onRejectedProblem } : {}),
	});
	return { handle, ctx, problems };
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

	// 验红:把转发的 `http` / `fetchImage` / `storeImage` 任一格从 `adapter-context.ts` 里剪掉,这条红(类型检查也过不去)。
	it("ctx.http / fetchImage / storeImage 就是集成上下文上的那三个:适配器用的是自己集成的客户端与图口", () => {
		const { handle, ctx } = build("onebot", () => all);
		expect(ctx.http).toBe(handle.ctx.http);
		expect(ctx.fetchImage).toBe(handle.ctx.fetchImage);
		expect(ctx.storeImage).toBe(handle.ctx.storeImage);
	});

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

	it("logger / signal / onDispose / state / secrets / redact 就是 integration 上的那六个", () => {
		const { handle, ctx } = build("onebot", () => all);
		expect(ctx.redact).toBeTypeOf("function");
		expect(ctx.redact).toBe(handle.ctx.redact);
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

/**
 * 适配器层的问题上报:多一格 `connectionId`。带了,宿主核它是不是这个适配器的连接再记在那条连接名下;
 * 不带就是适配器自己的问题(同集成层)。
 */
describe("createPlatformAdapterContext · reportProblem / resolveProblem", () => {
	const mine = [direct("ob1", "onebot"), direct("qq1", "qq-official")];

	it("带自己的 connectionId:进表、about 是那条连接,报的人是适配器键", () => {
		const { ctx, problems } = build("onebot", () => mine);
		ctx.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "网关连不上" });
		expect(problems.list()).toEqual([
			{
				reporter: "onebot",
				about: { connectionId: "ob1" },
				code: "gateway_down",
				message: "网关连不上",
				since: expect.any(String),
			},
		]);
	});

	it("带 connectionId 的上报盖上适配器给人看的名字", () => {
		const { ctx, problems } = build("onebot", () => mine);
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		ctx.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "网关连不上" });
		expect(changes[0]).toMatchObject({ kind: "opened", writtenBy: "onebot" });
	});

	it("QQ 网关的 gateway_offline 经适配器上下文进表时带着适配器的名字", () => {
		const { ctx, problems } = build("qq-official", () => mine);
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		ctx.reportProblem({
			connectionId: "qq1",
			code: "gateway_offline",
			message: "QQ 网关已经连续一分钟没连上",
		});
		expect(changes[0]).toMatchObject({ kind: "opened", writtenBy: "qq-official" });
	});

	it("不带 connectionId:适配器自己的问题,不带 about", () => {
		const { ctx, problems } = build("onebot", () => mine);
		ctx.reportProblem({ code: "adapter_broken", message: "坏了" });
		expect(problems.list().map((p) => p.about)).toEqual([undefined]);
	});

	it("别人的连接、不存在的连接:不进表,记一行 error", () => {
		const logger = { ...silentLogger, error: vi.fn() };
		const { ctx, problems } = build("onebot", () => mine, undefined, z.unknown(), logger);
		ctx.reportProblem({ connectionId: "qq1", code: "gateway_down", message: "别人的" });
		ctx.reportProblem({ connectionId: "nope", code: "gateway_down", message: "没有的" });
		expect(problems.list()).toEqual([]);
		expect(logger.error).toHaveBeenCalledTimes(2);
	});

	it("被隔离的连接(设置过不了规则)仍算自己的:归属只看 adapterKey", () => {
		const bad = connectionOf("bad", "webhook", "dingtalk", { url: 5 });
		const { ctx, problems } = build(
			"webhook",
			() => [bad],
			undefined,
			z.object({ url: z.string() }),
		);
		expect(ctx.connections()).toEqual([]);
		ctx.reportProblem({ connectionId: "bad", code: "x_y", message: "m" });
		expect(problems.list()).toHaveLength(1);
	});

	it("形状不对:不进表、记一行", () => {
		const logger = { ...silentLogger, error: vi.fn() };
		const { ctx, problems } = build("onebot", () => mine, undefined, z.unknown(), logger);
		ctx.reportProblem({ connectionId: "ob1", code: "Bad Code", message: "x" });
		expect(problems.list()).toEqual([]);
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("报一条缺 message(第三方 JS 交的):被拒、不进表,onRejectedProblem 收到点名 message 的原因", () => {
		const logger = { ...silentLogger, error: vi.fn() };
		const rejections: Array<{ externalId?: string; reason: string }> = [];
		const { ctx, problems } = build("onebot", () => mine, undefined, z.unknown(), logger, {
			onRejectedProblem: (rejection) => rejections.push(rejection),
		});
		ctx.reportProblem({ connectionId: "ob1", code: "x_down" } as never);
		expect(problems.list()).toEqual([]);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(rejections).toEqual([{ reason: "问题「x_down」被拒：message 不是字符串" }]);
	});

	it("给了 onRejectedProblem:记日志,并把原因交给它", () => {
		const logger = { ...silentLogger, error: vi.fn() };
		const rejections: Array<{ externalId?: string; reason: string }> = [];
		const { ctx, problems } = build("onebot", () => mine, undefined, z.unknown(), logger, {
			onRejectedProblem: (rejection) => rejections.push(rejection),
		});
		ctx.reportProblem({ connectionId: "ob1", code: "Bad Code", message: "x" });
		expect(problems.list()).toEqual([]);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(rejections).toEqual([{ reason: "问题「Bad Code」被拒：code 不是 snake 风格" }]);
	});

	it("resolveProblem 带 connectionId 清那一条;notify: false 不补已恢复", () => {
		const { ctx, problems } = build("onebot", () => mine);
		const seen: Array<[string, boolean]> = [];
		problems.subscribe((c) => seen.push([c.kind, c.notify]));
		ctx.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "x", notify: true });
		ctx.reportProblem({ code: "gateway_down", message: "适配器自己的" });
		ctx.resolveProblem({ connectionId: "ob1", code: "gateway_down", notify: false });
		expect(problems.list().map((p) => p.about)).toEqual([undefined]);
		expect(seen).toEqual([
			["opened", true],
			["opened", false],
			["closed", false],
		]);
	});

	it("适配器停下之后:带连接的上报被丢,名下的(含连接支)已清", async () => {
		const logger = { ...silentLogger, error: vi.fn() };
		const { handle, ctx, problems } = build("onebot", () => mine, undefined, z.unknown(), logger);
		ctx.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "x" });
		await handle.dispose();
		expect(problems.list()).toEqual([]);
		ctx.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "停后又报" });
		expect(problems.list()).toEqual([]);
		expect(logger.error).toHaveBeenCalledTimes(1);
	});
});

/**
 * 适配器交入站消息:`ctx.inbound`(ADR-0024 决策 12)。宿主核这条连接是不是适配器自己的(按原始连接表看
 * `adapterKey`,与上报问题同一个判法),平台**取自连接**、不由适配器自报,再把完整的 `InboundMeta` 交下一层。
 */
describe("createPlatformAdapterContext · inbound", () => {
	const MSG: InboundPrivateMessage = { address: "u", text: "hi" };
	const GROUP_MSG: InboundGroupMessage = {
		address: "g",
		senderId: "u",
		text: "hi",
		sharedLinks: [],
	};
	const list = [
		connectionOf("b1", "bridge", "telegram"),
		connectionOf("o1", "onebot", "onebot"),
		connectionOf("bad", "bridge", "discord", { url: 5 }),
	];

	function setup(over: { connection?: (id: string) => Connection | undefined } = {}) {
		const seen: Array<{ route: string; meta: InboundMeta }> = [];
		const warn = vi.fn();
		const built = build(
			"bridge",
			() => list,
			undefined,
			// 三条里 `bad` 与 `b1` 的 settings 都过不了这份规则 —— 归属不能看 `connections()`(隔离后不在里面)。
			z.object({ url: z.string() }),
			{ ...silentLogger, warn },
			{
				inbound: {
					private: (_msg, meta) => seen.push({ route: "private", meta }),
					group: (_msg, meta) => seen.push({ route: "group", meta }),
				},
				...over,
			},
		);
		return { ...built, seen, warn };
	}

	// 验红:平台改回取适配器报的(这里没得报)或者写死一个,这条红。
	it("自己的连接 → 交给下一层,平台取连接上的", () => {
		const { ctx, seen } = setup();
		ctx.inbound.private(MSG, { connectionId: "b1" });
		ctx.inbound.group(GROUP_MSG, { connectionId: "b1" });
		expect(seen).toEqual([
			{ route: "private", meta: { connectionId: "b1", platform: "telegram" } },
			{ route: "group", meta: { connectionId: "b1", platform: "telegram" } },
		]);
	});

	// 验红:归属改成「只看连接在不在、不看 adapterKey」,这条红。
	it("别的适配器的连接 → 丢掉并记一行 warn", () => {
		const { ctx, seen, warn } = setup();
		ctx.inbound.private(MSG, { connectionId: "o1" });
		ctx.inbound.group(GROUP_MSG, { connectionId: "o1" });
		expect(seen).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(String(warn.mock.calls[0]?.[0])).toContain("o1");
	});

	it("不存在的连接 → 丢掉并记一行 warn", () => {
		const { ctx, seen, warn } = setup();
		ctx.inbound.private(MSG, { connectionId: "nope" });
		expect(seen).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("被隔离的连接(设置过不了规则)仍算自己的:归属只看 adapterKey", () => {
		const { ctx, seen } = setup();
		ctx.inbound.private(MSG, { connectionId: "bad" });
		expect(seen).toEqual([
			{ route: "private", meta: { connectionId: "bad", platform: "discord" } },
		]);
	});

	// 入站是每条消息一趟的热路径:宿主的「全表」那口每问一次就深拷整张连接表,校验归属只要那一条。
	it("给了单条访问口就走它,全表一次都不问", () => {
		const connection = vi.fn((id: string) => list.find((c) => c.id === id));
		const connections = vi.fn(() => list);
		const seen: unknown[] = [];
		const problems = createProblemTable({ logger: silentLogger });
		const handle = createIntegrationContext({
			...integrationIo(),
			logger: silentLogger,
			stopReason: "测试",
			...memoryStores(),
			settings: inertSettings(),
			problems,
			reporter: "bridge",
			label: () => "bridge",
			rejectedProblemLevel: "error",
			redactValues: () => {},
		});
		const ctx = createPlatformAdapterContext({
			integration: handle.ctx,
			adapterKey: "bridge",
			label: () => "bridge",
			settingsSchema: z.unknown(),
			connections,
			connection,
			inbound: { private: (_m, meta) => seen.push(meta) },
			onConnectionsChanged: () => ({ dispose() {} }),
			problems,
			rejectedProblemLevel: "error",
		});
		ctx.inbound.private(MSG, { connectionId: "b1" });
		expect(seen).toEqual([{ connectionId: "b1", platform: "telegram" }]);
		expect(connection).toHaveBeenCalledTimes(1);
		expect(connections).not.toHaveBeenCalled();
	});

	// 验红:去掉入站 `feed` 里「适配器已停下」那道判断,这条红(停下之后的消息照样送到下一层)。
	it("适配器停下之后再交来的消息 → 丢掉,下一层不被调用,并记一行 warn(哪个适配器、私聊还是群、已停下)", async () => {
		const { handle, ctx, seen, warn } = setup();
		await handle.dispose();
		ctx.inbound.private(MSG, { connectionId: "b1" });
		ctx.inbound.group(GROUP_MSG, { connectionId: "b1" });
		expect(seen).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(String(warn.mock.calls[0]?.[0])).toContain("bridge");
		expect(String(warn.mock.calls[0]?.[0])).toContain("私聊");
		expect(String(warn.mock.calls[0]?.[0])).toContain("已停下");
		expect(String(warn.mock.calls[1]?.[0])).toContain("群");
	});

	it("下一层没接的那一路 → 静默丢掉,不抛", () => {
		const { ctx } = build("bridge", () => list, undefined, undefined, undefined, { inbound: {} });
		expect(() => ctx.inbound.private(MSG, { connectionId: "b1" })).not.toThrow();
	});
});
