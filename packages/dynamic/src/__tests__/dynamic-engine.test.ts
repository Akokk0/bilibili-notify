/**
 * 单元测试 — `DynamicEngine` 编排 + 图片失败软降级状态机 + 生命周期。
 *
 * 已有 `dynamic-filter.test.ts` 覆盖纯过滤函数;本文件覆盖把过滤/渲染/AI/推送
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
import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DynamicEngine, type DynamicEngine as DynamicEngineType } from "../dynamic-engine";
import type { PushLike, SubItemView, SubscriptionsView } from "../push-like";
import type { AllDynamicInfo, Dynamic } from "../types";

// ---------------------------------------------------------------------------
// cron mock — 惰性 FakeCronJob,不真正排程
// ---------------------------------------------------------------------------

const cronMock = vi.hoisted(() => {
	const instances: Array<{
		cronTime: string;
		onTick: () => void;
		running: boolean;
		startCount: number;
		stopCount: number;
	}> = [];
	class FakeCronJob {
		running = false;
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
			this.running = true;
			this.startCount++;
		}
		stop(): void {
			this.running = false;
			this.stopCount++;
		}
	}
	return { instances, FakeCronJob };
});

vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface Priv {
	dynamicSubManager: Map<string, SubItemView>;
	dynamicTimelineManager: Map<string, number>;
	detectDynamics(): Promise<void>;
	imageFailureStreak: number;
	imageFailureNotified: boolean;
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
	};
	return { ctx, disposers, logs };
}

function makeBus(): {
	bus: MessageBus;
	emits: Array<{ event: string; args: unknown[] }>;
	trigger: (event: string, ...args: unknown[]) => void;
} {
	const emits: Array<{ event: string; args: unknown[] }> = [];
	const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
	const bus = {
		emit: (event: string, ...args: unknown[]) => {
			emits.push({ event, args });
		},
		on: (event: string, handler: (...a: unknown[]) => void) => {
			const arr = handlers.get(event) ?? [];
			arr.push(handler);
			handlers.set(event, arr);
			return { dispose: () => {} };
		},
	} as unknown as MessageBus;
	return {
		bus,
		emits,
		trigger: (event, ...a) => {
			for (const h of handlers.get(event) ?? []) h(...a);
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
	/** 视频动态(DYNAMIC_TYPE_AV)的 major.archive.jump_url;引擎按此算 {url}/BV。 */
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

function resp(items: Dynamic[], code = 0, message = "ok"): AllDynamicInfo {
	return {
		code,
		message,
		data: { has_more: false, items, offset: "", update_baseline: "", update_num: items.length },
	};
}

interface EngineBag {
	engine: DynamicEngineType;
	getAllDynamic: ReturnType<typeof vi.fn>;
	push: PushLike & {
		broadcastDynamic: ReturnType<typeof vi.fn>;
		broadcastDynamicSequence: ReturnType<typeof vi.fn>;
		sendPrivateMsg: ReturnType<typeof vi.fn>;
		sendErrorMsg: ReturnType<typeof vi.fn>;
	};
	emits: Array<{ event: string; args: unknown[] }>;
	trigger: (event: string, ...args: unknown[]) => void;
	disposers: Array<() => void | Promise<void>>;
	generateDynamicCard: ReturnType<typeof vi.fn>;
	comment: ReturnType<typeof vi.fn>;
	logs: LogRec[];
}

function makeEngine(
	over: {
		config?: Partial<import("../dynamic-engine").DynamicEngineConfig>;
		withImage?: boolean;
		withAi?: boolean;
		subs?: SubscriptionsView | null;
		pickCardBackground?: import("../push-like").PickCardBackground;
	} = {},
): EngineBag {
	const { ctx, logs } = makeServiceCtx();
	const { bus, emits, trigger } = makeBus();
	const disposers: Array<() => void | Promise<void>> = [];
	(ctx as { onDispose: (fn: () => void) => void }).onDispose = (fn) => {
		disposers.push(fn);
	};
	const getAllDynamic = vi.fn();
	const api = { getAllDynamic } as unknown as BilibiliAPI;
	const push = {
		broadcastDynamic: vi.fn(async () => {}),
		broadcastDynamicSequence: vi.fn(async () => {}),
		sendPrivateMsg: vi.fn(async () => {}),
		sendErrorMsg: vi.fn(async () => {}),
	};
	const generateDynamicCard = vi.fn();
	const image = { generateDynamicCard } as unknown as ImageRenderer;
	const comment = vi.fn();
	const ai = { comment } as unknown as CommentaryGenerator;
	const engine = new DynamicEngine({
		serviceCtx: ctx,
		bus,
		api,
		push: push as unknown as PushLike,
		image: over.withImage ? image : undefined,
		ai: over.withAi ? ai : undefined,
		config: {
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: false,
			imageGroup: { enable: false, forward: false },
			filter: { enable: false },
			...over.config,
		},
		getSubs: () => over.subs ?? null,
		pickCardBackground: over.pickCardBackground,
	});
	return {
		engine,
		getAllDynamic,
		push: push as EngineBag["push"],
		emits,
		trigger,
		disposers,
		generateDynamicCard,
		comment,
		logs,
	};
}

