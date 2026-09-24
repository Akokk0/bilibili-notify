import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { type FansPollerHandle, startFansPoller } from "../fans-poller.js";
import { createNodeMessageBus } from "../message-bus.js";

/**
 * 粉丝轮询与拓展订阅(ADR-0019 决策 12 / 47)。
 *
 * - 粉丝曲线第一版只有 B 站订阅:拓展订阅没有 uid,不能拿它去问 B 站。
 * - 🔴 但删订阅之后那次资料缓存清理,保留名单必须是**两支的全部 id** —— 否则每删一条
 *   B 站订阅,拓展订阅的资料缓存就被当成孤儿静默抹掉。
 */

const GLOBALS = { app: { fansCron: "*/10 * * * *" } } as never;
const BILI = { kind: "bilibili", id: "b1", uid: "1", enabled: true } as const;
const EXT = makeExtensionSubscription({ id: "e1", externalId: "1" });

let handle: FansPollerHandle | undefined;
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

function start(list: () => unknown[]) {
	const bus = createNodeMessageBus();
	const prune = vi.fn(async (_keep: readonly string[]) => {});
	const dropUid = vi.fn(async (_uid: string) => {});
	const getRelationStat = vi.fn(async () => ({ code: 0, data: { follower: 123 } }));
	handle = startFansPoller({
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list } as never,
		subRuntimeStore: {
			get: vi.fn(() => ({
				cachedProfile: { name: "甲", avatar: "a", fans: 1, lastRefreshedAt: "x" },
			})),
			getAll: () => ({}),
			patch: vi.fn(async () => {}),
			prune,
			load: vi.fn(async () => {}),
		} as never,
		fansStore: {
			append: vi.fn(async () => {}),
			findNearestBefore: vi.fn(async () => null),
			findEarliest: vi.fn(async () => undefined),
			drop: dropUid,
		} as never,
		api: {
			getUserCardsBatch: vi.fn(async () => ({ code: 0, data: {} })),
			getRelationStat,
			getUserCardInfo: vi.fn(),
		} as never,
		// 不放行启动那次延时 tick:只看各用例自己触发的那一轮。
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
		} as never,
	});
	return { bus, prune, dropUid, getRelationStat, handle };
}

describe("fans poller × 拓展订阅", () => {
	it("只问 B 站订阅的粉丝数 —— 外部 id 恰好是同一串数字也不拿去问", async () => {
		const { getRelationStat, handle: h } = start(() => [BILI, EXT]);
		expect(await h.pollNow()).toBe(true);
		expect(getRelationStat).toHaveBeenCalledTimes(1);
		expect(getRelationStat).toHaveBeenCalledWith("1");
		expect(h.getLastEntries().map((e) => e.uid)).toEqual(["1"]);
	});

	it("删掉一条 B 站订阅 → 资料缓存的保留名单里仍有拓展订阅", () => {
		// 事件到的时候订阅仓已经是删完的样子(config-changed → replaceAll → subscription-changed)。
		const { bus, prune, dropUid } = start(() => [EXT]);
		bus.emit("subscription-changed", [{ type: "remove", sub: BILI as never }]);
		expect(prune).toHaveBeenCalledWith(["e1"]);
		// 粉丝文件按订阅 id 命名(ADR-0020 决策 2 的 🔗),删的是这条订阅的 id,不是 uid。
		expect(dropUid).toHaveBeenCalledWith("b1");
	});

	it("删掉一条拓展订阅 → 照样清资料缓存,不碰粉丝时序", () => {
		const { bus, prune, dropUid } = start(() => [BILI]);
		bus.emit("subscription-changed", [{ type: "remove", sub: EXT }]);
		expect(prune).toHaveBeenCalledWith(["b1"]);
		expect(dropUid).not.toHaveBeenCalled();
	});
});
