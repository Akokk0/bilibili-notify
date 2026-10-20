/**
 * 拓展报的直播交给场次引擎(`bindExtensionLive`,ADR-0019 决策 53 / 57 / 62;ADR-0021 决策 56 的过渡)。
 *
 * 拓展交的封面与作者头像是字节:绑定逐条订阅**先存进图库、再交带引用的信号**(data-model「图一律图库引用」;
 * 照 `posts/__tests__/extension-post.test.ts` 的先例)。喂一条真的总线,图库与场次引擎换成记账的替身:
 * - 开播上报:先存图、再交信号,信号里是引用;
 * - 存不进的那张缺着,信号照交;
 * - 同一个绑定的上报按到达顺序一条条翻(存图是异步的,不排队的话开播与下播会颠倒);
 * - 下播的时刻是上报到达的那一刻,不是翻完图的那一刻。
 */

import type { LiveSignal, SubscriptionReport } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { png } from "../../__tests__/support/report-images.js";
import { makeTrackingContext } from "../../__tests__/support/track-context.js";
import { imageRefOf } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { bindExtensionLive } from "../extension-live.js";

const EXT = "douyin";
const SUB = makeExtensionSubscription({ extensionId: EXT, externalId: "sec-uid-1" });
const SUB_2 = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-000000000002",
	extensionId: EXT,
	externalId: "sec-uid-1",
});
const URL = "https://live.douyin.com/1";
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0);
const COVER = png(16, 9, 1);
const AVATAR = png(8, 8, 2);
const GARBAGE = new Uint8Array([1, 2, 3, 4]);
const logger = { debug() {}, info() {}, warn: vi.fn(), error: vi.fn() };

interface World {
	bus: ReturnType<typeof createNodeMessageBus>;
	handle: ReturnType<typeof bindExtensionLive>;
	/** 交进引擎的信号,和存图,按发生的先后记在同一张表里。 */
	events: Array<{ kind: "put"; ref: string | undefined } | { kind: "apply"; signal: LiveSignal }>;
	signals(): LiveSignal[];
	puts: Uint8Array[];
	ctx: ReturnType<typeof makeTrackingContext>;
	report(r: SubscriptionReport, ids?: string[]): void;
}

/**
 * `put` 默认一步到位(只收图库认的图,同 `imageRefOf`);`gates` 让某一张图的存图停在半路,由测试放行;
 * `unavailable` 让图库说磁盘写失败。
 */
function world(
	over: {
		subs?: Array<ReturnType<typeof makeExtensionSubscription>>;
		gates?: Map<Uint8Array, Promise<void>>;
		unavailable?: boolean;
		now?: () => number;
	} = {},
): World {
	const bus = createNodeMessageBus();
	const subs = new Map((over.subs ?? [SUB]).map((s) => [s.id, s]));
	const events: World["events"] = [];
	const puts: Uint8Array[] = [];
	const ctx = makeTrackingContext();
	const handle = bindExtensionLive({
		bus,
		logger,
		serviceCtx: ctx,
		subscription: (id) => subs.get(id),
		profileName: () => "资料里的名字",
		liveImages: {
			async put(bytes) {
				await over.gates?.get(bytes);
				puts.push(bytes);
				if (over.unavailable) {
					events.push({ kind: "put", ref: undefined });
					return { ok: false as const, code: "unavailable", message: "磁盘写失败" } as never;
				}
				const ref = imageRefOf(bytes);
				events.push({ kind: "put", ref });
				return ref
					? { ok: true as const, ref }
					: ({ ok: false as const, code: "invalid", message: "不是图库收的图" } as never);
			},
		},
		sessions: { apply: (signal) => events.push({ kind: "apply", signal }) },
		now: over.now,
	});
	return {
		bus,
		handle,
		events,
		signals: () => events.flatMap((event) => (event.kind === "apply" ? [event.signal] : [])),
		puts,
		ctx,
		report(report, ids = [SUB.id]) {
			bus.emit("subscription-reported", {
				extensionId: EXT,
				externalId: "sec-uid-1",
				subscriptionIds: ids,
				report,
			});
		},
	};
}

