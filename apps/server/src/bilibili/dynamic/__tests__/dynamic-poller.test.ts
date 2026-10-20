/**
 * 单元测试 — `DynamicPoller`:**只管生产**。拉 feed → 判新 → 翻成作品 → 抓图 → 经 `reportPost` 交给核心的作品入口,
 * 加错误处理 / 故障恢复 / 生命周期。
 *
 * 过滤、出卡、AI 点评、套模板、装配、推送、图集都是核心的事(`posts/deliver-post.ts`,测试在
 * `posts/__tests__/deliver-post.test.ts`),引擎测试里不再有它们 —— 给引擎一个什么都不做的 `reportPost`,
 * 「被过滤就不推」这类旧断言会全绿(引擎根本不推了),所以那些断言只在核心那头,**不留在这里原样通过**。
 *
 * 测试策略:
 *   - `detectDynamics()` 是 private,但它是编排核心。白盒直调 + 直接 seed 私有
 *     `postAnchors`,完全绕开 cron + withLock 的
 *     fire-and-forget 计时纠缠(withLock 返回 `() => void` 不可 await)。
 *   - 生命周期用例 `vi.mock("cron")` 注入惰性 FakeCronJob,断言 start/stop 次数与
 *     重建出的新 cronTime。
 */

import {
	type FeatureKey,
	type ImageRef,
	type MessageBus,
	ok,
	type Post,
	type PostReport,
	type Result,
	type ServiceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { Settings } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fixedLocale } from "../../../__tests__/support/fixed-locale.js";
import { makeProblemPipeline } from "../../__tests__/problem-pipeline.js";
import type { Api } from "../../api/index.js";
import { failureFromBili } from "../../error-codes.js";
import { createProblemLayers, type ProblemLayers } from "../../problem-layers";
import { PROBLEM_TEXTS } from "../../problem-texts";
import { DynamicPoller, type DynamicPoller as DynamicPollerType } from "../dynamic-poller";
import { postFromDynamic } from "../post-from-dynamic";
import type { AllDynamicResponse, Dynamic } from "../types";

// ---------------------------------------------------------------------------
// cron mock — 惰性 FakeCronJob,不真正排程
// ---------------------------------------------------------------------------

const cronMock = vi.hoisted(() => {
	const instances: Array<{
		cronTime: string;
		onTick: () => void;
		isActive: boolean;
		startCount: number;
		stopCount: number;
	}> = [];
	class FakeCronJob {
		isActive = false;
		startCount = 0;
		stopCount = 0;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			// 镜像真实 `cron` 包对无法解析表达式的同步抛错(如
			// "Field (minute) cannot be parsed"),供 startJob() 的 try/catch 回归测试用。
			if (cronTime === "BAD CRON") {
				throw new Error("Field (minute) cannot be parsed");
			}
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
			this.startCount++;
		}
		stop(): void {
			this.isActive = false;
			this.stopCount++;
		}
	}
	return { instances, FakeCronJob };
});

vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

// 照常翻译,只是包一层好数它被调了几次(翻译只做一次)、好让它抛一次。
vi.mock("../post-from-dynamic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../post-from-dynamic")>();
	return { ...actual, postFromDynamic: vi.fn(actual.postFromDynamic) };
});

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface Priv {
	postAnchors: Map<string, number>;
	detectDynamics(): Promise<void>;
}
const priv = (e: DynamicPollerType): Priv => e as unknown as Priv;

type LogRec = { level: "info" | "warn" | "error" | "debug"; msg: string };

function makeServiceCtx(): {
	ctx: ServiceContext;
	disposers: Array<() => void | Promise<void>>;
	logs: LogRec[];
} {
	const disposers: Array<() => void | Promise<void>> = [];
	const logs: LogRec[] = [];
	const rec = (level: LogRec["level"]) => (msg: unknown) => {
		logs.push({ level, msg: String(msg) });
	};
	const ctx: ServiceContext = {
		logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: (fn) => {
			disposers.push(fn);
		},
		signal: new AbortController().signal,
		track: () => {},
	};
	return { ctx, disposers, logs };
}

/** 引擎要的那四个上报器方法(其余的 `attach` / `detach` 是来源的事)。 */
type FakeProblems = Pick<
	ProblemLayers,
	"reportRisk" | "resolveRisk" | "reportFailure" | "resolveFailure"
>;

/** 四个方法都是 spy 的假上报器。 */
function makeFakeProblems() {
	return {
		reportRisk: vi.fn<ProblemLayers["reportRisk"]>(),
		resolveRisk: vi.fn<ProblemLayers["resolveRisk"]>(),
		reportFailure: vi.fn<ProblemLayers["reportFailure"]>(),
		resolveFailure: vi.fn<ProblemLayers["resolveFailure"]>(),
	};
}

