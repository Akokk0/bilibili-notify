import {
	type CreatorProfileReport,
	type IntegrationContext,
	type LiveInteractionReport,
	type LiveSignal,
	ok,
	type PostEvent,
	type PostReport,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
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
	/** 来源上下文自己的几个选项(例如被拒的问题上报记成什么等级)。 */
	extra: {
		rejectedProblemLevel?: "warn" | "error";
		label?: () => string;
		onRejectedProblem?: (rejection: { externalId?: string; reason: string }) => void;
	} = {},
) => {
	const world = makeWorld(subs);
	const logger = makeLogger();
	const enqueue = vi.fn<(event: PostEvent) => void>();
	const liveSignals = vi.fn<(signal: LiveSignal) => void>();
	const liveInteractions =
		vi.fn<(subscriptionId: string, interaction: LiveInteractionReport) => void>();
	const profiles =
		vi.fn<(subscriptionIds: readonly string[], report: CreatorProfileReport) => void>();
	const problems = makeProblems();
	const settingsHost = makeSettingsHost();
	const handle = createSourceContext({
		integration: { ...makeIntegration(makeLogger(), settingsHost), ...overrides },
		sourceKey: SOURCE_KEY,
		descriptor: { label: "测试", supportedFeatures: ["post"], postNoun: "动态" },
		aiToolProviders: createAiToolProviderRegistry(),
		linkResolvers: createLinkResolverRegistry(),
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue,
		liveSignals,
		liveInteractions,
		profiles,
		problems,
		...extra,
	});
	return {
		...world,
		logger,
		enqueue,
		liveSignals,
		liveInteractions,
		profiles,
		problems,
		handle,
		settingsHost,
	};
};

