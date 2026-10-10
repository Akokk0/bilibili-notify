/**
 * 单元测试 — `DynamicEngine`:**只管生产**。拉 feed → 判新 → 翻成作品 → 抓图 → 经 `reportPost` 交给核心的作品入口,
 * 加错误处理 / 故障恢复 / 生命周期。
 *
 * 过滤、出卡、AI 点评、套模板、装配、推送、图集都是核心的事(`posts/deliver-post.ts`,测试在
 * `posts/__tests__/deliver-post.test.ts`),引擎测试里不再有它们 —— 给引擎一个什么都不做的 `reportPost`,
 * 「被过滤就不推」这类旧断言会全绿(引擎根本不推了),所以那些断言只在核心那头,**不留在这里原样通过**。
 *
 * 测试策略:
 *   - `detectDynamics()` 是 private,但它是编排核心。白盒直调 + 直接 seed 私有
 *     `dynamicSubManager` / `dynamicTimelineManager`,完全绕开 cron + withLock 的
 *     fire-and-forget 计时纠缠(withLock 返回 `() => void` 不可 await)。
 *   - 生命周期用例 `vi.mock("cron")` 注入惰性 FakeCronJob,断言 start/stop 次数与
 *     重建出的新 cronTime。
 */

import {
	type ImageRef,
	type MessageBus,
	ok,
	type Post,
	type PostReport,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../../api/index.js";
import { DynamicEngine, type DynamicEngine as DynamicEngineType } from "../dynamic-engine";
import { postFromDynamic } from "../post-from-dynamic";
import type { PushLike, SubItemView, SubscriptionsView } from "../push-like";
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
	dynamicSubManager: Map<string, SubItemView>;
	dynamicTimelineManager: Map<string, number>;
	detectDynamics(): Promise<void>;
}
const priv = (e: DynamicEngineType): Priv => e as unknown as Priv;

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

/** `engine-error` 的载荷是 `{ source, message }`;这里取 message 好按文案筛。 */
function engineErrorMessage(e: { payload: unknown }): string {
	return String((e.payload as { message?: unknown } | undefined)?.message ?? "");
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

function resp(items: Dynamic[], code = 0, message = "ok"): AllDynamicResponse {
	return {
		code,
		message,
		data: { has_more: false, items, offset: "", update_baseline: "", update_num: items.length },
	};
}

/** 测试里写的订阅视图:引擎只认 uid 与 post。 */
type SeedView = SubItemView;
const viewOf = (v: SeedView): SubItemView => v;
const viewsOf = (subs: Record<string, SeedView>): SubscriptionsView =>
	Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, viewOf(v)]));

interface EngineBag {
	engine: DynamicEngineType;
	fetchAllDynamic: ReturnType<typeof vi.fn>;
	/** 假的宿主出口:引擎只剩给主人发私信这一样。 */
	push: PushLike & { sendPrivateMsg: ReturnType<typeof vi.fn> };
	emits: Array<{ event: string; payload: unknown }>;
	trigger: (event: string, payload?: unknown) => void;
	disposers: Array<() => void | Promise<void>>;
	/** 注入给引擎的抓图服务(`imageFetcher` 选项):每个地址回一个以它命名的引用,测试数调用。 */
	fetchImage: ReturnType<typeof vi.fn>;
	/** 注入给引擎的核心入口(`reportPost` 选项):引擎交出去的每一条作品。 */
	reportPost: ReturnType<typeof vi.fn<(externalId: string, report: PostReport) => void>>;
	logs: LogRec[];
}

