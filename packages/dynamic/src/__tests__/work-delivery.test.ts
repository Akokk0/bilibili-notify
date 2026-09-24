/**
 * 单元测试 — **作品装配** `deliverWork`(ADR-0019 决策 66):B 站动态与拓展作品共用的那一段。
 *
 * 只经公开接口:给一份平台中立的作品 + 这条订阅折好的设置 + 假的发送 / 渲染器 / AI,看发出去了
 * 什么。B 站原始数据怎么翻成作品由 `dynamic-engine.test.ts` 钉(那边走完整的检测循环)。
 */

import type { ImageRenderer } from "@bilibili-notify/image";
import { defaultMessageKindLayout, type MessageKindLayout } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { PushSegment } from "../push-like";
import {
	type CardFailureTracker,
	createCardFailureTracker,
	type DeliverWorkArgs,
	deliverWork,
	type NeutralWork,
	type WorkSubscriptionSettings,
} from "../work-delivery";

type Seg = { type: string; text?: string; buffer?: Buffer; mime?: string };

const CARD = Buffer.from("card");
const LINK = "https://example.com/post/1";

function workOf(over: Partial<NeutralWork> = {}): NeutralWork & {
	renderCard: ReturnType<typeof vi.fn>;
} {
	return {
		renderCard: vi.fn(async () => CARD),
		link: LINK,
		name: "阿绫",
		isVideo: false,
		commentText: "",
		commentImages: [],
		postNoun: "作品",
		gallery: [],
		...over,
	} as NeutralWork & { renderCard: ReturnType<typeof vi.fn> };
}

const layoutOf = (blocks: Array<{ type: string; visible?: boolean }>): MessageKindLayout => ({
	blocks: blocks.map((b, i) => ({
		id: `${b.type}-${i}`,
		type: b.type,
		visible: b.visible ?? true,
	})),
	separator: "\n",
});

interface Harness {
	args: DeliverWorkArgs;
	broadcast: ReturnType<typeof vi.fn>;
	broadcastSequence: ReturnType<typeof vi.fn>;
	comment: ReturnType<typeof vi.fn>;
	sendErrorMsg: ReturnType<typeof vi.fn>;
	emitEngineError: ReturnType<typeof vi.fn>;
	logs: Array<{ level: string; msg: string }>;
	work: ReturnType<typeof workOf>;
}

function harness(
	over: {
		work?: Partial<NeutralWork>;
		settings?: Partial<WorkSubscriptionSettings>;
		config?: Partial<DeliverWorkArgs["config"]>;
		withImage?: boolean;
		withAi?: boolean;
		stillSubscribed?: () => boolean;
		cardFailures?: CardFailureTracker;
	} = {},
): Harness {
	const broadcast = vi.fn(async () => {});
	const broadcastSequence = vi.fn(async () => {});
	const comment = vi.fn(async () => "点评");
	const sendErrorMsg = vi.fn(async () => {});
	const emitEngineError = vi.fn();
	const logs: Harness["logs"] = [];
	const rec = (level: string) => (msg: unknown) => {
		logs.push({ level, msg: String(msg) });
	};
	const work = workOf(over.work);
	const args: DeliverWorkArgs = {
		work,
		settings: { messageLayout: defaultMessageKindLayout("dynamic"), ...over.settings },
		push: { broadcast, broadcastSequence },
		stillSubscribed: over.stillSubscribed ?? (() => true),
		config: { imageGroup: { enable: false, forward: false }, ...over.config },
		deps: {
			logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") },
			// 渲染器只是交给作品自己的 renderCard 的那个把手,装配不调它的方法。
			image: over.withImage === false ? undefined : ({} as ImageRenderer),
			ai: over.withAi ? { comment } : undefined,
			cardFailures: over.cardFailures ?? createCardFailureTracker(),
			sendErrorMsg,
			emitEngineError,
		},
		logLabel: "订阅=s1",
	};
	return {
		args,
		broadcast,
		broadcastSequence,
		comment,
		sendErrorMsg,
		emitEngineError,
		logs,
		work,
	};
}

