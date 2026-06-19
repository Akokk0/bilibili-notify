/**
 * 回归守护 — P1-B 短期-a:BilibiliPush.stop() 唤醒 sleepWakers,retry 循环立即收敛。
 *
 * 不变量:sendToTarget 在 target 持续不可达 → 进入 sleep retry 循环;若此时 stop()
 * 触发,sleep 应立即返回,sendToTarget 在下一轮检测 disposed=true 后返回失败结果,
 * 不必等到 32s backoff 全跑完。
 *
 * 关键 bug 复发点:任何人重构 stop() 漏调 sleepWakers wake / 或者把 sleep 改回
 * 裸 setTimeout 但忘了对接 wake,这条契约立刻挂。
 */

import type {
	DeliveryResult,
	Logger,
	NotificationSink,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vite-plus/test";
import { BilibiliPush } from "../bilibili-push";

const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function makeUnreachableSink(): NotificationSink {
	return {
		isAvailable: () => false, // 永远不可达 → sendToTarget 进入 sleep retry 循环
		send: async (): Promise<DeliveryResult> => ({ ok: false, latencyMs: 0, err: "unreachable" }),
		sendPrivate: async (): Promise<DeliveryResult> => ({
			ok: false,
			latencyMs: 0,
			err: "unreachable",
		}),
		resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
	};
}

const emptyStore = { list: () => [] } as unknown as SubscriptionStore;

describe("BilibiliPush.stop() — P1-B 短期-a sleepWakers 唤醒", () => {
	it("fake serviceCtx 永不自动 fire timer:sendToTarget 必须靠 stop() 唤醒才返回", async () => {
		// 这个 fake setTimeout 故意不自动 invoke fn — 把 sleep 拘在 pending 态。
		// 任何"伪造唤醒"或被 release.dispose 误触发的代码路径都会让本 case 在
		// stop() 之前就提前 resolve;断言会因此失败。
		const pendingTimers: Array<() => void> = [];
		const fakeServiceCtx: ServiceContext = {
			logger: silentLogger,
			setInterval: vi.fn(),
			setTimeout: (fn) => {
				pendingTimers.push(fn);
				// dispose 仅从 pendingTimers 移除,**不** invoke fn(否则就退化成 setTimeout(0))
				return {
					dispose: () => {
						const idx = pendingTimers.indexOf(fn);
						if (idx >= 0) pendingTimers.splice(idx, 1);
					},
				};
			},
			onDispose: () => {},
		};

		const push = new BilibiliPush({
			sink: makeUnreachableSink(),
			store: emptyStore,
			logger: silentLogger,
			serviceCtx: fakeServiceCtx,
		});
		push.start();

		let settled = false;
		const sendPromise = push.sendToTarget("target-x", { kind: "text", text: "x" }).then((r) => {
			settled = true;
			return r;
		});

		// 给 sendToTarget 跑到第一次 sleep 调用的机会
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		// 关键断言 #1:stop() 之前 sendPromise 必须 pending。
		// 如果 wake 逻辑被改坏,setTimeout 在 fake 下永不 fire,Promise 永远不 resolve,
		// settled 应保持 false。
		expect(settled).toBe(false);
		expect(pendingTimers.length).toBeGreaterThanOrEqual(1);

		// 关键断言 #2:stop() 后必须立即 wake → sleep resolve → 下一轮 disposed=true → return。
		push.stop();
		const result = await sendPromise;
		expect(settled).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.err).toBe("disposed");
	});

	it("P2-C:stop()→start() 不复活上一生命周期遗留的 in-flight retry(generation 守卫)", async () => {
		const pendingTimers: Array<() => void> = [];
		const fakeServiceCtx: ServiceContext = {
			logger: silentLogger,
			setInterval: vi.fn(),
			setTimeout: (fn) => {
				pendingTimers.push(fn);
				return {
					dispose: () => {
						const idx = pendingTimers.indexOf(fn);
						if (idx >= 0) pendingTimers.splice(idx, 1);
					},
				};
			},
			onDispose: () => {},
		};

		// available 初始 false → 进入 sleep retry;stop()+start() 后翻 true:
		// 若 in-flight 循环"复活",它会在下一轮看到 available 并真的 send()。
		let available = false;
		const send = vi.fn(
			async (): Promise<DeliveryResult> => ({ ok: true, latencyMs: 1 }) as DeliveryResult,
		);
		const sink: NotificationSink = {
			isAvailable: () => available,
			send,
			sendPrivate: async (): Promise<DeliveryResult> => ({ ok: false, latencyMs: 0 }),
			resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
		};

		const push = new BilibiliPush({
			sink,
			store: emptyStore,
			logger: silentLogger,
			serviceCtx: fakeServiceCtx,
		});
		push.start(); // generation 1

		const sendPromise = push.sendToTarget("t", { kind: "text", text: "x" });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(pendingTimers.length).toBeGreaterThanOrEqual(1); // 卡在 sleep

		// 旧生命周期结束 + 立刻重启(generation → 2);并让 target 变可达
		push.stop();
		push.start(); // generation 2
		available = true;

		const result = await sendPromise;
		// generation 守卫:in-flight 循环 myGen=1 ≠ 当前 2 → 直接退出,
		// 绝不在新生命周期上 send()。
		expect(result.ok).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("②7:sendBatch 跨 stop()→start() 不拆发剩余目标、不记录边界 artifact", async () => {
		const sent: string[] = [];
		let push!: BilibiliPush;
		const send = vi.fn(async (id: string): Promise<DeliveryResult> => {
			sent.push(id);
			// 第一个目标投递期间发生 stop()→start()(generation 1→2)。
			if (id === "a") {
				push.stop();
				push.start();
			}
			return { ok: true, latencyMs: 1 };
		});
		const sink: NotificationSink = {
			isAvailable: () => true,
			send: (id) => send(id),
			sendPrivate: async (): Promise<DeliveryResult> => ({ ok: false, latencyMs: 0 }),
			resolve: (id) => ({ id, name: id, platform: "test" }) as unknown as PushTarget,
		};
		const onSend = vi.fn();
		push = new BilibiliPush({ sink, store: emptyStore, logger: silentLogger, onSend });
		push.start(); // generation 1

		const results = await push.sendBatch(
			["a", "b"],
			{ kind: "text", text: "x" },
			{
				uid: "u1",
				feature: "live",
			},
		);

		// 仅 "a" 触达 sink;generation 1→2 后 "b" 被放弃,不跨生命周期拆发。
		expect(sent).toEqual(["a"]);
		// 边界 artifact("a" 完成时 lifecycle 已翻)不 onSend / 不计入 results。
		expect(onSend).not.toHaveBeenCalled();
		expect(results).toEqual([]);
	});

	it("不传 serviceCtx(退化路径)也能被 stop() 唤醒", async () => {
		const push = new BilibiliPush({
			sink: makeUnreachableSink(),
			store: emptyStore,
			logger: silentLogger,
			// 故意不传 serviceCtx,走 sleep 内裸 setTimeout 路径
		});
		push.start();

		const sendPromise = push.sendToTarget("target-y", { kind: "text", text: "y" });
		await new Promise((r) => setImmediate(r));
		const t0 = Date.now();
		push.stop();
		const result = await sendPromise;
		expect(result.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(100); // < 3s backoff
	});
});
