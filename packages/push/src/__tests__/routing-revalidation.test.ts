/**
 * 回归守护 — 退避重试期间的路由复检。
 *
 * bug 场景:某订阅同时路由到 target A / B。一次推送里 target A 暂时不可达
 * (如 OneBot WS 正在重连),`sendToTarget` 进入指数退避重试(最长约 190s:
 * 3s→6s→…→96s)。用户在这个重试窗口期间把 A 从该订阅的 routing 里移除
 * (取消勾选保存,或直接删掉这个 target)。此前 `sendToTarget` 只在**入口**
 * 捕获 `targetId`,重试循环全程不重新核对 routing —— 一旦 A 恢复可达,
 * 重试会照常把这条"已取消"的推送发出去,造成"明明取消了,还在继续推"的
 * 用户报告(History 记录会显示投递成功,即便 target 后续被整个删除,列表页
 * 也只是把它显示成"已删除目标",不代表投递发生在删除之前)。
 *
 * 修复后:`sendBatch`/`sendAtAllThenCard` 把订阅 id + feature 透传给
 * `sendToTarget`,重试循环每一轮先核对 targetId 是否仍在
 * `store.findById(subscriptionId).routing[feature]` 里,不在就放弃、不再调用 dispatcher.send。
 */

import type {
	DeliveryResult,
	PushTarget,
	ServiceContext,
	Subscription,
} from "@bilibili-notify/internal";
import {
	makeEmptySubscription,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vite-plus/test";
import { PushRouter } from "../push-router";
import { type FakeDispatcher, pushBase, silentLogger } from "./helpers";

/** 受控 serviceCtx:setTimeout 只登记,不自动触发,由测试手动 fire。 */
function makeControlledServiceCtx(): { ctx: ServiceContext; pending: Array<() => void> } {
	const pending: Array<() => void> = [];
	const ctx: ServiceContext = {
		logger: silentLogger,
		setInterval: vi.fn(),
		setTimeout: (fn) => {
			pending.push(fn);
			return {
				dispose: () => {
					const idx = pending.indexOf(fn);
					if (idx >= 0) pending.splice(idx, 1);
				},
			};
		},
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	return { ctx, pending };
}

function makeStore(...initial: Subscription[]): SubscriptionStore {
	let subs = [...initial];
	return {
		list: () => [...subs],
		findByIdentity: (identity) =>
			subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: (next) => {
			subs = [...next];
		},
	};
}

describe("PushRouter — 退避重试期间的路由复检", () => {
	it("重试等待期间 target 被移出 routing → 恢复可达后不再发送(dispatcher.send 从未被调)", async () => {
		const { ctx, pending } = makeControlledServiceCtx();

		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["target-a", "target-b"];
		const store = makeStore(sub);

		// target-a 起初不可达(触发 sleep 重试),之后翻可达。
		let aAvailable = false;
		const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, latencyMs: 1 }));
		const dispatcher: FakeDispatcher = {
			isAvailable: (id) => (id === "target-a" ? aAvailable : true),
			isEnabled: () => true,
			send: () => send(),
			resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
		};

		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store,
			logger: silentLogger,
			serviceCtx: ctx,
		});
		push.start();

		const resultPromise = push.sendToTarget(
			"target-a",
			{ kind: "text", text: "x" },
			{
				routing: { subscriptionId: "sub-1", feature: "post" },
			},
		);

		// 让 sendToTarget 跑到第一次 sleep 调用
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(pending.length).toBeGreaterThanOrEqual(1);
		expect(send).not.toHaveBeenCalled();

		// 用户在重试等待期间把 target-a 从该订阅的 dynamic routing 里移除。
		sub.routing.post = ["target-b"];

		// 退避到点 + target-a 恢复可达。
		aAvailable = true;
		const fire = pending.shift();
		fire?.();

		const result = await resultPromise;

		// 核心断言:target-a 已不在 routing 里,即便它现在可达,也绝不能真的发出去。
		expect(send).not.toHaveBeenCalled();
		// 与当前路由冲突(ADR-0026 的 conflict):不是对端坏了,是这条推送自己过期了。
		expect(result).toMatchObject({ ok: false, code: "conflict" });
		expect(!result.ok && result.message).toContain("target-a");
		expect(!result.ok && result.message).toContain("移除");
	});

	it("routing 期间保持不变 → 重试成功后正常发送(不误伤正常场景)", async () => {
		const { ctx, pending } = makeControlledServiceCtx();

		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["target-a"];
		const store = makeStore(sub);

		let available = false;
		const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, latencyMs: 1 }));
		const dispatcher: FakeDispatcher = {
			isAvailable: () => available,
			isEnabled: () => true,
			send: () => send(),
			resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
		};

		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store,
			logger: silentLogger,
			serviceCtx: ctx,
		});
		push.start();

		const resultPromise = push.sendToTarget(
			"target-a",
			{ kind: "text", text: "x" },
			{
				routing: { subscriptionId: "sub-1", feature: "post" },
			},
		);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(pending.length).toBeGreaterThanOrEqual(1);

		available = true;
		const fire = pending.shift();
		fire?.();

		const result = await resultPromise;
		expect(send).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
	});

	/**
	 * 同一个 uid 配了两条订阅、都路由到同一个目标。按 uid 复检的话「先出现的那条说了算」——
	 * B 删掉了,A 还路由着这个目标,B 那条推送就会继续重试、目标一恢复照样发出去。
	 * 复检认的是**这条推送自己那条订阅**(ADR-0019 决策 50)。
	 */
	it("同 uid 的 A、B 都路由到同一目标,重试中把 B 删掉 → B 那条放弃(A 还路由着也不算)", async () => {
		const { ctx, pending } = makeControlledServiceCtx();

		const a = makeEmptySubscription({
			id: "sub-a",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		a.routing.post = ["target-a"];
		const b = makeEmptySubscription({
			id: "sub-b",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		b.routing.post = ["target-a"];
		const store = makeStore(a, b);

		let available = false;
		const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, latencyMs: 1 }));
		const dispatcher: FakeDispatcher = {
			isAvailable: () => available,
			isEnabled: () => true,
			send: () => send(),
			resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
		};

		const push = new PushRouter({
			...pushBase(),
			dispatcher,
			store,
			logger: silentLogger,
			serviceCtx: ctx,
		});
		push.start();

		const resultPromise = push.sendToTarget(
			"target-a",
			{ kind: "text", text: "x" },
			{ routing: { subscriptionId: "sub-b", feature: "post" } },
		);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(pending.length).toBeGreaterThanOrEqual(1);

		// 重试等待期间 B 被删掉;A 原样留着,还路由着 target-a。
		store.replaceAll([a]);

		available = true;
		const fire = pending.shift();
		fire?.();

		const result = await resultPromise;
		expect(send).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: false, code: "conflict" });
		expect(!result.ok && result.message).toContain("移除");
	});
});