/** 真上报器(登录正常)+ 一个记录每次上报/清除的假核心。`present()` 回此刻表里该有的 code。 */
function makeRecordingLayers() {
	const table = new Map<string, string>();
	const keyOf = (p: { externalId?: string; code: string }) => `${p.externalId ?? ""}|${p.code}`;
	const layers = createProblemLayers({
		locale: fixedLocale(),
		auth: {
			state: () => ({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }),
			onChange: () => ({ dispose() {} }),
		},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	layers.attach({
		reportProblem: (p) => void table.set(keyOf(p), p.code),
		resolveProblem: (p) => void table.delete(keyOf(p)),
	});
	return { layers, present: () => [...table.values()] };
}

/** 真上报器 + 一个一碰就抛的核心:证明上报器把抛错接住,引擎的退避不受影响。 */
function makeThrowingLayers() {
	const layers = createProblemLayers({
		locale: fixedLocale(),
		auth: {
			state: () => ({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }),
			onChange: () => ({ dispose() {} }),
		},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	layers.attach({
		reportProblem: () => {
			throw new Error("核心那头坏了");
		},
		resolveProblem: () => {
			throw new Error("核心那头坏了");
		},
	});
	return layers;
}

function makeBus(): {
	bus: MessageBus;
	emits: Array<{ event: string; payload: unknown }>;
	trigger: (event: string, payload?: unknown) => void;
} {
	const emits: Array<{ event: string; payload: unknown }> = [];
	const handlers = new Map<string, Array<(payload?: unknown) => void>>();
	const bus = {
		emit: (event: string, payload?: unknown) => {
			emits.push({ event, payload });
		},
		on: (event: string, handler: (payload?: unknown) => void) => {
			const arr = handlers.get(event) ?? [];
			arr.push(handler);
			handlers.set(event, arr);
			return { dispose: () => {} };
		},
	} as unknown as MessageBus;
	return {
		bus,
		emits,
		trigger: (event, payload) => {
			for (const h of handlers.get(event) ?? []) h(payload);
		},
	};
}

function makeItem(opts: {
	uid?: number;
	name?: string;
	pubTs?: number;
	type?: string;
	/** 同时写进 desc.text 与 desc.rich_text_nodes。 */
	text?: string;
	drawPics?: string[];
	/** opus.pics 带原始尺寸。 */
	drawPicsWithDims?: Array<{ url: string; width: number; height: number }>;
	/** 真 DYNAMIC_TYPE_DRAW 形态:图在 major.draw.items[].src(非 opus.pics)。 */
	drawItems?: string[];
	/** 视频动态(DYNAMIC_TYPE_AV)的 major.archive.jump_url;引擎按此算链接 / BV。 */
	videoJumpUrl?: string;
}): Dynamic {
	const text = opts.text ?? "";
	return {
		basic: {},
		id_str: `id-${opts.uid ?? 1}`,
		type: opts.type ?? "DYNAMIC_TYPE_WORD",
		modules: {
			module_author: {
				face: "",
				following: false,
				jump_url: "",
				label: "",
				mid: opts.uid ?? 1,
				name: opts.name ?? "UP",
				pub_action: "",
				pub_time: "",
				pub_ts: opts.pubTs ?? 1000,
				type: "",
			},
			module_dynamic: {
				desc: {
					text,
					rich_text_nodes: text ? [{ text, type: "RICH_TEXT_NODE_TYPE_TEXT" }] : [],
				},
				major:
					opts.drawPics || opts.drawPicsWithDims || opts.drawItems || opts.videoJumpUrl
						? {
								...(opts.drawPicsWithDims
									? { opus: { pics: opts.drawPicsWithDims } }
									: opts.drawPics
										? { opus: { pics: opts.drawPics.map((url) => ({ url })) } }
										: {}),
								...(opts.drawItems
									? { draw: { items: opts.drawItems.map((src) => ({ src })) } }
									: {}),
								...(opts.videoJumpUrl ? { archive: { jump_url: opts.videoJumpUrl } } : {}),
							}
						: undefined,
			},
		},
	} as unknown as Dynamic;
}

/** 请求层回给引擎的东西:code 0 是成功(铺着 data),非 0 是请求层翻好的失败(标准码 + upstreamCode)。 */
function resp(
	items: Dynamic[],
	code = 0,
	message = "ok",
): Result<{ data: AllDynamicResponse["data"] }> {
	if (code !== 0) return failureFromBili(code, message);
	return ok({
		data: { has_more: false, items, offset: "", update_baseline: "", update_num: items.length },
	});
}

/** 测试里写的订阅视图:引擎只认 uid 与 post(`post` 决定名单里的 features 有没有 post)。 */
type SeedView = { uid: string; post?: boolean };
type Roster = Record<string, SeedView>;
const rosterOf = (subs: Roster | null | undefined): SourceSubscriptionView[] =>
	Object.values(subs ?? {}).map((v) => ({
		externalId: v.uid,
		features: new Set<FeatureKey>(v.post ? ["post"] : []),
	}));

interface EngineBag {
	engine: DynamicPollerType;
	fetchAllDynamic: ReturnType<typeof vi.fn>;
	/** 假的分层上报器(四个方法都是 spy);要真件的用例经 `makeEngine({ problems })` 换。 */
	problems: ReturnType<typeof makeFakeProblems>;
	emits: Array<{ event: string; payload: unknown }>;
	trigger: (event: string, payload?: unknown) => void;
	/** 换名单(`ctx.subscriptions()` 此后回新的);要让引擎知道,再调 `engine.syncSubscriptions()`。 */
	setRoster: (subs: Roster | null) => void;
	/** 注入给引擎的抓图口(`fetchImage` 选项):每个地址回一个以它命名的引用,测试数调用。 */
	fetchImage: ReturnType<typeof vi.fn>;
	/** 注入给引擎的核心入口(`reportPost` 选项):引擎交出去的每一条作品。 */
	reportPost: ReturnType<typeof vi.fn<(externalId: string, report: PostReport) => void>>;
	logs: LogRec[];
}

function makeEngine(
	over: {
		config?: Partial<import("../dynamic-poller").DynamicPollerConfig>;
		subs?: Roster | null;
		/** 引擎交作品时核心入口做什么(默认什么都不做);给个会抛的就是测「入口抛了」。 */
		reportPost?: (externalId: string, report: PostReport) => void;
		/** 换成别的上报器(真件);不给 = 四个方法都是 spy 的假件。 */
		problems?: FakeProblems;
	} = {},
): EngineBag {
	const { ctx, logs } = makeServiceCtx();
	const { bus, emits, trigger } = makeBus();
	let roster = rosterOf(over.subs);
	const fetchAllDynamic = vi.fn();
	const api = { fetchAllDynamic } as unknown as Api;
	// 换了真件的用例不碰 spy 的断言口,所以这里一律按假件的类型交出去。
	const problems = (over.problems ?? makeFakeProblems()) as ReturnType<typeof makeFakeProblems>;
	const fetchImage = vi.fn(async (url: string) =>
		ok({ ref: `${Buffer.from(url).toString("hex").slice(-60).padStart(64, "0")}.jpg` as ImageRef }),
	);
	const reportPost = vi.fn<(externalId: string, report: PostReport) => void>(
		over.reportPost ?? (() => {}),
	);
	const engine = new DynamicPoller({
		logger: ctx.logger,
		setTimeout: ctx.setTimeout,
		bus,
		api,
		problems,
		fetchImage,
		reportPost,
		config: {
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: false,
			...over.config,
		},
		subscriptions: () => roster,
	});
	return {
		engine,
		fetchAllDynamic,
		problems,
		emits,
		trigger,
		setRoster: (subs) => {
			roster = rosterOf(subs);
		},
		fetchImage,
		reportPost,
		logs,
	};
}

/** 播种一个订阅视图(推送名单里有它),并给它一个时间线锚点。 */
function seed(engine: DynamicPollerType, uid: string, timeline: number): void {
	priv(engine).postAnchors.set(uid, timeline);
}

const detect = (engine: DynamicPollerType): Promise<void> => priv(engine).detectDynamics();

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.mocked(postFromDynamic).mockClear();
});

// ---------------------------------------------------------------------------
// A. detectDynamics 编排
// ---------------------------------------------------------------------------

describe("DynamicPoller.detectDynamics — API 错误处理", () => {
	it("fetchAllDynamic 抛错 → 不交作品,静默返回", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockRejectedValue(new Error("network down"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	it("code=-101(未登录)→ 不发组件告警、不交作品、不报问题;这一路遗留的风控与请求失败静默清掉", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
		// 要不要告诉主人登录失效由问题表的未登录层管(看登录状态),引擎不再发 engine-error
		expect(b.emits.filter((e) => e.event === "engine-error")).toEqual([]);
		expect(b.problems.reportRisk).not.toHaveBeenCalled();
		expect(b.problems.reportFailure).not.toHaveBeenCalled();
		// 不再适用,不是风控解除:带 notify: false
		expect(b.problems.resolveRisk).toHaveBeenCalledWith("dynamic", { notify: false });
		expect(b.problems.resolveFailure).toHaveBeenCalledWith(
			{ code: "dynamic_fetch_failed" },
			{ notify: false },
		);
		expect(b.logs.some((l) => l.level === "error" && l.msg.includes("账号未登录"))).toBe(true);
	});

	it("code=-352(风控)→ 报到风控层(路名 dynamic),不发组件告警、不报请求失败、排退避重启", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.problems.reportRisk).toHaveBeenCalledTimes(1);
		expect(b.problems.reportRisk).toHaveBeenCalledWith("dynamic", { notify: true });
		expect(b.problems.reportFailure).not.toHaveBeenCalled();
		expect(b.emits.filter((e) => e.event === "engine-error")).toEqual([]);
		expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
	});

	it.each([-412, -799, -509])(
		"code=%i 也是风控 → 报到风控层(路名 dynamic)、不报请求失败、排退避重启",
		async (code) => {
			const b = makeEngine();
			b.fetchAllDynamic.mockResolvedValue(resp([], code, "risk"));
			seed(b.engine, "1", 0);
			await detect(b.engine);
			expect(b.problems.reportRisk).toHaveBeenCalledTimes(1);
			expect(b.problems.reportRisk).toHaveBeenCalledWith("dynamic", { notify: true });
			expect(b.problems.reportFailure).not.toHaveBeenCalled();
			expect(b.emits.filter((e) => e.event === "engine-error")).toEqual([]);
			expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
		},
	);

	it("-352 风控:每次撞都上报(幂等),日志边沿不变 —— 只第一次记 error,之后 debug;恢复后再触发重新记 error(Q7)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		const riskErrors = () =>
			b.logs.filter((l) => l.level === "error" && l.msg.includes("账号被风控")).length;

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 进入风控
		await detect(b.engine); // 仍风控 → 日志抑制,上报照叫
		expect(b.problems.reportRisk).toHaveBeenCalledTimes(2);
		expect(riskErrors()).toBe(1);
		expect(b.logs.some((l) => l.level === "debug" && l.msg.includes("仍处于风控态"))).toBe(true);

		b.fetchAllDynamic.mockResolvedValue(resp([])); // code 0 → 恢复
		await detect(b.engine);
		expect(b.logs.some((l) => l.level === "info" && l.msg.includes("风控已解除"))).toBe(true);

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 再次风控 → 边沿复位后重新记 error
		expect(b.problems.reportRisk).toHaveBeenCalledTimes(3);
		expect(riskErrors()).toBe(2);
	});

	it("-352 后跨 -101(auth-loss)再 -352:日志边沿复位,新风控重新记 error(审计缺口回归)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		const riskErrors = () =>
			b.logs.filter((l) => l.level === "error" && l.msg.includes("账号被风控")).length;

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 风控 episode #1
		expect(riskErrors()).toBe(1);

		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		await detect(b.engine); // auth-loss:独立 episode,复位风控边沿

		b.fetchAllDynamic.mockResolvedValue(resp([])); // 恢复(code 0)
		await detect(b.engine);

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 风控 episode #2(跨过 -101)
		expect(riskErrors()).toBe(2);
	});

	it("别的错误码 → 先清这一路的风控、再报请求失败(code dynamic_fetch_failed,文案带当次的码,是否私聊取自文案处)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		// 动态其实仍在失败:清风控但不是「解除」,不对主人说「风控已解除」
		expect(b.problems.resolveRisk).toHaveBeenCalledWith("dynamic", { notify: false });
		expect(b.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(b.problems.reportFailure).toHaveBeenCalledWith({
			code: "dynamic_fetch_failed",
			message: expect.any(Function),
			notify: PROBLEM_TEXTS.dynamicFetchFailed.notify,
			lasting: false,
		});
		// 交的是取字函数,出字那一刻才带上当次的码
		expect(b.problems.reportFailure.mock.calls[0]?.[0].message()).toBe(
			PROBLEM_TEXTS.dynamicFetchFailed.text(4101132),
		);
		expect(b.problems.reportRisk).not.toHaveBeenCalled();
		expect(b.emits.filter((e) => e.event === "engine-error")).toEqual([]);
		expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
	});

	/**
	 * 上报器的方法都不往外抛(核心那头抛了它自己接住),所以引擎里不必再包 try:
	 * `handleApiError` 开头已经 stop 了 job,退避重启全靠末尾那句 `scheduleDetectorRestart`。
	 * 这里用**真上报器**接一个会抛的核心,证明退避照排。
	 */
	it("上报口抛错 → 退避重启照排(不因通知失败而永久停摆)", async () => {
		const throwing = makeThrowingLayers();
		const b = makeEngine({ problems: throwing });
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
	});

	it("风控上报口抛错 → 退避重启同样照排", async () => {
		const throwing = makeThrowingLayers();
		const b = makeEngine({ problems: throwing });
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
	});

	/**
	 * 风控只在「这一路这一次的结果不是风控拦截」时才清。风控之后同一路以别的方式失败(`-352` → 下一拍 `4101132`),
	 * 风控键还挂着的话会把这条请求失败压成一行日志,表里一直是过时的「风控」。要用**真上报器**才测得出压没压。
	 */
	it("风控之后同一路换了错误码失败:表里是请求失败(dynamic_fetch_failed),风控已清", async () => {
		const rec = makeRecordingLayers();
		const b = makeEngine({ problems: rec.layers });
		seed(b.engine, "1", 0);

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		expect(rec.present()).toEqual(["risk_controlled"]);

		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		expect(rec.present()).toEqual(["dynamic_fetch_failed"]);

		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(rec.present()).toEqual([]);
	});
});

/**
 * 「到底好没好」—— 拉成功了,这一路的风控与请求失败清掉(问题表据此补「已恢复」),并复位两个日志边沿。
 *
 * 瞬时错误(4101132 这类未知码)会退避 300s 后自动重启检测,日志里三条
 * 「将在 300s 后自动重试」「退避计时到,重启动态检测」「动态检测任务已启动」一应俱全。
 * 清的时机是**下一次真正拉取成功**,不是「重启了检测任务」:重启只是把 cron 挂回去,故障还在的话
 * 下一轮照样失败,那时候说"好了"就是骗人。引擎不再有任何私聊口。
 */
