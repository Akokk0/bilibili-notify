import {
	type IntegrationContext,
	ok,
	type PostEvent,
	type PostReport,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createSourceContext } from "../source-context.js";
import {
	makeIntegration,
	makeLogger,
	makeProblems,
	makeSettingsHost,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "./fixtures.js";

const report = (postId = "p1"): PostReport => ({
	postId,
	url: `https://example.test/${postId}`,
	post: { creator: { name: "UP" }, publishedAt: "2026-01-01T00:00:00.000Z", text: "hi" },
});

const setup = (
	subs = [makeSub("a", "1")],
	/** 盖在集成上下文上的几格(例如换掉 `redact`);`settings` 的读源始终是下面的 `settingsHost`。 */
	overrides: Partial<IntegrationContext> = {},
) => {
	const world = makeWorld(subs);
	const logger = makeLogger();
	const enqueue = vi.fn<(event: PostEvent) => void>();
	const problems = makeProblems();
	const settingsHost = makeSettingsHost();
	const handle = createSourceContext({
		integration: { ...makeIntegration(makeLogger(), settingsHost), ...overrides },
		sourceKey: SOURCE_KEY,
		descriptor: { label: "测试", postNoun: "动态" },
		linkResolvers: createLinkResolverRegistry(),
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue,
		problems,
	});
	return { ...world, logger, enqueue, problems, handle, settingsHost };
};

describe("createSourceContext", () => {
	it("交出去的上下文只有公共那一面加来源的七个方法:没有 cookies", () => {
		const { handle } = setup();
		expect(Object.keys(handle.ctx).sort()).toEqual([
			"fetchImage",
			"http",
			"logger",
			"onDispose",
			"onSubscriptionsChanged",
			"redact",
			"registerLinkResolver",
			"reportPost",
			"reportProblem",
			"resolveProblem",
			"secrets",
			"settings",
			"signal",
			"state",
			"storeImage",
			"subscriptions",
		]);
		expect("cookies" in handle.ctx).toBe(false);
	});

	// 验红:把转发的 `http` / `fetchImage` / `storeImage` 任一格从 `source-context.ts` 里剪掉,这条红(类型检查也过不去)。
	it("ctx.http / fetchImage / storeImage 就是集成上下文上的那三个:来源抓图、请求走集成自己的客户端", () => {
		const integration = makeIntegration();
		const { handle } = setup([makeSub("a", "1")], {
			http: integration.http,
			fetchImage: integration.fetchImage,
			storeImage: integration.storeImage,
		});
		expect(handle.ctx.http).toBe(integration.http);
		expect(handle.ctx.fetchImage).toBe(integration.fetchImage);
		expect(handle.ctx.storeImage).toBe(integration.storeImage);
	});

	it("ctx.redact 就是集成上下文上的那一个:来源登记的临时凭据走集成的登记口", () => {
		const redact = vi.fn();
		const { handle } = setup([makeSub("a", "1")], { redact });
		handle.ctx.redact("FAKE-TEMP-TOKEN-1");
		expect(redact).toHaveBeenCalledWith("FAKE-TEMP-TOKEN-1");
	});

	it("ctx.logger 是宿主入参给的那个,不是集成上下文自带的", () => {
		const hostLogger = makeLogger();
		const integrationLogger = makeLogger();
		const handle = createSourceContext({
			integration: makeIntegration(integrationLogger),
			sourceKey: SOURCE_KEY,
			descriptor: { label: "测试", postNoun: "动态" },
			linkResolvers: createLinkResolverRegistry(),
			subscriptions: makeWorld().store,
			defaults: () => makeWorld().globals.defaults,
			bus: makeWorld().bus,
			logger: hostLogger,
			enqueue: vi.fn(),
			problems: makeProblems(),
		});
		expect(handle.ctx.logger).toBe(hostLogger);
		expect(handle.ctx.logger).not.toBe(integrationLogger);
	});

	it("subscriptions() 每次现读:改了仓再读不一样", () => {
		const { handle, store } = setup();
		expect(handle.ctx.subscriptions().map((v) => v.externalId)).toEqual(["1"]);
		store.upsert(makeSub("b", "2"));
		expect(handle.ctx.subscriptions().map((v) => v.externalId)).toEqual(["1", "2"]);
	});

	it("两路触发各叫一次回调:订阅变了、全局设置变了;别的设置变了不叫", () => {
		const { handle, bus, store } = setup();
		const fn = vi.fn();
		handle.ctx.onSubscriptionsChanged(fn);
		store.upsert(makeSub("b", "2"));
		expect(fn).toHaveBeenCalledTimes(1);
		bus.emit("config-changed", { scope: "globals" });
		expect(fn).toHaveBeenCalledTimes(2);
		bus.emit("config-changed", { scope: "connections" });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("一个回调抛了不影响后面的回调,也不往总线外抛,记一行 error", () => {
		const { handle, bus, logger } = setup();
		const after = vi.fn();
		handle.ctx.onSubscriptionsChanged(() => {
			throw new Error("boom");
		});
		handle.ctx.onSubscriptionsChanged(after);
		expect(() => bus.emit("config-changed", { scope: "globals" })).not.toThrow();
		expect(after).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error.mock.calls[0]?.[0]).toContain("boom");
	});

	it("onSubscriptionsChanged 交回的把手能摘掉自己", () => {
		const { handle, bus } = setup();
		const fn = vi.fn();
		const watch = handle.ctx.onSubscriptionsChanged(fn);
		watch.dispose();
		bus.emit("config-changed", { scope: "globals" });
		expect(fn).not.toHaveBeenCalled();
	});

	it("reportPost 按身份展开:每条订阅各一份,带来源的 postNoun", () => {
		const { handle, enqueue } = setup([makeSub("a", "1"), makeSub("b", "1"), makeSub("c", "2")]);
		handle.ctx.reportPost("1", report("p1"));
		expect(enqueue.mock.calls.map(([e]) => e.subscriptionId)).toEqual(["a", "b"]);
		expect(enqueue.mock.calls[0]?.[0]).toEqual({
			subscriptionId: "a",
			identity: { sourceKey: SOURCE_KEY, externalId: "1" },
			postId: "p1",
			url: "https://example.test/p1",
			post: report("p1").post,
			postNoun: "动态",
		});
	});

	it("reportPost 没有这个人的订阅:不入队,记 debug", () => {
		const { handle, enqueue, logger } = setup();
		handle.ctx.reportPost("999", report());
		expect(enqueue).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalled();
	});

	it("dispose 之后:回调不再叫、监听摘掉、reportPost 不入队并记 error、再登记回调也不会被叫", () => {
		const { handle, bus, enqueue, logger } = setup();
		const fn = vi.fn();
		handle.ctx.onSubscriptionsChanged(fn);
		handle.dispose();
		bus.emit("config-changed", { scope: "globals" });
		handle.ctx.onSubscriptionsChanged(fn);
		bus.emit("config-changed", { scope: "globals" });
		expect(fn).not.toHaveBeenCalled();
		handle.ctx.reportPost("1", report());
		expect(enqueue).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
		// 幂等
		expect(() => handle.dispose()).not.toThrow();
	});
});

describe("createSourceContext · settings", () => {
	const Schema = z.object({ cron: z.string() });

	it("ctx.settings(schema) 拿到的把手读得到宿主那一份", () => {
		const { handle, settingsHost } = setup();
		settingsHost.set(ok({ settings: { cron: "a", extra: 1 } }));
		expect(handle.ctx.settings(Schema).get()).toEqual({ ok: true, settings: { cron: "a" } });
	});

	it("可以交多份 zod,各读各的格", () => {
		const { handle, settingsHost } = setup();
		settingsHost.set(ok({ settings: { cron: "a", minutes: 3 } }));
		const a = handle.ctx.settings(Schema).get();
		const b = handle.ctx.settings(z.object({ minutes: z.number() })).get();
		expect(a).toEqual({ ok: true, settings: { cron: "a" } });
		expect(b).toEqual({ ok: true, settings: { minutes: 3 } });
	});

	it("设置变了把手回调;上下文收掉之后设置再变,把手不再回调、get() 照常能读", () => {
		const { handle, settingsHost } = setup();
		settingsHost.set(ok({ settings: { cron: "a" } }));
		const reader = handle.ctx.settings(Schema);
		const fn = vi.fn();
		reader.onChange(fn);
		settingsHost.set(ok({ settings: { cron: "b" } }));
		expect(fn).toHaveBeenCalledTimes(1);
		handle.dispose();
		settingsHost.set(ok({ settings: { cron: "c" } }));
		expect(fn).toHaveBeenCalledTimes(1);
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "c" } });
	});

	it("来源收掉之后才来要把手:get() 照常能读,onChange 不订阅(交一个空把手),设置再变不叫", () => {
		const { handle, settingsHost } = setup();
		settingsHost.set(ok({ settings: { cron: "a" } }));
		handle.dispose();
		const reader = handle.ctx.settings(Schema);
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "a" } });
		const fn = vi.fn();
		reader.onChange(fn);
		settingsHost.set(ok({ settings: { cron: "b" } }));
		expect(fn).not.toHaveBeenCalled();
	});

	// 读手本身(宿主那头的监听)属于集成上下文、随集成收摊(`integrations/__tests__/settings-reader.test.ts`);
	// 来源这一层只摘它自己订阅的 onChange。
	it("来源停下:它订阅过的每一个 onChange 都摘掉,读手还归集成上下文", () => {
		const { handle, settingsHost } = setup();
		const fns = [vi.fn(), vi.fn(), vi.fn()];
		for (const fn of fns) handle.ctx.settings(Schema).onChange(fn);
		expect(settingsHost.listenerCount()).toBe(3);
		handle.dispose();
		settingsHost.set(ok({ settings: { cron: "z" } }));
		for (const fn of fns) expect(fn).not.toHaveBeenCalled();
		expect(settingsHost.listenerCount()).toBe(3);
	});
});

