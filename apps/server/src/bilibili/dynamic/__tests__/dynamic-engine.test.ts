/**
 * 单元测试 — `DynamicEngine` 编排 + 图片失败软降级状态机 + 生命周期。
 *
 * 已有 `post-filter.test.ts` 覆盖纯过滤函数;本文件覆盖把翻译/过滤/渲染/AI/推送
 * 串起来的 `detectDynamics()` 编排,以及 `updateConfig` cron 重启 / `applyOps`
 * 增量 / `start`/`stop` 生命周期。
 *
 * 最该锁的不变量(改坏 = 用户被重复轰炸或永久静默):
 *   图片渲染失败时 → 软降级为纯文字推送 + 只在「连续失败首次」告警一次,渲染恢复
 *   后告警能力复位。
 *
 * 测试策略:
 *   - `detectDynamics()` 是 private,但它是编排核心。白盒直调 + 直接 seed 私有
 *     `dynamicSubManager` / `dynamicTimelineManager`,完全绕开 cron + withLock 的
 *     fire-and-forget 计时纠缠(withLock 返回 `() => void` 不可 await)。
 *   - 生命周期用例 `vi.mock("cron")` 注入惰性 FakeCronJob,断言 start/stop 次数与
 *     重建出的新 cronTime。
 */

import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { ImageRenderer } from "@bilibili-notify/image";
import {
	DEFAULT_CONTENT_FILTERS,
	defaultMessageKindLayout,
	type ImageRef,
	type MessageBus,
	ok,
	type Post,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../../api/index.js";
import { DynamicEngine, type DynamicEngine as DynamicEngineType } from "../dynamic-engine";
import { postFromDynamic } from "../post-from-dynamic";
import type { PushLike, SubItemView, SubscriptionsView } from "../push-like";
import type { AllDynamicResponse, Dynamic } from "../types";
import { type CardFailureTracker, createCardFailureTracker } from "../work-delivery";

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

// 照常翻译,只是包一层好数它被调了几次(㉑e:翻译只做一次,过滤 / 点评 / 出卡共用)、好让它抛一次。
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
	pickDynamicColorOptions(
		uid: string,
		style: SubItemView["customCardStyle"],
	): SubItemView["customCardStyle"] | undefined;
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
	/** 同时写进 desc.text(AI 提取读这个)与 desc.rich_text_nodes(过滤匹配读这个)。 */
	text?: string;
	drawPics?: string[];
	/** opus.pics 带原始尺寸(测尺寸透传:engine 应把 width/height 带进 image-group)。 */
	drawPicsWithDims?: Array<{ url: string; width: number; height: number }>;
	/** 真 DYNAMIC_TYPE_DRAW 形态:图在 major.draw.items[].src(非 opus.pics)。 */
	drawItems?: string[];
	/** 视频动态(DYNAMIC_TYPE_AV)的 major.archive.jump_url;引擎按此算链接部件 / BV。 */
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

/** 测试里写的订阅视图:除 uid / uname 外都可省,messageLayout 缺省为默认版式。 */
type SeedView = Partial<SubItemView> & Pick<SubItemView, "uid" | "uname">;
const viewOf = (v: SeedView): SubItemView => ({
	subscriptionId: `sub-${v.uid}`,
	messageLayout: defaultMessageKindLayout("post"),
	...v,
});
const viewsOf = (subs: Record<string, SeedView>): SubscriptionsView =>
	Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, viewOf(v)]));

interface EngineBag {
	engine: DynamicEngineType;
	fetchAllDynamic: ReturnType<typeof vi.fn>;
	push: PushLike & {
		broadcastDynamic: ReturnType<typeof vi.fn>;
		broadcastDynamicSequence: ReturnType<typeof vi.fn>;
		sendPrivateMsg: ReturnType<typeof vi.fn>;
		sendErrorMsg: ReturnType<typeof vi.fn>;
	};
	emits: Array<{ event: string; payload: unknown }>;
	trigger: (event: string, payload?: unknown) => void;
	disposers: Array<() => void | Promise<void>>;
	generatePostCard: ReturnType<typeof vi.fn>;
	/** 注入给引擎的抓图服务(`imageFetcher` 选项):每个地址回一个以它命名的引用,测试数调用。 */
	fetchImage: ReturnType<typeof vi.fn>;
	/** 注入给引擎的头像读口(`avatarOf` 选项):测试改它背后的值来模拟资料里的头像补上 / 换掉。 */
	avatarOf: ReturnType<typeof vi.fn>;
	comment: ReturnType<typeof vi.fn>;
	logs: LogRec[];
	/** 注入给引擎的出图失败计数(`cardFailures` 选项),测试直接读它。 */
	cardFailures: CardFailureTracker;
}