/** seed 一个已订阅 uid(timeline + subManager),供 detectDynamics 白盒直调。 */
function seed(engine: DynamicEngineType, uid: string, timeline: number, sub?: SubItemView): void {
	priv(engine).dynamicTimelineManager.set(uid, timeline);
	priv(engine).dynamicSubManager.set(uid, sub ?? { uid, uname: "UP" });
}

const detect = (engine: DynamicEngineType): Promise<void> => priv(engine).detectDynamics();

beforeEach(() => {
	cronMock.instances.length = 0;
});

// ---------------------------------------------------------------------------
// A. detectDynamics 编排
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — API 错误处理", () => {
	it("getAllDynamic 抛错 → 不广播,静默返回", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockRejectedValue(new Error("network down"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("code=-101(未登录)→ emit engine-error「账号未登录」,不广播", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(b.emits).toContainEqual(
			expect.objectContaining({
				event: "engine-error",
				args: expect.arrayContaining(["账号未登录"]),
			}),
		);
	});

	it("code=-352(风控)→ sendPrivateMsg + emit engine-error「账号被风控」", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(b.emits).toContainEqual(
			expect.objectContaining({
				event: "engine-error",
				args: expect.arrayContaining(["账号被风控"]),
			}),
		);
	});

	it("-352 风控边沿:连续触发只告警一次,恢复后再触发重新告警(Q7)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		const ecCount = () =>
			b.emits.filter(
				(e) =>
					e.event === "engine-error" &&
					(e.args as unknown[]).some((a) => String(a).includes("账号被风控")),
			).length;

		b.getAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 进入风控
		await detect(b.engine); // 仍风控 → 抑制
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(ecCount()).toBe(1);
		expect(b.logs.filter((l) => l.level === "error" && l.msg.includes("账号被风控"))).toHaveLength(
			1,
		);
		expect(b.logs.some((l) => l.level === "debug" && l.msg.includes("仍处于风控态"))).toBe(true);

		b.getAllDynamic.mockResolvedValue(resp([])); // code 0 → 恢复
		await detect(b.engine);
		expect(b.logs.some((l) => l.level === "info" && l.msg.includes("风控已解除"))).toBe(true);

		b.getAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 再次风控 → 边沿复位后重新告警
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		expect(ecCount()).toBe(2);
	});

	it("-352 后跨 -101(auth-loss)再 -352:复位边沿,新风控必须重新告警(审计缺口回归)", async () => {
		const b = makeEngine();
		seed(b.engine, "1", 0);
		const riskEc = () =>
			b.emits.filter(
				(e) =>
					e.event === "engine-error" &&
					(e.args as unknown[]).some((a) => String(a).includes("账号被风控")),
			).length;

		b.getAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 风控 episode #1 → 告警 1
		expect(riskEc()).toBe(1);

		b.getAllDynamic.mockResolvedValue(resp([], -101, "not login"));
		await detect(b.engine); // auth-loss:独立 episode,复位风控边沿

		b.getAllDynamic.mockResolvedValue(resp([])); // 恢复(code 0)
		await detect(b.engine);

		b.getAllDynamic.mockResolvedValue(resp([], -352, "risk"));
		await detect(b.engine); // 风控 episode #2(跨过 -101)→ 必须重新告警
		expect(b.push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		expect(riskEc()).toBe(2);
	});
});

describe("DynamicEngine.detectDynamics — 时间线 / 订阅过滤", () => {
	it("timeline >= pub_ts → 已推过,跳过不广播", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 1000); // timeline == pub_ts
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("未订阅 uid(无 timeline 条目)→ 跳过", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 999, pubTs: 1000 })]));
		seed(b.engine, "1", 0); // 订阅的是 1,动态来自 999
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("pub_ts 非数字 → 跳过该条,不广播", async () => {
		const b = makeEngine();
		const bad = makeItem({ uid: 1 });
		(bad.modules.module_author as { pub_ts: unknown }).pub_ts = "oops";
		b.getAllDynamic.mockResolvedValue(resp([bad]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("未订阅 uid 的无效 pub_ts → 静默跳过,不刷 warn", async () => {
		const b = makeEngine();
		const bad = makeItem({ uid: 999 });
		(bad.modules.module_author as { pub_ts: unknown }).pub_ts = "oops";
		b.getAllDynamic.mockResolvedValue(resp([bad]));
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
		b.getAllDynamic.mockResolvedValue(resp([item]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1234);
	});

	it("pub_ts 为毫秒时间戳字符串 → 归一化为秒后推送", async () => {
		const b = makeEngine();
		const item = makeItem({ uid: 1 });
		(item.modules.module_author as { pub_ts: unknown }).pub_ts = "1717067523000";
		b.getAllDynamic.mockResolvedValue(resp([item]));
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
		b.getAllDynamic.mockResolvedValue(resp([item]));
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
			b.getAllDynamic.mockResolvedValue(resp([item]));
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
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1234 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1234);
	});

	it("DY1:同 uid 多条全部成功 → 锚点推进到最大 pub_ts", async () => {
		const b = makeEngine();
		// 新→旧
		b.getAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 200 }), makeItem({ uid: 1, pubTs: 100 })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(200);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(2);
	});

	it("DY1:某 uid 推送失败 → 不 abort 其它 uid,失败 uid 锚点不前移(下轮重试)", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(
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
		expect(b.push.broadcastDynamic).toHaveBeenCalledWith("2", expect.anything(), expect.anything());
	});

	it("DY1:锚点单调,绝不回退(已 push 过的更新 pub_ts 不倒退)", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 100 })]));
		seed(b.engine, "1", 500); // 既有锚点已高于来项
		await detect(b.engine);
		// timeline(500) >= 100 → 跳过,锚点保持 500,绝不被 set 成 100。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(500);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});
});