function makeEngine(
	over: {
		config?: Partial<import("../dynamic-engine").DynamicEngineConfig>;
		subs?: Record<string, SeedView> | null;
		/** 引擎交作品时核心入口做什么(默认什么都不做);给个会抛的就是测「入口抛了」。 */
		reportPost?: (externalId: string, report: PostReport) => void;
	} = {},
): EngineBag {
	const { ctx, logs } = makeServiceCtx();
	const { bus, emits, trigger } = makeBus();
	const disposers: Array<() => void | Promise<void>> = [];
	(ctx as { onDispose: (fn: () => void) => void }).onDispose = (fn) => {
		disposers.push(fn);
	};
	const fetchAllDynamic = vi.fn();
	const api = { fetchAllDynamic } as unknown as Api;
	const push = { sendPrivateMsg: vi.fn(async () => {}) };
	const fetchImage = vi.fn(async (url: string) =>
		ok({ ref: `${Buffer.from(url).toString("hex").slice(-60).padStart(64, "0")}.jpg` as ImageRef }),
	);
	const reportPost = vi.fn<(externalId: string, report: PostReport) => void>(
		over.reportPost ?? (() => {}),
	);
	const engine = new DynamicEngine({
		serviceCtx: ctx,
		bus,
		api,
		push,
		imageFetcher: { fetchImage },
		reportPost,
		config: {
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: false,
			...over.config,
		},
		getSubs: () => (over.subs ? viewsOf(over.subs) : null),
	});
	return {
		engine,
		fetchAllDynamic,
		push,
		emits,
		trigger,
		disposers,
		fetchImage,
		reportPost,
		logs,
	};
}

/** 播种一个订阅视图(推送名单里有它),并给它一个时间线锚点。 */
function seed(engine: DynamicEngineType, uid: string, timeline: number, sub?: SeedView): void {
	priv(engine).dynamicTimelineManager.set(uid, timeline);
	priv(engine).dynamicSubManager.set(uid, viewOf(sub ?? { uid, post: true }));
}

const detect = (engine: DynamicEngineType): Promise<void> => priv(engine).detectDynamics();

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.mocked(postFromDynamic).mockClear();
});

// ---------------------------------------------------------------------------
// A. detectDynamics 编排
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — API 错误处理", () => {
	it("fetchAllDynamic 抛错 → 不交作品,静默返回", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockRejectedValue(new Error("network down"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
	});

	it("code=-101(未登录)→ emit engine-error「账号未登录」,不交作品", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(b.emits).toContainEqual(
			expect.objectContaining({
				event: "engine-error",
				payload: expect.objectContaining({ message: "账号未登录" }),
			}),
		);
	});

	it("code=-352(风控)→ sendPrivateMsg + emit engine-error「账号被风控」", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(b.emits).toContainEqual(
			expect.objectContaining({
				event: "engine-error",
				payload: expect.objectContaining({ message: "账号被风控" }),
			}),
		);
	});

	it("-352 风控边沿:连续触发只告警一次,恢复后再触发重新告警(Q7)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		const ecCount = () =>
			b.emits.filter(
				(e) => e.event === "engine-error" && engineErrorMessage(e).includes("账号被风控"),
			).length;
		// 数的是**风控告警**这一种私聊,不是私聊总数 —— 恢复时还会来一条「已恢复」
		// (见「故障恢复通知」),拿总数计这条边沿会被那条报喜带偏。
		const dmCount = () =>
			b.push.sendPrivateMsg.mock.calls.filter((c) => String(c[0]).includes("账号被风控")).length;

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 进入风控
		await detect(b.engine); // 仍风控 → 抑制
		expect(dmCount()).toBe(1);
		expect(ecCount()).toBe(1);
		expect(b.logs.filter((l) => l.level === "error" && l.msg.includes("账号被风控"))).toHaveLength(
			1,
		);
		expect(b.logs.some((l) => l.level === "debug" && l.msg.includes("仍处于风控态"))).toBe(true);

		b.fetchAllDynamic.mockResolvedValue(resp([])); // code 0 → 恢复
		await detect(b.engine);
		expect(b.logs.some((l) => l.level === "info" && l.msg.includes("风控已解除"))).toBe(true);

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 再次风控 → 边沿复位后重新告警
		expect(dmCount()).toBe(2);
		expect(ecCount()).toBe(2);
	});

	it("-352 后跨 -101(auth-loss)再 -352:复位边沿,新风控必须重新告警(审计缺口回归)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		const riskEc = () =>
			b.emits.filter(
				(e) => e.event === "engine-error" && engineErrorMessage(e).includes("账号被风控"),
			).length;

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 风控 episode #1 → 告警 1
		expect(riskEc()).toBe(1);

		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		await detect(b.engine); // auth-loss:独立 episode,复位风控边沿

		b.fetchAllDynamic.mockResolvedValue(resp([])); // 恢复(code 0)
		await detect(b.engine);

		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 风控 episode #2(跨过 -101)→ 必须重新告警
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		expect(riskEc()).toBe(2);
	});

	/**
	 * 告警私聊发不出去,不能把退避重启一起带走。
	 *
	 * `handleApiError` 开头就把 cron stop 了,重新起来全靠末尾那句
	 * `scheduleDetectorRestart`。中间的私聊要是裸 `await` 并抛了出去,后面的
	 * emit 和排程都不执行 —— 动态检测就此永久停摆,而日志上只有一条私聊失败。
	 */
	it("告警私聊抛错 → 退避重启照排(不因通知失败而永久停摆)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.push.sendPrivateMsg.mockRejectedValue(new Error("master unreachable"));
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
	});

	it("风控告警私聊抛错 → 退避重启同样照排", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.push.sendPrivateMsg.mockRejectedValue(new Error("master unreachable"));
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		expect(b.logs.some((l) => l.msg.includes("后自动重试动态检测"))).toBe(true);
	});
});