function makeEngine(
	over: {
		config?: Partial<import("../dynamic-engine").DynamicEngineConfig>;
		withImage?: boolean;
		withAi?: boolean;
		subs?: Record<string, SeedView> | null;
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
	const push = {
		broadcastDynamic: vi.fn(async () => {}),
		broadcastDynamicSequence: vi.fn(async () => {}),
		sendPrivateMsg: vi.fn(async () => {}),
		sendErrorMsg: vi.fn(async () => {}),
	};
	const generatePostCard = vi.fn();
	const fetchImage = vi.fn(async (url: string) =>
		ok({ ref: `${Buffer.from(url).toString("hex").slice(-60).padStart(64, "0")}.jpg` as ImageRef }),
	);
	const avatarOf = vi.fn((_subscriptionId: string): ImageRef | undefined => undefined);
	const image = { generatePostCard } as unknown as ImageRenderer;
	const comment = vi.fn();
	const ai = { comment } as unknown as CommentaryGenerator;
	const cardFailures = createCardFailureTracker();
	const engine = new DynamicEngine({
		serviceCtx: ctx,
		bus,
		api,
		push: push as unknown as PushLike,
		image: over.withImage ? image : undefined,
		ai: over.withAi ? ai : undefined,
		imageFetcher: { fetchImage },
		avatarOf,
		config: {
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: false,
			imageGroup: { enable: false, forward: false },
			filter: DEFAULT_CONTENT_FILTERS,
			...over.config,
		},
		getSubs: () => (over.subs ? viewsOf(over.subs) : null),
		cardFailures,
	});
	return {
		engine,
		fetchAllDynamic,
		push: push as EngineBag["push"],
		emits,
		trigger,
		disposers,
		generatePostCard,
		fetchImage,
		avatarOf,
		comment,
		logs,
		cardFailures,
	};
}

/** seed 一个已订阅 uid(timeline + subManager),供 detectDynamics 白盒直调。 */
/** 播种一个订阅视图;messageLayout 缺省为默认版式(宿主恒填,引擎不再有旧路径)。 */
function seed(engine: DynamicEngineType, uid: string, timeline: number, sub?: SeedView): void {
	priv(engine).dynamicTimelineManager.set(uid, timeline);
	priv(engine).dynamicSubManager.set(uid, viewOf(sub ?? { uid, uname: "UP" }));
}

const detect = (engine: DynamicEngineType): Promise<void> => priv(engine).detectDynamics();

beforeEach(() => {
	cronMock.instances.length = 0;
});

// ---------------------------------------------------------------------------
// A. detectDynamics 编排
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — API 错误处理", () => {
	it("fetchAllDynamic 抛错 → 不广播,静默返回", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockRejectedValue(new Error("network down"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("code=-101(未登录)→ emit engine-error「账号未登录」,不广播", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
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

	it("恢复通知发不出去不能打断本轮动态推送", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		b.fetchAllDynamic.mockResolvedValue(resp([], 4101132, "请求数据发生错误"));
		await detect(b.engine);

		// 私聊通道自己坏了(master 不可达 / 适配器抛错)。恢复通知是锦上添花,
		// 绝不能因为它发不出去就把这一轮真正要推的动态吞掉。
		b.push.sendPrivateMsg.mockRejectedValue(new Error("master unreachable"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalled();
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
	const oneSub = { subs: { "1": { uid: "1", uname: "UP", post: true } } } as const;
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

		b.engine.applyOps([
			{ kind: "add", sub: { uid: "2", uname: "UP2", post: true } as SubItemView },
		]);

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
	it("timeline >= pub_ts → 已推过,跳过不广播", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 1000); // timeline == pub_ts
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("未订阅 uid(无 timeline 条目)→ 跳过", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 999, pubTs: 1000 })]));
		seed(b.engine, "1", 0); // 订阅的是 1,动态来自 999
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("pub_ts 非数字 → 跳过该条,不广播", async () => {
		const b = makeEngine();
		const bad = makeItem({ uid: 1 });
		(bad.modules.module_author as { pub_ts: unknown }).pub_ts = "oops";
		b.fetchAllDynamic.mockResolvedValue(resp([bad]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("未订阅 uid 的无效 pub_ts → 静默跳过,不刷 warn", async () => {
		const b = makeEngine();
		const bad = makeItem({ uid: 999 });
		(bad.modules.module_author as { pub_ts: unknown }).pub_ts = "oops";
		b.fetchAllDynamic.mockResolvedValue(resp([bad]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(b.logs.some((l) => l.level === "warn" && l.msg.includes("无法解析发布时间"))).toBe(
			false,
		);
	});

	it("pub_ts 为数字字符串 → 正常推送并推进 timeline", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts: unknown }).pub_ts = "1234";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1234);
	});

	it("pub_ts 为毫秒时间戳字符串 → 归一化为秒后推送", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts: unknown }).pub_ts = "1717067523000";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1717067523);
	});

	it("pub_ts 缺失但 pub_time 可解析 → 兜底推送", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts?: unknown }).pub_ts = undefined;
		(item.modules.module_author as { pub_time: string }).pub_time = "2026-05-30 12:12:00";
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
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
			expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
			expect(priv(b.engine).dynamicTimelineManager.get("1")).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("新动态推送后 timeline 推进到 pub_ts", async () => {
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
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(2);
	});

	it("DY1:某 uid 推送失败 → 不 abort 其它 uid,失败 uid 锚点不前移(下轮重试)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 100 }), makeItem({ uid: 2, pubTs: 300 })]),
		);
		seed(b.engine, "1", 0);
		seed(b.engine, "2", 0);
		// uid1 推送抛错;uid2 正常。
		b.push.broadcastDynamic.mockImplementation(async (uid: string) => {
			if (uid === "1") throw new Error("push fail");
		});

		await expect(detect(b.engine)).resolves.toBeUndefined(); // 整轮不 abort

		// uid2 仍被投递且锚点前移 —— 证明单条 reject 没掀翻整轮(修复"下轮重推")。
		expect(priv(b.engine).dynamicTimelineManager.get("2")).toBe(300);
		// uid1 失败 → 锚点停在 0,下轮重试,绝不静默越过(不丢动态)。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(0);
		expect(b.push.broadcastDynamic).toHaveBeenCalledWith(
			"2",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("DY1:锚点单调,绝不回退(已 push 过的更新 pub_ts 不倒退)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 100 })]));
		seed(b.engine, "1", 500); // 既有锚点已高于来项
		await detect(b.engine);
		// timeline(500) >= 100 → 跳过,锚点保持 500,绝不被 set 成 100。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(500);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});
});

describe("DynamicEngine.detectDynamics — 推送形态", () => {
	it("有 image 实例 + 无 AI → 广播 [image] 段,part=post", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const [uid, segments, part] = b.push.broadcastDynamic.mock.calls[0] as [
			string,
			Array<{ kind: string }>,
			string,
		];
		expect(uid).toBe("1");
		expect(part).toBe("post");
		expect(segments[0]?.kind).toBe("image");
	});

	// 引擎出卡的唯一入口是 `generatePostCard(postFromDynamic(原始动态))`:零件各自绿(翻译有翻译的测试、出卡有出卡
	// 的测试)证明不了两头真的接上了。验红:把 dynamic-engine.ts 里那句换回只传原始动态、或不翻就交,这条红。
	it("出卡时先把原始动态翻成 Post 再交给 generatePostCard", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, name: "示例UP", pubTs: 1_700_000_000, text: "你好世界" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.generatePostCard).toHaveBeenCalledTimes(1);
		const post = b.generatePostCard.mock.calls[0]?.[0] as Post;
		// 是翻译出来的中立作品,不是原始动态:有 creator / publishedAt / text,没有 modules。
		expect(post).toMatchObject({
			creator: { name: "示例UP" },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "你好世界",
		});
		expect(post).not.toHaveProperty("modules");
	});

	// 3a-34:B 站的图在出卡前自己抓进图库。零件(抓图函数、出卡器)各自绿,证明不了引擎真的接上了。
	// 验红:把 dynamic-engine.ts `workFromDynamic` 里 renderCard 的 `await fetched` 换成直接交 `post`,这条红。
	it("出卡时作品里只有地址的图先抓进图库,出卡器收到的 Post 带 ref", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({ uid: 1, pubTs: 1000, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] }),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		const post = b.generatePostCard.mock.calls[0]?.[0] as Post;
		expect(post.images).toHaveLength(1);
		expect(post.images?.[0]?.ref).toBeDefined();
		expect(post.images?.[0]?.url).toBe("https://i0.hdslb.com/bfs/new_dyn/a.jpg");
	});

	// 3a-35:外层作者的头像由引擎出卡那一刻按订阅 id 向宿主读(`avatarOf`),出卡时零网络。
	// 验红:把 dynamic-engine.ts `workFromDynamic` 里传给 fetchPostImages 的 `avatar: readAvatar()` 去掉,这条红。
	it("读口给了头像引用:出卡器收到的 Post.creator.avatar 就是它(按视图上的订阅 id 读),不为头像联网", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, text: "你好" })]));
		const avatar = `${"a".repeat(64)}.jpg` as ImageRef;
		b.avatarOf.mockReturnValue(avatar);
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", subscriptionId: "sub-xyz" });
		await detect(b.engine);
		expect(b.avatarOf).toHaveBeenCalledWith("sub-xyz");
		const post = b.generatePostCard.mock.calls[0]?.[0] as Post;
		expect(post.creator.avatar).toBe(avatar);
		expect(b.fetchImage).not.toHaveBeenCalled();
	});

	// 现读:同一个引擎实例,资料里的头像之后才补上,下一张卡就要有。验红:把读取提前到引擎构造时 / 视图建立时,这条红。
	it("头像每张卡现读:同一个引擎先出一张没头像的卡,读口背后换成引用,下一张就有", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic
			.mockResolvedValueOnce(resp([makeItem({ uid: 1, pubTs: 1000, text: "第一条" })]))
			.mockResolvedValueOnce(resp([makeItem({ uid: 1, pubTs: 2000, text: "第二条" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const avatar = `${"b".repeat(64)}.jpg` as ImageRef;
		b.avatarOf.mockReturnValue(avatar);
		await detect(b.engine);
		expect(
			(b.generatePostCard.mock.calls[0]?.[0] as Post | undefined)?.creator.avatar,
		).toBeUndefined();
		expect((b.generatePostCard.mock.calls[1]?.[0] as Post | undefined)?.creator.avatar).toBe(
			avatar,
		);
	});

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

	// 验红:把 dynamic-engine.ts `workFromDynamic` 里传给 fetchPostImages 的 `repostAvatarUrl` 去掉,这条红。
	it("转发:原作者的头像出卡时现抓(480 宽头像档),填进 repost.creator.avatar", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([repostItem()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.fetchImage.mock.calls[0]?.[0]).toBe(
			"https://i0.hdslb.com/bfs/face/orig.jpg@480w_80q_1s.webp",
		);
		const post = b.generatePostCard.mock.calls[0]?.[0] as Post;
		expect(post.repost?.creator.avatar).toBeDefined();
		expect(post.creator.avatar).toBeUndefined();
	});

	it("转发的动态被过滤掉 / 没有渲染器:原作者的头像一次都不抓", async () => {
		const filtered = makeEngine({ withImage: true });
		const item = repostItem();
		item.modules.module_dynamic.desc = {
			text: "含禁词",
			rich_text_nodes: [{ text: "含禁词", type: "RICH_TEXT_NODE_TYPE_TEXT" } as never],
		};
		filtered.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(filtered.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["禁词"], notify: false },
		});
		await detect(filtered.engine);
		expect(filtered.generatePostCard).not.toHaveBeenCalled();
		expect(filtered.fetchImage).not.toHaveBeenCalled();

		const noRenderer = makeEngine({ withImage: false });
		noRenderer.fetchAllDynamic.mockResolvedValue(resp([repostItem()]));
		seed(noRenderer.engine, "1", 0);
		await detect(noRenderer.engine);
		expect(noRenderer.fetchImage).not.toHaveBeenCalled();
	});

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

	// 验红:把 dynamic-engine.ts `workFromDynamic` 里传给 fetchPostImages 的 `emojiUrls` 去掉,这条红。
	it("正文里的表情出卡时抓成图(表情那一档 128 宽),出卡器收到的 Post 里表情带 image", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([emojiItem()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.fetchImage).toHaveBeenCalledTimes(1);
		expect(b.fetchImage.mock.calls[0]?.[0]).toBe(
			"https://i0.hdslb.com/bfs/emote/doge.png@128w_80q_1s.webp",
		);
		const post = b.generatePostCard.mock.calls[0]?.[0] as Post;
		const emoji = post.richText?.find((segment) => segment.kind === "emoji");
		expect(emoji).toMatchObject({ text: "[doge]" });
		expect(emoji).toHaveProperty("image");
	});

	it("带表情的动态被过滤掉 / 没有渲染器 / 关了出图:表情一个都不抓", async () => {
		const filtered = makeEngine({ withImage: true });
		filtered.fetchAllDynamic.mockResolvedValue(resp([emojiItem()]));
		seed(filtered.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["看"], notify: false },
		});
		await detect(filtered.engine);
		expect(filtered.generatePostCard).not.toHaveBeenCalled();
		expect(filtered.fetchImage).not.toHaveBeenCalled();

		for (const over of [
			{ withImage: false },
			{ withImage: true, config: { imageEnabled: false } },
		]) {
			const b = makeEngine(over);
			b.fetchAllDynamic.mockResolvedValue(resp([emojiItem()]));
			seed(b.engine, "1", 0);
			await detect(b.engine);
			expect(b.fetchImage).not.toHaveBeenCalled();
		}
	});

	it("关了出图 / 没有渲染器:不出卡也就一张图都不抓", async () => {
		for (const over of [
			{ withImage: false },
			{ withImage: true, config: { imageEnabled: false } },
		]) {
			const b = makeEngine(over);
			b.fetchAllDynamic.mockResolvedValue(
				resp([
					makeItem({ uid: 1, pubTs: 1000, drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"] }),
				]),
			);
			seed(b.engine, "1", 0);
			await detect(b.engine);
			expect(b.fetchImage).not.toHaveBeenCalled();
		}
	});

	it("被过滤掉的动态一张图都不抓", async () => {
		const b = makeEngine({ withImage: true });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1500,
					text: "含禁词",
					drawPics: ["https://i0.hdslb.com/bfs/new_dyn/a.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["禁词"], notify: false },
		});
		await detect(b.engine);
		expect(b.generatePostCard).not.toHaveBeenCalled();
		expect(b.fetchImage).not.toHaveBeenCalled();
	});

	// per-UP 的皮肤 id 要一路走到 generatePostCard —— 断在哪一跳都是
	// 「选得动、存得住、就是不生效」那一族,而且全绿。
	it("per-UP 皮肤 id 进 colorOptions;样式没启用时也只多这一个键", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0, { uid: "1", uname: "U1", cardSkin: "k5aaa-b0a710" });
		await detect(b.engine);
		// 验红:把 work-delivery.ts 里那句 `cardSkin: settings.cardSkin` 删掉,这条红。
		expect(b.generatePostCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "k5aaa-b0a710" });
	});

	// 旋钮覆盖(ADR-0014 决策 17 的 🔗)是订阅视图上的一格,引擎把整份视图当设置交给装配 ——
	// 这条钉的是「视图上那格真走到了出卡」。验红:把 push-like.ts 的 `WorkSubscriptionSettings`
	// 里 `cardSkinKnobs` 那一项与 work-delivery.ts 递它那一句一起删掉,这条红。
	it("per-UP 旋钮覆盖随皮肤 id 进 colorOptions", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		const cardSkinKnobs = { "k5aaa-b0a710": { accent: "#aaaaaa" } };
		seed(b.engine, "1", 0, { uid: "1", uname: "U1", cardSkin: "k5aaa-b0a710", cardSkinKnobs });
		await detect(b.engine);
		expect(b.generatePostCard.mock.calls[0]?.[1]).toEqual({
			cardSkin: "k5aaa-b0a710",
			cardSkinKnobs,
		});
	});

	it("有 image + 有 AI → 段含 image + AI 点评文本", async () => {
		const b = makeEngine({ withImage: true, withAi: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.comment.mockResolvedValue("这条很有意思");
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, text: "原始内容" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{
			kind: string;
			text?: string;
		}>;
		expect(segments.some((s) => s.kind === "image")).toBe(true);
		// 默认版式:AI 点评后跟链接部件,同条内以换行连接。
		expect(
			segments.some(
				(s) => s.kind === "text" && s.text === `这条很有意思\nhttps://t.bilibili.com/id-1`,
			),
		).toBe(true);
	});

	it("无 image 实例 → 纯文字段降级", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ kind: string }>;
		expect(segments).toHaveLength(1);
		expect(segments[0]?.kind).toBe("text");
	});

	it("imageEnabled=false → 即使注入了 image 也跳过渲染,纯文字", async () => {
		const b = makeEngine({ withImage: true, config: { imageEnabled: false } });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.generatePostCard).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ kind: string }>;
		expect(segments[0]?.kind).toBe("text");
	});

	it("imageGroup.enable + DYNAMIC_TYPE_DRAW 带 pics → 追加 post-images 广播", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(2);
		expect(b.push.broadcastDynamic.mock.calls[1]?.[2]).toBe("post-images");
	});

	it("主卡与图集是同一次推送:两次 broadcast 带同一个 pushId;下一条动态换新的", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg"],
				}),
				makeItem({
					uid: 1,
					pubTs: 2000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/3.jpg", "http://a/4.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const calls = b.push.broadcastDynamic.mock.calls as Array<
			[string, unknown, string, { pushId?: string } | undefined]
		>;
		expect(calls.map((c) => c[2])).toEqual(["post", "post-images", "post", "post-images"]);
		const ids = calls.map((c) => c[3]?.pushId);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(ids[1]).toBe(ids[0]);
		expect(ids[3]).toBe(ids[2]);
		expect(ids[2]).not.toBe(ids[0]);
	});

	it("图组发送失败 → 主卡已发出,锚点仍推进(不因附属图组失败而重发主卡 + 重复 @全体)", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawItems: ["http://a/x1.jpg", "http://a/x2.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		// 主卡(第 1 次,part='post')成功;图组(第 2 次,part='post-images')失败。
		// 图组走 forward/NapCat 长消息通道,现实里会 reject(config 注释点名其不稳定)。
		b.push.broadcastDynamic.mockImplementation(
			async (_uid: string, _segs: unknown, part: string) => {
				if (part === "post-images") throw new Error("图组通道抖动");
			},
		);
		await detect(b.engine);
		// 主卡已成功送达 → 锚点必须推进到 pub_ts,否则下轮整条重判、主卡以 part='post'
		// 重发,而 post 不抑制 @全体 → 每 tick 重复 @全体,直到动态滚出 feed。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1000);
	});

	it("P2-A:DRAW 图在 major.draw.items[].src → 不再静默丢图组(此前只读 opus.pics)", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawItems: ["http://a/x1.jpg", "http://a/x2.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(2);
		const call = b.push.broadcastDynamic.mock.calls[1];
		expect(call?.[2]).toBe("post-images");
		expect(call?.[1]?.[0]).toMatchObject({
			kind: "image-group",
			images: [{ url: "http://a/x1.jpg" }, { url: "http://a/x2.jpg" }],
		});
	});

	it("图集 image-group 透传 B站原始尺寸(QQ 原生 markdown 多图需 width/height)", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPicsWithDims: [{ url: "http://a/1.jpg", width: 800, height: 600 }],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const call = b.push.broadcastDynamic.mock.calls[1];
		expect((call?.[1]?.[0] as { images: unknown[] } | undefined)?.images).toEqual([
			{ url: "http://a/1.jpg", width: 800, height: 600 },
		]);
	});

	it("imageGroupForward 默认 false → image-group segment 的 mergeForward 为 false", async () => {
		// 默认不走合并转发,避开 NapCat SsoSendLongMsg 长消息通道。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const call = b.push.broadcastDynamic.mock.calls[1];
		expect((call?.[1]?.[0] as { mergeForward: boolean } | undefined)?.mergeForward).toBe(false);
	});

	it("imageGroupForward=true + 多张图 → image-group segment 的 mergeForward 为 true", async () => {
		// 主动开启 + 多张图时 segment 携带 mergeForward:true,下游 adapter 走合并转发路径。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: true } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg", "http://a/3.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const call = b.push.broadcastDynamic.mock.calls[1];
		expect((call?.[1]?.[0] as { mergeForward: boolean } | undefined)?.mergeForward).toBe(true);
	});

	it("imageGroupForward=true 但只有 1 张图 → mergeForward 强制 false(单图合并转发无意义)", async () => {
		// 即使主动开启 imageGroupForward,单张图也不走 forward(聊天记录卡片包 1 张图无意义)。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: true } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/only.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const call = b.push.broadcastDynamic.mock.calls[1];
		expect((call?.[1]?.[0] as { mergeForward: boolean } | undefined)?.mergeForward).toBe(false);
	});

	it("per-UP imageGroupEnable=false 覆盖全局 true → 不推图集", async () => {
		// 全局开 imageGroup.enable,但 sub 视图带 imageGroupEnable:false → 不发图集广播。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", imageGroupEnable: false });
		await detect(b.engine);
		// 仅主卡片,无图集广播
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		expect(b.push.broadcastDynamic.mock.calls[0]?.[2]).toBe("post");
	});

	it("per-UP imageGroupEnable=true 覆盖全局 false → 推图集", async () => {
		// 全局关 imageGroup.enable,但 sub 视图 imageGroupEnable:true → 发图集。
		const b = makeEngine({ config: { imageGroup: { enable: false, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", imageGroupEnable: true });
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(2);
		expect(b.push.broadcastDynamic.mock.calls[1]?.[2]).toBe("post-images");
	});

	it("per-UP imageGroupEnable 缺省(undefined) → 继承全局 imageGroup.enable(回归守卫 `??` 非 `||`)", async () => {
		// 守护 dynamic-engine 用 `??` 折叠而非 `||`:undefined 走 fallback,但 false
		// 显式 per-UP 关闭不被吃。本用例钉「缺省=继承」一向。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg"],
				}),
			]),
		);
		// sub view 不带 imageGroupEnable 字段 → 应当继承全局 true → 推图集
		seed(b.engine, "1", 0, { uid: "1", uname: "UP" });
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(2);
		expect(b.push.broadcastDynamic.mock.calls[1]?.[2]).toBe("post-images");
	});

	it("per-UP imageGroupForward=true 覆盖全局 false → 多图走 forward", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					type: "DYNAMIC_TYPE_DRAW",
					drawPics: ["http://a/1.jpg", "http://a/2.jpg"],
				}),
			]),
		);
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", imageGroupForward: true });
		await detect(b.engine);
		const call = b.push.broadcastDynamic.mock.calls[1];
		expect((call?.[1]?.[0] as { mergeForward: boolean } | undefined)?.mergeForward).toBe(true);
	});
});