describe("DynamicPoller — 故障恢复", () => {
	it("拉成功:清这一路的风控与请求失败(请求失败是普通的清,会补「已恢复」)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.problems.resolveRisk.mockClear();

		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(b.problems.resolveRisk).toHaveBeenCalledWith("dynamic");
		expect(b.problems.resolveFailure).toHaveBeenCalledWith({ code: "dynamic_fetch_failed" });
	});

	it("瞬时错误恢复后记一行 info,带上此前的错误码", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(
			b.logs.some((l) => l.level === "info" && l.msg.includes("4101132") && l.msg.includes("恢复")),
		).toBe(true);
	});

	it("从没坏过的成功拉取不记恢复(否则每个 cron tick 刷一行)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		await detect(b.engine);
		expect(b.logs.some((l) => l.msg.includes("恢复正常"))).toBe(false);
	});

	it("恢复只记一次,后续成功拉取保持安静", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine); // 恢复 → 记一次
		await detect(b.engine);
		await detect(b.engine);
		expect(b.logs.filter((l) => l.msg.includes("恢复正常"))).toHaveLength(1);
	});

	it("瞬时错误连续失败:每次都上报(幂等),日志只记一次 warn(与风控边沿对称)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		await detect(b.engine);
		await detect(b.engine);
		expect(b.problems.reportFailure).toHaveBeenCalledTimes(3);
		expect(b.logs.filter((l) => l.level === "warn" && l.msg.includes("4101132"))).toHaveLength(1);
		expect(b.logs.filter((l) => l.level === "debug" && l.msg.includes("仍是错误码"))).toHaveLength(
			2,
		);
	});

	it("错误码变了 → 当作新故障再记 warn,上报的文案带新的码", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([], -403, "访问权限不足"));
		await detect(b.engine);
		expect(
			b.logs.filter((l) => l.level === "warn" && l.msg.includes("获取动态信息失败")),
		).toHaveLength(2);
		expect(b.problems.reportFailure.mock.lastCall?.[0].message()).toBe(
			PROBLEM_TEXTS.dynamicFetchFailed.text(-403),
		);
	});

	it("风控解除:拉成功时记「风控已解除」", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(b.logs.some((l) => l.level === "info" && l.msg.includes("风控已解除"))).toBe(true);
	});

	it("风控与瞬时错误同时挂着 → 恢复记一行,两样都说到", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // riskControlled 置位
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine); // transientErrorCode 也置位(风控边沿不清)

		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		const recovery = b.logs.filter((l) => l.msg.includes("恢复正常"));
		expect(recovery).toHaveLength(1);
		expect(recovery[0]?.msg).toContain("风控");
		expect(recovery[0]?.msg).toContain("4101132");
	});

	it("跨 -101 后恢复:不拿陈旧错误码记恢复(登录恢复由 auth-restored 负责)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		await detect(b.engine); // 独立 episode
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(b.logs.some((l) => l.msg.includes("恢复正常"))).toBe(false);
	});

	it("上报口抛错不能打断本轮动态的交出", async () => {
		const throwing = makeThrowingLayers();
		const b = makeEngine({ problems: throwing });
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);

		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalled();
	});

	it("引擎 stop():这一路的风控清掉,请求失败用「不再适用」清(不补「已恢复」)", () => {
		const b = makeEngine();
		b.engine.start();
		b.problems.resolveRisk.mockClear();
		b.problems.resolveFailure.mockClear();
		b.engine.stop();
		expect(b.problems.resolveRisk).toHaveBeenCalledWith("dynamic", { notify: false });
		expect(b.problems.resolveFailure).toHaveBeenCalledWith(
			{ code: "dynamic_fetch_failed" },
			{ notify: false },
		);
	});
});

/**
 * 登录掉了以后,动态引擎自己的事:停 cron、不许被订阅变动拉回来、等 `auth-restored`。
 * 告诉主人登录失效不归它 —— 问题表的未登录层看登录状态说(一条带「该怎么办」的私聊),引擎不再发 engine-error。
 */
describe("DynamicPoller — 登录失效时的 cron", () => {
	const oneSub = { subs: { "1": { uid: "1", post: true } } } as const;

	it("收到 auth-lost 立刻停 cron —— 别等下一轮再去白撞一次 -101", () => {
		const b = makeEngine(oneSub);
		b.engine.start();
		expect(cronMock.instances[0]?.isActive).toBe(true);

		b.trigger("auth-lost");
		expect(cronMock.instances[0]?.isActive).toBe(false);
	});

	it("-101 一律不发组件告警:不管有没有先收到 auth-lost(冷启动 cookie 过期也是)", async () => {
		const withLost = makeEngine(oneSub);
		withLost.engine.start();
		withLost.trigger("auth-lost");
		withLost.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(withLost.engine, "1", 0);
		await detect(withLost.engine);
		expect(withLost.emits.filter((e) => e.event === "engine-error")).toEqual([]);

		const withoutLost = makeEngine(oneSub);
		withoutLost.engine.start();
		withoutLost.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(withoutLost.engine, "1", 0);
		await detect(withoutLost.engine);
		expect(withoutLost.emits.filter((e) => e.event === "engine-error")).toEqual([]);
	});

	it("auth-lost 之后订阅变更不许把 cron 拉回来 —— 登录还没恢复,拉起来就是再撞一次", () => {
		// reconcileJob 原本只认「-352 退避窗口」这一个不许启动的理由,登录失效不在其列。
		// 于是 auth-lost 停掉 cron 之后,随便一次订阅增删都会立刻把它重新建起来。
		const b = makeEngine(oneSub);
		b.engine.start();
		b.trigger("auth-lost");
		const after = cronMock.instances.length;

		b.setRoster({ "1": { uid: "1", post: true }, "2": { uid: "2", post: true } });
		b.engine.syncSubscriptions();

		expect(cronMock.instances.length).toBe(after);
	});

	it("auth-restored 之后才重新开跑", () => {
		const b = makeEngine(oneSub);
		b.engine.start();
		b.trigger("auth-lost");

		b.trigger("auth-restored");

		expect(cronMock.instances.at(-1)?.isActive).toBe(true);
	});
});