/**
 * 「到底好没好」—— 故障恢复得跟报错走同一条通道说一声。
 *
 * 瞬时错误(4101132 这类未知码)会退避 300s 后自动重启检测,日志里三条
 * 「将在 300s 后自动重试」「退避计时到,重启动态检测」「动态检测任务已启动」
 * 一应俱全 —— 但全都只进日志。主人在 IM 里只收到一条报错,之后再无下文,分不清
 * 是自己好了还是还坏着只是不再吭声。
 *
 * 报「恢复」的时机是**下一次真正拉取成功**,不是「重启了检测任务」:重启只是把
 * cron 挂回去,故障还在的话下一轮照样失败,那时候说"好了"就是骗人。
 *
 * 恢复通知只走私聊,不发 `engine-error` —— 那个事件在独立端会点亮 AlertShell 的
 * 红色告警面板,拿它报喜语义是反的。
 */
describe("DynamicEngine — 故障恢复通知", () => {
	it("瞬时错误恢复后私聊说一声,并带上此前的错误码", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);

		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);

		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		const msg = String(b.push.sendPrivateMsg.mock.calls[1]?.[0]);
		expect(msg).toContain("恢复");
		expect(msg).toContain("4101132");
	});

	it("从没坏过的成功拉取不发恢复通知(否则每个 cron tick 刷一条)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).not.toHaveBeenCalled();
	});

	it("恢复只报一次,后续成功拉取保持安静", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine); // 恢复 → 报一次
		await detect(b.engine); // 已经好了 → 不该再报
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
	});

	it("瞬时错误连续失败只告警一次(与风控边沿对称,不每 300s 打扰一次)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		await detect(b.engine);
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(
			b.emits.filter(
				(e) => e.event === "engine-error" && engineErrorMessage(e).includes("4101132"),
			),
		).toHaveLength(1);
	});

	it("错误码变了 → 当作新故障重新告警", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);
		b.fetchAllDynamic.mockResolvedValue(resp([], -509, "限流"));
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
	});

	it("风控解除同样私聊说一声", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);

		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		expect(String(b.push.sendPrivateMsg.mock.calls[1]?.[0])).toContain("风控");
	});

	it("风控与瞬时错误同时挂着 → 恢复报一条,两样都说到", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // riskControlled 置位
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine); // transientErrorCode 也置位(风控边沿不清)

		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine);
		const recovery = b.push.sendPrivateMsg.mock.calls.filter((c) => String(c[0]).includes("恢复"));
		expect(recovery).toHaveLength(1);
		expect(String(recovery[0]?.[0])).toContain("风控");
		expect(String(recovery[0]?.[0])).toContain("4101132");
	});

	it("跨 -101 后恢复:不拿陈旧错误码报喜(登录恢复由上层 auth-restored 负责)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine); // DM #1:报错
		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		await detect(b.engine); // 独立 episode,-101 不发 DM
		b.fetchAllDynamic.mockResolvedValue(resp([]));
		await detect(b.engine); // 成功,但这是登录恢复,不该由这里报喜
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);
	});

	it("恢复通知发不出去不能打断本轮动态的交出", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);

		// 私聊通道自己坏了(master 不可达 / 适配器抛错)。恢复通知是锦上添花,
		// 绝不能因为它发不出去就把这一轮真正要推的动态吞掉。
		b.push.sendPrivateMsg.mockRejectedValue(new Error("master unreachable"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalled();
	});
});

