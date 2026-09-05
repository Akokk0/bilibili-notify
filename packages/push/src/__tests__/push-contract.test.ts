/**
 * `BilibiliPush.broadcastToFeature` 的推送契约 —— 历史一行 = 一次推送 × 一个目标。
 *
 * 锁住:
 *   - 一次广播对每个目标只回调 `onSend` 一次,带这一段的全部消息与逐条结果
 *   - `pushId` 透传;没传就现生成,同一次广播里各目标拿到同一个
 *   - 某条失败仍中止该目标后续条:失败那条在消息列表里,被中止的不在
 *   - 可用目标为零(没配,或配的全停用)→ 以 `target: null` 回调一次,不调 sink、不重试
 *   - 停用目标不当候选:只推给启用的,停用的既不发也不记
 *   - 附加项(`role: "extra"`)与本体分开标;@全体 恒为附加项,且在本体那次回调之后
 *   - 上游闸(静音 / 特性关 / 免扰 / 无订阅)一律不回调 —— 那不是「无目标」
 */

import {
	type DeliveryResult,
	makeEmptySubscription,
	type NotificationPayload,
	type NotificationSink,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vite-plus/test";
import { BilibiliPush, type PushSendInfo } from "../bilibili-push";
import { pushBase, silentLogger } from "./helpers";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const M1: NotificationPayload = { kind: "text", text: "m1" };
const M2: NotificationPayload = { kind: "text", text: "m2" };
const M3: NotificationPayload = { kind: "text", text: "m3" };

function textOf(p: NotificationPayload): string {
	if (p.kind === "text") return p.text;
	if (p.kind === "composite" && p.segments[0]?.type === "at-all") return "@全体";
	return p.kind;
}

interface SinkOptions {
	/** 哪些目标停用了(配置层面);缺省全启用。 */
	disabled?: string[];
	/** 按 (targetId, 该目标第几次 send) 指定失败。 */
	failOn?: (targetId: string, nth: number) => boolean;
}

function makeSink(opts: SinkOptions = {}) {
	const calls: Array<{ targetId: string; payload: NotificationPayload }> = [];
	const perTarget = new Map<string, number>();
	const isAvailable = vi.fn(() => true);
	const sink: NotificationSink = {
		isAvailable,
		isEnabled: (id) => !opts.disabled?.includes(id),
		send: async (targetId, payload) => {
			const nth = (perTarget.get(targetId) ?? 0) + 1;
			perTarget.set(targetId, nth);
			calls.push({ targetId, payload });
			if (opts.failOn?.(targetId, nth)) return { ok: false, latencyMs: 1, err: "boom" };
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		sendPrivate: async () => ({ ok: true, latencyMs: 1 }),
		resolve: (id) =>
			({
				id,
				name: id,
				adapterId: "a",
				platform: "test",
				scope: "group",
				enabled: !opts.disabled?.includes(id),
			}) as unknown as PushTarget,
	};
	return { sink, calls, isAvailable };
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

function subWith(targets: string[], atAll = false): Subscription {
	const sub = makeEmptySubscription({ id: "s1", uid: "u1" });
	sub.routing.dynamic = [...targets];
	sub.atAllDefaults.dynamic = atAll;
	return sub;
}

function setup(sub: Subscription, sinkOpts: SinkOptions = {}) {
	const { sink, calls, isAvailable } = makeSink(sinkOpts);
	const seen: PushSendInfo[] = [];
	const push = new BilibiliPush({
		...pushBase(),
		sink,
		store: makeStore([sub]),
		logger: silentLogger,
		onSend: (info) => seen.push(info),
	});
	push.start();
	return { push, calls, seen, isAvailable };
}

/** 一次回调压成 `[目标, [文案, ok]...]`,方便整体比对。 */
function flat(info: PushSendInfo): [string | null, Array<[string, string, boolean | null]>] {
	return [
		info.target?.id ?? null,
		info.messages.map((m) => [textOf(m.payload), m.role, "result" in m ? m.result.ok : null]),
	];
}

describe("推送契约:一次广播 × 每个目标回调一次", () => {
	it("两个目标各收两条 → 回调两次,各带整段消息与逐条结果,pushId 相同", async () => {
		const { push, seen } = setup(subWith([T1, T2]));
		await push.broadcastToFeature("u1", "dynamic", [M1, M2], { pushId: "p1" });
		expect(seen.map(flat)).toEqual([
			[
				T1,
				[
					["m1", "main", true],
					["m2", "main", true],
				],
			],
			[
				T2,
				[
					["m1", "main", true],
					["m2", "main", true],
				],
			],
		]);
		expect(seen.map((s) => s.pushId)).toEqual(["p1", "p1"]);
		expect(seen[0]).toMatchObject({ uid: "u1", feature: "dynamic" });
	});

	it("没传 pushId → 现生成一个,同一次广播里各目标同一个;下一次广播是新的", async () => {
		const { push, seen } = setup(subWith([T1, T2]));
		await push.broadcastToFeature("u1", "dynamic", M1);
		await push.broadcastToFeature("u1", "dynamic", M1);
		const ids = seen.map((s) => s.pushId);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[2]).toBe(ids[3]);
		expect(ids[2]).not.toBe(ids[0]);
	});

	it("某条失败仍中止该目标后续条:失败那条在列表里,被中止的不在;别的目标不受牵连", async () => {
		const { push, seen } = setup(subWith([T1, T2]), {
			failOn: (id, nth) => id === T1 && nth === 2,
		});
		await push.broadcastToFeature("u1", "dynamic", [M1, M2, M3]);
		expect(seen.map(flat)).toEqual([
			[
				T1,
				[
					["m1", "main", true],
					["m2", "main", false],
				],
			],
			[
				T2,
				[
					["m1", "main", true],
					["m2", "main", true],
					["m3", "main", true],
				],
			],
		]);
	});

	it("role: 附加项(图集 / 词云 / 总结)按调用方说的标,缺省是本体", async () => {
		const { push, seen } = setup(subWith([T1]));
		await push.broadcastToFeature("u1", "dynamic", M1, { pushId: "p1" });
		await push.broadcastToFeature("u1", "dynamic", M2, { pushId: "p1", role: "extra" });
		expect(seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T1, [["m2", "extra", true]]],
		]);
	});
});