/**
 * 问题上报:不带 `externalId` 记在来源自己名下;带了按身份展开成这个人名下的每一条订阅。
 * 上报类一律没有返回值;停下之后、形状不对的丢弃并记 error(内置来源被拒就是 BN 的 bug)。
 */
describe("createSourceContext · reportProblem / resolveProblem", () => {
	it("不带 externalId:记在来源自己名下(报的人是来源键),notify 原样带上", () => {
		const { handle, problems } = setup();
		handle.ctx.reportProblem({ code: "auth_lost", message: "登录失效", notify: true });
		expect(problems.report).toHaveBeenCalledTimes(1);
		expect(problems.report).toHaveBeenCalledWith({
			reporter: SOURCE_KEY,
			code: "auth_lost",
			message: "登录失效",
			notify: true,
			writtenBy: "测试",
		});
	});

	it("盖上的写者名是来源描述符的 label", () => {
		const { handle, problems } = setup();
		handle.ctx.reportProblem({ code: "auth_lost", message: "登录失效" });
		expect(problems.report.mock.calls[0]?.[0]).toMatchObject({ writtenBy: "测试" });
	});

	it("带 externalId:按身份展开,遗留的两条重复订阅各记一条,别人的订阅不碰", () => {
		const { handle, problems } = setup([makeSub("a", "1"), makeSub("b", "1"), makeSub("c", "2")]);
		handle.ctx.reportProblem({ externalId: "1", code: "monitor_stopped", message: "停了" });
		expect(
			problems.report.mock.calls.map(([p]) =>
				p.about && "subscriptionId" in p.about ? p.about.subscriptionId : undefined,
			),
		).toEqual(["a", "b"]);
		expect(problems.report.mock.calls[0]?.[0]).toEqual({
			reporter: SOURCE_KEY,
			about: { subscriptionId: "a" },
			code: "monitor_stopped",
			message: "停了",
			writtenBy: "测试",
		});
	});

	it("recoveryMessage 原样带给问题表(来源级与订阅级都带);不给就没有这一格", () => {
		const { handle, problems } = setup([makeSub("a", "1")]);
		handle.ctx.reportProblem({ code: "auth_lost", message: "话", recoveryMessage: "好啦" });
		handle.ctx.reportProblem({
			externalId: "1",
			code: "monitor_stopped",
			message: "话",
			recoveryMessage: "连上啦",
		});
		handle.ctx.reportProblem({ code: "no_recovery", message: "话" });
		expect(problems.report.mock.calls[0]?.[0]).toMatchObject({ recoveryMessage: "好啦" });
		expect(problems.report.mock.calls[1]?.[0]).toMatchObject({ recoveryMessage: "连上啦" });
		expect("recoveryMessage" in (problems.report.mock.calls[2]?.[0] ?? {})).toBe(false);
	});

	it("recoveryMessage 是空白:按形状不对丢弃并记 error", () => {
		const { handle, problems, logger } = setup();
		handle.ctx.reportProblem({ code: "auth_lost", message: "话", recoveryMessage: "  " });
		expect(problems.report).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("带 externalId 但这个人没有订阅:不记,记 debug", () => {
		const { handle, problems, logger } = setup();
		handle.ctx.reportProblem({ externalId: "999", code: "monitor_stopped", message: "停了" });
		expect(problems.report).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalled();
	});

	it("停用着的订阅照记,不在这里筛", () => {
		const { handle, problems } = setup([makeSub("a", "1", { enabled: false })]);
		handle.ctx.reportProblem({ externalId: "1", code: "monitor_stopped", message: "停了" });
		expect(problems.report).toHaveBeenCalledTimes(1);
	});

	it.each([
		["code 不是 snake", { code: "Auth-Lost", message: "x" }],
		["code 是空串", { code: "", message: "x" }],
		["message 是空白", { code: "auth_lost", message: "   " }],
		["externalId 给了空串", { externalId: "", code: "auth_lost", message: "x" }],
	])("形状不对(%s):丢弃并记 error", (_name, input) => {
		const { handle, problems, logger } = setup();
		handle.ctx.reportProblem(input);
		expect(problems.report).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("resolveProblem:同样的展开,notify 缺省不带、给了就带", () => {
		const { handle, problems } = setup([makeSub("a", "1"), makeSub("b", "1")]);
		handle.ctx.resolveProblem({ code: "auth_lost" });
		expect(problems.resolve).toHaveBeenLastCalledWith(
			{ reporter: SOURCE_KEY, code: "auth_lost" },
			undefined,
		);
		handle.ctx.resolveProblem({ externalId: "1", code: "monitor_stopped", notify: false });
		expect(problems.resolve.mock.calls.slice(1)).toEqual([
			[
				{ reporter: SOURCE_KEY, about: { subscriptionId: "a" }, code: "monitor_stopped" },
				{ notify: false },
			],
			[
				{ reporter: SOURCE_KEY, about: { subscriptionId: "b" }, code: "monitor_stopped" },
				{ notify: false },
			],
		]);
	});

	it("resolveProblem 形状不对:丢弃并记 error", () => {
		const { handle, problems, logger } = setup();
		handle.ctx.resolveProblem({ code: "Bad Code" });
		expect(problems.resolve).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("来源停下之后:报与清都丢弃,各记一行 error", () => {
		const { handle, problems, logger } = setup();
		handle.dispose();
		handle.ctx.reportProblem({ code: "auth_lost", message: "x" });
		handle.ctx.resolveProblem({ code: "auth_lost" });
		expect(problems.report).not.toHaveBeenCalled();
		expect(problems.resolve).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(2);
	});
});