/**
 * 登录掉了以后,谁负责告诉主人。
 *
 * `auth-lost` 是 API 层单点广播的(任何 -101 响应都会经 interceptor 触发),上层
 * master-notifier 收到后私聊「账号登录已失效,请到控制台重新扫码登录」—— 那句话
 * 带着该怎么办。直播引擎收到同一个事件直接 `teardown()`。
 *
 * 动态引擎此前两样都没做:cron 照跑,直到下一轮自己撞上 -101,再报一句
 * 「[bilibili-notify-dynamic] 账号未登录」。主人先收到一条登录失效,过一会儿又收
 * 到一条听起来像新故障的报错,而后者不带任何新信息 —— 那正是同一件事的第二次通知。
 */
describe("DynamicEngine — 登录失效时不再报第二遍", () => {
	const oneSub = { subs: { "1": { uid: "1", post: true } } } as const;
	const authEc = (b: ReturnType<typeof makeEngine>) =>
		b.emits.filter(
			(e) => e.event === "engine-error" && engineErrorMessage(e).includes("账号未登录"),
		).length;

	it("收到 auth-lost 立刻停 cron —— 别等下一轮再去白撞一次 -101", () => {
		const b = makeEngine(oneSub);
		b.engine.start();
		expect(cronMock.instances[0]?.isActive).toBe(true);

		b.trigger("auth-lost");
		expect(cronMock.instances[0]?.isActive).toBe(false);
	});

	it("auth-lost 之后才落地的那一轮撞上 -101,不再报 engine-error", async () => {
		// 事件到达时可能已经有一轮请求在飞。它照样会拿到 -101 走 handleApiError,
		// 而主人在这之前已经收到那条更有用的「登录已失效」了。
		const b = makeEngine(oneSub);
		b.engine.start();
		b.trigger("auth-lost");

		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);

		expect(authEc(b)).toBe(0);
	});

	it("没收到 auth-lost 就撞上 -101 时照常报 —— 冷启动 cookie 过期走的正是这条", async () => {
		// `auth-lost` 只在**真的丢掉一个好会话**时才发(login-flow 的 wasLoggedIn 门)。
		// 进程起来时 cookie 就已经过期的话根本没有那个事件,这里是唯一的通知路径,
		// 静默掉就等于让主人对着一个不推送的服务干等。
		const b = makeEngine(oneSub);
		b.engine.start();

		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);

		expect(authEc(b)).toBe(1);
	});

	it("auth-restored 之后重新武装 —— 抑制只对这一次登录失效有效", async () => {
		// 标记粘住的话,重新登录再掉一次就永远静默了。
		const b = makeEngine(oneSub);
		b.engine.start();
		b.trigger("auth-lost");
		b.trigger("auth-restored");

		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);

		expect(authEc(b)).toBe(1);
	});

	it("auth-lost 之后订阅变更不许把 cron 拉回来 —— 登录还没恢复,拉起来就是再撞一次", () => {
		// reconcileJob 原本只认「-352 退避窗口」这一个不许启动的理由,登录失效不在其列。
		// 于是 auth-lost 停掉 cron 之后,随便一次订阅增删都会立刻把它重新建起来。
		const b = makeEngine(oneSub);
		b.engine.start();
		b.trigger("auth-lost");
		const after = cronMock.instances.length;

		b.engine.applyOps([{ kind: "add", sub: { uid: "2", post: true } as SubItemView }]);

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

describe("DynamicEngine.detectDynamics — 时间线 / 订阅过滤", () => {
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
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1234);
	});

	it("pub_ts 为毫秒时间戳字符串 → 归一化为秒后交出", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts: unknown }).pub_ts = "1717067523000";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1717067523);
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
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBeGreaterThan(0);
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
			expect(priv(b.engine).dynamicTimelineManager.get("1")).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("新动态交出后 timeline 推进到 pub_ts", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1234 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1234);
	});

	it("DY1:同 uid 多条全部成功 → 锚点推进到最大 pub_ts", async () => {
		const b = makeEngine();
		// 新→旧
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 200 }), makeItem({ uid: 1, pubTs: 100 })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(200);
		expect(b.reportPost).toHaveBeenCalledTimes(2);
	});

	it("DY1:锚点单调,绝不回退(已 push 过的更新 pub_ts 不倒退)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 100 })]));
		seed(b.engine, "1", 500); // 既有锚点已高于来项
		await detect(b.engine);
		// timeline(500) >= 100 → 跳过,锚点保持 500,绝不被 set 成 100。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(500);
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

describe("DynamicEngine.detectDynamics — 把作品交给核心入口", () => {
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
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1500);
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
	// 验红:把 dynamic-engine.ts 里覆写 `publishedAt` 那一行去掉,这条红(交出去的是 1970 年)。
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
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(
			Math.floor(expected.getTime() / 1000),
		);
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

describe("DynamicEngine.detectDynamics — 交出之前先把图抓好(决策 3)", () => {
	// 验红:把 dynamic-engine.ts 里 `fetchPostImages` 挪到 `reportPost` 之后(或不调),这条红。
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

describe("DynamicEngine.detectDynamics — 只为推送名单里的订阅生产(决策 6)", () => {
	/** 建表走 `startDynamicDetector`:锚点覆盖全部订阅,推送名单只收 `post` 开着的。 */
	const startWith = (b: EngineBag): void =>
		b.engine.startDynamicDetector({
			"11": { uid: "11", post: false },
			"22": { uid: "22", post: true },
		});
	/** 建表之后才发布 —— 锚点初值是「此刻」,拿旧时间戳的动态一律算已看过。 */
	const pubTs = Math.floor(Date.now() / 1000) + 60;
	const picItem = (uid: number) =>
		makeItem({ uid, pubTs, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] });

	it("关了作品推送的订阅:不翻译、不抓图、不交;时间线照常前移", async () => {
		const b = makeEngine();
		startWith(b);
		b.fetchAllDynamic.mockResolvedValue(resp([picItem(11)]));
		await detect(b.engine);
		expect(postFromDynamic).not.toHaveBeenCalled();
		expect(b.fetchImage).not.toHaveBeenCalled();
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(priv(b.engine).dynamicTimelineManager.get("11")).toBe(pubTs);
	});

	it("对照:同样的铺垫,开着作品推送的订阅就翻译、抓图、交", async () => {
		const b = makeEngine();
		startWith(b);
		b.fetchAllDynamic.mockResolvedValue(resp([picItem(22)]));
		await detect(b.engine);
		expect(postFromDynamic).toHaveBeenCalledTimes(1);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).dynamicTimelineManager.get("22")).toBe(pubTs);
	});
});

describe("DynamicEngine.detectDynamics — 每条越过时间线的动态恰好前移一次", () => {
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
		expect(priv(b.engine).dynamicTimelineManager.get("2")).toBe(300);
		// 入口抛了也前移:作品只交一次、核心不替来源重放,留着不前移只会下一轮重交一遍。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(100);
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
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(100);
		expect(b.reportPost).toHaveBeenCalledTimes(1);
		expect(reported(b)[1].post.images?.[0]?.ref).toBeUndefined();
	});
});