describe("关停时的在途上报", () => {
	it("先退订,再等已经进闸的信号交完", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = world({ gates: new Map([[COVER, gate]]) });
		w.report({
			kind: "liveStatus",
			value: { live: true, viewers: 2000, cover: COVER },
		});
		await Promise.resolve();

		const closing = w.handle.dispose();
		expect(w.signals()).toEqual([]);
		release();
		await closing;

		expect(w.signals()).toEqual([
			expect.objectContaining({
				kind: "status",
				isLive: true,
				details: { currentViewers: 2000, cover: { ref: imageRefOf(COVER) } },
			}),
		]);
	});

	it("关停开始之后到达的上报不再交", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = world({ gates: new Map([[COVER, gate]]) });
		w.report({
			kind: "liveStatus",
			value: { live: true, viewers: 2000, cover: COVER },
		});
		await Promise.resolve();

		const closing = w.handle.dispose();
		w.report({ kind: "liveStatus", value: { live: false } });
		release();
		await closing;

		expect(w.signals().map((signal) => signal.kind)).toEqual(["status"]);
		expect(w.signals()[0]).toMatchObject({ isLive: true });
	});
});

describe("开播上报:先存图,再交带引用的信号", () => {
	it("封面与作者头像先存进图库,信号里只有引用;其余的格原样翻成中立详情", async () => {
		const w = world();
		w.report({
			kind: "liveStart",
			value: {
				url: URL,
				startedAt: T0,
				title: "第一场",
				cover: COVER,
				category: "聊天",
				viewers: 10,
				totalViewers: 40,
				likes: 3,
				description: "简介",
				author: { name: "事件里的名字", avatar: AVATAR },
			},
		});
		await w.ctx.settled();

		// 次序:两张图都存好了,信号才交出去。
		expect(w.events.map((event) => event.kind)).toEqual(["put", "put", "apply"]);
		expect(w.signals()).toEqual([
			{
				kind: "start",
				subscriptionId: SUB.id,
				identity: SUB.identity,
				startedAt: new Date(T0).toISOString(),
				details: {
					title: "第一场",
					cover: { ref: imageRefOf(COVER) },
					category: "聊天",
					url: URL,
					currentViewers: 10,
					totalViewers: 40,
					likes: 3,
					description: "简介",
					creator: { name: "事件里的名字", avatar: imageRefOf(AVATAR) },
				},
			},
		]);
	});

	it("什么都没带:不存图,详情里只有链接;没有作者就没有 creator(名字留给推送那头现取)", async () => {
		const w = world();
		w.report({ kind: "liveStart", value: { url: URL, startedAt: T0 } });
		await w.ctx.settled();
		expect(w.puts).toEqual([]);
		expect(w.signals()[0]).toMatchObject({ kind: "start", details: { url: URL } });
		expect(w.signals()[0]).not.toHaveProperty("details.creator");
		expect(w.signals()[0]).not.toHaveProperty("details.cover");
	});

	it("作者只带了头像没带名字:名字按 订阅资料里的 → 外部 id 补上", async () => {
		const w = world();
		w.report({ kind: "liveStart", value: { url: URL, startedAt: T0, author: { avatar: AVATAR } } });
		await w.ctx.settled();
		expect(w.signals()[0]).toMatchObject({
			details: { creator: { name: "资料里的名字", avatar: imageRefOf(AVATAR) } },
		});
	});

	it("一条上报对上同一个人的几条订阅:每条各一份信号,图每份各存(同一份字节只刷新修改时间)", async () => {
		const w = world({ subs: [SUB, SUB_2] });
		w.report({ kind: "liveStart", value: { url: URL, startedAt: T0, cover: COVER } }, [
			SUB.id,
			SUB_2.id,
		]);
		await w.ctx.settled();
		expect(w.signals().map((s) => s.subscriptionId)).toEqual([SUB.id, SUB_2.id]);
		expect(w.puts).toEqual([COVER, COVER]);
	});

	it("订阅已经删了:这份上报不收,也不存图", async () => {
		const w = world({ subs: [] });
		w.report({ kind: "liveStart", value: { url: URL, startedAt: T0, cover: COVER } });
		await w.ctx.settled();
		expect(w.events).toEqual([]);
	});
});