describe("DynamicEngine.detectDynamics — 动态文本模板 (Part A/B)", () => {
	type Seg = { kind: string; text?: string };
	const textOf = (segments: Seg[]): string | undefined =>
		segments.find((s) => s.kind === "text")?.text;
	const segsOf = (b: EngineBag): Seg[] => b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];

	it("无图 + 无 AI → 默认模板文案 + 链接部件(默认版式同条换行连接)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe(`阿绫发布了一条动态\nhttps://t.bilibili.com/id-1`);
	});

	it("版式隐藏 link 部件 → 无链接", async () => {
		const b = makeEngine({ config: { dynamicTemplate: "{name}发布了一条动态" } });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		const noLink = defaultMessageKindLayout("post");
		for (const blk of noLink.blocks) if (blk.type === "link") blk.visible = false;
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", messageLayout: noLink });
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("阿绫发布了一条动态");
	});

	it("视频转 BV 但 jump_url 无 BV → url 空,link 部件缺席", async () => {
		const b = makeEngine({
			config: { dynamicVideoUrlToBV: true, videoTemplate: "{name}发布了新视频" },
		});
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					name: "阿绫",
					type: "DYNAMIC_TYPE_AV",
					videoJumpUrl: "//www.bilibili.com/read/cv1",
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("阿绫发布了新视频");
	});

	it("Part A:有图分支的文字段 == 无图分支的文字段(模板单源,无双前缀)", async () => {
		const withImg = makeEngine({ withImage: true });
		withImg.generatePostCard.mockResolvedValue(Buffer.from("png"));
		withImg.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]),
		);
		seed(withImg.engine, "1", 0);
		await detect(withImg.engine);
		const imgSegs = segsOf(withImg);
		expect(imgSegs[0]?.kind).toBe("image");

		const noImg = makeEngine();
		noImg.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]),
		);
		seed(noImg.engine, "1", 0);
		await detect(noImg.engine);
		expect(textOf(imgSegs)).toBe(`阿绫发布了一条动态\nhttps://t.bilibili.com/id-1`);
		expect(textOf(imgSegs)).toBe(textOf(segsOf(noImg)));
	});

	it("视频动态(DYNAMIC_TYPE_AV)走 videoTemplate + jump_url 链接", async () => {
		const b = makeEngine({ config: { videoTemplate: "{name}发布了新视频" } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					name: "阿绫",
					type: "DYNAMIC_TYPE_AV",
					videoJumpUrl: "//www.bilibili.com/video/BV1demo",
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("阿绫发布了新视频\nhttps://www.bilibili.com/video/BV1demo");
	});

	it("per-UP customDynamicTemplate 覆盖内建模板", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			customDynamicTemplate: "🔔 {name} 有新动态",
		});
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe(`🔔 阿绫 有新动态\nhttps://t.bilibili.com/id-1`);
	});

	it("全局 config.dynamicTemplate 覆盖内建兜底", async () => {
		const b = makeEngine({ config: { dynamicTemplate: "【动态】{name}" } });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe(`【动态】阿绫\nhttps://t.bilibili.com/id-1`);
	});

	it("有 AI 点评时两分支都用点评,不走模板", async () => {
		const b = makeEngine({ withAi: true });
		b.comment.mockResolvedValue("这条很有意思");
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫", text: "原始内容" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe(`这条很有意思\nhttps://t.bilibili.com/id-1`);
	});
});

