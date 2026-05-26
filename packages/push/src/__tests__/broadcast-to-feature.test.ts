/**
 * 单元测试 — `BilibiliPush.broadcastToFeature` routing 决策。
 *
 * 这是 push 链路的"路由网关":sub.features → sub.routing → quietHours 三道 gate
 * 后才到 sink.send。任何环节走错 = 用户看到漏推 / 推错目标 / 免扰失效。
 *
 * 锁住:
 *   - 无订阅 / 无 routing 不调 sink
 *   - features=false 总开关短路(配 defaults provider 时)
 *   - quietHours 命中时不发
 *   - atAll 修饰仅作用于 dynamic / live,且按 atAllDefaults + tristate 覆写决定
 *   - onSend 回调每个 target 触发一次,private 字段为 false
 */

import { Buffer } from "node:buffer";
import {
	type DeliveryResult,
	type GlobalDefaults,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type NotificationPayload,
	type NotificationSink,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vitest";
import { BilibiliPush } from "../bilibili-push";

const silentLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

interface SendCall {
	targetId: string;
	payload: NotificationPayload;
}

function makeSink(opts?: { available?: boolean }): {
	sink: NotificationSink;
	calls: SendCall[];
} {
	const available = opts?.available ?? true;
	const calls: SendCall[] = [];
	const sink: NotificationSink = {
		isAvailable: () => available,
		send: async (targetId, payload) => {
			calls.push({ targetId, payload });
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		sendPrivate: async (targetId, payload) => {
			calls.push({ targetId, payload });
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) =>
			({
				id,
				name: id,
				adapterId: "a",
				platform: "test",
				scope: "group",
				enabled: true,
			}) as unknown as PushTarget,
	};
	return { sink, calls };
}

function makeStore(subs: Subscription[]): SubscriptionStore {
	return {
		list: () => [...subs],
		findByUid: (uid) => subs.find((s) => s.uid === uid),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: () => {},
	};
}

function loopbackDefaults(): GlobalDefaults {
	// 任意 features=true、quietHours=空,使 runtime gate 直接放行
	const g = makeDefaultGlobalConfig();
	for (const k of Object.keys(g.defaults.features)) {
		(g.defaults.features as Record<string, boolean>)[k] = true;
	}
	g.defaults.schedule.quietHours = [];
	return g.defaults;
}

describe("BilibiliPush.broadcastToFeature — routing decision", () => {
	it("uid 无订阅 → 不调 sink", async () => {
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			sink,
			store: makeStore([]),
			logger: silentLogger,
		});
		push.start();
		const out = await push.broadcastToFeature("nope", "live", { kind: "text", text: "x" });
		expect(out).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("routing 空数组 → 不调 sink", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);
	});

	it("routing 命中两个 target → sink.send 调两次", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1", "t2"];
		sub.atAllDefaults.live = false; // 排除 @全体 路径的额外 send 调用,只验证路由
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "开播了" });
		expect(calls.map((c) => c.targetId)).toEqual(["t1", "t2"]);
	});

	it("features.X=false(defaults provider)→ 短路,不调 sink", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1"];
		const defaults = loopbackDefaults();
		defaults.features.live = false;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			sink,
			store: makeStore([sub]),
			logger: silentLogger,
			defaults: () => defaults,
		});
		push.start();
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);
	});

	it("quietHours 命中(0-24)→ 全天免扰,不发", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1"];
		const defaults = loopbackDefaults();
		defaults.schedule.quietHours = [{ start: 0, end: 0 }]; // 整天免扰
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			sink,
			store: makeStore([sub]),
			logger: silentLogger,
			defaults: () => defaults,
		});
		push.start();
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "x" });
		expect(calls).toHaveLength(0);
	});

	it("atAllDefaults.dynamic=true → @全体单独一条 + 原 payload 两条独立消息", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.dynamic = ["t1"];
		sub.atAllDefaults.dynamic = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "dynamic", { kind: "text", text: "动态" });
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 单独一条 composite,只含 at-all 段
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
		}
		// 第 2 条:原 payload 原样不变(卡片 + 文字保持单独消息形态)
		expect(calls[1].payload).toEqual({ kind: "text", text: "动态" });
	});

	it("atAll tristate 覆写:per-target false 强 OFF + 顺序 plain → @全体 → 原 payload", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1", "t2"];
		sub.atAllDefaults.live = true;
		sub.atAll.live = { t1: false }; // 显式关 t1 的 @全体,t2 走 default=true
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "开播" });
		// t1 一条原 payload;t2 先收 @全体 only,再收原 payload。共 3 条。
		expect(calls).toHaveLength(3);
		expect(calls[0]).toMatchObject({ targetId: "t1" });
		expect(calls[0].payload.kind).toBe("text"); // t1 plain,原 payload
		expect(calls[1]).toMatchObject({ targetId: "t2" });
		expect(calls[1].payload.kind).toBe("composite"); // t2 第 1 条 @全体 only
		if (calls[1].payload.kind === "composite") {
			expect(calls[1].payload.segments).toEqual([{ type: "at-all" }]);
		}
		expect(calls[2]).toMatchObject({ targetId: "t2" });
		expect(calls[2].payload).toEqual({ kind: "text", text: "开播" }); // t2 第 2 条原 payload
	});

	it("opts.allowAtAll=false → 抑制 @全体,即使 feature=live 且 atAllDefaults.live=true(本次 bug 修复:周期「正在直播」)", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1", "t2"];
		sub.atAllDefaults.live = true;
		sub.atAll.live = { t1: true }; // 即便 per-target 显式 true 也得被抑制
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature(
			"u1",
			"live",
			{ kind: "text", text: "正在直播" },
			{ allowAtAll: false },
		);
		expect(calls.map((c) => c.targetId)).toEqual(["t1", "t2"]); // 仍正常路由
		for (const c of calls) expect(c.payload.kind).toBe("text"); // 但都没 at-all 头
	});

	it("opts.allowAtAll=true(显式)或不传 → 维持按 feature 决定的旧行为(开播仍 @全体)", async () => {
		const mk = () => {
			const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
			sub.routing.live = ["t1"];
			sub.atAllDefaults.live = true;
			return sub;
		};
		const assertAtAllThenPayload = (calls: SendCall[]) => {
			// 单 target 走 atAll 路径 → @全体 only + 原 payload 两条
			expect(calls).toHaveLength(2);
			expect(calls[0].payload.kind).toBe("composite");
			if (calls[0].payload.kind === "composite") {
				expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
			}
			expect(calls[1].payload).toEqual({ kind: "text", text: "开播" });
		};
		// 显式 true
		{
			const { sink, calls } = makeSink();
			const push = new BilibiliPush({ sink, store: makeStore([mk()]), logger: silentLogger });
			push.start();
			await push.broadcastToFeature(
				"u1",
				"live",
				{ kind: "text", text: "开播" },
				{ allowAtAll: true },
			);
			assertAtAllThenPayload(calls);
		}
		// opts 不传(向后兼容:dynamic 等既有调用点不受影响)
		{
			const { sink, calls } = makeSink();
			const push = new BilibiliPush({ sink, store: makeStore([mk()]), logger: silentLogger });
			push.start();
			await push.broadcastToFeature("u1", "live", { kind: "text", text: "开播" });
			assertAtAllThenPayload(calls);
		}
	});

	it("@全体 单独一条 → composite [image,text] 原 payload 第二条(live)", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1"];
		sub.atAllDefaults.live = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		const payload: NotificationPayload = {
			kind: "composite",
			segments: [
				{ type: "image", buffer: Buffer.from([1]), mime: "image/jpeg" },
				{ type: "text", text: "开播啦" },
			],
		};
		await push.broadcastToFeature("u1", "live", payload);
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 only
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
		}
		// 第 2 条:原 [image, text] 不改不重组
		if (calls[1].payload.kind === "composite") {
			expect(calls[1].payload.segments.map((s) => s.type)).toEqual(["image", "text"]);
		}
	});

	it("@全体 单独一条对 dynamic 同样生效(共用 broadcastToFeature 分支)", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.dynamic = ["t1"];
		sub.atAllDefaults.dynamic = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "dynamic", {
			kind: "composite",
			segments: [
				{ type: "image", buffer: Buffer.from([3]), mime: "image/jpeg" },
				{ type: "text", text: "发了条动态" },
			],
		});
		expect(calls).toHaveLength(2);
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
		}
		if (calls[1].payload.kind === "composite") {
			expect(calls[1].payload.segments.map((s) => s.type)).toEqual(["image", "text"]);
		}
	});

	it("@全体 单独一条:image+caption / text-only 原 payload 都保持原样不变", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1"];
		sub.atAllDefaults.live = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "live", {
			kind: "image",
			image: { buffer: Buffer.from([2]), mime: "image/png" },
			caption: "字幕",
		});
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 only
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
		}
		// 第 2 条:image+caption 原样(不被升级为 composite)
		expect(calls[1].payload.kind).toBe("image");
		if (calls[1].payload.kind === "image") {
			expect(calls[1].payload.caption).toBe("字幕");
		}
		// 纯文本无图 → 同样两条:@全体 only + text 原 payload
		calls.length = 0;
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "无图开播" });
		expect(calls).toHaveLength(2);
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
		}
		expect(calls[1].payload).toEqual({ kind: "text", text: "无图开播" });
	});

	it("forward-images + atAllTargets:同样先发独立 @全体 再发合并转发", async () => {
		// 合并转发节点跟外层独立 @全体 不冲突,一视同仁两条发出,@ 提醒在前。
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.dynamic = ["t1"];
		sub.atAllDefaults.dynamic = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "dynamic", {
			kind: "forward-images",
			urls: ["http://x/1.jpg"],
			forward: true,
		});
		expect(calls).toHaveLength(2);
		// 第 1 条:@全体 only
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments).toEqual([{ type: "at-all" }]);
		}
		// 第 2 条:原 forward-images 原样
		expect(calls[1].payload.kind).toBe("forward-images");
	});

	it("非 dynamic / live 的 feature 不进入 atAll 分支(superchat 即使 atAllDefaults=true)", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.superchat = ["t1"];
		sub.atAllDefaults.dynamic = true; // 无效字段,不应影响 superchat
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "superchat", { kind: "text", text: "SC" });
		expect(calls[0].payload.kind).toBe("text"); // 没 at-all 头
	});

	it("onSend 每个 target 触发一次,private=false,target 字段填", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.dynamic = ["t1", "t2"];
		const onSend = vi.fn();
		const { sink } = makeSink();
		const push = new BilibiliPush({
			sink,
			store: makeStore([sub]),
			logger: silentLogger,
			onSend,
		});
		push.start();
		await push.broadcastToFeature("u1", "dynamic", { kind: "text", text: "x" });
		expect(onSend).toHaveBeenCalledTimes(2);
		const calls = onSend.mock.calls.map((c) => c[0]);
		expect(calls[0]).toMatchObject({ uid: "u1", feature: "dynamic", private: false });
		expect(calls[0].target.id).toBe("t1");
	});
});