describe("存不进的那张图缺着,信号照交", () => {
	it("图库不收(格式不认):封面缺着,别的格都在", async () => {
		const w = world();
		w.report({
			kind: "liveStart",
			value: {
				url: URL,
				startedAt: T0,
				title: "第一场",
				cover: GARBAGE,
				author: { avatar: AVATAR },
			},
		});
		await w.ctx.settled();
		const [signal] = w.signals();
		expect(signal).toMatchObject({
			kind: "start",
			details: { title: "第一场", creator: { avatar: imageRefOf(AVATAR) } },
		});
		expect(signal).not.toHaveProperty("details.cover");
	});

	it("磁盘写失败(unavailable):记一条 warn,两张图都缺着,信号照交", async () => {
		const w = world({ unavailable: true });
		w.report({
			kind: "liveStart",
			value: { url: URL, startedAt: T0, cover: COVER, author: { name: "甲", avatar: AVATAR } },
		});
		await w.ctx.settled();
		expect(logger.warn).toHaveBeenCalled();
		const [signal] = w.signals();
		expect(signal).toMatchObject({ details: { creator: { name: "甲" } } });
		expect(signal).not.toHaveProperty("details.cover");
		expect(signal).not.toHaveProperty("details.creator.avatar");
	});
});

describe("同一个绑定的上报按到达顺序一条条翻", () => {
	it("开播的封面还在存图,下播已经到了:引擎先收到开播、再收到下播", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = world({ gates: new Map([[COVER, gate]]) });
		w.report({ kind: "liveStart", value: { url: URL, startedAt: T0, cover: COVER } });
		w.report({ kind: "liveEnd", value: { url: URL } });
		await Promise.resolve();
		// 第一条还卡在存图上,第二条不能抢在前面交进引擎。
		expect(w.signals()).toEqual([]);

		release();
		await w.ctx.settled();
		expect(w.signals().map((s) => s.kind)).toEqual(["start", "end"]);
	});

	it("下播的时刻是上报到达的那一刻,不是翻完图的那一刻", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let clock = T0;
		const w = world({ gates: new Map([[COVER, gate]]), now: () => clock });
		w.report({ kind: "liveStart", value: { url: URL, startedAt: T0, cover: COVER } });
		clock = T0 + 5 * 60_000;
		w.report({ kind: "liveEnd", value: { url: URL, startedAt: T0 } });
		clock = T0 + 30 * 60_000;
		release();
		await w.ctx.settled();

		expect(w.signals()[1]).toMatchObject({
			kind: "end",
			endedAt: new Date(T0 + 5 * 60_000).toISOString(),
			startedAt: new Date(T0).toISOString(),
		});
	});
});

describe("直播状态与下播", () => {
	it("直播状态:isLive 与开播时刻(选填)一并翻过去;在线数叫 currentViewers", async () => {
		const w = world();
		w.report({ kind: "liveStatus", value: { live: true, startedAt: T0, viewers: 5 } });
		w.report({ kind: "liveStatus", value: { live: false } });
		await w.ctx.settled();
		expect(w.signals()).toEqual([
			{
				kind: "status",
				subscriptionId: SUB.id,
				identity: SUB.identity,
				isLive: true,
				startedAt: new Date(T0).toISOString(),
				details: { currentViewers: 5 },
			},
			{
				kind: "status",
				subscriptionId: SUB.id,
				identity: SUB.identity,
				isLive: false,
				details: {},
			},
		]);
	});

	it("作品与资料更新不归这里", async () => {
		const w = world();
		w.report({
			kind: "post",
			value: { id: "p1", url: "https://www.douyin.com/video/p1", publishedAt: T0 },
		});
		w.report({ kind: "profile", value: { name: "新名字" } });
		await w.ctx.settled();
		expect(w.events).toEqual([]);
		expect(w.ctx.tracked).toEqual([]);
	});

	it("收摊之后不再听总线", async () => {
		const bus = createNodeMessageBus();
		const apply = vi.fn();
		const handle = bindExtensionLive({
			bus,
			logger,
			serviceCtx: makeTrackingContext(),
			subscription: () => SUB,
			profileName: () => undefined,
			liveImages: {
				put: async () => ({ ok: false as const, code: "invalid", message: "" }) as never,
			},
			sessions: { apply },
		});
		handle.dispose();
		bus.emit("subscription-reported", {
			extensionId: EXT,
			externalId: "sec-uid-1",
			subscriptionIds: [SUB.id],
			report: { kind: "liveStatus", value: { live: true } },
		});
		await Promise.resolve();
		expect(apply).not.toHaveBeenCalled();
	});
});