describe("DynamicEngine.detectDynamics — 推送形态", () => {
	it("有 image 实例 + 无 AI → 广播 [image] 段,kind=dynamic", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const [uid, segments, kind] = b.push.broadcastDynamic.mock.calls[0] as [
			string,
			Array<{ type: string }>,
			string,
		];
		expect(uid).toBe("1");
		expect(kind).toBe("dynamic");
		expect(segments[0]?.type).toBe("image");
	});

	it("有 image + 有 AI → 段含 image + AI 点评文本", async () => {
		const b = makeEngine({ withImage: true, withAi: true });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.comment.mockResolvedValue("这条很有意思");
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, text: "原始内容" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{
			type: string;
			text?: string;
		}>;
		expect(segments.some((s) => s.type === "image")).toBe(true);
		expect(segments.some((s) => s.type === "text" && s.text === "这条很有意思")).toBe(true);
	});

	it("无 image 实例 → 纯文字段降级", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ type: string }>;
		expect(segments).toHaveLength(1);
		expect(segments[0]?.type).toBe("text");
	});

	it("imageEnabled=false → 即使注入了 image 也跳过渲染,纯文字", async () => {
		const b = makeEngine({ withImage: true, config: { imageEnabled: false } });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(b.generateDynamicCard).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ type: string }>;
		expect(segments[0]?.type).toBe("text");
	});

	it("imageGroup.enable + DYNAMIC_TYPE_DRAW 带 pics → 追加 dynamic-images 广播", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect(b.push.broadcastDynamic.mock.calls[1]?.[2]).toBe("dynamic-images");
	});

	it("图组发送失败 → 主卡已发出,锚点仍推进(不因附属图组失败而重发主卡 + 重复 @全体)", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		// 主卡(第 1 次,kind='dynamic')成功;图组(第 2 次,kind='dynamic-images')失败。
		// 图组走 forward/NapCat 长消息通道,现实里会 reject(config 注释点名其不稳定)。
		b.push.broadcastDynamic.mockImplementation(
			async (_uid: string, _segs: unknown, kind: string) => {
				if (kind === "dynamic-images") throw new Error("图组通道抖动");
			},
		);
		await detect(b.engine);
		// 主卡已成功送达 → 锚点必须推进到 pub_ts,否则下轮整条重判、主卡以 kind='dynamic'
		// 重发,而 dynamic 不抑制 @全体 → 每 tick 重复 @全体,直到动态滚出 feed。
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1000);
	});

	it("P2-A:DRAW 图在 major.draw.items[].src → 不再静默丢图组(此前只读 opus.pics)", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect(call?.[2]).toBe("dynamic-images");
		expect(call?.[1]?.[0]).toMatchObject({
			type: "image-group",
			images: [{ url: "http://a/x1.jpg" }, { url: "http://a/x2.jpg" }],
		});
	});

	it("图集 image-group 透传 B站原始尺寸(QQ 原生 markdown 多图需 width/height)", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect((call?.[1]?.[0] as { images: unknown[] }).images).toEqual([
			{ url: "http://a/1.jpg", width: 800, height: 600 },
		]);
	});

	it("imageGroupForward 默认 false → image-group segment 的 forward 为 false", async () => {
		// 默认不走合并转发,避开 NapCat SsoSendLongMsg 长消息通道。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect((call?.[1]?.[0] as { forward: boolean }).forward).toBe(false);
	});

	it("imageGroupForward=true + 多张图 → image-group segment 的 forward 为 true", async () => {
		// 主动开启 + 多张图时 segment 携带 forward:true,下游 adapter 走合并转发路径。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: true } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect((call?.[1]?.[0] as { forward: boolean }).forward).toBe(true);
	});

	it("imageGroupForward=true 但只有 1 张图 → forward 强制 false(单图合并转发无意义)", async () => {
		// 即使主动开启 imageGroupForward,单张图也不走 forward(聊天记录卡片包 1 张图无意义)。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: true } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect((call?.[1]?.[0] as { forward: boolean }).forward).toBe(false);
	});

	it("per-UP imageGroupEnable=false 覆盖全局 true → 不推图集", async () => {
		// 全局开 imageGroup.enable,但 sub 视图带 imageGroupEnable:false → 不发图集广播。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect(b.push.broadcastDynamic.mock.calls[0]?.[2]).toBe("dynamic");
	});

	it("per-UP imageGroupEnable=true 覆盖全局 false → 推图集", async () => {
		// 全局关 imageGroup.enable,但 sub 视图 imageGroupEnable:true → 发图集。
		const b = makeEngine({ config: { imageGroup: { enable: false, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect(b.push.broadcastDynamic.mock.calls[1]?.[2]).toBe("dynamic-images");
	});

	it("per-UP imageGroupEnable 缺省(undefined) → 继承全局 imageGroup.enable(回归守卫 `??` 非 `||`)", async () => {
		// 守护 dynamic-engine 用 `??` 折叠而非 `||`:undefined 走 fallback,但 false
		// 显式 per-UP 关闭不被吃。本用例钉「缺省=继承」一向。
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect(b.push.broadcastDynamic.mock.calls[1]?.[2]).toBe("dynamic-images");
	});

	it("per-UP imageGroupForward=true 覆盖全局 false → 多图走 forward", async () => {
		const b = makeEngine({ config: { imageGroup: { enable: true, forward: false } } });
		b.getAllDynamic.mockResolvedValue(
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
		expect((call?.[1]?.[0] as { forward: boolean }).forward).toBe(true);
	});
});

describe("DynamicEngine.detectDynamics — 动态文本模板 (Part A/B)", () => {
	type Seg = { type: string; text?: string };
	const textOf = (segments: Seg[]): string | undefined =>
		segments.find((s) => s.type === "text")?.text;
	const segsOf = (b: EngineBag): Seg[] => b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];

	it("无图 + 无 AI → 默认模板纯文案(链接不再进模板;{url} 仍恒计算供旧模板/版式用)", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("阿绫发布了一条动态");
	});

	it("旧路径下模板不写 {url} → 无链接(旧存档语义保持)", async () => {
		const b = makeEngine({ config: { dynamicTemplate: "{name}发布了一条动态" } });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("阿绫发布了一条动态");
	});

	it("视频转 BV 但 jump_url 无 BV → url 空,renderDynamicText 去掉尾随分隔符", async () => {
		const b = makeEngine({
			config: { dynamicVideoUrlToBV: true, videoTemplate: "{name}发布了新视频：{url}" },
		});
		b.getAllDynamic.mockResolvedValue(
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
		withImg.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		withImg.getAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]),
		);
		seed(withImg.engine, "1", 0);
		await detect(withImg.engine);
		const imgSegs = segsOf(withImg);
		expect(imgSegs[0]?.type).toBe("image");

		const noImg = makeEngine();
		noImg.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(noImg.engine, "1", 0);
		await detect(noImg.engine);
		expect(textOf(imgSegs)).toBe("阿绫发布了一条动态");
		expect(textOf(imgSegs)).toBe(textOf(segsOf(noImg)));
	});

	it("旧模板写 {url} → 单条链接(双前缀 bug 回归守护)", async () => {
		const b = makeEngine({ config: { dynamicTemplate: "{name}发布了一条动态：{url}" } });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("阿绫发布了一条动态：https://t.bilibili.com/id-1");
	});

	it("视频动态(DYNAMIC_TYPE_AV)走 videoTemplate + jump_url 链接(旧模板写 {url})", async () => {
		const b = makeEngine({ config: { videoTemplate: "{name}发布了新视频：{url}" } });
		b.getAllDynamic.mockResolvedValue(
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
		expect(textOf(segsOf(b))).toBe("阿绫发布了新视频：https://www.bilibili.com/video/BV1demo");
	});

	it("per-UP customDynamicTemplate 覆盖内建模板", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			customDynamicTemplate: "🔔 {name} 有新动态 {url}",
		});
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("🔔 阿绫 有新动态 https://t.bilibili.com/id-1");
	});

	it("全局 config.dynamicTemplate 覆盖内建兜底", async () => {
		const b = makeEngine({ config: { dynamicTemplate: "【动态】{name}" } });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫" })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("【动态】阿绫");
	});

	it("有 AI 点评时两分支都用点评,不走模板", async () => {
		const b = makeEngine({ withAi: true });
		b.comment.mockResolvedValue("这条很有意思");
		b.getAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, name: "阿绫", text: "原始内容" })]),
		);
		seed(b.engine, "1", 0);
		await detect(b.engine);
		expect(textOf(segsOf(b))).toBe("这条很有意思");
	});
});

