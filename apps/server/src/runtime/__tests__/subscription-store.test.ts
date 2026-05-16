/**
 * 单元测试 — `bindSubscriptionStore`(file-backed ConfigStore → 内存 SubscriptionStore)。
 *
 * 守护契约:
 *   - boot 即从 ConfigStore.getSubscriptions() seed(replaceAll)
 *   - 仅 `subscriptions` scope 的 onChange 触发 re-seed;其它 scope 忽略
 *   - re-seed 经内部 diff 在 bus 上 emit subscription-changed
 *   - dispose() 解绑 ConfigStore.onChange 订阅
 */

import type { ConfigScope, Subscription } from "@bilibili-notify/internal";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeMessageBus } from "../message-bus.js";
import { bindSubscriptionStore } from "../subscription-store.js";

const sub = (uid: string): Subscription => makeEmptySubscription({ id: `sub-${uid}`, uid });

function makeConfigStore(initial: Subscription[]) {
	let subs = initial;
	let handler: ((scope: ConfigScope) => void) | undefined;
	const disposeSpy = vi.fn();
	return {
		getSubscriptions: () => subs,
		onChange: (h: (scope: ConfigScope) => void) => {
			handler = h;
			return { dispose: disposeSpy };
		},
		_set: (next: Subscription[]) => {
			subs = next;
		},
		_fire: (scope: ConfigScope) => handler?.(scope),
		_disposeSpy: disposeSpy,
	};
}

let bus: ReturnType<typeof createNodeMessageBus>;
let changes: unknown[];
beforeEach(() => {
	bus = createNodeMessageBus();
	changes = [];
	bus.on("subscription-changed", (ops) => changes.push(ops));
});

describe("bindSubscriptionStore", () => {
	it("boot 即 seed,store 反映 ConfigStore 当前订阅", () => {
		const cs = makeConfigStore([sub("u1")]);
		const b = bindSubscriptionStore({ bus, configStore: cs as never });
		expect(b.store.list().map((s) => s.uid)).toEqual(["u1"]);
		// [] → [u1] 的 diff 经 bus emit。
		expect(changes.length).toBeGreaterThanOrEqual(1);
	});

	it("subscriptions scope 变更 → re-seed 并 emit diff", () => {
		const cs = makeConfigStore([sub("u1")]);
		const b = bindSubscriptionStore({ bus, configStore: cs as never });
		const before = changes.length;
		cs._set([sub("u1"), sub("u2")]);
		cs._fire("subscriptions");
		expect(b.store.list().map((s) => s.uid).sort()).toEqual(["u1", "u2"]);
		expect(changes.length).toBeGreaterThan(before);
	});

	it("非 subscriptions scope 被忽略(store 不变)", () => {
		const cs = makeConfigStore([sub("u1")]);
		const b = bindSubscriptionStore({ bus, configStore: cs as never });
		cs._set([sub("u1"), sub("u2"), sub("u3")]);
		cs._fire("globals");
		cs._fire("targets");
		cs._fire("secrets");
		expect(b.store.list().map((s) => s.uid)).toEqual(["u1"]); // 仍是 boot 时的快照
	});

	it("dispose() 解绑 ConfigStore.onChange", () => {
		const cs = makeConfigStore([sub("u1")]);
		const b = bindSubscriptionStore({ bus, configStore: cs as never });
		b.dispose();
		expect(cs._disposeSpy).toHaveBeenCalledTimes(1);
	});
});