describe("DynamicEngine.detectDynamics — 开播伪动态", () => {
	const liveRcmd = () => makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_LIVE_RCMD" });

	it("不翻译、不抓图、不交;锚点照常前移,下一轮不再重判", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([liveRcmd()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(postFromDynamic).not.toHaveBeenCalled();
		expect(b.fetchImage).not.toHaveBeenCalled();
		expect(b.reportPost).not.toHaveBeenCalled();
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1000);
	});
});

describe("DynamicEngine — applyOps 在 detectDynamics 抓图的 await 期间改了订阅(A7)", () => {
	const picItem = () =>
		makeItem({ uid: 1, pubTs: 1000, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] });

	it("抓图期间 delete 该 UID → 不交 + 不复活时间线", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
		seed(b.engine, "1", 0);
		// 模拟交错:抓图解析前,adapter 收到 subscription-changed 调 applyOps 退订 uid 1。
		b.fetchImage.mockImplementation(async (url: string) => {
			b.engine.applyOps([{ kind: "delete", uid: "1" }]);
			return ok({ ref: `${"c".repeat(63)}1.jpg` as ImageRef, url });
		});

		await detect(b.engine);

		expect(priv(b.engine).dynamicSubManager.has("1")).toBe(false); // 确已退订
		// 身份重校:已退订 → 不得再交。
		expect(b.reportPost).not.toHaveBeenCalled();
		// 时间线回写守卫:不得把已删 UID 的时间线“复活”成孤儿锚点。
		expect(priv(b.engine).dynamicTimelineManager.has("1")).toBe(false);
	});

	// 引擎只交 uid,接线按身份**现查**订阅:抓图那几秒里同一个 uid 被「删了再加」的话,现查会找到新加的那条订阅,
	// 核心的回问也过得去(新订阅好端端在),于是一条旧动态被推给新订阅。「删了」与「删了又加回来」时间线锚点都会变
	// (没了 / 重置成现在),所以抓完图把进门时过的两道闸再过一遍:名单里还有这个 uid、锚点还在且仍早于这条动态。
	// 验红:把 dynamic-engine.ts 抓图之后那句 `this.stillDue(...)` 的判断去掉,这条与上一条红。
	it("抓图期间同一 uid 被「删了再加」→ 旧动态不交给新订阅;对照:订阅没变就交", async () => {
		const swapped = makeEngine();
		swapped.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
		seed(swapped.engine, "1", 0);
		swapped.fetchImage.mockImplementation(async (url: string) => {
			swapped.engine.applyOps([
				{ kind: "delete", uid: "1" },
				{ kind: "add", sub: { uid: "1", post: true } },
			]);
			return ok({ ref: `${"c".repeat(63)}1.jpg` as ImageRef, url });
		});
		await detect(swapped.engine);
		expect(priv(swapped.engine).dynamicSubManager.has("1")).toBe(true); // 新订阅在
		expect(swapped.reportPost).not.toHaveBeenCalled();

		const steady = makeEngine();
		steady.fetchAllDynamic.mockResolvedValue(resp([picItem()]));
		seed(steady.engine, "1", 0);
		await detect(steady.engine);
		expect(steady.reportPost).toHaveBeenCalledTimes(1);
	});

	// 同 uid 的 update / 名单整份重建 / 关了又开作品推送,只换名单里的对象、不动时间线锚点:这条动态是同一条订阅的,照常交、恰好一次。
	// 验红:把抓图之后的重校改回对象身份比对(`this.dynamicSubManager.get(uid) !== subAtCapture`),这几条红(动态永久丢)。
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

		it("收到同 uid 的 update(post: true)→ 名单里换了新对象,这条动态照常交", async () => {
			const b = await withDuringFetch((x) =>
				x.engine.applyOps([
					{ kind: "update", uid: "1", changes: [{ scope: "dynamic", post: true }] },
				]),
			);
			expect(b.reportPost).toHaveBeenCalledTimes(1);
			expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1000);
		});

		it("整份名单被重建(startDynamicDetector,如登录恢复后重启检测)→ 照常交", async () => {
			const b = await withDuringFetch((x) => x.engine.startDynamicDetector(viewsOf(sub)));
			expect(b.reportPost).toHaveBeenCalledTimes(1);
		});

		it("关了作品推送又打开(update post:false 再 post:true,锚点不动)→ 照常交", async () => {
			const b = await withDuringFetch((x) => {
				x.engine.applyOps([
					{ kind: "update", uid: "1", changes: [{ scope: "dynamic", post: false }] },
				]);
				x.engine.applyOps([
					{ kind: "update", uid: "1", changes: [{ scope: "dynamic", post: true }] },
				]);
			});
			expect(b.reportPost).toHaveBeenCalledTimes(1);
		});

		it("对照:抓图期间关了作品推送且没再打开 → 不交(名单里没有了)", async () => {
			const b = await withDuringFetch((x) =>
				x.engine.applyOps([
					{ kind: "update", uid: "1", changes: [{ scope: "dynamic", post: false }] },
				]),
			);
			expect(b.reportPost).not.toHaveBeenCalled();
		});
	});
});

