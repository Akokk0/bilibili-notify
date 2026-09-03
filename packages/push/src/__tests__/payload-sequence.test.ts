/**
 * 单元测试 — `BilibiliPush.broadcastToFeature` 多 payload 序列发送(消息版式分条)。
 *
 * 消息版式允许一次推送拆成多条消息。语义锁定:
 *   - 同一 target 内 payload 顺序 await 保序
 *   - 某条失败 → **该 target** 的后续 payload 不再发(既然失败了后面大概率也失败);
 *     其他 target 不受牵连
 *   - onSend 每条 payload 记一行(含失败那条;被中止的不记)
 *   - @全体仍是独立一条、在序列首条之前 fire-and-forget
 *   - 单 payload(非数组)行为与旧签名完全一致(koishi 兼容)
 */

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
import { describe, expect, it } from "vite-plus/test";
import { BilibiliPush, type PushSendInfo } from "../bilibili-push";
import { pushBase } from "./helpers";

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

/** sink:可按 (targetId, 第几次调用) 指定失败。 */
function makeSink(failOn?: (targetId: string, nthCallForTarget: number) => boolean): {
	sink: NotificationSink;
	calls: SendCall[];
} {
	const calls: SendCall[] = [];
	const perTarget = new Map<string, number>();
	const sink: NotificationSink = {
		isAvailable: () => true,
		send: async (targetId, payload) => {
			const nth = (perTarget.get(targetId) ?? 0) + 1;
			perTarget.set(targetId, nth);
			calls.push({ targetId, payload });
			if (failOn?.(targetId, nth)) {
				return { ok: false, latencyMs: 1, err: "boom" } as DeliveryResult;
			}
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
	const g = makeDefaultGlobalConfig();
	for (const k of Object.keys(g.defaults.features)) {
		(g.defaults.features as Record<string, boolean>)[k] = true;
	}
	g.defaults.schedule.quietHours = [];
	return g.defaults;
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function subWithTargets(targets: string[], atAllLiveDefault = false): Subscription {
	const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
	sub.routing.dynamic = [...targets];
	sub.atAllDefaults.dynamic = atAllLiveDefault;
	return sub;
}

const M1: NotificationPayload = { kind: "text", text: "m1" };
const M2: NotificationPayload = { kind: "text", text: "m2" };
const M3: NotificationPayload = { kind: "text", text: "m3" };

function textOf(p: NotificationPayload): string {
	return p.kind === "text" ? p.text : p.kind;
}

describe("BilibiliPush.broadcastToFeature — payload 序列", () => {
	it("payload 数组 → 每个 target 顺序收到全部消息", async () => {
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([subWithTargets([T1, T2])]),
			logger: silentLogger,
			defaults: loopbackDefaults,
		});
		push.start();
		await push.broadcastToFeature("u1", "dynamic", [M1, M2]);
		expect(calls.map((c) => [c.targetId, textOf(c.payload)])).toEqual([
			[T1, "m1"],
			[T1, "m2"],
			[T2, "m1"],
			[T2, "m2"],
		]);
	});

	it("某 target 首条失败 → 该 target 后续条中止,其他 target 不受影响", async () => {
		const { sink, calls } = makeSink((id, nth) => id === T1 && nth === 1);
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([subWithTargets([T1, T2])]),
			logger: silentLogger,
			defaults: loopbackDefaults,
		});
		push.start();
		await push.broadcastToFeature("u1", "dynamic", [M1, M2, M3]);
		expect(calls.map((c) => [c.targetId, textOf(c.payload)])).toEqual([
			[T1, "m1"], // 失败 → m2/m3 被中止
			[T2, "m1"],
			[T2, "m2"],
			[T2, "m3"],
		]);
	});

	it("onSend 每条 payload 记一行:含失败那条,不含被中止的", async () => {
		const { sink } = makeSink((id, nth) => id === T1 && nth === 2);
		const seen: Array<[string, string, boolean]> = [];
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([subWithTargets([T1])]),
			logger: silentLogger,
			defaults: loopbackDefaults,
			onSend: (info: PushSendInfo) => {
				seen.push([info.target.id, textOf(info.payload), info.result.ok]);
			},
		});
		push.start();
		await push.broadcastToFeature("u1", "dynamic", [M1, M2, M3]);
		expect(seen).toEqual([
			[T1, "m1", true],
			[T1, "m2", false], // 失败条本身要落历史
		]);
	});

	it("空数组 → 不调 sink", async () => {
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([subWithTargets([T1])]),
			logger: silentLogger,
			defaults: loopbackDefaults,
		});
		push.start();
		const out = await push.broadcastToFeature("u1", "dynamic", []);
		expect(out).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("单 payload(非数组)→ 行为与旧签名一致", async () => {
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([subWithTargets([T1, T2])]),
			logger: silentLogger,
			defaults: loopbackDefaults,
		});
		push.start();
		const out = await push.broadcastToFeature("u1", "dynamic", M1);
		expect(out).toHaveLength(2);
		expect(calls.map((c) => [c.targetId, textOf(c.payload)])).toEqual([
			[T1, "m1"],
			[T2, "m1"],
		]);
	});

	it("@全体 target:独立 at-all 消息先发,再顺序发序列", async () => {
		const { sink, calls } = makeSink();
		const push = new BilibiliPush({
			...pushBase(),
			sink,
			store: makeStore([subWithTargets([T1], true)]),
			logger: silentLogger,
			defaults: loopbackDefaults,
		});
		push.start();
		await push.broadcastToFeature("u1", "dynamic", [M1, M2]);
		// at-all 是独立 composite 一条,先于序列首条入 sink
		expect(calls).toHaveLength(3);
		expect(calls[0]?.payload.kind).toBe("composite");
		expect(calls.slice(1).map((c) => textOf(c.payload))).toEqual(["m1", "m2"]);
	});
});
