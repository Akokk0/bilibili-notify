import { ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startProfileRefreshHarness } from "./profile-refresh-support.js";

const SUB = {
	id: "sub-1",
	identity: { sourceKey: "alpha", externalId: "creator-1" },
	enabled: true,
} as Subscription;

let close: (() => void) | undefined;
afterEach(() => {
	close?.();
	close = undefined;
});

describe("资料刷新代数", () => {
	it("清数据时在途的一轮停在读时序,放开后也不能把旧的订阅以来写回来", async () => {
		let pause = false;
		let cleared = false;
		let release = (): void => {};
		let started = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const findEarliest = vi.fn(async () => {
			if (cleared) return undefined;
			if (!pause) return { sampledAt: new Date(0).toISOString(), followers: 0 };
			pause = false;
			started = true;
			await gate;
			return { sampledAt: new Date(0).toISOString(), followers: 0 };
		});
		const fetchProfile = vi.fn(async () => ok({ name: "名字", followers: 500 }));
		const p = await startProfileRefreshHarness({
			subscriptions: [SUB],
			sources: { alpha: fetchProfile },
			findEarliest,
			findNearestBefore: async () =>
				cleared ? undefined : { sampledAt: new Date(0).toISOString(), followers: 0 },
			runtime: {
				"sub-1": {
					cachedProfile: {
						name: "名字",
						followers: 500,
						refreshedAt: new Date(0).toISOString(),
					},
				},
			},
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		pause = true;
		const polling = p.handle.pollNow();
		await vi.waitFor(() => expect(started).toBe(true));
		cleared = true;
		// 代数当场 +1,重算排在在途那轮后面;那轮卡在闸上,所以先放闸让它收手,reset 才轮得到。
		const resetting = p.handle.reset();
		release();
		await polling;
		await resetting;

		expect(p.handle.getLastEntries()).toEqual([
			{
				subscriptionId: "sub-1",
				identity: SUB.identity,
				current: 500,
				refreshedAt: expect.any(String),
				deltaSubscribed: null,
				delta24h: null,
				delta7d: null,
			},
		]);
	});
});