// ---------------------------------------------------------------------------
// C. 生命周期(cron mock)
// ---------------------------------------------------------------------------

describe("DynamicEngine — reconcileJob 尊重风控退避", () => {
	it("-352 退避窗口内 applyOps → 不提前重启 cron(退避不被击穿)", async () => {
		const before = cronMock.instances.length;
		const b = makeEngine({ subs: { "1": { uid: "1", post: true } } });
		b.engine.start(); // cron 实例 #1
		const afterStart = cronMock.instances.length;
		expect(afterStart).toBe(before + 1);

		// 进入 -352 风控:handleApiError 停 job(dynamicJob=undefined)并排一次性退避重启
		// (detectorRestartTimer 置位;fake setTimeout 不触发,故退避一直挂着)。
		b.fetchAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine);

		// 退避窗口内 adapter 收到订阅变更 → applyOps → reconcileJob。subManager 仍非空,
		// dynamicJob 又是 undefined —— 若只看 dynamicJob?.isActive 会立即 startJob,提前去戳
		// 仍在风控的端点,击穿退避。修复后应识别 detectorRestartTimer 待执行而跳过。
		b.engine.applyOps([{ kind: "add", sub: { uid: "2", post: true } as SubItemView }]);

		expect(cronMock.instances.length).toBe(afterStart); // 没有新建 cron
	});
});

