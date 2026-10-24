import { type ImageRef, ok, type Subscription } from "@bilibili-notify/internal";
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

describe("资料刷新写资料缓存", () => {
	it("名字或头像变了只发一次 subscription-profiles-changed;没变不再发", async () => {
		const avatar = "new-avatar" as ImageRef;
		const fetchProfile = vi.fn(async () =>
			ok({ name: "新名字", avatar, bio: "新签名", followers: 120 }),
		);
		const p = await startProfileRefreshHarness({
			subscriptions: [SUB],
			sources: { alpha: fetchProfile },
			runtime: {
				"sub-1": {
					cachedProfile: {
						name: "旧名字",
						avatar: "old-avatar" as ImageRef,
						followers: 100,
						refreshedAt: new Date(0).toISOString(),
					},
				},
			},
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		expect(await p.handle.pollNow()).toBe(true);
		expect(p.sourceCalls).toEqual([{ sourceKey: "alpha", externalId: "creator-1" }]);
		expect(p.logger.warn).not.toHaveBeenCalled();
		expect(p.runtime.get("sub-1")?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar,
			bio: "新签名",
			followers: 120,
		});
		await vi.waitFor(() => expect(p.changed).toEqual([["sub-1"]]));

		await p.handle.pollNow();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(p.changed).toEqual([["sub-1"]]);
	});
});