describe("DynamicPoller.detectDynamics — 时间线 / 订阅过滤", () => {
	it("timeline >= pub_ts → 已处理过,跳过不交", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 1000); // timeline == pub_ts
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	it("未订阅 uid(无 timeline 条目)→ 跳过", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 999, pubTs: 1000 })]));
		seed(b.engine, "1", 0); // 订阅的是 1,动态来自 999
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	it("pub_ts 非数字 → 跳过该条,不交", async () => {
		const b = makeEngine();
		const bad = makeItem({ uid: 1 });
		(bad.modules.module_author as { pub_ts: unknown }).pub_ts = "oops";
		b.fetchAllDynamic.mockResolvedValue(resp([bad]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	it("未订阅 uid 的无效 pub_ts → 静默跳过,不刷 warn", async () => {
		const b = makeEngine();
		const bad = makeItem({ uid: 999 });
		(bad.modules.module_author as { pub_ts: unknown }).pub_ts = "oops";
		b.fetchAllDynamic.mockResolvedValue(resp([bad]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(b.logs.some((l) => l.level === "warn" && l.msg.includes("无法解析发布时间"))).toBe(
			false,
		);
	});

	it("pub_ts 为数字字符串 → 正常交出并推进 timeline", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts: unknown }).pub_ts = "1234";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).postAnchors.get("1")).toBe(1234);
	});

	it("pub_ts 为毫秒时间戳字符串 → 归一化为秒后交出", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts: unknown }).pub_ts = "1717067523000";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).postAnchors.get("1")).toBe(1717067523);
	});

	it("pub_ts 缺失但 pub_time 可解析 → 兜底交出", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts?: unknown }).pub_ts = undefined;
		(item.modules.module_author as { pub_time: string }).pub_time = "2026-05-30 12:12:00";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).postAnchors.get("1")).toBeGreaterThan(0);
	});

	// 验红:退回按进程本地时区读,这条红(`Settings.defaultZone = "UTC"` 时会是 12:12Z)。
	it("pub_ts 缺失但 pub_time 是不带时区的文字 → 按北京时间读,不随进程默认时区", async () => {
		const previousZone = Settings.defaultZone;
		Settings.defaultZone = "UTC";
		try {
			const b = makeEngine();
			const item = makeItem({ uid: 1 });
			(item.modules.module_author as { pub_ts?: unknown }).pub_ts = undefined;
			(item.modules.module_author as { pub_time: string }).pub_time = "2026-05-30 12:12:00";
			b.fetchAllDynamic.mockResolvedValue(resp([item]));
			seed(b.engine, "1", 0);
			await detect(b.engine);
			expect(priv(b.engine).postAnchors.get("1")).toBe(1780114320);
		} finally {
			Settings.defaultZone = previousZone;
		}
	});

	it("pub_ts 缺失但 pub_time 为相对时间/昨天 → 兜底解析", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-30T12:00:00+08:00"));
			const b = makeEngine();
			const item = makeItem({ uid: 1 });
			(item.modules.module_author as { pub_ts?: unknown }).pub_ts = undefined;
			(item.modules.module_author as { pub_time: string }).pub_time = "昨天 11:30";
			b.fetchAllDynamic.mockResolvedValue(resp([item]));
			seed(b.engine, "1", 0);
			await detect(b.engine);
			expect(b.reportPost).toHaveBeenCalledTimes(1);
			expect(priv(b.engine).postAnchors.get("1")).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("新动态交出后 timeline 推进到 pub_ts", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1234 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).postAnchors.get("1")).toBe(1234);
	});

	it("DY1:同 uid 多条全部成功 → 锚点推进到最大 pub_ts", async () => {
		const b = makeEngine();
		// 新→旧
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 200 }), makeItem({ uid: 1, pubTs: 100 })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).postAnchors.get("1")).toBe(200);
		expect(b.reportPost).toHaveBeenCalledTimes(2);
	});

	it("DY1:锚点单调,绝不回退(已 push 过的更新 pub_ts 不倒退)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 100 })]));
		seed(b.engine, "1", 500); // 既有锚点已高于来项
		await detect(b.engine);
		// timeline(500) >= 100 → 跳过,锚点保持 500,绝不被 set 成 100。
		expect(priv(b.engine).postAnchors.get("1")).toBe(500);
		expect(b.reportPost).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 交给核心的作品:引擎只管生产
// ---------------------------------------------------------------------------

/** 一条转发:原作者的头像地址写在原动态的作者模块里。 */
const repostItem = (): Dynamic => {
	const item = makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_FORWARD", text: "转发" });
	item.orig = {
		type: "DYNAMIC_TYPE_WORD",
		modules: {
			module_author: { name: "原作者", face: "https://i0.hdslb.com/bfs/face/orig.jpg" },
			module_dynamic: { desc: { text: "原文", rich_text_nodes: [] } },
		},
	} as unknown as Dynamic;
	return item;
};

/** 一条带表情的动态:表情图地址写在富文本节点的 `emoji.icon_url`。 */
const emojiItem = (): Dynamic => {
	const item = makeItem({ uid: 1, pubTs: 1000, text: "看[doge]" });
	item.modules.module_dynamic.desc = {
		text: "看[doge]",
		rich_text_nodes: [
			{ text: "看", type: "RICH_TEXT_NODE_TYPE_TEXT" },
			{
				text: "[doge]",
				type: "RICH_TEXT_NODE_TYPE_EMOJI",
				emoji: {
					icon_url: "https://i0.hdslb.com/bfs/emote/doge.png",
					size: 1,
					text: "[doge]",
					type: 1,
				},
			},
		] as never,
	};
	return item;
};

/** 取引擎交出去的第 n 条:`[uid, 作品信封]`。 */
const reported = (b: EngineBag, n = 0): [string, PostReport] => {
	const call = b.reportPost.mock.calls[n];
	if (!call) throw new Error(`引擎没有交出第 ${n + 1} 条作品`);
	return call;
};

describe("DynamicPoller.detectDynamics — 把作品交给核心入口", () => {
	it("每条越过时间线闸的动态交一次:(uid, { postId, url, post }),post 是翻译出来的中立作品、没有原始字段", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, name: "示例UP", pubTs: 1_700_000_000, text: "你好世界" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		const [uid, report] = reported(b);
		expect(uid).toBe("1");
		expect(report.postId).toBe("id-1");
		expect(report.url).toBe("https://t.bilibili.com/id-1");
		// 是翻译出来的中立作品,不是原始动态:有 creator / publishedAt / text,没有 modules。
		expect(report.post).toMatchObject({
			creator: { name: "示例UP" },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "你好世界",
		});
		expect(report.post).not.toHaveProperty("modules");
	});

	it("翻译只做一次:交出去的就是那份翻译(没有图要抓时内容一致);点评、出卡都是核心拿这一份", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1500, name: "阿伟", text: "正文" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(postFromDynamic).toHaveBeenCalledTimes(1);
		const translated = vi.mocked(postFromDynamic).mock.results[0]?.value;
		expect(reported(b)[1].post).toEqual(translated);
	});

	it("翻译抛错(不该发生,但别卡住这位 UP):这一条记 warn 跳过、不交、不发抓图、timeline 照推进,同一轮别的动态照常交", async () => {
		const b = makeEngine();
		vi.mocked(postFromDynamic).mockImplementationOnce(() => {
			throw new Error("翻不动");
		});
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({ uid: 1, pubTs: 1500, name: "阿伟", text: "新的" }),
				makeItem({ uid: 1, pubTs: 1200, name: "阿伟", text: "旧的" }),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		// 第一条(翻译抛错)跳过,第二条照交;锚点推进到两条里最大的(翻译失败的算处理过,不重试)。
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(reported(b)[1].post.text).toBe("旧的");
		expect(priv(b.engine).postAnchors.get("1")).toBe(1500);
		expect(
			b.logs.some((l) => l.level === "warn" && l.msg.includes("翻不动") && l.msg.includes("id-1")),
		).toBe(true);
	});

	it("链接:动态给动态页;视频给视频页;视频换 BV 取得到就是 BV 号,取不到就是空串", async () => {
		const urlOf = async (
			config: { dynamicVideoUrlToBV: boolean },
			type: string,
			videoJumpUrl?: string,
		): Promise<string> => {
			const b = makeEngine({ config });
			b.fetchAllDynamic.mockResolvedValue(
				resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫", type, videoJumpUrl })]),
			);
			seed(b.engine, "1", 0);
			await detect(b.engine);
			return reported(b)[1].url;
		};
		const off = { dynamicVideoUrlToBV: false };
		const on = { dynamicVideoUrlToBV: true };
		expect(await urlOf(off, "DYNAMIC_TYPE_WORD")).toBe("https://t.bilibili.com/id-1");
		expect(await urlOf(off, "DYNAMIC_TYPE_AV", "//www.bilibili.com/video/BV1demo")).toBe(
			"https://www.bilibili.com/video/BV1demo",
		);
		expect(await urlOf(on, "DYNAMIC_TYPE_AV", "//www.bilibili.com/video/BV1demo")).toBe("BV1demo");
		expect(await urlOf(on, "DYNAMIC_TYPE_AV", "//www.bilibili.com/read/cv1")).toBe("");
	});

	// 引擎的发布时间有一整套兜底(`pub_ts` 的秒 / 毫秒 / 数字字符串,缺了再读 `pub_time` 的文字),翻译里只有
	// `author.pub_ts`,缺了落在纪元。统计与卡上的时间都吃交出去的那份,所以引擎交出之前要覆写。
	// 验红:把 dynamic-poller.ts 里覆写 `publishedAt` 那一行去掉,这条红(交出去的是 1970 年)。
	it("publishedAt 用引擎自己算的发布时间:pub_ts 缺失、靠 pub_time 兜底时,翻译落在 1970,交出去的不是", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1, name: "阿绫", text: "兜底" });
		(item.modules.module_author as { pub_ts?: unknown }).pub_ts = undefined;
		(item.modules.module_author as { pub_time: string }).pub_time = "2026-05-30 12:12:00";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const translated = vi.mocked(postFromDynamic).mock.results[0]?.value as Post;
		expect(translated.publishedAt).toBe("1970-01-01T00:00:00.000Z");
		const expected = new Date(2026, 4, 30, 12, 12, 0);
		expect(reported(b)[1].post.publishedAt).toBe(expected.toISOString());
		expect(priv(b.engine).postAnchors.get("1")).toBe(Math.floor(expected.getTime() / 1000));
	});

	it("有 pub_ts 的动态:交出去的发布时间就是 pub_ts(秒与毫秒两种写法一致)", async () => {
		for (const raw of [1717067523, "1717067523", "1717067523000"]) {
			const b = makeEngine();
			const item = makeItem({ uid: 1, name: "阿绫", text: "有时间" });
			(item.modules.module_author as { pub_ts: unknown }).pub_ts = raw;
			b.fetchAllDynamic.mockResolvedValue(resp([item]));
			seed(b.engine, "1", 0);
			await detect(b.engine);
			expect(reported(b)[1].post.publishedAt).toBe(new Date(1717067523 * 1000).toISOString());
		}
	});

	it("直播预约动态(DYNAMIC_TYPE_LIVE)照常交,翻成一条不带视频的作品", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫", type: "DYNAMIC_TYPE_LIVE" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		const { post, url } = reported(b)[1];
		expect(post.video).toBeUndefined();
		expect(post.notice).toContain("直播预约");
		expect(url).toBe("https://t.bilibili.com/id-1");
	});

	it("过滤不是引擎的事:含屏蔽词的动态照样交(核心入口之后再挡)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, text: "含禁词的动态" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
	});
});

describe("DynamicPoller.detectDynamics — 交出之前先把图抓好(决策 3)", () => {
	// 验红:把 dynamic-poller.ts 里 `fetchPostImages` 挪到 `reportPost` 之后(或不调),这条红。
	it("只有地址的图先抓进图库再交:交出去的作品里图已带 ref(原地址仍在),抓图发生在交出之前", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({ uid: 1, pubTs: 1000, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] }),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		const { post } = reported(b)[1];
		expect(post.images).toHaveLength(1);
		expect(post.images?.[0]?.ref).toBeDefined();
		expect(post.images?.[0]?.url).toBe("https://i0.hdslb.com/bfs/new_dyn/a.jpg");
		expect(b.fetchImage.mock.invocationCallOrder[0]).toBeLessThan(
			b.reportPost.mock.invocationCallOrder[0] as number,
		);
	});

	it("只有 draw.items 的老形状图文动态:交出去的作品里有图,带宽高", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_DRAW" });
		(item.modules.module_dynamic as { major: unknown }).major = {
			draw: { items: [{ src: "https://i0.hdslb.com/bfs/new_dyn/d.jpg", width: 800, height: 600 }] },
		};
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const image = reported(b)[1].post.images?.[0];
		expect(image).toMatchObject({
			url: "https://i0.hdslb.com/bfs/new_dyn/d.jpg",
			width: 800,
			height: 600,
		});
		expect(image?.ref).toBeDefined();
	});

	// 验红:把 `repostAvatarUrlOf(item)` 那一项从 fetchPostImages 的选项里去掉,这条红。
	it("转发:原作者的头像一起抓(480 宽头像档),交出去的作品里已有 repost.creator.avatar;外层头像不在引擎里填", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([repostItem()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.fetchImage.mock.calls[0]?.[0]).toBe(
			"https://i0.hdslb.com/bfs/face/orig.jpg@480w_80q_1s.webp",
		);
		const { post } = reported(b)[1];
		expect(post.repost?.creator.avatar).toBeDefined();
		expect(post.creator.avatar).toBeUndefined();
	});

	// 验红:把 `emojiUrlsOf(item)` 那一项从 fetchPostImages 的选项里去掉,这条红。
	it("正文里的表情一起抓成图(表情那一档 128 宽),交出去的作品里表情带 image", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([emojiItem()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.fetchImage.mock.calls[0]?.[0]).toBe(
			"https://i0.hdslb.com/bfs/emote/doge.png@128w_80q_1s.webp",
		);
		const emoji = reported(b)[1].post.richText?.find((segment) => segment.kind === "emoji");
		expect(emoji).toMatchObject({ text: "[doge]" });
		expect(emoji).toHaveProperty("image");
	});

	it("不管出不出卡、被不被过滤:这些都是核心的事,引擎一律照抓(决策 3,出网变多的代价主人知情)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					text: "含禁词",
					drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
	});
});

