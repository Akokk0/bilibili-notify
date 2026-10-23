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

describe("资料刷新与订阅生命周期", () => {
	it("拉资料途中删了订阅,不写粉丝样本", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = false;
		const fetchProfile = vi.fn(async () => {
			started = true;
			await gate;
			return ok({ name: "名字", followers: 222 });
		});
		const p = await startProfileRefreshHarness({
			subscriptions: [SUB],
			sources: { alpha: fetchProfile },
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		const polling = p.handle.pollNow();
		await vi.waitFor(() => expect(started).toBe(true));
		p.setSubscriptions([]);
		release();
		await polling;

		expect(p.recordFollowers).not.toHaveBeenCalled();
	});
});
