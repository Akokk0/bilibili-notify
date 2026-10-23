import { ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startProfileRefreshHarness } from "./profile-refresh-support.js";

const sub = (id: string, sourceKey: string, externalId: string, enabled = true): Subscription =>
	({ id, identity: { sourceKey, externalId }, enabled }) as Subscription;

let close: (() => void) | undefined;
afterEach(() => {
	close?.();
	close = undefined;
});

describe("资料刷新单条订阅", () => {
	it("只拉这一条、写缓存、发一次 followers-refreshed", async () => {
		const alpha = vi.fn(async () => ok({ name: "新名字", followers: 120 }));
		const beta = vi.fn(async () => ok({ name: "另一条", followers: 220 }));
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("sub-1", "alpha", "creator-1"), sub("sub-2", "beta", "creator-2")],
			sources: { alpha, beta },
			findNearestBefore: async () => ({
				sampledAt: new Date(0).toISOString(),
				followers: 100,
			}),
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};
		p.snapshots.length = 0;

		await p.handle.refreshSubscription("sub-1");

		expect(alpha).toHaveBeenCalledTimes(1);
		expect(beta).not.toHaveBeenCalled();
		expect(p.runtime.get("sub-1")?.cachedProfile).toMatchObject({
			name: "新名字",
			fans: 120,
		});
		expect(p.snapshots).toHaveLength(1);
		expect(p.snapshots[0]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ subscriptionId: "sub-1", current: 120 }),
				expect.objectContaining({ subscriptionId: "sub-2", current: 100 }),
			]),
		);
	});

	it("不在册 / 停用：不调来源", async () => {
		const alpha = vi.fn(async () => ok({ name: "不该拉" }));
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("outside", "outside", "x"), sub("disabled", "alpha", "off", false)],
			sources: { alpha },
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};
		p.snapshots.length = 0;

		await p.handle.refreshSubscription("outside");
		await p.handle.refreshSubscription("disabled");

		expect(alpha).not.toHaveBeenCalled();
		expect(p.snapshots).toEqual([]);
	});
});
