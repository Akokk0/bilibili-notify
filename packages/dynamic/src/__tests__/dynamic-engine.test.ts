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
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	/** 真 DYNAMIC_TYPE_DRAW 形态:图在 major.draw.items[].src(非 opus.pics)。 */
	drawItems?: string[];
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
					opts.drawPics || opts.drawItems
						? {
								...(opts.drawPics ? { opus: { pics: opts.drawPics.map((url) => ({ url })) } } : {}),
								...(opts.drawItems
									? { draw: { items: opts.drawItems.map((src) => ({ src })) } }
									: {}),
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
			dynamicUrl: false,
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: false,
			imageGroup: { enable: false, forward: false },
			filter: { enable: false },
			...over.config,
		},
		getSubs: () => over.subs ?? null,
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
			urls: ["http://a/x1.jpg", "http://a/x2.jpg"],
		});
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
				dynamicUrl: false,
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
			dynamicUrl: false,
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
			dynamicUrl: true, // 改了别的字段,但 cron 不变
			dynamicCron: "*/2 * * * *",
			dynamicVideoUrlToBV: false,
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
