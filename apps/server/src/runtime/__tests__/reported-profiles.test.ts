/**
 * 拓展报的资料更新落盘(`bindReportedProfiles`,ADR-0019 决策 7 / 49 / 62)—— 开机级那条
 * (`__tests__/reported-profile-e2e.test.ts`)钉的是「报了 → 订阅列表读得到」;这里钉它够不着的三件:
 *  - 一阵连着的资料更新,面板只被叫一次(一百条订阅不该刷出一百帧、一百次重取);
 *  - 订阅刚删、拓展还没收到通知时报来的,不再替它种资料、写头像(那就是孤儿,要等开机才扫);
 *  - 头像存不下来,名字与粉丝照样更新。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, SubscriptionReportDelivery } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { createNodeMessageBus } from "../message-bus.js";
import { bindReportedProfiles, type ReportedProfilesHandle } from "../reported-profiles.js";
import { createSubAvatarStore, type SubAvatarStore } from "../sub-avatar-store.js";
import { createSubRuntimeStore, type SubRuntimeStore } from "../sub-runtime-store.js";

const A = "d0000000-0000-4000-8000-000000000001";
const B = "d0000000-0000-4000-8000-000000000002";
const GONE = "d0000000-0000-4000-8000-000000000003";

function makeLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function profileReport(
	subscriptionIds: string[],
	value: { name?: string; fans?: number; avatar?: Uint8Array },
): SubscriptionReportDelivery {
	return {
		extensionId: "douyin",
		externalId: "person",
		subscriptionIds,
		report: { kind: "profile", value },
	};
}

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let subRuntime: SubRuntimeStore;
let avatars: SubAvatarStore;
let alive: string[];
let handle: ReportedProfilesHandle;
let announced: string[][];

function bind(over: { avatars?: SubAvatarStore } = {}): void {
	handle = bindReportedProfiles({
		bus,
		subRuntime,
		avatars: over.avatars ?? avatars,
		subscriptionIds: () => alive,
		logger: makeLogger(),
		coalesceMs: 30,
	});
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-reported-profiles-"));
	bus = createNodeMessageBus();
	subRuntime = createSubRuntimeStore({ dataDir, logger: makeLogger() });
	avatars = createSubAvatarStore({ dataDir, logger: makeLogger() });
	alive = [A, B];
	announced = [];
	bus.on("subscription-profiles-changed", (ids) => {
		announced.push([...ids].sort());
	});
});

afterEach(async () => {
	handle.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

describe("bindReportedProfiles", () => {
	it("一阵连着报了好几条:面板只被叫一次,带上变了的全部订阅", async () => {
		bind();
		bus.emit("subscription-reported", profileReport([A], { name: "甲" }));
		bus.emit("subscription-reported", profileReport([B], { name: "乙" }));
		bus.emit("subscription-reported", profileReport([A], { fans: 3 }));
		await handle.idle();

		await vi.waitFor(() => expect(announced).toEqual([[A, B]]));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(announced).toHaveLength(1);
		// 后报的粉丝没把先报的名字冲掉 —— 排成一条队处理。
		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({ name: "甲", fans: 3 });
		expect(subRuntime.get(B)?.cachedProfile).toMatchObject({ name: "乙" });
	});

	it("订阅已经不在了:不种资料、不写头像,也不叫面板", async () => {
		bind();
		bus.emit("subscription-reported", profileReport([GONE], { name: "丙", avatar: PNG_BYTES }));
		await handle.idle();
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(subRuntime.get(GONE)).toBeUndefined();
		await expect(readdir(join(dataDir, "avatars"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(announced).toEqual([]);
	});

	it("头像存不下来:名字与粉丝照样更新,头像留着原来那张", async () => {
		await subRuntime.patch(A, {
			cachedProfile: {
				name: "旧名字",
				avatar: `/api/subs/${A}/avatar?v=old`,
				sign: "",
				fans: 1,
				lastRefreshedAt: "2026-09-01T00:00:00.000Z",
			},
		});
		bind({
			avatars: {
				...avatars,
				writeBytes: vi.fn(async () => {
					throw new Error("盘满了");
				}),
			},
		});
		bus.emit("subscription-reported", profileReport([A], { name: "新名字", avatar: PNG_BYTES }));
		await handle.idle();

		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: `/api/subs/${A}/avatar?v=old`,
			fans: 1,
		});
	});

	it("别的种类的上报不碰资料", async () => {
		bind();
		bus.emit("subscription-reported", {
			...profileReport([A], {}),
			report: { kind: "liveStatus", value: { live: true } },
		});
		await handle.idle();
		expect(subRuntime.get(A)).toBeUndefined();
	});
});