describe("DynamicEngine — 生命周期 / cron 重启", () => {
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

	it("start() 无快照 → 不建 cron;auth-restored 后用快照重建", () => {
		let snap: SubscriptionsView | null = null;
		const { ctx } = makeServiceCtx();
		const { bus, trigger } = makeBus();
		const api = { fetchAllDynamic: vi.fn() } as unknown as Api;
		const push: PushLike = { sendPrivateMsg: vi.fn(async () => {}) };
		const engine = new DynamicEngine({
			reportPost: () => {},
			serviceCtx: ctx,
			bus,
			api,
			push,
			imageFetcher: { fetchImage: vi.fn() },
			config: {
				dynamicCron: "*/2 * * * *",
				dynamicVideoUrlToBV: false,
			},
			getSubs: () => snap,
		});
		engine.start();
		expect(cronMock.instances).toHaveLength(0);

		snap = viewsOf({ "1": { uid: "1", post: true } });
		trigger("auth-restored");
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.isActive).toBe(true);
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

	it("applyOps:add dynamic 订阅 → 起 job;delete 最后一个 → 停 job", () => {
		const sub = viewOf({ uid: "1", post: true });
		const b = makeEngine({ subs: { "1": sub } });
		b.engine.start(); // 快照里 sub.post=true → 已有 running job
		expect(cronMock.instances[0]?.isActive).toBe(true);

		b.engine.applyOps([{ kind: "delete", uid: "1" }]);
		expect(cronMock.instances[0]?.isActive).toBe(false);

		b.engine.applyOps([{ kind: "add", sub }]);
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

	it("applyOps:per-UID 走 debug,批次收口一条 info 汇总(Q1 不刷屏)", () => {
		const s1 = viewOf({ uid: "1", post: true });
		const s2 = viewOf({ uid: "2", post: true });
		const b = makeEngine({ subs: { "1": s1, "2": s2 } });
		b.logs.length = 0;
		b.engine.applyOps([
			{ kind: "add", sub: s1 },
			{ kind: "add", sub: s2 },
		]);
		const summary = b.logs.filter(
			(l) => l.level === "info" && l.msg.includes("动态订阅变更已应用"),
		);
		expect(summary).toHaveLength(1); // 两条 add 仅一条汇总 info
		expect(summary[0]?.msg).toContain("+2 开启");
		// per-UID 行降到 debug,不再 info 刷屏
		expect(b.logs.some((l) => l.level === "info" && l.msg.includes("开启动态订阅 UID"))).toBe(
			false,
		);
		expect(
			b.logs.filter((l) => l.level === "debug" && l.msg.includes("开启动态订阅 UID")),
		).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// H. 作品只交一次、不交的就不交 —— 统计不在引擎这头记:统计听核心入口发的 `post-detected`
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — 过闸的才交,引擎自己不发统计事件", () => {
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
	 * 刻意**走 startDynamicDetector 建表**而不是直接塞锚点 —— 病灶就在建表这一步:
	 * 锚点表只登记 `sub.post` 为真的 UP。手塞锚点的话测试会空过。
	 * 另配一个开着开关的 UP,否则订阅表为空、检测任务根本不起。
	 */
	const seedStatsOnly = (b: EngineBag, uid: string): void => {
		b.engine.startDynamicDetector({
			[uid]: { uid, post: false },
			other: { uid: "other", post: true },
		} as never);
	};
	/** 建表之后才发布 —— 锚点初值是「此刻」,拿旧时间戳的动态一律算已看过。 */
	const laterThanSeed = () => Math.floor(Date.now() / 1000) + 60;

	it("per-UP 动态推送关掉 → 不交(这位 UP 的作品开关关着,统计也不记)", async () => {
		// 锚点表覆盖每个订阅、推送名单只收开着的;关掉开关的 UP 照样登记锚点(`timeline ===
		// undefined` 处不再 continue),只是不翻译、不抓图、不交。
		const b = makeEngine();
		const pubTs = laterThanSeed();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs })]));
		seedStatsOnly(b, "1");
		await detect(b.engine);
		expect(reportedCount(b)).toBe(0);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(pubTs);
	});

	it("推送关掉的 UP 锚点照常推进 —— 否则每轮把同一条重新判一遍", async () => {
		const b = makeEngine();
		const pubTs = laterThanSeed();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs })]));
		seedStatsOnly(b, "1");
		await detect(b.engine);
		await detect(b.engine);
		expect(postFromDynamic).not.toHaveBeenCalled();
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(pubTs);
	});

	it("真退订则连锚点一起清掉,不留孤儿抑制再订阅后的动态", async () => {
		const b = makeEngine();
		seedStatsOnly(b, "1");
		expect(priv(b.engine).dynamicTimelineManager.has("1")).toBe(true);
		b.engine.applyOps([{ kind: "delete", uid: "1" }]);
		expect(priv(b.engine).dynamicTimelineManager.has("1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// F. 上次成功抓取的时刻
//
// 独立端的 `/status` 拿它回答「还在跑吗」。**只记成功、不记尝试**:连着失败三小时
// 的系统若报「1 分钟前抓过」,这一项就从答案变成了骗局 —— 而那正是主人掏出手机
// 敲 status 的场合。
// ---------------------------------------------------------------------------

describe("DynamicEngine.lastFetchAt", () => {
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
