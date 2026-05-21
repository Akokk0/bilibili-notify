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

	it("atAllDefaults.dynamic=true → 调 sink 的 payload 含 at-all 段", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.dynamic = ["t1"];
		sub.atAllDefaults.dynamic = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "dynamic", { kind: "text", text: "动态" });
		expect(calls).toHaveLength(1);
		// prependAtAll 把 payload 升级为 composite,首段是 { type: "at-all" }
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			expect(calls[0].payload.segments[0]?.type).toBe("at-all");
		}
	});

	it("atAll tristate 覆写:per-target false 强 OFF,即使 default=true", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1", "t2"];
		sub.atAllDefaults.live = true;
		sub.atAll.live = { t1: false }; // 显式关 t1 的 @全体,t2 走 default=true
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "开播" });
		const byTarget = new Map(calls.map((c) => [c.targetId, c.payload]));
		expect(byTarget.get("t1")?.kind).toBe("text"); // 没 at-all 头
		expect(byTarget.get("t2")?.kind).toBe("composite"); // 有 at-all 头
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
			expect(calls[0].payload.kind).toBe("composite");
		}
		// opts 不传(向后兼容:dynamic 等既有调用点不受影响)
		{
			const { sink, calls } = makeSink();
			const push = new BilibiliPush({ sink, store: makeStore([mk()]), logger: silentLogger });
			push.start();
			await push.broadcastToFeature("u1", "live", { kind: "text", text: "开播" });
			expect(calls[0].payload.kind).toBe("composite");
		}
	});

	it("@全体 版式:composite [image,text] → [image, at-all, 空格, text](@全体后留空格)", async () => {
		const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
		sub.routing.live = ["t1"];
		sub.atAllDefaults.live = true;
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({ sink, store: makeStore([sub]), logger: silentLogger });
		push.start();
		await push.broadcastToFeature("u1", "live", {
			kind: "composite",
			segments: [
				{ type: "image", buffer: Buffer.from([1]), mime: "image/jpeg" },
				{ type: "text", text: "开播啦" },
			],
		});
		expect(calls[0].payload.kind).toBe("composite");
		if (calls[0].payload.kind === "composite") {
			const segs = calls[0].payload.segments;
			expect(segs.map((s) => s.type)).toEqual(["image", "at-all", "text", "text"]);
			expect(segs[2]).toEqual({ type: "text", text: " " });
		}
	});

	it("@全体 版式对 dynamic 同样生效(共用 prependAtAll,[image, at-all, 空格, text])", async () => {
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
		if (calls[0].payload.kind === "composite") {
			const segs = calls[0].payload.segments;
			expect(segs.map((s) => s.type)).toEqual(["image", "at-all", "text", "text"]);
			expect(segs[2]).toEqual({ type: "text", text: " " });
		}
	});

	it("@全体 版式:image+caption → [image, at-all, 空格, caption];text-only → [at-all, 空格, text]", async () => {
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
		if (calls[0].payload.kind === "composite") {
			const segs = calls[0].payload.segments;
			expect(segs.map((s) => s.type)).toEqual(["image", "at-all", "text", "text"]);
			expect(segs[2]).toEqual({ type: "text", text: " " });
		}
		// 纯文本无图 → @全体 打头,后面跟空格再接正文。
		calls.length = 0;
		await push.broadcastToFeature("u1", "live", { kind: "text", text: "无图开播" });
		if (calls[0].payload.kind === "composite") {
			const segs = calls[0].payload.segments;
			expect(segs.map((s) => s.type)).toEqual(["at-all", "text", "text"]);
			expect(segs[1]).toEqual({ type: "text", text: " " });
		}
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