describe("DynamicPoller.detectDynamics — 只为推送名单里的订阅生产(决策 6)", () => {
	/** 建表走 `start()`(名单现读):表里只收 `post` 开着的人,关着的没有锚点。 */
	const startWith = (b: EngineBag): void => {
		b.setRoster({
			"11": { uid: "11", post: false },
			"22": { uid: "22", post: true },
		});
		b.engine.start();
	};
	/** 建表之后才发布 —— 锚点初值是「此刻」,拿旧时间戳的动态一律算已看过。 */
	const pubTs = Math.floor(Date.now() / 1000) + 60;
	const picItem = (uid: number) =>
		makeItem({ uid, pubTs, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] });

	it("关了作品推送的订阅:不翻译、不抓图、不交;也没有锚点(已定 18:不在要推的人里)", async () => {
		const b = makeEngine();
		startWith(b);
		b.fetchAllDynamic.mockResolvedValue(resp([picItem(11)]));
		await detect(b.engine);
		expect(postFromDynamic).not.toHaveBeenCalled();
		expect(b.fetchImage).not.toHaveBeenCalled();
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(priv(b.engine).postAnchors.has("11")).toBe(false);
	});

	it("对照:同样的铺垫,开着作品推送的订阅就翻译、抓图、交", async () => {
		const b = makeEngine();
		startWith(b);
		b.fetchAllDynamic.mockResolvedValue(resp([picItem(22)]));
		await detect(b.engine);
		expect(postFromDynamic).toHaveBeenCalledTimes(1);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).postAnchors.get("22")).toBe(pubTs);
	});
});

describe("DynamicPoller.detectDynamics — 每条越过时间线的动态恰好前移一次", () => {
	it("reportPost 抛了:记 warn、这一条仍前移(不重试),别的订阅 / 别的动态照常交", async () => {
		const b = makeEngine({
			reportPost: (uid) => {
				if (uid === "1") throw new Error("入口炸了");
			},
		});
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 100 }), makeItem({ uid: 2, pubTs: 300 })]),
		);
		seed(b.engine, "1", 0);
		seed(b.engine, "2", 0);

		await expect(detect(b.engine)).resolves.toBeUndefined(); // 整轮不 abort

		expect(b.reportPost).toHaveBeenCalledTimes(2);
		expect(priv(b.engine).postAnchors.get("2")).toBe(300);
		// 入口抛了也前移:作品只交一次、核心不替来源重放,留着不前移只会下一轮重交一遍。
		expect(priv(b.engine).postAnchors.get("1")).toBe(100);
		expect(b.logs.some((l) => l.level === "warn" && l.msg.includes("入口炸了"))).toBe(true);
	});

	it("抓图服务出错(图抓不到):那张图保持只有地址,这一条照常交、仍前移", async () => {
		const b = makeEngine();
		b.fetchImage.mockImplementation(async () => {
			throw new Error("图床炸了");
		});
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({ uid: 1, pubTs: 100, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] }),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).postAnchors.get("1")).toBe(100);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(reported(b)[1].post.images?.[0]?.ref).toBeUndefined();
	});
});

// 一轮里按创作者分组:同一位的几条照旧一条接一条交,不同创作者的链同时跑(同时最多 4 条),
// 一位的图抓得慢不再堵住别人;一轮仍是所有链都跑完才算结束。
describe("DynamicPoller.detectDynamics — 按创作者分组并行生产", () => {
	const picUrl = (uid: number, n = 1) => `https://i0.hdslb.com/bfs/new_dyn/u${uid}-${n}.jpg`;
	const picOf = (uid: number, pubTs: number, n = 1) =>
		makeItem({ uid, pubTs, drawPics: [picUrl(uid, n)] });
	/** 让已经能往前走的微任务 / 定时器都跑完(手动放行的 promise 之外不真等时间)。 */
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	/** 给指定地址的抓图挂一道手动放行的闸;没挂闸的地址立刻回。 */
	function holdFetches(b: EngineBag, urls: string[]) {
		const gates = new Map<string, () => void>();
		const waits = new Map(
			urls.map((url) => [url, new Promise<void>((r) => gates.set(url, r))] as const),
		);
		// 抓图服务拿到的地址会带缩放后缀(`@…w_…webp`),按前缀认挂的是哪一张。
		const heldBy = (url: string) => urls.find((held) => url.startsWith(held));
		b.fetchImage.mockImplementation(async (url: string) => {
			const held = heldBy(url);
			if (held !== undefined) await waits.get(held);
			return ok({ ref: `${"c".repeat(63)}1.jpg` as ImageRef, url });
		});
		return (url: string) => gates.get(url)?.();
	}
	const deliveredUids = (b: EngineBag): string[] => b.reportPost.mock.calls.map(([uid]) => uid);
	const deliveredUrls = (b: EngineBag): Array<string | undefined> =>
		b.reportPost.mock.calls.map(([, report]) => report.post.images?.[0]?.url);

	// 验红:把分组并行改回逐条串行(`for` + `await produce`),这条红(乙要等甲)。
	it("甲的图抓得慢:乙的作品不等甲的抓图放行就交出;放行后甲也交,两位锚点各推到自己的发布时间", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([picOf(1, 100), picOf(2, 200)]));
		seed(b.engine, "1", 0);
		seed(b.engine, "2", 0);
		const release = holdFetches(b, [picUrl(1)]);

		const round = detect(b.engine);
		await settle();
		expect(deliveredUids(b)).toEqual(["2"]); // 乙先交,甲还卡在抓图里

		release(picUrl(1));
		await round;
		expect(deliveredUids(b)).toEqual(["2", "1"]);
		expect(priv(b.engine).postAnchors.get("1")).toBe(100);
		expect(priv(b.engine).postAnchors.get("2")).toBe(200);
	});

	// 验红:把组内串行改成全并行,第二条抢在第一条前面交,这条红。
	it("同一位创作者两条、第一条的抓图挂着:第二条不抢先,放行后按动态流的次序交", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([picOf(1, 200, 1), picOf(1, 100, 2)]));
		seed(b.engine, "1", 0);
		const release = holdFetches(b, [picUrl(1, 1)]);

		const round = detect(b.engine);
		await settle();
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(b.fetchImage).toHaveBeenCalledTimes(1); // 第二条连抓图都没开始

		release(picUrl(1, 1));
		await round;
		expect(deliveredUrls(b)).toEqual([picUrl(1, 1), picUrl(1, 2)]);
		expect(priv(b.engine).postAnchors.get("1")).toBe(200);
	});

	it("并行有上限:同时在抓图的创作者不超过 4 位;放行一位,下一位才开始", async () => {
		const b = makeEngine();
		const uids = [1, 2, 3, 4, 5, 6];
		b.fetchAllDynamic.mockResolvedValue(resp(uids.map((uid) => picOf(uid, 100 + uid))));
		for (const uid of uids) seed(b.engine, String(uid), 0);
		const release = holdFetches(
			b,
			uids.map((uid) => picUrl(uid)),
		);

		const round = detect(b.engine);
		await settle();
		expect(b.fetchImage).toHaveBeenCalledTimes(4);

		release(picUrl(1));
		await settle();
		expect(b.fetchImage).toHaveBeenCalledTimes(5);
		expect(deliveredUids(b)).toEqual(["1"]);

		for (const uid of uids) release(picUrl(uid));
		await round;
		expect(b.reportPost).toHaveBeenCalledTimes(6);
		expect(b.fetchImage).toHaveBeenCalledTimes(6);
	});

	it("一条链里 produce 之外意外抛错:别的创作者的链照常交,整轮正常结束,锚点照常回写(出错那条也前移)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([picOf(1, 100), picOf(1, 90, 2), picOf(2, 200), picOf(3, 300)]),
		);
		for (const uid of ["1", "2", "3"]) seed(b.engine, uid, 0);
		// produce 自己吞错;这里直接让它在甲那条上拒绝,验的是并发那一层不把一个拒绝变成整轮失败。
		const engine = b.engine as unknown as {
			produce: (item: Dynamic, uid: string, postTime: number) => Promise<void>;
		};
		const realProduce = engine.produce.bind(engine);
		engine.produce = async (item, uid, postTime) => {
			if (uid === "1" && postTime === 100) throw new Error("意外炸了");
			return realProduce(item, uid, postTime);
		};

		await expect(detect(b.engine)).resolves.toBeUndefined();

		expect(deliveredUids(b).sort()).toEqual(["1", "2", "3"]); // 甲的第二条也照交
		expect(priv(b.engine).postAnchors.get("1")).toBe(100);
		expect(priv(b.engine).postAnchors.get("2")).toBe(200);
		expect(priv(b.engine).postAnchors.get("3")).toBe(300);
		expect(b.logs.some((l) => l.level === "error" && l.msg.includes("意外炸了"))).toBe(true);
	});
});