describe("DynamicEngine.detectDynamics — 过滤 notify", () => {
	it("命中过滤 + notify=false → 不广播,但 timeline 仍推进", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1500, text: "含禁词" })]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { enable: true, keywords: ["禁词"], notify: false },
		});
		await detect(b.engine);
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
		expect(priv(b.engine).dynamicTimelineManager.get("1")).toBe(1500);
	});

	it("命中过滤 + notify=true → 广播屏蔽原因文案", async () => {
		const b = makeEngine();
		b.getAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, name: "阿伟", pubTs: 1500, text: "含禁词" })]),
		);
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			filter: { enable: true, keywords: ["禁词"], notify: true },
		});
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{
			type: string;
			text?: string;
		}>;
		expect(segments[0]?.text).toContain("阿伟");
	});
});

// ---------------------------------------------------------------------------
// B. 图片失败软降级状态机(最高优先级)
// ---------------------------------------------------------------------------

describe("DynamicEngine — 图片失败软降级状态机", () => {
	it("渲染失败一次 → streak=1,sendErrorMsg+emit 各一次,仍降级纯文字推送", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockRejectedValue(new Error("chrome crash"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);

		expect(priv(b.engine).imageFailureStreak).toBe(1);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);
		expect(b.emits.filter((e) => e.event === "engine-error")).toHaveLength(1);
		// 软降级:推送照常发生,只是退化为纯文字
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Array<{ type: string }>;
		expect(segments[0]?.type).toBe("text");
	});

	it("连续失败两轮 → sendErrorMsg / engine-error 全程仅一次(notified 守卫)", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockRejectedValue(new Error("chrome crash"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		// 第二轮:新动态(pub_ts 更大),仍失败
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 2000 })]));
		await detect(b.engine);

		expect(priv(b.engine).imageFailureStreak).toBe(2);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);
		expect(b.emits.filter((e) => e.event === "engine-error")).toHaveLength(1);
	});

	it("A3:首次失败的 sendErrorMsg reject → notified 不置位,下轮失败重试通知", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockRejectedValue(new Error("chrome crash"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);

		// 轮1:渲染失败 + 通知本身 reject。
		b.push.sendErrorMsg.mockRejectedValueOnce(new Error("push down"));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);
		// 关键不变量:通知没送达 → notified 必须仍 false(旧实现在 await 前置位
		// → reject 后永远 true,后续失败永久静默)。
		expect(priv(b.engine).imageFailureNotified).toBe(false);

		// 轮2:再失败,这次通知成功 → 因 notified 仍 false,重试并送达后才置位。
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 2000 })]));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(2);
		expect(priv(b.engine).imageFailureNotified).toBe(true);
	});

	it("特殊错误「直播开播动态，不做处理」→ continue,不计失败也不告警", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockRejectedValue(new Error("直播开播动态，不做处理"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);

		expect(priv(b.engine).imageFailureStreak).toBe(0);
		expect(b.push.sendErrorMsg).not.toHaveBeenCalled();
		expect(b.push.broadcastDynamic).not.toHaveBeenCalled();
	});

	it("失败 → 成功(复位)→ 再失败:能再次告警(sendErrorMsg 共两次)", async () => {
		const b = makeEngine({ withImage: true });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);

		// 轮1:失败 → 告警#1
		b.generateDynamicCard.mockRejectedValueOnce(new Error("crash"));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(1);

		// 轮2:成功 → streak/notified 复位
		b.generateDynamicCard.mockResolvedValueOnce(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 2000 })]));
		await detect(b.engine);
		expect(priv(b.engine).imageFailureStreak).toBe(0);
		expect(priv(b.engine).imageFailureNotified).toBe(false);

		// 轮3:再失败 → 告警#2(复位后恢复了告警能力)
		b.generateDynamicCard.mockRejectedValueOnce(new Error("crash again"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 3000 })]));
		await detect(b.engine);
		expect(b.push.sendErrorMsg).toHaveBeenCalledTimes(2);
	});
});