const segsOf = (h: Harness, call = 0): Seg[] => h.broadcast.mock.calls[call]?.[0] as Seg[];

describe("deliverWork — 按版式装配", () => {
	it("默认版式:卡片 + 模板文字与链接同条,kind=dynamic,带 pushId", async () => {
		const h = harness();
		expect(await deliverWork(h.args)).toBe("delivered");
		expect(h.broadcast).toHaveBeenCalledTimes(1);
		const [segs, kind, opts] = h.broadcast.mock.calls[0] as [Seg[], string, { pushId?: string }];
		expect(kind).toBe("dynamic");
		expect(opts.pushId).toMatch(/^[0-9a-f-]{36}$/);
		expect(segs.map((s) => s.type)).toEqual(["image", "text"]);
		expect(segs[0]).toMatchObject({ buffer: CARD, mime: "image/jpeg" });
		expect(segs[1]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
	});

	it("分条符切两条 → 走序列发送", async () => {
		const h = harness({
			settings: {
				messageLayout: layoutOf([{ type: "card" }, { type: "split" }, { type: "text" }]),
			},
		});
		await deliverWork(h.args);
		expect(h.broadcast).not.toHaveBeenCalled();
		const [messages, kind] = h.broadcastSequence.mock.calls[0] as [Seg[][], string];
		expect(kind).toBe("dynamic");
		expect(messages.map((m) => m.map((s) => s.type))).toEqual([["image"], ["text"]]);
	});

	it("链接为空串 → 链接部件缺席", async () => {
		const h = harness({ withImage: false, work: { link: "" } });
		await deliverWork(h.args);
		expect(segsOf(h)).toEqual([{ type: "text", text: "阿绫发布了一条动态" }]);
	});

	it("全部块藏起来 → 一条都不发,仍算走完", async () => {
		const h = harness({
			withAi: true,
			work: { commentText: "正文" },
			settings: {
				messageLayout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text", visible: false },
					{ type: "link", visible: false },
				]),
			},
		});
		expect(await deliverWork(h.args)).toBe("delivered");
		expect(h.broadcast).not.toHaveBeenCalled();
		expect(h.broadcastSequence).not.toHaveBeenCalled();
		expect(h.work.renderCard).not.toHaveBeenCalled();
		expect(h.comment).not.toHaveBeenCalled();
	});
});

describe("deliverWork — 出卡", () => {
	it("作品自己出卡:拿到渲染器与这条订阅的样式 + 皮肤", async () => {
		const h = harness({
			settings: { customCardStyle: { enable: true, font: "霞鹜文楷" }, cardSkin: "skin-1" },
		});
		await deliverWork(h.args);
		expect(h.work.renderCard).toHaveBeenCalledWith(h.args.deps.image, {
			enable: true,
			font: "霞鹜文楷",
			cardSkin: "skin-1",
		});
	});

	it("样式覆盖没启用 → 只带皮肤(吃渲染器的全局样式)", async () => {
		const h = harness({ settings: { customCardStyle: { enable: false, font: "x" } } });
		await deliverWork(h.args);
		expect(h.work.renderCard.mock.calls[0]?.[1]).toEqual({ cardSkin: undefined });
	});

	// per-UP 旋钮覆盖(ADR-0014 决策 17 的 🔗)跟皮肤 id 同路,与样式启没启用无关。B 站动态与
	// 拓展作品都经这里出卡。验红:把 work-delivery.ts 里递 `cardSkinKnobs` 那一句删掉,这条红。
	it("这条订阅的旋钮覆盖随皮肤一起交给出卡(样式没启用也带着)", async () => {
		const cardSkinKnobs = { "skin-1": { accent: "#aaaaaa" } };
		const h = harness({
			settings: { customCardStyle: { enable: false }, cardSkin: "skin-1", cardSkinKnobs },
		});
		await deliverWork(h.args);
		expect(h.work.renderCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "skin-1", cardSkinKnobs });
	});

	it("关了出图 / 没有渲染器 / 版式藏起卡片 → 不出卡,纯文字", async () => {
		const cases = [
			harness({ config: { imageEnabled: false } }),
			harness({ withImage: false }),
			harness({
				settings: { messageLayout: layoutOf([{ type: "card", visible: false }, { type: "text" }]) },
			}),
		];
		for (const h of cases) {
			await deliverWork(h.args);
			expect(h.work.renderCard).not.toHaveBeenCalled();
			expect(segsOf(h).map((s) => s.type)).toEqual(["text"]);
		}
	});

	it("出卡失败 → 降级纯文字照发", async () => {
		const h = harness({
			work: { renderCard: vi.fn(async () => Promise.reject(new Error("boom"))) },
		});
		expect(await deliverWork(h.args)).toBe("delivered");
		expect(segsOf(h)).toEqual([{ type: "text", text: `阿绫发布了一条动态\n${LINK}` }]);
	});
});