describe("createSourceContext", () => {
	it("来源现读共同timezone,停止只摘自己的通知,旧ctx不再订", () => {
		let timezone = "UTC";
		const listeners = new Set<() => void>();
		const { handle } = setup([], {
			timezone: () => timezone,
			onTimezoneChanged(fn) {
				listeners.add(fn);
				return { dispose: () => void listeners.delete(fn) };
			},
		});
		const ctx = handle.ctx as typeof handle.ctx & { timezone?: () => string };
		expect(ctx.timezone?.()).toBe("UTC");
		const seen: string[] = [];
		handle.ctx.onTimezoneChanged(() => seen.push(handle.ctx.timezone()));
		timezone = "Asia/Kathmandu";
		for (const fn of listeners) fn();
		expect(seen).toEqual(["Asia/Kathmandu"]);
		handle.dispose();
		expect(listeners.size).toBe(0);
		handle.ctx.onTimezoneChanged(() => seen.push("stale"));
		expect(listeners.size).toBe(0);
		expect(handle.ctx.timezone()).toBe("Asia/Kathmandu");
	});
	it("交出去的上下文只有公共那一面加来源的八个方法:没有 cookies", () => {
		const { handle } = setup();
		expect(Object.keys(handle.ctx).sort()).toEqual([
			"fetchImage",
			"http",
			"logger",
			"onDispose",
			"onSubscriptionsChanged",
			"onTimezoneChanged",
			"redact",
			"registerAiToolProvider",
			"registerLinkResolver",
			"reportLive",
			"reportLiveInteraction",
			"reportPost",
			"reportProblem",
			"reportProfile",
			"resolveProblem",
			"secrets",
			"settings",
			"signal",
			"state",
			"storeImage",
			"subscriptions",
			"timezone",
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
			descriptor: { label: "测试", supportedFeatures: ["post"], postNoun: "动态" },
			aiToolProviders: createAiToolProviderRegistry(),
			linkResolvers: createLinkResolverRegistry(),
			subscriptions: makeWorld().store,
			defaults: () => makeWorld().globals.defaults,
			bus: makeWorld().bus,
			logger: hostLogger,
			enqueue: vi.fn(),
			liveSignals: vi.fn(),
			liveInteractions: vi.fn(),
			profiles: vi.fn(),
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

	it("reportLive 按身份展开:每条订阅各一份(停用的也交,不在这里筛),带订阅 id 与身份", () => {
		const { handle, liveSignals } = setup([
			makeSub("a", "1"),
			makeSub("b", "1", { enabled: false }),
			makeSub("c", "2"),
		]);
		const details = { title: "开播啦", totalViewers: 3 };
		handle.ctx.reportLive("1", { kind: "start", startedAt: "2026-10-01T08:00:00.000Z", details });
		expect(liveSignals.mock.calls.map(([s]) => s.subscriptionId)).toEqual(["a", "b"]);
		expect(liveSignals.mock.calls[0]?.[0]).toEqual({
			kind: "start",
			startedAt: "2026-10-01T08:00:00.000Z",
			details,
			subscriptionId: "a",
			identity: { sourceKey: SOURCE_KEY, externalId: "1" },
		});
	});

	it("reportLive 没有这个人的订阅:不交信号,记 debug", () => {
		const { handle, liveSignals, logger } = setup();
		handle.ctx.reportLive("999", { kind: "status", isLive: true, details: {} });
		expect(liveSignals).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalled();
	});

	it("reportLive 形状坏的丢弃并记 error:时刻解析不出、下播没带 endedAt", () => {
		const { handle, liveSignals, logger } = setup();
		handle.ctx.reportLive("1", { kind: "start", startedAt: "不是时刻", details: {} });
		handle.ctx.reportLive("1", {
			kind: "status",
			isLive: true,
			startedAt: "2026-13-45",
			details: {},
		});
		handle.ctx.reportLive("1", { kind: "end", endedAt: "昨天" });
		handle.ctx.reportLive("1", {
			kind: "end",
			startedAt: "不是时刻",
			endedAt: "2026-10-01T09:00:00.000Z",
		});
		// 绕过类型的:下播没带 endedAt。
		handle.ctx.reportLive("1", { kind: "end" } as never);
		expect(liveSignals).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(5);
		// 合格式的照交。
		handle.ctx.reportLive("1", { kind: "end", endedAt: "2026-10-01T09:00:00.000Z" });
		expect(liveSignals).toHaveBeenCalledTimes(1);
	});

	it("dispose 之后 reportLive 不交信号并记 error", () => {
		const { handle, liveSignals, logger } = setup();
		handle.dispose();
		handle.ctx.reportLive("1", { kind: "status", isLive: true, details: {} });
		expect(liveSignals).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("reportLiveInteraction 按身份展开:每条订阅各一份(停用的也交,不在这里筛),带订阅 id,没有这个人的订阅就不交", () => {
		const { handle, liveInteractions } = setup([
			makeSub("a", "1"),
			makeSub("b", "1", { enabled: false }),
			makeSub("c", "2"),
		]);
		const viewer = { id: "123", name: "小明" };
		handle.ctx.reportLiveInteraction("1", { kind: "viewerChat", viewer, text: "你好呀" });
		handle.ctx.reportLiveInteraction("1", { kind: "viewerEnter", viewer });
		handle.ctx.reportLiveInteraction("999", { kind: "viewerEnter", viewer });
		expect(liveInteractions.mock.calls).toEqual([
			["a", { kind: "viewerChat", viewer, text: "你好呀" }],
			["b", { kind: "viewerChat", viewer, text: "你好呀" }],
			["a", { kind: "viewerEnter", viewer }],
			["b", { kind: "viewerEnter", viewer }],
		]);
	});

	it("dispose 之后 reportLiveInteraction 不交并记 error", () => {
		const { handle, liveInteractions, logger } = setup();
		handle.dispose();
		handle.ctx.reportLiveInteraction("1", {
			kind: "viewerEnter",
			viewer: { id: "123", name: "小明" },
		});
		expect(liveInteractions).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("reportProfile 按身份展开:只交启用中的订阅(停用的不收),连同整份上报一起交一次;没有这个人的订阅记 debug 不交", () => {
		const { handle, profiles, logger } = setup([
			makeSub("a", "1"),
			makeSub("b", "1", { enabled: false }),
			makeSub("c", "1"),
			makeSub("d", "2"),
		]);
		const profile: CreatorProfileReport = { name: "新名字", followers: 42 };
		handle.ctx.reportProfile("1", profile);
		expect(profiles.mock.calls).toEqual([[["a", "c"], profile]]);
		handle.ctx.reportProfile("999", profile);
		expect(profiles).toHaveBeenCalledTimes(1);
		expect(logger.debug).toHaveBeenCalledTimes(1);
	});

	it("reportProfile:这个人名下的订阅全停用了也不交,记 debug", () => {
		const { handle, profiles, logger } = setup([makeSub("a", "1", { enabled: false })]);
		handle.ctx.reportProfile("1", { name: "x" });
		expect(profiles).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalledTimes(1);
	});

	it("dispose 之后 reportProfile 不交并记 error", () => {
		const { handle, profiles, logger } = setup();
		handle.dispose();
		handle.ctx.reportProfile("1", { name: "x" });
		expect(profiles).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
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

	// 验红:把 `reportProblem` 里的 `writtenBy` 改回恒取 `descriptor.label`,这条红。
	it("给了 label(拓展的来源:当前语言的清单名):写者名取它,报问题那一刻现取;不给照旧取描述符的 label", () => {
		let current = "抖音拓展";
		const { handle, problems } = setup([makeSub("a", "1")], {}, { label: () => current });
		handle.ctx.reportProblem({ code: "auth_lost", message: "x" });
		current = "Douyin extension";
		handle.ctx.reportProblem({ code: "other_code", message: "y" });
		expect(problems.report.mock.calls.map(([call]) => call.writtenBy)).toEqual([
			"抖音拓展",
			"Douyin extension",
		]);
		const plain = setup();
		plain.handle.ctx.reportProblem({ code: "auth_lost", message: "x" });
		expect(plain.problems.report.mock.calls[0]?.[0].writtenBy).toBe("测试");
	});

	// 验红:让 `forEachProblemObject` 里两处记日志不看 `rejectedProblemLevel`、一律 `error`,这条红。
	it("rejectedProblemLevel 给 warn(拓展的来源):形状不对与已停下的问题上报被拒,记 warn、不记 error", () => {
		const { handle, problems, logger } = setup(
			[makeSub("a", "1")],
			{},
			{ rejectedProblemLevel: "warn" },
		);
		handle.ctx.reportProblem({ code: "Bad Code", message: "x" });
		handle.dispose();
		handle.ctx.resolveProblem({ code: "auth_lost" });
		expect(problems.report).not.toHaveBeenCalled();
		expect(problems.resolve).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("报一条缺 message(第三方 JS 交的):丢弃并记 error,onRejectedProblem 收到点名 message 的原因", () => {
		const rejections: Array<{ externalId?: string; reason: string }> = [];
		const { handle, problems, logger } = setup(
			[makeSub("a", "1")],
			{},
			{ onRejectedProblem: (rejection) => rejections.push(rejection) },
		);
		handle.ctx.reportProblem({ code: "x_down" } as never);
		expect(problems.report).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(rejections).toEqual([{ reason: "问题「x_down」被拒：message 不是字符串" }]);
	});

	it("给了 onRejectedProblem:带上 externalId 与原因,日志照记", () => {
		const rejections: Array<{ externalId?: string; reason: string }> = [];
		const { handle, problems, logger } = setup(
			[makeSub("a", "1")],
			{},
			{
				onRejectedProblem: (rejection) => rejections.push(rejection),
				rejectedProblemLevel: "warn",
			},
		);
		handle.ctx.reportProblem({ externalId: "1", code: "auth_lost", message: "   " });
		expect(problems.report).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(rejections).toEqual([
			{
				externalId: "1",
				reason: "问题「auth_lost」被拒：message 是空白",
			},
		]);
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
