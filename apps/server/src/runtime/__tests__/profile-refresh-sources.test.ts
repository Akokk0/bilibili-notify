import { type CreatorProfileReport, ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startProfileRefreshHarness } from "./profile-refresh-support.js";

const sub = (id: string, sourceKey: string, externalId: string, enabled = true): Subscription =>
	({ id, identity: { sourceKey, externalId }, enabled }) as Subscription;
const report = (name: string, followers = 100): CreatorProfileReport => ({ name, followers });

let close: (() => void) | undefined;
afterEach(() => {
	close?.();
	close = undefined;
});

describe("资料刷新按在册来源拉取", () => {
	it("只调在册来源的启用订阅;同一来源串行,不同来源并行", async () => {
		let releaseFirst = (): void => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted = false;
		const a = vi.fn(async (identity) => {
			if (identity.externalId === "a1") {
				firstStarted = true;
				await firstGate;
			}
			return ok(report(identity.externalId));
		});
		const b = vi.fn(async (identity) => ok(report(identity.externalId)));
		const p = await startProfileRefreshHarness({
			subscriptions: [
				sub("a1", "alpha", "a1"),
				sub("a2", "alpha", "a2"),
				sub("disabled", "alpha", "off", false),
				sub("outside", "outside", "x"),
			],
			sources: { alpha: a, beta: b },
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		const polling = p.handle.pollNow();
		await vi.waitFor(() => expect(firstStarted).toBe(true));
		await vi.waitFor(() =>
			expect(a).toHaveBeenCalledWith(
				{ sourceKey: "alpha", externalId: "a1" },
				expect.any(AbortSignal),
			),
		);
		expect(p.sourceCalls).toEqual([{ sourceKey: "alpha", externalId: "a1" }]);
		releaseFirst();
		await polling;

		expect(p.sourceCalls).toEqual([
			{ sourceKey: "alpha", externalId: "a1" },
			{ sourceKey: "alpha", externalId: "a2" },
		]);
		expect(b).not.toHaveBeenCalled();
	});

	it("两个在册来源各跑一条,不因为前一个来源没落定而等它", async () => {
		let releaseAlpha = (): void => {};
		const alphaGate = new Promise<void>((resolve) => {
			releaseAlpha = resolve;
		});
		const alpha = vi.fn(async () => {
			await alphaGate;
			return ok(report("alpha"));
		});
		const beta = vi.fn(async () => ok(report("beta")));
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("a", "alpha", "a"), sub("b", "beta", "b")],
			sources: { alpha, beta },
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
		};

		const polling = p.handle.pollNow();
		await vi.waitFor(() => expect(beta).toHaveBeenCalledTimes(1));
		expect(alpha).toHaveBeenCalledTimes(1);
		releaseAlpha();
		await polling;
	});
});