// 刻画(ADR-0019 决策 66 切出作品装配之前钉的现状):B 站原始数据里哪几格进了 AI 点评、
// 视频链接换 BV、per-UP 的视频模板 / AI 覆盖 / 卡片样式、图集只认图文动态。切开之后这几样
// 由 B 站那头先翻成作品,装配只认翻好的。㉑e 起 AI 点评的文字也走 `postText(post, "labeled")`,
// 不再是引擎自己拼的那一份。
describe("DynamicEngine.detectDynamics — B 站动态翻成作品(刻画)", () => {
	type Seg = { kind: string; text?: string };
	const textNode = (text: string) => ({ text, type: "RICH_TEXT_NODE_TYPE_TEXT" });
	/** 一条带标题的图文,转发了一条视频投稿(接口里的字都写在富文本节点上)。 */
	const richItem = (): Dynamic => {
		const item = makeItem({
			uid: 1,
			pubTs: 1000,
			name: "阿绫",
			type: "DYNAMIC_TYPE_FORWARD",
			text: "正文",
			drawItems: ["http://i/d1.jpg", "http://i/d2.jpg", "http://i/d3.jpg"],
		});
		const major = item.modules.module_dynamic.major as Record<string, unknown>;
		major.opus = {
			title: "标题",
			summary: { text: "摘要", rich_text_nodes: [textNode("摘要")] },
			pics: [{ url: "http://i/p1.jpg" }],
		};
		major.archive = { title: "视频", jump_url: "", cover: "http://i/cover.jpg" };
		item.orig = {
			type: "DYNAMIC_TYPE_AV",
			modules: {
				module_author: { name: "原作者" },
				module_dynamic: {
					desc: { text: "原文", rich_text_nodes: [textNode("原文")] },
					major: { archive: { title: "视频", jump_url: "", cover: "http://i/orig-cover.jpg" } },
				},
			},
		} as unknown as Dynamic;
		return item;
	};

	it("AI 点评:提示词带名字与正文(标题 / 摘要 / 转发原文及它的视频标题),图取前 4 张", async () => {
		const b = makeEngine({ withAi: true });
		b.comment.mockResolvedValue("点评");
		b.fetchAllDynamic.mockResolvedValue(resp([richItem()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.comment).toHaveBeenCalledTimes(1);
		const [prompt, scene, images] = b.comment.mock.calls[0] as [string, string, string[]];
		expect(prompt).toBe(
			// 取段只此一份(`postText(post, "labeled")`):标题排最前,正文与摘要一段,转发的原作品收进括号。
			// 从前引擎自己拼的是「正文 / 标题：… / 摘要 / 视频标题：… / （转发自 …）」。
			"阿绫发布了一条动态，内容如下：\n标题：标题\n正文\n摘要\n（转发自 原作者：原文 视频标题：视频）",
		);
		expect(scene).toBe("dynamic");
		// draw.items → opus.pics → 视频封面,截前 4 张(封面被截掉)。
		expect(images).toEqual([
			"http://i/d1.jpg",
			"http://i/d2.jpg",
			"http://i/d3.jpg",
			"http://i/p1.jpg",
		]);
	});

	it("没有可点评的正文 → 不调 AI,走模板", async () => {
		const b = makeEngine({ withAi: true });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.comment).not.toHaveBeenCalled();
		const segs = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segs[0]?.text).toBe("阿绫发布了一条动态\nhttps://t.bilibili.com/id-1");
	});

	it("AI 点评失败 → 回退到模板,照常推送", async () => {
		const b = makeEngine({ withAi: true });
		b.comment.mockRejectedValue(new Error("额度用完"));
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫", text: "原始内容" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segs = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segs[0]?.text).toBe("阿绫发布了一条动态\nhttps://t.bilibili.com/id-1");
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1000);
	});

	it("per-UP 的 AI 覆盖原样交给这一次点评", async () => {
		const b = makeEngine({ withAi: true });
		b.comment.mockResolvedValue("点评");
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, text: "原始内容" })]),
		);
		const aiOverride = { dynamicPrompt: "这位 UP 专属的场景提示" };
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", aiOverride });
		await detect(b.engine);
		expect(b.comment.mock.calls[0]?.[3]).toEqual(aiOverride);
	});

	it("视频链接换 BV:jump_url 里有 BV 号 → 链接部件就是 BV 号", async () => {
		const b = makeEngine({ config: { dynamicVideoUrlToBV: true } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					name: "阿绫",
					type: "DYNAMIC_TYPE_AV",
					videoJumpUrl: "//www.bilibili.com/video/BV1demo",
				}),
			]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segs = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segs[0]?.text).toBe("阿绫发布了新视频\nBV1demo");
	});

	it("per-UP 视频模板盖过全局视频模板", async () => {
		const b = makeEngine({ config: { videoTemplate: "全局 {name}" } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([
				makeItem({
					uid: 1,
					pubTs: 1000,
					name: "阿绫",
					type: "DYNAMIC_TYPE_AV",
					videoJumpUrl: "//www.bilibili.com/video/BV1demo",
				}),
			]),
		);
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", customVideoTemplate: "UP 的 {name}" });
		await detect(b.engine);
		const segs = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segs[0]?.text).toBe("UP 的 阿绫\nhttps://www.bilibili.com/video/BV1demo");
	});

	it("per-UP 卡片样式启用 → 样式与皮肤一起进 colorOptions", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			customCardStyle: { enable: true, font: "霞鹜文楷" },
			cardSkin: "skin-1",
		});
		await detect(b.engine);
		expect(b.generatePostCard.mock.calls[0]?.[1]).toEqual({
			enable: true,
			font: "霞鹜文楷",
			cardSkin: "skin-1",
		});
	});

	it("图集只认图文动态:别的类型带图也不附图集", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, drawPics: ["http://a/1.jpg", "http://a/2.jpg"] })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		expect(b.push.broadcastDynamic.mock.calls[0]?.[2]).toBe("post");
	});
});

