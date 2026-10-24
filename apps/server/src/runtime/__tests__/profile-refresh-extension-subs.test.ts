import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { ProfileRefreshHandle } from "../profile-refresh.js";
import { startMigratedProfileRefresh } from "./profile-refresh-support.js";

/**
 * 粉丝轮询与拓展订阅(ADR-0019 决策 12 / 47)。
 *
 * - 粉丝曲线第一版只有 B 站订阅:拓展订阅没有 uid,不能拿它去问 B 站。
 * - 🔴 但删订阅之后那次资料缓存清理,保留名单必须是**两支的全部 id** —— 否则每删一条
 *   B 站订阅,拓展订阅的资料缓存就被当成孤儿静默抹掉。
 */

// cron 换成不排程的假货(同 profile-refresh-track 等的套路)。真的 CronJob 按墙钟每 10 分钟整点放一轮 tick,
// 不归 serviceCtx 管:用例跨过整点时它会插进来多跑一轮。
vi.mock("cron", () => ({
	CronJob: class {
		start(): void {}
		stop(): void {}
	},
}));

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;
const BILI = {
	id: "b1",
	identity: { sourceKey: "bilibili", externalId: "1" },
	enabled: true,
} as const;
const EXT = makeExtensionSubscription({ id: "e1", externalId: "1" });

let handle: ProfileRefreshHandle | undefined;
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

function start(list: () => unknown[]) {
	const bus = createNodeMessageBus();
	const prune = vi.fn(async (_keep: readonly string[]) => {});
	const dropUid = vi.fn(async (_uid: string) => {});
	const fetchUserCard = vi.fn(async () => ({
		data: { card: { name: "甲", fans: 123 } },
	}));
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list } as never,
		subscriptionStateStore: {
			get: vi.fn(() => ({
				cachedProfile: { name: "甲", followers: 1, refreshedAt: "x" },
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
			fetchUserCard,
		} as never,
		// 不放行启动那次延时 tick:只看各用例自己触发的那一轮。
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
	});
	return { bus, prune, dropUid, fetchUserCard, handle };
}

describe("profile refresh × 拓展订阅", () => {
	it("只调在册来源、拓展订阅不调", async () => {
		const { fetchUserCard, handle: h } = start(() => [BILI, EXT]);
		expect(await h.pollNow()).toBe(true);
		expect(fetchUserCard).toHaveBeenCalledTimes(1);
		expect(fetchUserCard).toHaveBeenCalledWith("1");
		expect(h.getLastEntries().map((e) => e.identity.externalId)).toEqual(["1"]);
	});

	it("删掉一条 B 站订阅 → 资料缓存的保留名单里仍有拓展订阅", async () => {
		// 事件到的时候订阅仓已经是删完的样子(config-changed → replaceAll → subscription-changed)。
		const { bus, prune, dropUid } = start(() => [EXT]);
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: BILI as never }] });
		expect(prune).toHaveBeenCalledWith(["e1"]);
		// 粉丝文件按订阅 id 命名(ADR-0020 决策 2 的 🔗),删的是这条订阅的 id,不是 uid。
		await vi.waitFor(() => expect(dropUid).toHaveBeenCalledWith("b1"));
	});

	it("删掉一条拓展订阅 → 照样清资料缓存,粉丝文件交给记录器删", async () => {
		const { bus, prune, dropUid } = start(() => [BILI]);
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: EXT }] });
		expect(prune).toHaveBeenCalledWith(["b1"]);
		await vi.waitFor(() => expect(dropUid).toHaveBeenCalledWith("e1"));
	});
});