describe("推送契约:无可用目标", () => {
	it("没配目标 → target:null 回调一次,消息照带(没有结果),不调 sink,返回空", async () => {
		const { push, seen, calls } = setup(subWith([]));
		const out = await push.broadcastToFeature("u1", "dynamic", [M1, M2], { pushId: "p1" });
		expect(out).toEqual([]);
		expect(calls).toHaveLength(0);
		expect(seen.map(flat)).toEqual([
			[
				null,
				[
					["m1", "main", null],
					["m2", "main", null],
				],
			],
		]);
		expect(seen[0]).toMatchObject({ pushId: "p1", uid: "u1", feature: "dynamic" });
	});

	it("配了目标但全停用 → 同样是无目标;停用的不进可达性重试", async () => {
		const { push, seen, calls, isAvailable } = setup(subWith([T1, T2]), {
			disabled: [T1, T2],
		});
		await push.broadcastToFeature("u1", "dynamic", M1);
		expect(calls).toHaveLength(0);
		expect(isAvailable).not.toHaveBeenCalled();
		expect(seen.map(flat)).toEqual([[null, [["m1", "main", null]]]]);
	});

	it("一个启用一个停用 → 只推给启用的;停用的既不发也不记", async () => {
		const { push, seen, calls } = setup(subWith([T1, T2]), { disabled: [T2] });
		await push.broadcastToFeature("u1", "dynamic", M1);
		expect(calls.map((c) => c.targetId)).toEqual([T1]);
		expect(seen.map(flat)).toEqual([[T1, [["m1", "main", true]]]]);
	});

	it("附加项那次广播也走无目标:同一 pushId 再回调一次 target:null", async () => {
		const { push, seen } = setup(subWith([]));
		await push.broadcastToFeature("u1", "dynamic", M1, { pushId: "p1" });
		await push.broadcastToFeature("u1", "dynamic", M2, { pushId: "p1", role: "extra" });
		expect(seen.map(flat)).toEqual([
			[null, [["m1", "main", null]]],
			[null, [["m2", "extra", null]]],
		]);
	});
});

describe("推送契约:@全体 是附加项", () => {
	it("本体那次回调在前;@全体 单独一次回调、标 extra、同一 pushId 同一目标", async () => {
		const { push, seen } = setup(subWith([T1], true));
		await push.broadcastToFeature("u1", "dynamic", [M1, M2], { pushId: "p1" });
		// @全体 是 fire-and-forget,等它落地。
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen.map(flat)).toEqual([
			[
				T1,
				[
					["m1", "main", true],
					["m2", "main", true],
				],
			],
			[T1, [["@全体", "extra", true]]],
		]);
		expect(seen.map((s) => s.pushId)).toEqual(["p1", "p1"]);
	});

	it("@全体 发失败 → 本体照旧记成功,附加项那次回调带失败结果", async () => {
		const { push, seen } = setup(subWith([T1], true), {
			failOn: (id, nth) => id === T1 && nth === 1,
		});
		await push.broadcastToFeature("u1", "dynamic", M1);
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen.map(flat)).toEqual([
			[T1, [["m1", "main", true]]],
			[T1, [["@全体", "extra", false]]],
		]);
	});
});

describe("推送契约:上游闸不算无目标", () => {
	it("特性关着 → 不回调、不记", async () => {
		const sub = subWith([]);
		sub.overrides = { features: { dynamic: false } };
		const { push, seen } = setup(sub);
		await push.broadcastToFeature("u1", "dynamic", M1);
		expect(seen).toHaveLength(0);
	});

	it("订阅本身没有 → 不回调、不记", async () => {
		const { push, seen } = setup(subWith([]));
		await push.broadcastToFeature("nobody", "dynamic", M1);
		expect(seen).toHaveLength(0);
	});

	it("全局静音 → 不回调", async () => {
		const { sink } = makeSink();
		const seen: PushSendInfo[] = [];
		const push = new BilibiliPush({
			...pushBase(),
			muted: () => true,
			sink,
			store: makeStore([subWith([])]),
			logger: silentLogger,
			onSend: (info) => seen.push(info),
		});
		push.start();
		await push.broadcastToFeature("u1", "dynamic", M1);
		expect(seen).toHaveLength(0);
	});
});