describe("deliverWork — 出图连续失败只提醒一次", () => {
	const failing = () => vi.fn(async () => Promise.reject(new Error("chrome crash")));

	it("头一次失败:私聊一句 + 点亮告警,计数 1;同一串再失败不再提醒", async () => {
		const tracker = createCardFailureTracker();
		const h = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		await deliverWork(h.args);
		expect(tracker.streak).toBe(1);
		expect(h.sendErrorMsg).toHaveBeenCalledWith(
			"生成动态图片失败：chrome crash，已降级为纯文字推送，请检查图片插件状态",
		);
		expect(h.emitEngineError).toHaveBeenCalledWith("生成动态图片失败：chrome crash");

		await deliverWork(h.args);
		expect(tracker.streak).toBe(2);
		expect(h.sendErrorMsg).toHaveBeenCalledTimes(1);
		expect(h.emitEngineError).toHaveBeenCalledTimes(1);
	});

	it("两条路共用一份计数:一条路提醒过,另一条路同一串失败不再提醒", async () => {
		const tracker = createCardFailureTracker();
		const bili = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		const ext = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		await deliverWork(bili.args);
		await deliverWork(ext.args);
		expect(tracker.streak).toBe(2);
		expect(bili.sendErrorMsg).toHaveBeenCalledTimes(1);
		expect(ext.sendErrorMsg).not.toHaveBeenCalled();
	});

	it("并发的几条失败只提醒一次:提醒还在路上时,别的失败不再各发一遍", async () => {
		const tracker = createCardFailureTracker();
		const a = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		const b = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		await Promise.all([deliverWork(a.args), deliverWork(b.args)]);
		expect(tracker.streak).toBe(2);
		expect(a.sendErrorMsg.mock.calls.length + b.sendErrorMsg.mock.calls.length).toBe(1);
		expect(tracker.notified).toBe(true);
	});

	it("提醒还在路上时出图恢复了:晚到的送达不算到下一串头上", async () => {
		const tracker = createCardFailureTracker();
		const bad = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		let release!: () => void;
		bad.sendErrorMsg.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const pending = deliverWork(bad.args);
		await vi.waitFor(() => expect(bad.sendErrorMsg).toHaveBeenCalled());
		await deliverWork(harness({ cardFailures: tracker }).args);
		release();
		await pending;
		expect(tracker.notified).toBe(false);
		const badAgain = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		await deliverWork(badAgain.args);
		expect(badAgain.sendErrorMsg).toHaveBeenCalledTimes(1);
	});

	it("提醒没送达 → 不算提醒过,下一次失败再提醒", async () => {
		const tracker = createCardFailureTracker();
		const h = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		h.sendErrorMsg.mockRejectedValueOnce(new Error("push down"));
		await deliverWork(h.args);
		expect(tracker.notified).toBe(false);
		expect(h.emitEngineError).not.toHaveBeenCalled();
		await deliverWork(h.args);
		expect(h.sendErrorMsg).toHaveBeenCalledTimes(2);
		expect(tracker.notified).toBe(true);
	});

	it("出卡恢复 → 复位并记一句恢复;之后再失败能再提醒", async () => {
		const tracker = createCardFailureTracker();
		const bad = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		await deliverWork(bad.args);
		const good = harness({ cardFailures: tracker });
		await deliverWork(good.args);
		expect(tracker.streak).toBe(0);
		expect(tracker.notified).toBe(false);
		expect(good.logs.some((l) => l.level === "info" && l.msg.includes("之前连续失败 1 次"))).toBe(
			true,
		);
		const badAgain = harness({ cardFailures: tracker, work: { renderCard: failing() } });
		await deliverWork(badAgain.args);
		expect(badAgain.sendErrorMsg).toHaveBeenCalledTimes(1);
	});
});

