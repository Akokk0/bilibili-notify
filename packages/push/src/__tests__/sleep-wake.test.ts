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
import { describe, expect, it, vi } from "vitest";
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
		resolve: (id) => ({ id, name: id, platform: "test" }) as PushTarget,
	};
}

const emptyStore = { list: () => [] } as unknown as SubscriptionStore;

describe("BilibiliPush.stop() — P1-B 短期-a sleepWakers 唤醒", () => {
	it("target 持续不可达进入 sleep,stop() 后 sendToTarget 立即返回(不等 backoff)", async () => {
		const fakeServiceCtx: ServiceContext = {
			logger: silentLogger,
			setInterval: vi.fn(),
			setTimeout: (fn, _ms) => {
				// 立即调用 fn —— 在 fake serviceCtx 下"零延迟",但实际行为靠 stop() 唤醒
				// 这里返回一个 Disposable 句柄,sleep release 调用即可
				const handle = setTimeout(fn, 0);
				return { dispose: () => clearTimeout(handle) };
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

		// 启动 send,target 不可达 → sleep 3s + 重试。
		const sendPromise = push.sendToTarget("target-x", { kind: "text", text: "x" });

		// 给 sendToTarget 跑到第一次 sleep 调用的机会
		await new Promise((r) => setImmediate(r));

		// stop() 应该立即唤醒 sleepWakers,sleep 立刻 resolve,下一轮 disposed=true → 返回
		const t0 = Date.now();
		push.stop();
		const result = await sendPromise;
		const elapsed = Date.now() - t0;

		expect(result.ok).toBe(false);
		expect(result.err).toBe("disposed");
		// 即使 fake serviceCtx 的 setTimeout(0) 也有几 ms 抖动,放宽到 100ms 上限。
		// 关键是远小于 INITIAL_RETRY_DELAY_MS=3000。
		expect(elapsed).toBeLessThan(100);
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