describe("DynamicPoller.detectDynamics — 开播伪动态", () => {
	const liveRcmd = () => makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_LIVE_RCMD" });

	it("不翻译、不抓图、不交;锚点照常前移,下一轮不再重判", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([liveRcmd()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(postFromDynamic).not.toHaveBeenCalled();
		expect(b.fetchImage).not.toHaveBeenCalled();
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(priv(b.engine).postAnchors.get("1")).toBe(1000);
	});
});

describe("DynamicPoller — 名单在 detectDynamics 抓图的 await 期间变了(A7)", () => {
	const picItem = () =>
		makeItem({ uid: 1, pubTs: 1000, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] });

	it("抓图期间 delete 该 UID → 不交 + 不复活时间线", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
		seed(b.engine, "1", 0);
		// 模拟交错:抓图解析前,来源收到「名单可能变了」,新名单里没有 uid 1(退订)。
		b.fetchImage.mockImplementation(async (url: string) => {
			b.setRoster({});
			b.engine.syncSubscriptions();
			return ok({ ref: `${"c".repeat(63)}1.jpg` as ImageRef, url });
		});

		await detect(b.engine);

		// 身份重校:已退订 → 不得再交。
		expect(b.reportPost).not.toHaveBeenCalled();
		// 时间线回写守卫:不得把已删 UID 的时间线“复活”成孤儿锚点。
		expect(priv(b.engine).postAnchors.has("1")).toBe(false);
	});

	// 引擎只交 uid,接线按身份**现查**订阅:抓图那几秒里同一个 uid 被「删了再加」的话,现查会找到新加的那条订阅,
	// 核心的回问也过得去(新订阅好端端在),于是一条旧动态被推给新订阅。「删了」与「删了又加回来」时间线锚点都会变
	// (没了 / 重置成现在),所以抓完图把进门时过的两道闸再过一遍:名单里还有这个 uid、锚点还在且仍早于这条动态。
	// 验红:把 dynamic-poller.ts 抓图之后那句 `this.stillDue(...)` 的判断去掉,这条与上一条红。
	it("抓图期间同一 uid 被「删了再加」→ 旧动态不交给新订阅;对照:订阅没变就交", async () => {
		const swapped = makeEngine();
		swapped.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
		seed(swapped.engine, "1", 0);
		swapped.fetchImage.mockImplementation(async (url: string) => {
			swapped.setRoster({});
			swapped.engine.syncSubscriptions();
			swapped.setRoster({ "1": { uid: "1", post: true } });
			swapped.engine.syncSubscriptions();
			return ok({ ref: `${"c".repeat(63)}1.jpg` as ImageRef, url });
		});
		await detect(swapped.engine);
		expect(priv(swapped.engine).postAnchors.has("1")).toBe(true); // 新订阅在
		expect(swapped.reportPost).not.toHaveBeenCalled();

		const steady = makeEngine();
		steady.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
		seed(steady.engine, "1", 0);
		await detect(steady.engine);
		expect(steady.reportPost).toHaveBeenCalledTimes(1);
	});

	// 同 uid 的 update / 名单整份重建,只换名单里的对象、不动时间线锚点:这条动态是同一条订阅的,照常交、恰好一次。
	// 关了又开作品推送不在此列:离开就删锚点,再开从「现在」起算,抓图前发的旧动态不交(已定 18)。
	// 验红:把抓图之后的重校改回对象身份比对(`this.postAnchors.get(uid) !== subAtCapture`),这几条红(动态永久丢)。
	describe("抓图期间订阅只是被更新(没删):照常交,恰好一次", () => {
		const sub = { "1": { uid: "1", post: true } };
		const withDuringFetch = async (during: (b: EngineBag) => void) => {
			const b = makeEngine({ subs: sub });
			b.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
			seed(b.engine, "1", 0);
			b.fetchImage.mockImplementation(async (url: string) => {
				during(b);
				return ok({ ref: `${"c".repeat(63)}1.jpg` as ImageRef, url });
			});
			await detect(b.engine);
			return b;
		};

		it("名单重算一遍、内容没变(订阅被保存了一下)→ 这条动态照常交", async () => {
			const b = await withDuringFetch((x) => x.engine.syncSubscriptions());
			expect(b.reportPost).toHaveBeenCalledTimes(1);
			expect(priv(b.engine).postAnchors.get("1")).toBe(1000);
		});

		it("整份名单被重建(restartDetector,如登录恢复后重启检测)→ 照常交", async () => {
			const b = await withDuringFetch((x) => x.trigger("auth-restored"));
			expect(b.reportPost).toHaveBeenCalledTimes(1);
		});

		it("关了作品推送又打开(先去掉 post 再加回来,锚点重置成现在)→ 这条旧动态不交", async () => {
			const b = await withDuringFetch((x) => {
				x.setRoster({ "1": { uid: "1", post: false } });
				x.engine.syncSubscriptions();
				x.setRoster(sub);
				x.engine.syncSubscriptions();
			});
			expect(b.reportPost).not.toHaveBeenCalled();
		});

		it("对照:抓图期间关了作品推送且没再打开 → 不交(名单里没有了)", async () => {
			const b = await withDuringFetch((x) => {
				x.setRoster({ "1": { uid: "1", post: false } });
				x.engine.syncSubscriptions();
			});
			expect(b.reportPost).not.toHaveBeenCalled();
		});

		it("抓图期间引擎停下了 → 不交(停下之后不许再上报)", async () => {
			const b = await withDuringFetch((x) => x.engine.stop());
			expect(b.reportPost).not.toHaveBeenCalled();
		});
	});
});

// ---------------------------------------------------------------------------
// C. 生命周期(cron mock)
// ---------------------------------------------------------------------------

describe("DynamicPoller — reconcileJob 尊重风控退避", () => {
	it("-352 退避窗口内 syncSubscriptions → 不提前重启 cron(退避不被击穿)", async () => {
		const before = cronMock.instances.length;
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start(); // cron 实例 #1
		const afterStart = cronMock.instances.length;
		expect(afterStart).toBe(before + 1);

		// 进入 -352 风控:handleApiError 停 job(dynamicJob=undefined)并排一次性退避重启
		// (detectorRestartTimer 置位;fake setTimeout 不触发,故退避一直挂着)。
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);

		// 退避窗口内来源收到「名单可能变了」→ syncSubscriptions → reconcileJob。subManager 仍非空,
		// dynamicJob 又是 undefined —— 若只看 dynamicJob?.isActive 会立即 startJob,提前去戳
		// 仍在风控的端点,击穿退避。修复后应识别 detectorRestartTimer 待执行而跳过。
		b.setRoster({ "1": { uid: "1", post: true }, "2": { uid: "2", post: true } });
		b.engine.syncSubscriptions();

		expect(cronMock.instances.length).toBe(afterStart); // 没有新建 cron
	});
});