describe("DynamicEngine.detectDynamics — 过滤 notify", () => {
	it("命中过滤 + notify=false → 不广播,但 timeline 仍推进", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1500, text: "含禁词" })]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["禁词"], notify: false },
		});
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1500);
	});

	it("命中过滤 + notify=true → 广播屏蔽原因文案", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, name: "阿伟", pubTs: 1500, text: "含禁词" })]),
		);
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["禁词"], notify: true },
		});
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{
			kind: string;
			text?: string;
		}>;
		expect(segments[0]?.text).toContain("阿伟");
	});
});

/**
 * 过滤吃翻译好的 `Post`(㉑e,ADR-0021 决策 43):引擎先 `postFromDynamic` 再过滤 —— 类型开关看的是作品「有没有」
 * 图集 / 视频 / 转发 / 专栏,不再是 B 站的外层类型码;翻译只做一次,过滤、点评、出卡共用同一份。
 * `dynamic-detected` 仍在过滤之前发、载荷里是原始类型码(这个事件 3a 才换,不动)。
 */
describe("DynamicEngine.detectDynamics — 过滤吃翻译好的 Post", () => {
	const rules = (over: Partial<typeof DEFAULT_CONTENT_FILTERS>) => ({
		...DEFAULT_CONTENT_FILTERS,
		...over,
	});
	const detected = (b: EngineBag) => b.emits.filter((e) => e.event === "dynamic-detected");

	const videoItem = () =>
		makeItem({
			uid: 1,
			pubTs: 1500,
			name: "阿伟",
			type: "DYNAMIC_TYPE_AV",
			videoJumpUrl: "//www.bilibili.com/video/BV1xx411c7mD",
		});
	const drawItem = () =>
		makeItem({
			uid: 1,
			pubTs: 1500,
			name: "阿伟",
			type: "DYNAMIC_TYPE_DRAW",
			drawPics: ["http://i/p1.jpg"],
		});
	const forwardItem = () => {
		const item = makeItem({ uid: 1, pubTs: 1500, name: "阿伟", type: "DYNAMIC_TYPE_FORWARD" });
		item.orig = {
			type: "DYNAMIC_TYPE_WORD",
			modules: { module_author: { name: "原作者" }, module_dynamic: {} },
		} as unknown as Dynamic;
		return item;
	};
	const articleItem = () =>
		makeItem({ uid: 1, pubTs: 1500, name: "阿伟", type: "DYNAMIC_TYPE_ARTICLE" });

	/** 四个开关各接到哪一类作品 —— 单元测试证明不了引擎真的把翻好的 Post 交给了过滤。 */
	const cases: [string, keyof typeof DEFAULT_CONTENT_FILTERS, () => Dynamic][] = [
		["blockVideos ← 视频投稿", "blockVideos", videoItem],
		["blockImages ← 带图的图文", "blockImages", drawItem],
		["blockReposts ← 转发", "blockReposts", forwardItem],
		["blockArticles ← 专栏", "blockArticles", articleItem],
	];

	for (const [name, key, build] of cases) {
		it(`${name}:开着 → 不广播、timeline 照推进;没开 → 照常推`, async () => {
			const blocked = makeEngine();
			blocked.fetchAllDynamic.mockResolvedValue(resp([build()]));
			seed(blocked.engine, "1", 0, { uid: "1", uname: "UP", filter: rules({ [key]: true }) });
			await detect(blocked.engine);
			expect(blocked.push.broadcastDynamic).not.toHaveBeenCalled();
			expect(priv(blocked.engine).dynamicTimelineManager.get("1")).toBe(1500);

			const open = makeEngine();
			open.fetchAllDynamic.mockResolvedValue(resp([build()]));
			seed(open.engine, "1", 0, { uid: "1", uname: "UP", filter: rules({}) });
			await detect(open.engine);
			expect(open.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		});
	}

	it("看的是「有没有图集」不是外层类型码:没带图的图文动态,blockImages 不拦", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1500, type: "DYNAMIC_TYPE_DRAW", text: "只有字" })]),
		);
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", filter: rules({ blockImages: true }) });
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
	});

	it("全局那份过滤(config.filter)同样吃 Post:per-UP 没覆盖就用它", async () => {
		const b = makeEngine({ config: { filter: rules({ blockVideos: true }) } });
		b.fetchAllDynamic.mockResolvedValue(resp([videoItem()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("per-UP 覆盖盖过全局:全局拦视频,这位 UP 单独放开 → 照推", async () => {
		const b = makeEngine({ config: { filter: rules({ blockVideos: true }) } });
		b.fetchAllDynamic.mockResolvedValue(resp([videoItem()]));
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", filter: rules({}) });
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
	});

	it("转发里的视频不归 blockVideos 管(只看最外层):只开 blockVideos 的转发照推", async () => {
		const item = forwardItem();
		item.orig = {
			type: "DYNAMIC_TYPE_AV",
			modules: {
				module_author: { name: "原作者" },
				module_dynamic: { major: { archive: { title: "原视频", jump_url: "" } } },
			},
		} as unknown as Dynamic;
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", filter: rules({ blockVideos: true }) });
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
	});

	it("dynamic-detected 仍在过滤之前发,载荷里是原始类型码(3a 才换,这一片不动)", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([videoItem()]));
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", filter: rules({ blockVideos: true }) });
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(detected(b)).toHaveLength(1);
		expect(detected(b)[0]?.payload).toMatchObject({ uid: "1", type: "DYNAMIC_TYPE_AV" });
	});

	it("屏蔽提醒(notify 开着)用中立措辞,作品叫「动态」", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([videoItem()]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { ...rules({ blockVideos: true }), notify: true },
		});
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ text?: string }>;
		expect(segments[0]?.text).toBe("阿伟发布了一条带视频的动态，已屏蔽");
	});

	it("翻译只做一次:过滤、AI 点评、出卡共用同一份 Post", async () => {
		const b = makeEngine({ withImage: true, withAi: true });
		b.comment.mockResolvedValue("点评");
		b.generatePostCard.mockResolvedValue(Buffer.from("card"));
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1500, name: "阿伟", text: "正文" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(postFromDynamic).toHaveBeenCalledTimes(1);
		const translated = vi.mocked(postFromDynamic).mock.results[0]?.value;
		// 出卡前抓图换出的是一份新对象(3a-34),这条作品没有图要抓,所以内容与翻译出来的那份一致。
		expect(b.generatePostCard.mock.calls[0]?.[0]).toEqual(translated);
		// 点评的文字取自同一份 Post(`postText(post, "labeled")`)。
		expect(b.comment.mock.calls[0]?.[0]).toContain("正文");
	});

	it("翻译抛错(不该发生,但别卡住这位 UP):这一条记 warn 跳过、timeline 照推进,同一轮别的动态照常推", async () => {
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
		// 第一条(翻译抛错)跳过,第二条照推;锚点推进到两条里最大的(翻译失败的算处理过,不重试、不重复推送)。
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1500);
		expect(
			b.logs.some((l) => l.level === "warn" && l.msg.includes("翻不动") && l.msg.includes("id-1")),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// B. 图片失败软降级状态机(最高优先级)
// ---------------------------------------------------------------------------

describe("DynamicEngine — 图片失败软降级状态机", () => {
	it("渲染失败一次 → streak=1,sendErrorMsg+emit 各一次,仍降级纯文字推送", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockRejectedValue(new Error("chrome crash"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);

		expect(b.cardFailures.streak).toBe(1);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);
		expect(b.emits.filter((e) => e.event === "engine-error")).toHaveLength(1);
		// 软降级:推送照常发生,只是退化为纯文字
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ kind: string }>;
		expect(segments[0]?.kind).toBe("text");
	});

	it("连续失败两轮 → sendErrorMsg / engine-error 全程仅一次(notified 守卫)", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockRejectedValue(new Error("chrome crash"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		// 第二轮:新动态(pub_ts 更大),仍失败
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 2000 })]));
		await detect(b.engine);

		expect(b.cardFailures.streak).toBe(2);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);
		expect(b.emits.filter((e) => e.event === "engine-error")).toHaveLength(1);
	});

	it("A3:首次失败的 sendErrorMsg reject → notified 不置位,下轮失败重试通知", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockRejectedValue(new Error("chrome crash"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);

		// 轮1:渲染失败 + 通知本身 reject。
		b.push.sendErrorMsg.mockRejectedValueOnce(new Error("push down"));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);
		// 关键不变量:通知没送达 → notified 必须仍 false(旧实现在 await 前置位
		// → reject 后永远 true,后续失败永久静默)。
		expect(b.cardFailures.notified).toBe(false);

		// 轮2:再失败,这次通知成功 → 因 notified 仍 false,重试并送达后才置位。
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 2000 })]));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(2);
		expect(b.cardFailures.notified).toBe(true);
	});

	it("失败 → 成功(复位)→ 再失败:能再次告警(sendErrorMsg 共两次)", async () => {
		const b = makeEngine({ withImage: true });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);

		// 轮1:失败 → 告警#1
		b.generatePostCard.mockRejectedValueOnce(new Error("crash"));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);

		// 轮2:成功 → streak/notified 复位
		b.generatePostCard.mockResolvedValueOnce(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 2000 })]));
		await detect(b.engine);
		expect(b.cardFailures.streak).toBe(0);
		expect(b.cardFailures.notified).toBe(false);

		// 轮3:再失败 → 告警#2(复位后恢复了告警能力)
		b.generatePostCard.mockRejectedValueOnce(new Error("crash again"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 3000 })]));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// 开播伪动态(DYNAMIC_TYPE_LIVE_RCMD)—— ADR-0019 决策 66
