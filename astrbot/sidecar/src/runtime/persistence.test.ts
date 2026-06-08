import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmptySubscription, type Subscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import { ASTRBOT_TARGET_ID } from "./callback-sink.js";
import {
	createAstrBotSubscription,
	JsonSubscriptionPersistence,
	normalizeAstrBotSubscription,
	resolveAstrBotDefaultTargetIds,
} from "./persistence.js";

describe("AstrBot sidecar subscription persistence", () => {
	it("creates AstrBot subscriptions with routes for enabled default features", () => {
		const subscription = createAstrBotSubscription(
			{
				uid: "123456",
				name: "测试 UP 主",
			},
			{ defaultTargetIds: [ASTRBOT_TARGET_ID] },
		);

		expect(subscription.uid).toBe("123456");
		expect(subscription.enabled).toBe(true);
		expect(subscription.routing.dynamic).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.routing.live).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.routing.liveEnd).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.routing.wordcloud).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.routing.liveSummary).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.routing.liveGuardBuy).toEqual([]);
		expect(subscription.routing.superchat).toEqual([]);
		expect(subscription.routing.specialDanmaku).toEqual([]);
		expect(subscription.routing.specialUserEnter).toEqual([]);
		expect(subscription.overrides).toEqual({});
	});

	it("keeps explicit minimal feature toggles as overrides", () => {
		const subscription = createAstrBotSubscription(
			{
				uid: "123456",
				name: "测试 UP 主",
				dynamic: false,
				live: false,
			},
			{ defaultTargetIds: [ASTRBOT_TARGET_ID] },
		);

		expect(subscription.routing.dynamic).toEqual([]);
		expect(subscription.routing.live).toEqual([]);
		expect(subscription.routing.liveEnd).toEqual([]);
		expect(subscription.routing.wordcloud).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.routing.liveSummary).toEqual([ASTRBOT_TARGET_ID]);
		expect(subscription.overrides.features).toEqual({
			dynamic: false,
			live: false,
			liveEnd: false,
		});
	});

	it("uses only enabled real AstrBot targets as subscription defaults", () => {
		expect(resolveAstrBotDefaultTargetIds([])).toEqual([]);
		expect(resolveAstrBotDefaultTargetIds([{ id: ASTRBOT_TARGET_ID, enabled: true }])).toEqual([]);
		expect(
			resolveAstrBotDefaultTargetIds([
				{ id: "22222222-2222-4222-8222-222222222222", enabled: false },
			]),
		).toEqual([]);
		expect(
			resolveAstrBotDefaultTargetIds([
				{ id: "22222222-2222-4222-8222-222222222222", enabled: false },
				{ id: "33333333-3333-4333-8333-333333333333", enabled: true },
			]),
		).toEqual(["33333333-3333-4333-8333-333333333333"]);
	});

	it("loads and saves subscriptions without overwriting explicit routing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-astrbot-sidecar-"));
		try {
			const filePath = join(dir, "subscriptions.json");
			const persistence = new JsonSubscriptionPersistence(filePath);
			const raw = makeEmptySubscription({
				id: "11111111-1111-4111-8111-111111111111",
				uid: "123456",
			});
			raw.routing.dynamic = ["22222222-2222-4222-8222-222222222222"];
			raw.routing.live = ["33333333-3333-4333-8333-333333333333"];
			raw.routing.liveEnd = ["44444444-4444-4444-8444-444444444444"];

			await writeFile(filePath, `${JSON.stringify([raw], null, 2)}\n`, "utf8");

			const loaded = (await persistence.load())[0];
			if (!loaded) {
				throw new Error("expected one loaded subscription");
			}
			expect(loaded).toMatchObject({
				uid: "123456",
				routing: {
					dynamic: ["22222222-2222-4222-8222-222222222222"],
					live: ["33333333-3333-4333-8333-333333333333"],
					liveEnd: ["44444444-4444-4444-8444-444444444444"],
				},
			});

			const normalized = normalizeAstrBotSubscription(loaded);
			await persistence.save([normalized]);
			const persisted = JSON.parse(await readFile(filePath, "utf8")) as Subscription[];
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.routing.dynamic).toEqual(["22222222-2222-4222-8222-222222222222"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