describe("DynamicPoller — 生命周期 / cron 重启", () => {
	it("start() 有订阅快照 → 建并启动 cron;stop() → 停止", () => {
		const subs = { "1": { uid: "1", post: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		expect(b.engine.isActive).toBe(true);

		b.engine.stop();
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(b.engine.isActive).toBe(false);
	});

	it("start() 空名单 → 不建 cron;auth-restored 后用新名单重建", () => {
		const b = makeEngine();
		b.engine.start();
		expect(cronMock.instances).toHaveLength(0);

		b.setRoster({ "1": { uid: "1", post: true } });
		b.trigger("auth-restored");
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.isActive).toBe(true);
	});

	it("空名单重启不留旧推送名单(今天的小毛病:先 return 后赋值)", () => {
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start();
		expect(priv(b.engine).postAnchors.has("1")).toBe(true);
		b.setRoster({});
		b.trigger("auth-restored");
		expect(priv(b.engine).postAnchors.size).toBe(0);
	});

	it("syncSubscriptions 前后是同一个 cron job(名单一动不重启 cron、不打乱相位)", () => {
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start();
		const job = cronMock.instances[0];
		b.setRoster({ "1": { uid: "1", post: true }, "2": { uid: "2", post: true } });
		b.engine.syncSubscriptions();
		expect(cronMock.instances).toHaveLength(1);
		expect(job?.isActive).toBe(true);
		expect(job?.stopCount).toBe(0);
	});

	it("退避到点按最新名单重启检测", () => {
		const timers: Array<() => void> = [];
		// 能触发的定时器:本用例只关心「到点会重启」。
		const engine = new DynamicPoller({
			logger: { info() {}, warn() {}, error() {}, debug() {} },
			setTimeout: (fn) => {
				timers.push(fn);
				return { dispose() {} };
			},
			bus: makeBus().bus,
			api: { fetchAllDynamic: vi.fn(async () => resp([], -352, "risk")) } as unknown as Api,
			problems: makeFakeProblems(),
			fetchImage: vi.fn(),
			reportPost: () => {},
			config: { dynamicCron: "*/2 * * * *", dynamicVideoUrlToBV: false },
			subscriptions: () => rosterOf({ "1": { uid: "1", post: true } }),
		});
		engine.start();
		const before = cronMock.instances.length;
		return detect(engine).then(() => {
			expect(timers).toHaveLength(1);
			timers[0]?.();
			expect(cronMock.instances.length).toBe(before + 1);
			expect(cronMock.instances.at(-1)?.isActive).toBe(true);
		});
	});

	it("名单里去掉某人再加回来 → 锚点是加回来那一刻,之前发的那条不交(已定 16)", async () => {
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start();
		const midpoint = Math.floor(Date.now() / 1000) + 30;
		b.setRoster({});
		b.engine.syncSubscriptions();
		expect(priv(b.engine).postAnchors.has("1")).toBe(false);
		// 停用期间发的动态,在「加回来」之前发出:发布时间早于加回来的那一刻。
		vi.useFakeTimers({ toFake: ["Date"], now: (midpoint + 60) * 1000 });
		try {
			b.setRoster({ "1": { uid: "1", post: true } });
			b.engine.syncSubscriptions();
		} finally {
			vi.useRealTimers();
		}
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: midpoint })]));
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	// 验红:去掉 `applyRoster` 里「离开就删锚点」(留着旧锚点),这条红。
	// 关着期间只轮询别人(「2」),「1」自己的动态那一轮没出现:再开之后补出来的那条是「1」关着期间发的,锚点若留着就会被交。
	// 用例这样设计是为了与「锚点被别人的轮询推过去」分开 —— 那种情况「1」的锚点没被推过,只可能靠删了重置挡下。
	it("名单里有别人开着作品时,某人关了再开:关着期间他发的那条不交(因为离开就删了锚点)", async () => {
		const b = makeEngine({
			subs: { "1": { uid: "1", post: true }, "2": { uid: "2", post: true } },
		});
		b.engine.start();
		const base = Math.floor(Date.now() / 1000);

		b.setRoster({ "1": { uid: "1", post: false }, "2": { uid: "2", post: true } });
		b.engine.syncSubscriptions();
		expect(priv(b.engine).postAnchors.has("1")).toBe(false);
		// 关着期间 cron 为「2」照常轮询,这一轮里只有「2」的动态。
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 2, pubTs: base + 100 })]));
		await detect(b.engine);

		vi.useFakeTimers({ toFake: ["Date"], now: (base + 200) * 1000 });
		try {
			b.setRoster({ "1": { uid: "1", post: true }, "2": { uid: "2", post: true } });
			b.engine.syncSubscriptions();
		} finally {
			vi.useRealTimers();
		}
		b.reportPost.mockClear();
		// 再开之后的下一轮,feed 里才出现「1」关着期间(base+150,早于重新打开的那一刻)发的动态。
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: base + 150 })]));
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	it("updateConfig 改 dynamicCron(运行中)→ 旧 job 停,新 job 用新 cronTime", () => {
		const subs = { "1": { uid: "1", post: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		expect(cronMock.instances).toHaveLength(1);

		b.engine.updateConfig({
			dynamicCron: "*/5 * * * *",
			dynamicVideoUrlToBV: false,
		});
		expect(cronMock.instances[0]?.stopCount).toBe(1);
		expect(cronMock.instances).toHaveLength(2);
		expect(cronMock.instances[1]?.cronTime).toBe("*/5 * * * *");
		expect(cronMock.instances[1]?.isActive).toBe(true);
	});

	it("updateConfig 同 cron → 不重建 job", () => {
		const subs = { "1": { uid: "1", post: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		b.engine.updateConfig({
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: true, // 改了别的字段,但 cron 不变
		});
		expect(cronMock.instances).toHaveLength(1);
	});

	it("syncSubscriptions:名单里有人开了作品 → 起 job;去掉最后一个 → 停 job", () => {
		const sub = { uid: "1", post: true };
		const b = makeEngine({ subs: { "1": sub } });
		b.engine.start(); // 名单里 post 开着 → 已有 running job
		expect(cronMock.instances[0]?.isActive).toBe(true);

		b.setRoster({});
		b.engine.syncSubscriptions();
		expect(cronMock.instances[0]?.isActive).toBe(false);

		b.setRoster({ "1": sub });
		b.engine.syncSubscriptions();
		// 重新有订阅 → reconcile 重启(可能复用或新建 instance,断言最终处于 running)
		const last = cronMock.instances[cronMock.instances.length - 1];
		expect(last?.isActive).toBe(true);
	});

	it("回归:dynamicCron 无法解析(new CronJob 同步抛错)不炸穿 start(),记录 error 且不建 job(此前独立端会在启动期整进程崩溃,见 sidecar.stderr.log 的 CronError)", () => {
		const subs = { "1": { uid: "1", post: true } };
		const b = makeEngine({ subs, config: { dynamicCron: "BAD CRON" } });
		expect(() => b.engine.start()).not.toThrow();
		expect(cronMock.instances).toHaveLength(0);
		expect(b.engine.isActive).toBe(false);
		expect(
			b.logs.some(
				(l) => l.level === "error" && l.msg.includes("BAD CRON") && l.msg.includes("无法解析"),
			),
		).toBe(true);
	});

	it("cron 写坏起不来 → 改成好的:updateConfig 自己把 job 拉起来(不等名单变动)", () => {
		const b = makeEngine({
			subs: { "1": { uid: "1", post: true } },
			config: { dynamicCron: "BAD CRON" },
		});
		b.engine.start();
		expect(cronMock.instances).toHaveLength(0);

		b.engine.updateConfig({ dynamicCron: "*/5 * * * *", dynamicVideoUrlToBV: false });

		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.cronTime).toBe("*/5 * * * *");
		expect(b.engine.isActive).toBe(true);
	});

	it("对照:-352 退避窗口内改 cron → 不把 job 提前拉起来", async () => {
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start();
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		const before = cronMock.instances.length;

		b.engine.updateConfig({ dynamicCron: "*/5 * * * *", dynamicVideoUrlToBV: false });

		expect(cronMock.instances.length).toBe(before);
		expect(b.engine.isActive).toBe(false);
	});

	it("对照:登录失效时改 cron → 不把 job 提前拉起来", () => {
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start();
		b.trigger("auth-lost");
		const before = cronMock.instances.length;

		b.engine.updateConfig({ dynamicCron: "*/5 * * * *", dynamicVideoUrlToBV: false });

		expect(cronMock.instances.length).toBe(before);
		expect(b.engine.isActive).toBe(false);
	});

	it("syncSubscriptions:一批进出收口一条 info 汇总(Q1 不刷屏),没有进出不记", () => {
		const b = makeEngine();
		b.setRoster({ "1": { uid: "1", post: true }, "2": { uid: "2", post: true } });
		b.logs.length = 0;
		b.engine.syncSubscriptions();
		const summary = () =>
			b.logs.filter((l) => l.level === "info" && l.msg.includes("动态订阅变更已应用"));
		expect(summary()).toHaveLength(1); // 两个人进名单仅一条汇总 info
		expect(summary()[0]?.msg).toContain("+2 开启");
		// 再对一遍、没有进出:什么都不记
		b.logs.length = 0;
		b.engine.syncSubscriptions();
		expect(summary()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// H. 作品只交一次、不交的就不交 —— 统计不在引擎这头记:统计听核心入口发的 `post-detected`
// ---------------------------------------------------------------------------

describe("DynamicPoller.detectDynamics — 过闸的才交,引擎自己不发统计事件", () => {
	const reportedCount = (b: EngineBag) => b.reportPost.mock.calls.length;
	const postEvents = (b: EngineBag) => b.emits.filter((e) => e.event === "post-detected");

	it("新动态过闸 → 交一次;`post-detected` 是核心入口的事,引擎不发", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_AV" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(reportedCount(b)).toBe(1);
		expect(postEvents(b)).toHaveLength(0);
	});

	it("timeline >= pub_ts(已处理过)→ 不重复交,避免统计重复计数", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 1000);
		await detect(b.engine);
		expect(reportedCount(b)).toBe(0);
	});

	it("未订阅 uid → 不交", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 99, pubTs: 1000 })]));
		await detect(b.engine);
		expect(reportedCount(b)).toBe(0);
	});

	/**
	 * 订阅还在、但这位 UP 的动态推送被关了。
	 *
	 * 刻意**走 start() 按名单建表**而不是直接塞锚点 —— 病灶就在建表这一步:
	 * 锚点表只登记 `post` 为真的 UP。手塞锚点的话测试会空过。
	 * 另配一个开着开关的 UP,否则订阅表为空、检测任务根本不起。
	 */
	const seedStatsOnly = (b: EngineBag, uid: string): void => {
		b.setRoster({
			[uid]: { uid, post: false },
			other: { uid: "other", post: true },
		});
		b.engine.start();
	};
	/** 建表之后才发布 —— 锚点初值是「此刻」,拿旧时间戳的动态一律算已看过。 */
	const laterThanSeed = () => Math.floor(Date.now() / 1000) + 60;

	it("per-UP 动态推送关掉 → 不交(这位 UP 的作品开关关着,统计也不记)", async () => {
		// 表里只有开着作品开关的人;关掉开关的 UP 没有锚点(已定 18),检测循环直接跳过他。
		const b = makeEngine();
		const pubTs = laterThanSeed();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs })]));
		seedStatsOnly(b, "1");
		await detect(b.engine);
		expect(reportedCount(b)).toBe(0);
		expect(priv(b.engine).postAnchors.has("1")).toBe(false);
	});

	it("推送关掉的 UP 每轮都被跳过:不翻译、也不留锚点", async () => {
		const b = makeEngine();
		const pubTs = laterThanSeed();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs })]));
		seedStatsOnly(b, "1");
		await detect(b.engine);
		await detect(b.engine);
		expect(postFromDynamic).not.toHaveBeenCalled();
		expect(priv(b.engine).postAnchors.has("1")).toBe(false);
	});

	it("真退订则连锚点一起清掉,不留孤儿抑制再订阅后的动态", async () => {
		const b = makeEngine();
		b.setRoster({ "1": { uid: "1", post: true }, other: { uid: "other", post: true } });
		b.engine.start();
		expect(priv(b.engine).postAnchors.has("1")).toBe(true);
		b.setRoster({ other: { uid: "other", post: true } });
		b.engine.syncSubscriptions();
		expect(priv(b.engine).postAnchors.has("1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// F. 上次成功抓取的时刻
//
// 独立端的 `/status` 拿它回答「还在跑吗」。**只记成功、不记尝试**:连着失败三小时
// 的系统若报「1 分钟前抓过」,这一项就从答案变成了骗局 —— 而那正是主人掏出手机
// 敲 status 的场合。
// ---------------------------------------------------------------------------

describe("DynamicPoller.lastFetchAt", () => {
	it("还没跑过 → undefined,而不是 0", () => {
		const b = makeEngine();
		expect(b.engine.lastFetchAt()).toBeUndefined();
	});

	it("成功拉到一轮 → 记下时刻", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		seed(b.engine, "1", 0);
		const before = Date.now();
		await detect(b.engine);
		const at = b.engine.lastFetchAt();
		expect(at).toBeDefined();
		expect(at as number).toBeGreaterThanOrEqual(before);
	});

	it("拉取抛错 → 不刷新(否则「还在跑吗」永远答是)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const first = b.engine.lastFetchAt();

		b.fetchAllDynamic.mockRejectedValue(new Error("network down"));
		await detect(b.engine);
		expect(b.engine.lastFetchAt()).toBe(first);
	});

	it("接口返回错误码 → 同样不刷新", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const first = b.engine.lastFetchAt();

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		expect(b.engine.lastFetchAt()).toBe(first);
	});
});

// ---------------------------------------------------------------------------
// K. detectNow —— devtools「现在就跑」
// ---------------------------------------------------------------------------

/**
 * 与 cron 那一轮共用同一把锁:cron tick 撞上在跑的那轮就跳过(老规矩);`detectNow`
 * 撞上则**等它跑完再跑一轮** —— 调用方是刚往 feed 里塞了东西才来的,那一轮的 feed 是
 * 塞之前拉的,跳过等于白塞。
 */
describe("K. detectNow", () => {
	function deferred() {
		let resolve!: (v: ReturnType<typeof resp>) => void;
		const promise = new Promise<ReturnType<typeof resp>>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	it("跑一轮:拉 feed、处理,promise 在这一轮结束时落定", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, text: "x" })]));
		seed(b.engine, "1", 0);
		await b.engine.detectNow();
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(1);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
	});

	it("cron tick 撞上在跑的一轮就跳过;detectNow 撞上则排在后面再跑一轮", async () => {
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		const first = deferred();
		b.fetchAllDynamic.mockReturnValueOnce(first.promise).mockResolvedValue(resp([]));
		b.engine.start();
		const tick = cronMock.instances[0];
		if (!tick) throw new Error("cron 没建起来");

		tick.onTick();
		tick.onTick();
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(1);

		const second = b.engine.detectNow();
		await Promise.resolve();
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(1);

		first.resolve(resp([]));
		await second;
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(2);
	});

	it("一轮卡住不落定:检测器重启之后新 job 的 tick 还得能跑,不能被旧锁永久堵死", async () => {
		// 锁挂在实例上,活得比 cron job 长。一轮要是永远不落定(渲染闸堆住之类),
		// 旧写法的 tick 会全部静默丢弃 —— 而且是**永久**:登录恢复 / 改 cron 重建 job
		// 也救不回来。停掉检测器时锁得跟着松开,重启才算真的重新武装。
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		const stuck = deferred();
		b.fetchAllDynamic.mockReturnValueOnce(stuck.promise).mockResolvedValue(resp([]));
		b.engine.start();
		const first = cronMock.instances[0];
		if (!first) throw new Error("cron 没建起来");
		first.onTick();
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(1);

		b.engine.stop();
		b.engine.start();
		const second = cronMock.instances[1];
		if (!second) throw new Error("重启后 cron 没重建");
		second.onTick();
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(2);

		stuck.resolve(resp([]));
	});

	it("那一轮抛了:记日志、锁释放,下一次还能跑", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockRejectedValueOnce(new TypeError("boom")).mockResolvedValue(resp([]));
		seed(b.engine, "1", 0);
		await b.engine.detectNow();
		await b.engine.detectNow();
		expect(b.fetchAllDynamic).toHaveBeenCalledTimes(2);
	});
});