describe("deliverWork — 模板", () => {
	it("视频走视频模板,别的走动态模板;内建兜底", async () => {
		const video = harness({ withImage: false, work: { isVideo: true } });
		await deliverWork(video.args);
		expect(segsOf(video)[0]?.text).toBe(`阿绫发布了新视频\n${LINK}`);
		const post = harness({ withImage: false });
		await deliverWork(post.args);
		expect(segsOf(post)[0]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
	});

	it("这条订阅的模板盖过全局,全局盖过内建;`\\n` 展开成换行", async () => {
		const global = harness({
			withImage: false,
			config: { dynamicTemplate: "全局 {name}", videoTemplate: "全局视频 {name}" },
		});
		await deliverWork(global.args);
		expect(segsOf(global)[0]?.text).toBe(`全局 阿绫\n${LINK}`);

		const perSub = harness({
			withImage: false,
			work: { isVideo: true },
			config: { videoTemplate: "全局视频 {name}" },
			settings: { customVideoTemplate: "{name}\\n投稿啦" },
		});
		await deliverWork(perSub.args);
		expect(segsOf(perSub)[0]?.text).toBe(`阿绫\n投稿啦\n${LINK}`);
	});
});

describe("deliverWork — AI 点评", () => {
	it("点评替换模板文字;提示词按平台叫法,图只看前 4 张,这条订阅的 AI 覆盖原样交过去", async () => {
		const aiOverride = { dynamicPrompt: "这位 UP 专属的场景提示" };
		const h = harness({
			withImage: false,
			withAi: true,
			work: {
				commentText: "正文",
				commentImages: ["data:1", "data:2", "data:3", "data:4", "data:5"],
			},
			settings: { aiOverride },
		});
		await deliverWork(h.args);
		expect(h.comment).toHaveBeenCalledWith(
			"阿绫发布了一条作品，内容如下：\n正文",
			"dynamic",
			["data:1", "data:2", "data:3", "data:4"],
			aiOverride,
		);
		expect(segsOf(h)[0]?.text).toBe(`点评\n${LINK}`);
	});

	it("联网搜索开着 → override 带 webSearch:true", async () => {
		const h = harness({
			withAi: true,
			work: { commentText: "正文" },
			config: { aiWebSearch: true },
			settings: { aiOverride: { dynamicPrompt: "这位 UP 专属的场景提示" } },
		});
		await deliverWork(h.args);
		expect(h.comment.mock.calls[0]?.[3]).toEqual({
			dynamicPrompt: "这位 UP 专属的场景提示",
			webSearch: true,
		});
	});

	it("没有可点评的正文 / 关了 AI / 文字块藏起来 → 不调 AI", async () => {
		const cases = [
			harness({ withAi: true }),
			harness({ withAi: true, work: { commentText: "正文" }, config: { aiEnabled: false } }),
			harness({
				withAi: true,
				work: { commentText: "正文" },
				settings: { messageLayout: layoutOf([{ type: "card" }, { type: "text", visible: false }]) },
			}),
		];
		for (const h of cases) {
			await deliverWork(h.args);
			expect(h.comment).not.toHaveBeenCalled();
		}
	});

	it("点评失败 → 回退模板文字照发", async () => {
		const h = harness({ withImage: false, withAi: true, work: { commentText: "正文" } });
		h.comment.mockRejectedValueOnce(new Error("额度用完"));
		await deliverWork(h.args);
		expect(segsOf(h)[0]?.text).toBe(`阿绫发布了一条动态\n${LINK}`);
	});
});

describe("deliverWork — 还订阅着吗", () => {
	it("出卡 / 点评之后才回问;已退订 → 不发主卡也不发图集", async () => {
		let subscribed = true;
		const h = harness({
			withAi: true,
			work: {
				commentText: "正文",
				gallery: [{ url: "http://a/1.jpg" }],
				renderCard: vi.fn(async () => {
					subscribed = false; // 出卡途中被退订
					return CARD;
				}),
			},
			config: { imageGroup: { enable: true, forward: false } },
			stillSubscribed: () => subscribed,
		});
		expect(await deliverWork(h.args)).toBe("unsubscribed");
		expect(h.broadcast).not.toHaveBeenCalled();
		expect(h.broadcastSequence).not.toHaveBeenCalled();
	});
});

describe("deliverWork — 发送失败与图集", () => {
	const gallery = [
		{ url: "http://a/1.jpg", width: 800, height: 600 },
		{ url: "http://a/2.jpg", width: 800, height: 600 },
	];

	it("主卡发送失败 → 往外抛,不再附图集", async () => {
		const h = harness({
			work: { gallery },
			config: { imageGroup: { enable: true, forward: false } },
		});
		h.broadcast.mockRejectedValueOnce(new Error("bot 掉线"));
		await expect(deliverWork(h.args)).rejects.toThrow("bot 掉线");
		expect(h.broadcast).toHaveBeenCalledTimes(1);
	});

	it("图集附在主卡之后,同一个 pushId,kind=dynamic-images", async () => {
		const h = harness({
			work: { gallery },
			config: { imageGroup: { enable: true, forward: true } },
		});
		await deliverWork(h.args);
		const calls = h.broadcast.mock.calls as Array<[PushSegment[], string, { pushId?: string }]>;
		expect(calls.map((c) => c[1])).toEqual(["dynamic", "dynamic-images"]);
		expect(calls[1]?.[2].pushId).toBe(calls[0]?.[2].pushId);
		expect(calls[1]?.[0]).toEqual([{ type: "image-group", forward: true, images: gallery }]);
	});

	it("图集发送失败 → 吞掉,仍算走完", async () => {
		const h = harness({
			work: { gallery },
			config: { imageGroup: { enable: true, forward: false } },
		});
		h.broadcast.mockImplementation(async (_segs: unknown, kind: string) => {
			if (kind === "dynamic-images") throw new Error("图组通道抖动");
		});
		expect(await deliverWork(h.args)).toBe("delivered");
		expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("订阅=s1 图组发送失败"))).toBe(
			true,
		);
	});

	it("单张图不走合并转发;没有图不附;这条订阅的开关盖过全局", async () => {
		const single = harness({
			work: { gallery: [{ url: "http://a/1.jpg" }] },
			config: { imageGroup: { enable: true, forward: true } },
		});
		await deliverWork(single.args);
		expect((segsOf(single, 1)[0] as { forward?: boolean }).forward).toBe(false);

		const none = harness({ config: { imageGroup: { enable: true, forward: false } } });
		await deliverWork(none.args);
		expect(none.broadcast).toHaveBeenCalledTimes(1);

		const offForSub = harness({
			work: { gallery },
			config: { imageGroup: { enable: true, forward: false } },
			settings: { imageGroupEnable: false },
		});
		await deliverWork(offForSub.args);
		expect(offForSub.broadcast).toHaveBeenCalledTimes(1);

		const onForSub = harness({
			work: { gallery },
			config: { imageGroup: { enable: false, forward: false } },
			settings: { imageGroupEnable: true, imageGroupForward: true },
		});
		await deliverWork(onForSub.args);
		expect((segsOf(onForSub, 1)[0] as { forward?: boolean }).forward).toBe(true);
	});
});
