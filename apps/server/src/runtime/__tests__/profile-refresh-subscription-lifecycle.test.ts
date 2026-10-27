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

const ALPHA_A = {
	id: "sub-a",
	identity: { sourceKey: "alpha", externalId: "creator-a" },
	enabled: true,
} as Subscription;
const ALPHA_B = {
	id: "sub-b",
	identity: { sourceKey: "alpha", externalId: "creator-b" },
	enabled: true,
} as Subscription;
const SAMPLE_AT = "2026-01-01T00:00:00.000Z";

describe("资料刷新与订阅生命周期", () => {
	it("整轮刷新途中删掉的订阅,不会因为整份写回又回到面板", async () => {
		// 第一轮(开机恢复)先走完,让 lastBySub 里本来就有 A、B;闸只卡第二轮。
		let armed = false;
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let earliestStarted = false;
		const p = await startProfileRefreshHarness({
			subscriptions: [ALPHA_A, ALPHA_B],
			sources: { alpha: async () => ok({ name: "名字", followers: 300 }) },
			findNearestBefore: async () => ({ sampledAt: SAMPLE_AT, followers: 100 }),
			findEarliest: async (key: string) => {
				if (armed && key === ALPHA_B.id) {
					earliestStarted = true;
					await gate;
				}
				return { sampledAt: SAMPLE_AT, followers: 100 };
			},
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		armed = true;
		const polling = p.handle.pollNow();
		await vi.waitFor(() => expect(earliestStarted).toBe(true));
		// A 已经算进这一轮的局部结果;B 还卡着,这时删 A。
		p.setSubscriptions([ALPHA_B]);
		p.bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: ALPHA_A }] });
		release();
		await polling;

		expect(p.handle.getLastEntries().map((entry) => entry.subscriptionId)).not.toContain(
			ALPHA_A.id,
		);
		expect(p.snapshots.at(-1)?.map((entry) => entry.subscriptionId) ?? []).not.toContain(
			ALPHA_A.id,
		);
	});

	it("只重算报来的几行途中删掉的另一条订阅,不会因为整份写回又回到面板", async () => {
		let armed = false;
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let earliestStarted = false;
		const p = await startProfileRefreshHarness({
			subscriptions: [ALPHA_A, ALPHA_B],
			sources: { alpha: async () => ok({ name: "名字", followers: 300 }) },
			findNearestBefore: async () => ({ sampledAt: SAMPLE_AT, followers: 100 }),
			findEarliest: async (key: string) => {
				if (armed && key === ALPHA_A.id) {
					earliestStarted = true;
					await gate;
				}
				return { sampledAt: SAMPLE_AT, followers: 100 };
			},
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		armed = true;
		const recomputing = p.handle.refreshReportedEntries([ALPHA_A.id]);
		await vi.waitFor(() => expect(earliestStarted).toBe(true));
		// 这一路只算 A,却复制了整张旧表;B 在算的途中被删。
		p.setSubscriptions([ALPHA_A]);
		p.bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: ALPHA_B }] });
		release();
		await recomputing;

		expect(p.handle.getLastEntries().map((entry) => entry.subscriptionId)).not.toContain(
			ALPHA_B.id,
		);
		expect(p.snapshots.at(-1)?.map((entry) => entry.subscriptionId) ?? []).not.toContain(
			ALPHA_B.id,
		);
	});

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