/**
 * 这一路不再跑了(名单空了 / 检测起不来):它报的风控与拉取失败要清掉 —— 没有「下一次结果」会去清它们,
 * 不清的话风控条目永远挂在表里,还把之后所有直播间的停监压成无声。
 * 清的是「不再适用」,不是风控解除:主人不会听到「风控已解除」。真引擎 + 真上报器 + 真问题表 + 真问题通知器。
 */
describe("DynamicPoller — 这一路不再跑了,它报的要清", () => {
	const IN = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" } as const;
	const oneSub = { subs: { "1": { uid: "1", post: true } } } as const;

	function makeWorld() {
		const pipeline = makeProblemPipeline({ state: () => IN, onChange: () => ({ dispose() {} }) });
		const b = makeEngine({ ...oneSub, problems: pipeline.layers });
		seed(b.engine, "1", 0);
		return { ...pipeline, b };
	}

	/** 让私聊的回执(异步)落定:「已恢复」要等头一句送到才补。 */
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	/** 清完之后,直播间报的停监能进表、能私聊(没有风控压着它)。 */
	function liveStoppedGetsThrough(w: ReturnType<typeof makeWorld>): void {
		const before = w.notifyMaster.mock.calls.length;
		w.layers.reportFailure({
			code: "live_monitor_stopped",
			message: () => "房间停了",
			notify: true,
			lasting: true,
		});
		expect(w.table.list().map((p) => p.code)).toEqual(["live_monitor_stopped"]);
		expect(w.notifyMaster).toHaveBeenCalledTimes(before + 1);
		expect(w.notifyMaster).toHaveBeenLastCalledWith("房间停了");
	}

	// 验红:去掉 reconcileJob 里空名单那一支的 dropProblems,前两条里「订阅关掉」那条红;
	//       去掉 restartDetector 里空名单返回前的 dropProblems,「退避到点」那条红;
	//       dropProblems 里 resolveRisk 去掉 notify: false,「不说风控已解除」的断言红。
	it("-352 后订阅关掉、名单空了:风控清掉、不说「风控已解除」,之后直播的停监照常进表并私聊", async () => {
		const w = makeWorld();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(w.b.engine);
		await settle();
		expect(w.table.list().map((p) => p.code)).toEqual(["risk_controlled"]);
		expect(w.notifyMaster).toHaveBeenCalledTimes(1);

		w.b.setRoster(null);
		w.b.engine.syncSubscriptions();
		await settle();

		expect(w.table.list()).toEqual([]);
		expect(w.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text(),
		]);
		liveStoppedGetsThrough(w);
	});

	it("-352 后退避到点、名单已空:风控清掉、不说「风控已解除」", async () => {
		const w = makeWorld();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(w.b.engine);
		await settle();
		w.b.setRoster(null); // 没有 sync:模拟名单变空发生在退避途中,到点才发现
		expect(w.table.list().map((p) => p.code)).toEqual(["risk_controlled"]);

		(w.b.engine as unknown as { restartDetector(): void }).restartDetector();
		await settle();

		expect(w.table.list()).toEqual([]);
		expect(w.notifyMaster).toHaveBeenCalledTimes(1);
		liveStoppedGetsThrough(w);
	});

	it("拉动态失败(非 -352)后名单空了:dynamic_fetch_failed 同样清掉", async () => {
		const w = makeWorld();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(w.b.engine);
		expect(w.table.list().map((p) => p.code)).toEqual(["dynamic_fetch_failed"]);

		w.b.setRoster(null);
		w.b.engine.syncSubscriptions();

		expect(w.table.list()).toEqual([]);
	});

	it("-352 后 dynamicCron 被改成起不来的值、退避到点:同样是「不再跑了」,风控清掉", async () => {
		const w = makeWorld();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(w.b.engine);
		await settle();
		expect(w.table.list().map((p) => p.code)).toEqual(["risk_controlled"]);

		w.b.engine.updateConfig({ dynamicCron: "BAD CRON", dynamicVideoUrlToBV: false });
		(w.b.engine as unknown as { restartDetector(): void }).restartDetector();
		await settle();

		expect(w.table.list()).toEqual([]);
		expect(w.notifyMaster).toHaveBeenCalledTimes(1);
	});

	it("对照:名单没空、拉成功了:风控清掉并说「风控已解除」(真解除)", async () => {
		const w = makeWorld();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(w.b.engine);
		await settle();
		w.b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(w.b.engine);
		await settle();

		expect(w.table.list()).toEqual([]);
		expect(w.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text(),
			PROBLEM_TEXTS.riskControlled.recovery(),
		]);
	});

	it("对照:-352 之后换成别的错误码:风控清掉但不说「风控已解除」(动态仍在失败)", async () => {
		const w = makeWorld();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(w.b.engine);
		await settle();
		w.b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(w.b.engine);
		await settle();

		expect(w.table.list().map((p) => p.code)).toEqual(["dynamic_fetch_failed"]);
		expect(w.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text(),
		]);
	});

	// 在途的那一轮迟到:名单已经清空(这一路不跑了、该清的清过了),它才带着失败回来。
	// 这时再报就是一条没人清的:风控要挂到退避到点(5 分钟),期间把直播间的停监压成无声。
	// 验红:去掉 handleApiError 里「这一路还在跑才报」的判断(`watching()`),这两条红。
	it.each([
		[-352, "risk"],
		[4101132, "请求数据发生错误"],
	] as const)(
		"名单清空之后在途的那一轮才回 %i:不往表里挂,直播的停监照常进表并私聊",
		async (code, message) => {
			const w = makeWorld();
			let release: (value: unknown) => void = () => {};
			w.b.fetchAllDynamic.mockReturnValueOnce(
				new Promise((resolve) => {
					release = resolve;
				}),
			);
			const round = detect(w.b.engine);
			w.b.setRoster(null);
			w.b.engine.syncSubscriptions();

			release(resp([], code, message));
			await round;
			await settle();

			expect(w.table.list()).toEqual([]);
			expect(w.notifyMaster).not.toHaveBeenCalled();
			liveStoppedGetsThrough(w);
		},
	);
});
