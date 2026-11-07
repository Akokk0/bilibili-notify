import { fail, ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startProfileRefreshHarness } from "./profile-refresh-support.js";

const sub = (id: string, sourceKey: string, externalId: string): Subscription =>
	({ id, identity: { sourceKey, externalId }, enabled: true }) as Subscription;
const runtime = (name: string, followers: number) => ({
	cachedProfile: { name, followers, refreshedAt: new Date(0).toISOString() },
});

let close: (() => void) | undefined;
afterEach(() => {
	close?.();
	close = undefined;
});

describe("资料刷新单条失败", () => {
	it("失败行沿用上一次的数,别的订阅照刷,并记一条带码的 debug", async () => {
		const failed = vi.fn(async () =>
			fail("rate_limited", "upstream blocked", { upstreamCode: -352 }),
		);
		const healthy = vi.fn(async () => ok({ name: "新名字", followers: 220 }));
		const p = await startProfileRefreshHarness({
			subscriptions: [
				sub("bad", "alpha", "bad"),
				sub("good", "beta", "good"),
				sub("ext", "extension", "ext"),
			],
			sources: { alpha: failed, beta: healthy },
			findNearestBefore: async () => ({
				sampledAt: new Date(0).toISOString(),
				followers: 100,
			}),
			runtime: {
				bad: runtime("旧名字", 110),
				good: runtime("旧名字", 200),
				ext: runtime("拓展", 330),
			},
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		expect(await p.handle.pollNow()).toBe(true);
		expect(p.sourceCalls).toEqual([
			{ sourceKey: "alpha", externalId: "bad" },
			{ sourceKey: "beta", externalId: "good" },
		]);
		expect(p.handle.getLastEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ subscriptionId: "bad", current: 110 }),
				expect.objectContaining({ subscriptionId: "good", current: 220 }),
				expect.objectContaining({ subscriptionId: "ext", current: 330 }),
			]),
		);
		expect(p.logger.debug).toHaveBeenCalledWith("资料刷新未取得资料", {
			identity: { sourceKey: "alpha", externalId: "bad" },
			code: "rate_limited",
			upstreamCode: -352,
			message: "upstream blocked",
		});
	});
});