//
// 开播由直播引擎推。从前这里靠出卡时抛「直播开播动态，不做处理」、再按错误文案接住来跳过:
// 关了出图、或版式里藏起卡片时根本不出卡,这条就被当普通动态推出去,和直播引擎的开播撞车。
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — 开播伪动态", () => {
	const liveRcmd = () => makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_LIVE_RCMD" });
	const expectSkipped = (b: EngineBag): void => {
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(b.push.broadcastDynamicSequence).not.toHaveBeenCalled();
		// 当作已处理:锚点照常前移,下一轮不再重判。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1000);
	};

	it("关了出图 → 不推送,锚点照常前移", async () => {
		const b = makeEngine({ withImage: true, config: { imageEnabled: false } });
		b.fetchAllDynamic.mockResolvedValue(resp([liveRcmd()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expectSkipped(b);
	});

	it("版式藏起卡片 → 不推送,锚点照常前移", async () => {
		const b = makeEngine({ withImage: true });
		b.fetchAllDynamic.mockResolvedValue(resp([liveRcmd()]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			messageLayout: {
				...defaultMessageKindLayout("post"),
				blocks: defaultMessageKindLayout("post").blocks.map((x) =>
					x.type === "card" ? { ...x, visible: false } : x,
				),
			},
		});
		await detect(b.engine);
		expectSkipped(b);
	});

	it("开着出图也不去出卡、不点评:不计出图失败、不告警", async () => {
		const b = makeEngine({ withImage: true, withAi: true });
		b.fetchAllDynamic.mockResolvedValue(resp([liveRcmd()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expectSkipped(b);
		expect(b.generatePostCard).not.toHaveBeenCalled();
		expect(b.comment).not.toHaveBeenCalled();
		expect(b.push.sendErrorMsg).not.toHaveBeenCalled();
	});

	it("统计照常看得见它(统计那头自己按类型忽略)", async () => {
		const b = makeEngine({ config: { imageEnabled: false } });
		b.fetchAllDynamic.mockResolvedValue(resp([liveRcmd()]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const detected = b.emits.filter((e) => e.event === "dynamic-detected");
		expect(detected).toHaveLength(1);
		expect(detected[0]?.payload).toMatchObject({ type: "DYNAMIC_TYPE_LIVE_RCMD" });
	});
});

describe("DynamicEngine — applyOps 在 detectDynamics 跨 await 时退订(A7)", () => {
	it("渲染 await 期间 delete 该 UID → 不推送 + 不复活时间线", async () => {
		const b = makeEngine({ withImage: true });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		// 模拟交错:generatePostCard 解析前,adapter 收到 subscription-changed
		// 调 applyOps 退订 uid 1(stopDynamicForUid 删两张表)。
		b.generatePostCard.mockImplementation(async () => {
			b.engine.applyOps([{ kind: "delete", uid: "1" }]);
			return undefined;
		});

		await detect(b.engine);

		expect(priv(b.engine).dynamicSubManager.has("1")).toBe(false); // 确已退订
		// stillSubscribed 守卫:已退订 → 不得再 broadcast。
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		// 时间线回写守卫:不得把已删 UID 的时间线“复活”成孤儿锚点。
		expect(priv(b.engine).dynamicTimelineManager.has("1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// C. 生命周期(cron mock)
// ---------------------------------------------------------------------------

describe("DynamicEngine — reconcileJob 尊重风控退避", () => {
	it("-352 退避窗口内 applyOps → 不提前重启 cron(退避不被击穿)", async () => {
		const before = cronMock.instances.length;
		const b = makeEngine({ subs: { "1": { uid: "1", uname: "UP", post: true } } });
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
		b.engine.applyOps([
			{ kind: "add", sub: { uid: "2", uname: "UP2", post: true } as SubItemView },
		]);

		expect(cronMock.instances.length).toBe(afterStart); // 没有新建 cron
	});
});

describe("DynamicEngine — 生命周期 / cron 重启", () => {
	it("start() 有订阅快照 → 建并启动 cron;stop() → 停止", () => {
		const subs = { "1": { uid: "1", uname: "UP", post: true } };
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
		const push = {
			broadcastDynamic: vi.fn(async () => {}),
			sendPrivateMsg: vi.fn(async () => {}),
			sendErrorMsg: vi.fn(async () => {}),
		} as unknown as PushLike;
		const engine = new DynamicEngine({
			avatarOf: () => undefined,
			serviceCtx: ctx,
			bus,
			api,
			push,
			imageFetcher: { fetchImage: vi.fn() },
			config: {
				dynamicCron: "*/2 * * * *",
				dynamicVideoUrlToBV: false,
				imageGroup: { enable: false, forward: false },
				filter: DEFAULT_CONTENT_FILTERS,
			},
			getSubs: () => snap,
		});
		engine.start();
		expect(cronMock.instances).toHaveLength(0);

		snap = viewsOf({ "1": { uid: "1", uname: "UP", post: true } });
		trigger("auth-restored");
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.isActive).toBe(true);
	});

	it("updateConfig 改 dynamicCron(运行中)→ 旧 job 停,新 job 用新 cronTime", () => {
		const subs = { "1": { uid: "1", uname: "UP", post: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		expect(cronMock.instances).toHaveLength(1);

		b.engine.updateConfig({
			dynamicCron: "*/5 * * * *",
			dynamicVideoUrlToBV: false,
			imageGroup: { enable: false, forward: false },
			filter: DEFAULT_CONTENT_FILTERS,
		});
		expect(cronMock.instances[0]?.stopCount).toBe(1);
		expect(cronMock.instances).toHaveLength(2);
		expect(cronMock.instances[1]?.cronTime).toBe("*/5 * * * *");
		expect(cronMock.instances[1]?.isActive).toBe(true);
	});

	it("updateConfig 同 cron → 不重建 job", () => {
		const subs = { "1": { uid: "1", uname: "UP", post: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		b.engine.updateConfig({
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: true, // 改了别的字段,但 cron 不变
			imageGroup: { enable: false, forward: false },
			filter: DEFAULT_CONTENT_FILTERS,
		});
		expect(cronMock.instances).toHaveLength(1);
	});

	it("applyOps:add dynamic 订阅 → 起 job;delete 最后一个 → 停 job", () => {
		const sub = viewOf({ uid: "1", uname: "UP", post: true });
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
		const subs = { "1": { uid: "1", uname: "UP", post: true } };
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
		const s1 = viewOf({ uid: "1", uname: "U1", post: true });
		const s2 = viewOf({ uid: "2", uname: "U2", post: true });
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
// D. 后置注入:setAi / setImage(adapter 在 ai / image 服务上下线时调用)
// ---------------------------------------------------------------------------

describe("DynamicEngine — setAi / setImage 后置注入", () => {
	const dyn = (): Dynamic =>
		({
			id_str: "d1",
			type: "DYNAMIC_TYPE_WORD",
			modules: {
				module_author: { mid: 1, name: "UP", pub_ts: 1000 },
				module_dynamic: {
					desc: {
						text: "新动态内容",
						rich_text_nodes: [{ text: "新动态内容", type: "RICH_TEXT_NODE_TYPE_TEXT" }],
					},
					major: undefined,
				},
			},
		}) as unknown as Dynamic;

	it("启动时 ai 字段为 undefined → setAi 注入后 detectDynamics 调用 ai.comment", async () => {
		const b = makeEngine({
			withAi: false,
			withImage: false,
			config: { aiEnabled: true },
		});
		seed(b.engine, "1", 500);
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicResponse);

		await detect(b.engine);
		// 没注入 ai → 不调 ai.comment
		expect(b.comment).not.toHaveBeenCalled();

		// 模拟 ai 服务后置 ready → setAi 注入
		const comment = vi.fn().mockResolvedValue("点评");
		const ai = { comment } as unknown as CommentaryGenerator;
		b.engine.setAi(ai);

		// 推下一条动态
		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(comment).toHaveBeenCalledTimes(1);
	});

	it("setAi(undefined) → 撤销后 detectDynamics 不再调 ai.comment", async () => {
		const comment = vi.fn().mockResolvedValue("点评");
		const ai = { comment } as unknown as CommentaryGenerator;
		const b = makeEngine({
			withAi: false,
			withImage: false,
			config: { aiEnabled: true },
		});
		seed(b.engine, "1", 500);
		b.engine.setAi(ai);
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(comment).toHaveBeenCalledTimes(1);

		b.engine.setAi(undefined);
		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(comment).toHaveBeenCalledTimes(1); // 没新增调用
	});

	it("启动时 image 字段为 undefined → setImage 注入后 detectDynamics 调用 generatePostCard", async () => {
		const b = makeEngine({
			withImage: false,
			withAi: false,
		});
		seed(b.engine, "1", 500);
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicResponse);

		await detect(b.engine);
		expect(b.generatePostCard).not.toHaveBeenCalled();

		const generatePostCard = vi.fn().mockResolvedValue(Buffer.from("png"));
		const image = { generatePostCard } as unknown as ImageRenderer;
		b.engine.setImage(image);

		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(generatePostCard).toHaveBeenCalledTimes(1);
	});

	it("setAi 多次替换 → 下次 detect 用最新引用(reload ai plugin 场景)", async () => {
		const oldComment = vi.fn().mockResolvedValue("旧点评");
		const newComment = vi.fn().mockResolvedValue("新点评");
		const oldAi = { comment: oldComment } as unknown as CommentaryGenerator;
		const newAi = { comment: newComment } as unknown as CommentaryGenerator;
		const b = makeEngine({
			withAi: false,
			withImage: false,
			config: { aiEnabled: true },
		});
		seed(b.engine, "1", 500);
		b.engine.setAi(oldAi);
		b.engine.setAi(newAi); // 第二次替换 = ai plugin reload

		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(oldComment).not.toHaveBeenCalled();
		expect(newComment).toHaveBeenCalledTimes(1);
	});

	it("setImage(undefined) → 撤销后 detectDynamics 不再调 generatePostCard", async () => {
		const generatePostCard = vi.fn().mockResolvedValue(Buffer.from("png"));
		const image = { generatePostCard } as unknown as ImageRenderer;
		const b = makeEngine({
			withImage: false,
			withAi: false,
		});
		seed(b.engine, "1", 500);
		b.engine.setImage(image);
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(generatePostCard).toHaveBeenCalledTimes(1);

		b.engine.setImage(undefined);
		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.fetchAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicResponse);
		await detect(b.engine);
		expect(generatePostCard).toHaveBeenCalledTimes(1);
	});
});

// 从前这里有一整块「动态卡背景轮换」(`pickDynamicColorOptions` + 注入的选择器 + 全局
// 默认图廊兜底)。整条 `cardStyle.backgroundImages` 链 2026-09-20 删掉(背景图归皮肤的
// `image` 旋钮),剩下那道 enable 闸归 `card-style.test.ts`。

// ---------------------------------------------------------------------------
// H. 消息版式(messageLayout)— 发送侧结构自定义
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — 消息版式(messageLayout)", () => {
	type Seg = { kind: string; text?: string };
	const layoutOf = (
		blocks: Array<{ type: string; visible?: boolean; id?: string }>,
		separator = "\n",
	): NonNullable<SubItemView["messageLayout"]> => ({
		blocks: blocks.map((x) => ({ id: x.id ?? x.type, type: x.type, visible: x.visible ?? true })),
		separator,
	});
	const seedLayout = (
		b: EngineBag,
		layout: SubItemView["messageLayout"],
		extra?: Partial<SubItemView>,
	): void => {
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", messageLayout: layout, ...extra });
	};
	const URL1 = "https://t.bilibili.com/id-1";

	it("默认版式(card,text,link 合并一条):模板按 url='' 渲染,链接独立成段,同条内换行连接", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]));
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.kind)).toEqual(["image", "text"]);
		// 默认模板 "{name}发布了一条动态" → "UP发布了一条动态",链接作为独立部件在同条内以
		// 分隔符(\n)连接。
		expect(segments[1]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});

	it("分条符切两条 → 走 broadcastDynamicSequence,不再走单条 broadcastDynamic", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(
			b,
			layoutOf([
				{ type: "card" },
				{ type: "split", id: "split-1" },
				{ type: "text" },
				{ type: "link" },
			]),
		);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(b.push.broadcastDynamicSequence).toHaveBeenCalledTimes(1);
		const [uid, messages, part, opts] = b.push.broadcastDynamicSequence.mock.calls[0] as [
			string,
			Seg[][],
			string,
			{ pushId?: string } | undefined,
		];
		expect(uid).toBe("1");
		expect(part).toBe("post");
		expect(opts?.pushId).toMatch(/^[0-9a-f-]{36}$/);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.map((s) => s.kind)).toEqual(["image"]);
		expect(messages[1]?.map((s) => s.kind)).toEqual(["text"]);
		expect(messages[1]?.[0]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});

	it("隐藏 card 块 → 直接跳过图片渲染(不浪费渲染)", async () => {
		const b = makeEngine({ withImage: true });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card", visible: false }, { type: "text" }, { type: "link" }]));
		await detect(b.engine);
		expect(b.generatePostCard).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.kind)).toEqual(["text"]);
	});

	it("隐藏 text 块 → 跳过 AI 调用(省 token),消息里无文本部件", async () => {
		const b = makeEngine({ withImage: true, withAi: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, text: "有可提取文本" })]),
		);
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text", visible: false }, { type: "link" }]));
		await detect(b.engine);
		expect(b.comment).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.kind)).toEqual(["image", "text"]);
		expect(segments[1]?.text).toBe(URL1);
	});

	it("全部块隐藏 → 本条不推送,但锚点照常推进(下轮不重推)", async () => {
		const b = makeEngine({ withImage: true });
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(
			b,
			layoutOf([
				{ type: "card", visible: false },
				{ type: "text", visible: false },
				{ type: "link", visible: false },
			]),
		);
		await detect(b.engine);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(b.push.broadcastDynamicSequence).not.toHaveBeenCalled();
		expect(b.generatePostCard).not.toHaveBeenCalled();
	});

	// 刻画(ADR-0019 决策 67 把装配合成一份之前钉的现状):自定义连接符、隐藏的分条符
	// 不切组、卡片夹在文字中间时前后两段文字各自成段、卡片段带 image/jpeg。
	it("自定义连接符连相邻文字;隐藏的分条符不切组", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockResolvedValue(Buffer.from("png"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(
			b,
			layoutOf(
				[
					{ type: "link" },
					{ type: "split", id: "split-1", visible: false },
					{ type: "text" },
					{ type: "card" },
				],
				" | ",
			),
		);
		await detect(b.engine);
		expect(b.push.broadcastDynamicSequence).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.kind)).toEqual(["text", "image"]);
		expect(segments[0]?.text).toBe(`${URL1} | UP发布了一条动态`);
	});

	it("卡片夹在文字中间 → 前后两段文字各自成段,卡片段是 image/jpeg", async () => {
		const b = makeEngine({ withImage: true });
		const png = Buffer.from("png");
		b.generatePostCard.mockResolvedValue(png);
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "text" }, { type: "card" }, { type: "link" }]));
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<
			Seg & { buffer?: Buffer; mime?: string }
		>;
		expect(segments.map((s) => s.kind)).toEqual(["text", "image", "text"]);
		expect(segments[0]?.text).toBe("UP发布了一条动态");
		expect(segments[1]).toMatchObject({ buffer: png, mime: "image/jpeg" });
		expect(segments[2]?.text).toBe(URL1);
	});

	it("渲染失败 → card 部件缺席,其余部件照发(软降级不变)", async () => {
		const b = makeEngine({ withImage: true });
		b.generatePostCard.mockRejectedValue(new Error("boom"));
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]));
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.kind)).toEqual(["text"]);
		expect(segments[0]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// H. dynamic-detected —— 数据统计的动态/投稿数据源
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — dynamic-detected 事件", () => {
	const detected = (b: EngineBag) => b.emits.filter((e) => e.event === "dynamic-detected");

	it("新动态过闸 → emit 一次,携带 uid / id / 原始 type / ISO 发布时间", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, type: "DYNAMIC_TYPE_AV" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(detected(b)).toHaveLength(1);
		expect(detected(b)[0]?.payload).toEqual({
			uid: "1",
			id: "id-1",
			type: "DYNAMIC_TYPE_AV",
			ts: new Date(1000 * 1000).toISOString(),
		});
	});

	it("timeline >= pub_ts(已处理过)→ 不重复 emit,避免统计重复计数", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 1000);
		await detect(b.engine);
		expect(detected(b)).toHaveLength(0);
	});

	it("未订阅 uid → 不 emit", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 99, pubTs: 1000 })]));
		await detect(b.engine);
		expect(detected(b)).toHaveLength(0);
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
			[uid]: { uid, uname: "UP", post: false },
			other: { uid: "other", uname: "别人", post: true },
		} as never);
	};
	/** 建表之后才发布 —— 锚点初值是「此刻」,拿旧时间戳的动态一律算已看过。 */
	const laterThanSeed = () => Math.floor(Date.now() / 1000) + 60;

	it("per-UP 动态推送关掉 → 仍然 emit,只是不推送", async () => {
		// 契约(platform.ts)明写:「被过滤器屏蔽、被 per-UP 开关关掉、投递失败的动态
		// 一律照常 emit」。此前锚点表只登记推送开着的 UP,关掉开关的在 `timeline ===
		// undefined` 处就 continue 了 —— 而 overview 仍会为这位 UP 出一行,且粉丝轮询
		// 让 hasCoverage 为真,于是投稿/动态给出的是**笃定的 0** 而不是「无记录」。
		// 一位窗口内投了 40 个视频的 UP 在表里显示 0,AI 锐评还据此给他加冕鸽王。
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: laterThanSeed() })]));
		seedStatsOnly(b, "1");
		await detect(b.engine);
		expect(detected(b)).toHaveLength(1);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("推送关掉的 UP 锚点照常推进 —— 否则每轮把同一条重新 emit 一遍", async () => {
		const b = makeEngine();
		b.fetchAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: laterThanSeed() })]));
		seedStatsOnly(b, "1");
		await detect(b.engine);
		await detect(b.engine);
		expect(detected(b)).toHaveLength(1);
	});

	it("真退订则连锚点一起清掉,不留孤儿抑制再订阅后的动态", async () => {
		const b = makeEngine();
		seedStatsOnly(b, "1");
		expect(priv(b.engine).dynamicTimelineManager.has("1")).toBe(true);
		b.engine.applyOps([{ kind: "delete", uid: "1" }]);
		expect(priv(b.engine).dynamicTimelineManager.has("1")).toBe(false);
	});

	it("被过滤器屏蔽 → 仍然 emit —— 统计的是 UP 的产出,不是推送次数", async () => {
		const b = makeEngine({
			config: {
				filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["禁词"], notify: false },
			},
		});
		b.fetchAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, text: "含禁词的动态" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(detected(b)).toHaveLength(1);
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

describe("联网搜索 override(aiWebSearch)", () => {
	/**
	 * 引擎自己不碰搜索 —— 它只负责把 per-engine 开关翻成这一次 comment() 的
	 * override.webSearch。执行器在不在、要不要真挂工具,是生成器的事。
	 */
	const oneDyn = () => {
		return resp([makeItem({ uid: 1, pubTs: 1000, text: "原始内容" })]);
	};

	it("aiWebSearch 开着 → comment 的 override 带 webSearch:true", async () => {
		const b = makeEngine({ withAi: true, config: { aiEnabled: true, aiWebSearch: true } });
		b.comment.mockResolvedValue("点评");
		b.fetchAllDynamic.mockResolvedValue(oneDyn());
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.comment).toHaveBeenCalledWith(
			expect.any(String),
			"dynamic",
			expect.anything(),
			expect.objectContaining({ webSearch: true }),
		);
	});

	it("没开 aiWebSearch → override 不带 webSearch(现状不变)", async () => {
		const b = makeEngine({ withAi: true, config: { aiEnabled: true } });
		b.comment.mockResolvedValue("点评");
		b.fetchAllDynamic.mockResolvedValue(oneDyn());
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const override = b.comment.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
		expect(override?.webSearch).toBeUndefined();
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
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
	});

	it("cron tick 撞上在跑的一轮就跳过;detectNow 撞上则排在后面再跑一轮", async () => {
		const b = makeEngine({ subs: { "1": { uid: "1", uname: "UP", post: true } } });
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
		const b = makeEngine({ subs: { "1": { uid: "1", uname: "UP", post: true } } });
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
