/**
 * `GET /api/live/listening`:首页「正在直播」的数据源(ADR-0019 决策 12)。
 *
 * 每条在播订阅一行,按订阅 id 认;身份从订阅仓补,面板不再按平台分两种快照。
 */

import type { LiveListeningEntry } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { createLiveTable } from "../../live/live-table.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createLiveRoute } from "../live.js";
import type { RouteDeps } from "../types.js";

const T0 = Date.UTC(2026, 8, 23, 12);
const BILI_SUB = "b0000000-0000-4000-8000-000000000001";
const EXT_SUB = "d0000000-0000-4000-8000-000000000001";
const MISSING_SUB = "d0000000-0000-4000-8000-000000000002";

const SUBS = [
	{ id: BILI_SUB, identity: { sourceKey: "bilibili", externalId: "42" } },
	{ id: EXT_SUB, identity: { sourceKey: "douyin", externalId: "sec-1" } },
];

function setup(opts: { pipeline: boolean }) {
	const bus = createNodeMessageBus();
	const liveTable = createLiveTable({ bus, now: () => T0 });
	const runtime = {
		pipeline: opts.pipeline ? {} : null,
		liveTable,
	};
	const app = createLiveRoute({
		runtime,
		store: { getSubscriptions: () => SUBS },
	} as unknown as RouteDeps);
	async function listening(): Promise<LiveListeningEntry[]> {
		const res = await app.request("/listening");
		expect(res.status).toBe(200);
		return (await res.json()) as LiveListeningEntry[];
	}
	return { liveTable, listening };
}

describe("GET /api/live/listening", () => {
	it("在播的每条订阅一行:带订阅 id 与 identity,没有 uid / roomId / 平台分支", async () => {
		const { liveTable, listening } = setup({ pipeline: true });
		liveTable.replace(BILI_SUB, "bilibili", T0 - 3_600_000, {
			title: "B 站这一间",
			category: "单机游戏",
			cover: { ref: `${"c".repeat(64)}.png` },
			currentViewers: 123,
			totalViewers: 12_000,
		});
		liveTable.replace(EXT_SUB, "douyin", T0, {
			title: "抖音这一场",
			category: "聊天",
			currentViewers: 12,
			totalViewers: 30,
		});

		expect(await listening()).toStrictEqual([
			{
				subscriptionId: BILI_SUB,
				identity: { sourceKey: "bilibili", externalId: "42" },
				isLive: true,
				title: "B 站这一间",
				category: "单机游戏",
				startedAt: "2026-09-23T11:00:00.000Z",
				totalViewers: 12_000,
			},
			{
				subscriptionId: EXT_SUB,
				identity: { sourceKey: "douyin", externalId: "sec-1" },
				isLive: true,
				title: "抖音这一场",
				category: "聊天",
				startedAt: new Date(T0).toISOString(),
				totalViewers: 30,
			},
		]);
		for (const row of await listening()) {
			expect(row).not.toHaveProperty("kind");
			expect(row).not.toHaveProperty("uid");
			expect(row).not.toHaveProperty("roomId");
			expect(row).not.toHaveProperty("cover");
			expect(row).not.toHaveProperty("areaName");
			expect(row).not.toHaveProperty("viewers");
		}
	});

	it("下播了就没了", async () => {
		const { liveTable, listening } = setup({ pipeline: true });
		liveTable.replace(EXT_SUB, "douyin", T0, { title: "这一场" });
		expect(await listening()).toHaveLength(1);

		liveTable.remove(EXT_SUB);
		expect(await listening()).toEqual([]);
	});

	it("订阅不在:表里残留的行也不列", async () => {
		const { liveTable, listening } = setup({ pipeline: true });
		liveTable.replace(MISSING_SUB, "douyin", T0, { title: "没有订阅的一行" });

		expect(await listening()).toEqual([]);
	});

	it("直播引擎还没挂上(开机早期):在播表里的行照样有", async () => {
		const { liveTable, listening } = setup({ pipeline: false });
		liveTable.merge(EXT_SUB, "douyin", undefined, {});

		expect(await listening()).toEqual([
			{
				subscriptionId: EXT_SUB,
				identity: { sourceKey: "douyin", externalId: "sec-1" },
				isLive: true,
			},
		]);
	});
});