describe("DynamicEngine — applyOps 在 detectDynamics 跨 await 时退订(A7)", () => {
	it("渲染 await 期间 delete 该 UID → 不推送 + 不复活时间线", async () => {
		const b = makeEngine({ withImage: true });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		// 模拟交错:generateDynamicCard 解析前,adapter 收到 subscription-changed
		// 调 applyOps 退订 uid 1(stopDynamicForUid 删两张表)。
		b.generateDynamicCard.mockImplementation(async () => {
			b.engine.applyOps([{ type: "delete", uid: "1" }]);
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

describe("DynamicEngine — 生命周期 / cron 重启", () => {
	it("start() 有订阅快照 → 建并启动 cron;stop() → 停止", () => {
		const subs: SubscriptionsView = { "1": { uid: "1", uname: "UP", dynamic: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.running).toBe(true);
		expect(b.engine.isActive).toBe(true);

		b.engine.stop();
		expect(cronMock.instances[0]?.running).toBe(false);
		expect(b.engine.isActive).toBe(false);
	});

	it("start() 无快照 → 不建 cron;auth-restored 后用快照重建", () => {
		let snap: SubscriptionsView | null = null;
		const { ctx } = makeServiceCtx();
		const { bus, trigger } = makeBus();
		const api = { getAllDynamic: vi.fn() } as unknown as BilibiliAPI;
		const push = {
			broadcastDynamic: vi.fn(async () => {}),
			sendPrivateMsg: vi.fn(async () => {}),
			sendErrorMsg: vi.fn(async () => {}),
		} as unknown as PushLike;
		const engine = new DynamicEngine({
			serviceCtx: ctx,
			bus,
			api,
			push,
			config: {
				dynamicCron: "*/2 * * * *",
				dynamicVideoUrlToBV: false,
				imageGroup: { enable: false, forward: false },
				filter: { enable: false },
			},
			getSubs: () => snap,
		});
		engine.start();
		expect(cronMock.instances).toHaveLength(0);

		snap = { "1": { uid: "1", uname: "UP", dynamic: true } };
		trigger("auth-restored");
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.running).toBe(true);
	});

	it("updateConfig 改 dynamicCron(运行中)→ 旧 job 停,新 job 用新 cronTime", () => {
		const subs: SubscriptionsView = { "1": { uid: "1", uname: "UP", dynamic: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		expect(cronMock.instances).toHaveLength(1);

		b.engine.updateConfig({
			dynamicCron: "*/5 * * * *",
			dynamicVideoUrlToBV: false,
			imageGroup: { enable: false, forward: false },
			filter: { enable: false },
		});
		expect(cronMock.instances[0]?.stopCount).toBe(1);
		expect(cronMock.instances).toHaveLength(2);
		expect(cronMock.instances[1]?.cronTime).toBe("*/5 * * * *");
		expect(cronMock.instances[1]?.running).toBe(true);
	});

	it("updateConfig 同 cron → 不重建 job", () => {
		const subs: SubscriptionsView = { "1": { uid: "1", uname: "UP", dynamic: true } };
		const b = makeEngine({ subs });
		b.engine.start();
		b.engine.updateConfig({
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: true, // 改了别的字段,但 cron 不变
			imageGroup: { enable: false, forward: false },
			filter: { enable: false },
		});
		expect(cronMock.instances).toHaveLength(1);
	});

	it("applyOps:add dynamic 订阅 → 起 job;delete 最后一个 → 停 job", () => {
		const sub: SubItemView = { uid: "1", uname: "UP", dynamic: true };
		const b = makeEngine({ subs: { "1": sub } });
		b.engine.start(); // 快照里 sub.dynamic=true → 已有 running job
		expect(cronMock.instances[0]?.running).toBe(true);

		b.engine.applyOps([{ type: "delete", uid: "1" }]);
		expect(cronMock.instances[0]?.running).toBe(false);

		b.engine.applyOps([{ type: "add", sub }]);
		// 重新有订阅 → reconcile 重启(可能复用或新建 instance,断言最终处于 running)
		const last = cronMock.instances[cronMock.instances.length - 1];
		expect(last?.running).toBe(true);
	});

	it("回归:dynamicCron 无法解析(new CronJob 同步抛错)不炸穿 start(),记录 error 且不建 job(此前独立端会在启动期整进程崩溃,见 sidecar.stderr.log 的 CronError)", () => {
		const subs: SubscriptionsView = { "1": { uid: "1", uname: "UP", dynamic: true } };
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
		const s1: SubItemView = { uid: "1", uname: "U1", dynamic: true };
		const s2: SubItemView = { uid: "2", uname: "U2", dynamic: true };
		const b = makeEngine({ subs: { "1": s1, "2": s2 } });
		b.logs.length = 0;
		b.engine.applyOps([
			{ type: "add", sub: s1 },
			{ type: "add", sub: s2 },
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
					desc: { text: "新动态内容" },
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
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicInfo);

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
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicInfo);
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
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicInfo);
		await detect(b.engine);
		expect(comment).toHaveBeenCalledTimes(1);

		b.engine.setAi(undefined);
		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicInfo);
		await detect(b.engine);
		expect(comment).toHaveBeenCalledTimes(1); // 没新增调用
	});

	it("启动时 image 字段为 undefined → setImage 注入后 detectDynamics 调用 generateDynamicCard", async () => {
		const b = makeEngine({
			withImage: false,
			withAi: false,
		});
		seed(b.engine, "1", 500);
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicInfo);

		await detect(b.engine);
		expect(b.generateDynamicCard).not.toHaveBeenCalled();

		const generateDynamicCard = vi.fn().mockResolvedValue(Buffer.from("png"));
		const image = { generateDynamicCard } as unknown as ImageRenderer;
		b.engine.setImage(image);

		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicInfo);
		await detect(b.engine);
		expect(generateDynamicCard).toHaveBeenCalledTimes(1);
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

		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicInfo);
		await detect(b.engine);
		expect(oldComment).not.toHaveBeenCalled();
		expect(newComment).toHaveBeenCalledTimes(1);
	});

	it("setImage(undefined) → 撤销后 detectDynamics 不再调 generateDynamicCard", async () => {
		const generateDynamicCard = vi.fn().mockResolvedValue(Buffer.from("png"));
		const image = { generateDynamicCard } as unknown as ImageRenderer;
		const b = makeEngine({
			withImage: false,
			withAi: false,
		});
		seed(b.engine, "1", 500);
		b.engine.setImage(image);
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [dyn()] },
		} as unknown as AllDynamicInfo);
		await detect(b.engine);
		expect(generateDynamicCard).toHaveBeenCalledTimes(1);

		b.engine.setImage(undefined);
		const next = dyn();
		(next as { id_str: string }).id_str = "d2";
		(next.modules.module_author as { pub_ts: number }).pub_ts = 2000;
		b.getAllDynamic.mockResolvedValue({
			code: 0,
			data: { items: [next] },
		} as unknown as AllDynamicInfo);
		await detect(b.engine);
		expect(generateDynamicCard).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// 背景图轮换(每次推送轮换)
// ---------------------------------------------------------------------------

describe("DynamicEngine — 动态卡背景轮换", () => {
	it("customCardStyle 多图 → pickDynamicColorOptions 经注入选择器逐张轮换", () => {
		const cursors: Record<string, number> = {};
		const b = makeEngine({
			withImage: true,
			pickCardBackground: (key, images) => {
				const i = cursors[key] ?? 0;
				cursors[key] = i + 1;
				return images[i % images.length];
			},
		});
		const style = { enable: true, backgroundImages: ["a", "b", "c"] };
		const picks = [0, 1, 2, 3].map(
			() => priv(b.engine).pickDynamicColorOptions("u1", style)?.backgroundImage,
		);
		expect(picks).toEqual(["a", "b", "c", "a"]);
	});

	it("单图 → 不轮换,原样沿用 backgroundImage", () => {
		const b = makeEngine({ withImage: true, pickCardBackground: () => "ROTATED" });
		const style = { enable: true, backgroundImage: "solo", backgroundImages: ["solo"] };
		expect(priv(b.engine).pickDynamicColorOptions("u1", style)?.backgroundImage).toBe("solo");
	});

	it("enable=false / 缺省 → undefined(走渲染器全局兜底)", () => {
		const b = makeEngine({ withImage: true, pickCardBackground: () => "X" });
		expect(priv(b.engine).pickDynamicColorOptions("u1", { enable: false })).toBeUndefined();
		expect(priv(b.engine).pickDynamicColorOptions("u1", undefined)).toBeUndefined();
	});

	it("未注入选择器(koishi)+ 多图 → 不轮换,沿用 backgroundImage", () => {
		const b = makeEngine({ withImage: true });
		const style = { enable: true, backgroundImage: "first", backgroundImages: ["first", "second"] };
		expect(priv(b.engine).pickDynamicColorOptions("u1", style)?.backgroundImage).toBe("first");
	});

	it("回归:该 UP 无背景覆盖,但全局默认图廊配了多图 → 仍按 defaultBackgroundImages 轮换", () => {
		const cursors: Record<string, number> = {};
		const b = makeEngine({
			withImage: true,
			config: { defaultBackgroundImages: ["x", "y"] },
			pickCardBackground: (key, images) => {
				const i = cursors[key] ?? 0;
				cursors[key] = i + 1;
				return images[i % images.length];
			},
		});
		const picks = [0, 1].map(
			() => priv(b.engine).pickDynamicColorOptions("u1", { enable: false })?.backgroundImage,
		);
		expect(picks).toEqual(["x", "y"]);
		// 该 UP 自带背景(哪怕只设了一张)优先于全局默认,不落到 defaultBackgroundImages。
		expect(
			priv(b.engine).pickDynamicColorOptions("u1", {
				enable: true,
				backgroundImage: "own",
				backgroundImages: ["own"],
			})?.backgroundImage,
		).toBe("own");
	});
});

// ---------------------------------------------------------------------------
// H. 消息版式(messageLayout)— 发送侧结构自定义
// ---------------------------------------------------------------------------

describe("DynamicEngine.detectDynamics — 消息版式(messageLayout)", () => {
	type Seg = { type: string; text?: string };
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
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]));
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["image", "text"]);
		// 默认模板 "{name}发布了一条动态：{url}" 以 url='' 渲染 → "UP发布了一条动态",
		// 链接作为独立部件在同条内以分隔符(\n)连接。
		expect(segments[1]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});

	it("分条符切两条 → 走 broadcastDynamicSequence,不再走单条 broadcastDynamic", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
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
		const [uid, messages, kind] = b.push.broadcastDynamicSequence.mock.calls[0] as [
			string,
			Seg[][],
			string,
		];
		expect(uid).toBe("1");
		expect(kind).toBe("dynamic");
		expect(messages).toHaveLength(2);
		expect(messages[0]?.map((s) => s.type)).toEqual(["image"]);
		expect(messages[1]?.map((s) => s.type)).toEqual(["text"]);
		expect(messages[1]?.[0]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});

	it("隐藏 card 块 → 直接跳过图片渲染(不浪费渲染)", async () => {
		const b = makeEngine({ withImage: true });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card", visible: false }, { type: "text" }, { type: "link" }]));
		await detect(b.engine);
		expect(b.generateDynamicCard).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["text"]);
	});

	it("隐藏 text 块 → 跳过 AI 调用(省 token),消息里无文本部件", async () => {
		const b = makeEngine({ withImage: true, withAi: true });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(
			resp([makeItem({ uid: 1, pubTs: 1000, text: "有可提取文本" })]),
		);
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text", visible: false }, { type: "link" }]));
		await detect(b.engine);
		expect(b.comment).not.toHaveBeenCalled();
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["image", "text"]);
		expect(segments[1]?.text).toBe(URL1);
	});

	it("旧自定义模板仍写 {url} → 版式路径按 url='' 渲染,不出现双链接", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]), {
			customDynamicTemplate: "看看{name}：{url}",
		});
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments[1]?.text).toBe(`看看UP\n${URL1}`);
	});

	it("全部块隐藏 → 本条不推送,但锚点照常推进(下轮不重推)", async () => {
		const b = makeEngine({ withImage: true });
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
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
		expect(b.generateDynamicCard).not.toHaveBeenCalled();
	});

	it("adapter 不支持 sequence(防御兜底)→ 合并回一条 broadcastDynamic", async () => {
		const b = makeEngine({ withImage: true });
		(b.push as { broadcastDynamicSequence?: unknown }).broadcastDynamicSequence = undefined;
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card" }, { type: "split", id: "split-1" }, { type: "text" }]));
		await detect(b.engine);
		expect(b.push.broadcastDynamic).toHaveBeenCalledTimes(1);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["image", "text"]);
	});

	it("渲染失败 → card 部件缺席,其余部件照发(软降级不变)", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockRejectedValue(new Error("boom"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seedLayout(b, layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]));
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["text"]);
		expect(segments[0]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});

	it("两级都无 messageLayout(旧路径兜底)→ 模板 {url} 仍内嵌渲染(旧存档兼容)", async () => {
		const b = makeEngine({ withImage: true });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		// 旧存档自定义模板还写着 {url}:旧路径按真实 url 渲染,不剥离。
		seed(b.engine, "1", 0, { uid: "1", uname: "UP", customDynamicTemplate: "看看{name}：{url}" });
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["image", "text"]);
		expect(segments[1]?.text).toBe(`看看UP：${URL1}`);
	});
});

