/**
 * 单元测试 — `createSubscriptionStore` CRUD + diff 行为。
 *
 * 业务核心:store 是 SubscriptionStore 接口的唯一实现,koishi 和 standalone 两端
 * adapter 都消费。CRUD 操作和 subscription-changed 事件 ops 是双端 engine 增量
 * apply 的唯一数据来源。
 *
 * 锁住:
 *   - upsert 区分 add / update
 *   - removeById 不存在时不发事件
 *   - replaceAll 计算 diff(add / update / remove 三类 op),没变化不发空事件
 *   - findByUid / findById 查询正常
 */

import {
	type BiliEvents,
	type Disposable,
	type MessageBus,
	makeEmptySubscription,
	type Subscription,
	type SubscriptionOp,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createSubscriptionStore, diff } from "../index";

function makeFakeBus(): MessageBus & { events: Array<[keyof BiliEvents, unknown[]]> } {
	const events: Array<[keyof BiliEvents, unknown[]]> = [];
	const listeners = new Map<keyof BiliEvents, Set<(...a: unknown[]) => void>>();
	return {
		events,
		emit(event, ...args) {
			events.push([event, args as unknown[]]);
			const set = listeners.get(event);
			if (!set) return;
			for (const h of [...set]) (h as (...a: unknown[]) => void)(...args);
		},
		on(event, handler): Disposable {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			const wrapped = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
			set.add(wrapped);
			return { dispose: () => set?.delete(wrapped) };
		},
	};
}

function makeSub(uid: string, id = `sub-${uid}`): Subscription {
	return makeEmptySubscription({ id, uid });
}

function lastOps(bus: ReturnType<typeof makeFakeBus>): SubscriptionOp[] | undefined {
	const last = bus.events.at(-1);
	if (!last || last[0] !== "subscription-changed") return undefined;
	return last[1][0] as SubscriptionOp[];
}

describe("SubscriptionStore — CRUD + diff", () => {
	it("upsert 新订阅 → 触发 add op", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);

		const sub = makeSub("u1");
		store.upsert(sub);

		expect(store.list()).toHaveLength(1);
		expect(store.findByUid("u1")?.id).toBe("sub-u1");
		expect(store.findById("sub-u1")?.uid).toBe("u1");
		expect(lastOps(bus)).toEqual([{ type: "add", sub }]);
	});

	it("upsert 同 id → 触发 update op,不重复出现", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);
		const sub = makeSub("u1");
		store.upsert(sub);

		const sub2 = { ...sub, notes: "改了" };
		store.upsert(sub2);

		expect(store.list()).toHaveLength(1);
		expect(store.findById("sub-u1")?.notes).toBe("改了");
		expect(lastOps(bus)).toEqual([{ type: "update", sub: sub2 }]);
	});

	it("removeById 存在 → 触发 remove op + 返回被删项", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);
		const sub = makeSub("u1");
		store.upsert(sub);

		const removed = store.removeById("sub-u1");
		expect(removed?.id).toBe("sub-u1");
		expect(store.list()).toHaveLength(0);
		expect(lastOps(bus)).toEqual([{ type: "remove", id: "sub-u1", uid: "u1" }]);
	});

	it("removeById 不存在 → 返回 undefined,不发事件", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);
		const evCountBefore = bus.events.length;

		expect(store.removeById("nope")).toBeUndefined();
		expect(bus.events.length).toBe(evCountBefore);
	});

	it("replaceAll 计算 diff:add + update + remove 三类 op", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);
		const a = makeSub("u1", "sub-a");
		const b = makeSub("u2", "sub-b");
		store.replaceAll([a, b]);

		const a2 = { ...a, notes: "改" };
		const c = makeSub("u3", "sub-c");
		store.replaceAll([a2, c]); // a 更新 / b 删 / c 新增

		const ops = lastOps(bus);
		expect(ops).toBeDefined();
		const byType = new Map<string, SubscriptionOp>();
		for (const op of ops ?? []) byType.set(op.type, op);
		expect(byType.has("update")).toBe(true);
		expect(byType.has("remove")).toBe(true);
		expect(byType.has("add")).toBe(true);
	});

	it("replaceAll 内容完全不变 → 不发 subscription-changed", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);
		const a = makeSub("u1");
		store.replaceAll([a]);
		const evCountBefore = bus.events.length;

		store.replaceAll([a]); // 同一对象引用,无任何变化
		expect(bus.events.length).toBe(evCountBefore);
	});

	it("list 返回快照(外部修改不影响 store 内部状态)", () => {
		const bus = makeFakeBus();
		const store = createSubscriptionStore(bus);
		store.upsert(makeSub("u1"));
		const snapshot = store.list();
		snapshot.pop();
		expect(store.list()).toHaveLength(1);
	});

	it("纯函数 diff:add / update / remove / 无变化 四类输出", () => {
		const a = makeSub("u1", "sub-a");
		const b = makeSub("u2", "sub-b");
		const a2 = { ...a, notes: "改" };

		expect(diff([], [a])).toEqual([{ type: "add", sub: a }]);
		expect(diff([a], [])).toEqual([{ type: "remove", id: "sub-a", uid: "u1" }]);
		expect(diff([a], [a2])).toEqual([{ type: "update", sub: a2 }]);
		expect(diff([a, b], [a, b])).toEqual([]);
	});

	// 回归守护 — P2:stableStringify 消伪 update op。
	// 不变量:仅 key 插入序不同(内容等价)不得产 update op / 不得发事件;
	// 真实内容变更仍照常。复发点:diff()/upsert 改回裸 JSON.stringify。
	describe("stableStringify 消伪 update op (P2)", () => {
		// 同内容但顶层 key 插入序反转 —— 裸 JSON.stringify 会判不等(伪 update),
		// stableStringify 递归排序后相等。
		function reorderKeys(s: Subscription): Subscription {
			return Object.fromEntries(
				Object.keys(s)
					.reverse()
					.map((k) => [k, (s as Record<string, unknown>)[k]]),
			) as unknown as Subscription;
		}

		it("diff:仅 key 序不同 → 无伪 update op", () => {
			const a = makeSub("u1", "sub-a");
			expect(diff([a], [reorderKeys(a)])).toEqual([]);
		});

		it("upsert:内容等价(key 序不同)→ 不发 subscription-changed", () => {
			const bus = makeFakeBus();
			const store = createSubscriptionStore(bus);
			const a = makeSub("u1");
			store.upsert(a);
			const before = bus.events.length;
			store.upsert(reorderKeys(a));
			expect(bus.events.length).toBe(before);
		});

		it("真实内容变更仍照常 update(不被误吞)", () => {
			const a = makeSub("u1", "sub-a");
			const a2 = { ...a, notes: "真改了" };
			expect(diff([a], [a2])).toEqual([{ type: "update", sub: a2 }]);
		});
	});
});