describe("DynamicEngine — config 级 messageLayout(koishi 端默认版式 + 链接开关)", () => {
	type Seg = { type: string; text?: string };
	const URL1 = "https://t.bilibili.com/id-1";
	const configLayout = (linkVisible: boolean) => ({
		blocks: [
			{ id: "card", type: "card", visible: true },
			{ id: "text", type: "text", visible: true },
			{ id: "link", type: "link", visible: linkVisible },
		],
		separator: "\n",
	});

	it("sub 无版式但 config 有 → 走版式路径(链接独立部件)", async () => {
		const b = makeEngine({ withImage: true, config: { messageLayout: configLayout(true) } });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["image", "text"]);
		expect(segments[1]?.text).toBe(`UP发布了一条动态\n${URL1}`);
	});

	it("config 版式 link 隐藏(koishi 开关关)→ 消息不含链接", async () => {
		const b = makeEngine({ withImage: true, config: { messageLayout: configLayout(false) } });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0);
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments[1]?.text).toBe("UP发布了一条动态");
	});

	it("sub 版式优先于 config 版式", async () => {
		const b = makeEngine({ withImage: true, config: { messageLayout: configLayout(true) } });
		b.generateDynamicCard.mockResolvedValue(Buffer.from("png"));
		b.getAllDynamic.mockResolvedValue(resp([makeItem({ uid: 1, pubTs: 1000 })]));
		seed(b.engine, "1", 0, {
			uid: "1",
			uname: "UP",
			messageLayout: {
				blocks: [{ id: "text", type: "text", visible: true }],
				separator: "\n",
			},
		});
		await detect(b.engine);
		const segments = b.push.broadcastDynamic.mock.calls[0]?.[1] as Seg[];
		expect(segments.map((s) => s.type)).toEqual(["text"]);
		expect(segments[0]?.text).toBe("UP发布了一条动态");
	});
});
