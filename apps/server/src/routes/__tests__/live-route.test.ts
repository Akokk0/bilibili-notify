/**
 * `GET /api/live/listening`:首页「正在直播」的数据源(ADR-0019 决策 12)。
 *
 * B 站那几行照直播引擎的快照原样交(形状一格不变);拓展订阅的在播从在播表来,按订阅 id 认、
 * 带 `kind: "extension"`,并在 B 站那几行后面。
 */

import type { LiveListenerSnapshot, LiveListeningEntry } from "@bilibili-notify/contract";
import type { Disposable } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createLiveTable } from "../../live/live-table.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createLiveRoute } from "../live.js";
import type { RouteDeps } from "../types.js";

const T0 = Date.UTC(2026, 8, 23, 12);
const EXT_SUB = "d0000000-0000-4000-8000-000000000001";

const BILI_ROWS: LiveListenerSnapshot[] = [
	{
		subscriptionId: "s-bili",
		uid: "42",
		roomId: "100",
		isLive: true,
		title: "B 站这一间",
		cover: "https://i0.hdslb.com/cover.jpg",
		areaName: "单机游戏",
		startedAt: "2026-09-23T11:00:00.000Z",
		viewers: 12_000,
	},
];

const NO_TIMERS = { setTimeout: (): Disposable => ({ dispose() {} }) };

function setup(opts: { engines: boolean }) {
	const bus = createNodeMessageBus();
	const liveTable = createLiveTable({ bus, timers: NO_TIMERS, now: () => T0 });
	const runtime = {
		engines: opts.engines ? { listLiveRooms: () => BILI_ROWS } : null,
		liveTable,
	};
	const app = createLiveRoute({ runtime } as unknown as RouteDeps);
	async function listening(): Promise<LiveListeningEntry[]> {
		const res = await app.request("/listening");
		expect(res.status).toBe(200);
		return (await res.json()) as LiveListeningEntry[];
	}
	return { bus, liveTable, listening };
}

describe("GET /api/live/listening", () => {
	it("只有 B 站在播:原样交,一格不多", async () => {
		const { listening } = setup({ engines: true });
		expect(await listening()).toStrictEqual(BILI_ROWS);
	});

	it("拓展订阅在播:并在 B 站那几行后面,按订阅 id 认、标着 kind;下播了就没了", async () => {
		const { liveTable, listening } = setup({ engines: true });
		// 场次引擎收到开播信号时写表的样子。
		liveTable.replace(EXT_SUB, "douyin", T0, {
			url: "https://live.douyin.com/1",
			title: "抖音这一场",
			category: "聊天",
			currentViewers: 12,
			totalViewers: 30,
			cover: { ref: `${"c".repeat(64)}.png` },
		});
		expect(await listening()).toStrictEqual([
			...BILI_ROWS,
			{
				kind: "extension",
				subscriptionId: EXT_SUB,
				extensionId: "douyin",
				isLive: true,
				title: "抖音这一场",
				areaName: "聊天",
				startedAt: new Date(T0).toISOString(),
				// 那一列是累计观看(决策 75);此刻在线不上面板。
				totalViewers: 30,
			},
		]);

		liveTable.remove(EXT_SUB);
		expect(await listening()).toStrictEqual(BILI_ROWS);
	});

	it("直播引擎还没挂上(开机早期):B 站那几行是空的,拓展的照样有", async () => {
		const { liveTable, listening } = setup({ engines: false });
		liveTable.merge(EXT_SUB, "douyin", undefined, {});
		expect(await listening()).toStrictEqual([
			{ kind: "extension", subscriptionId: EXT_SUB, extensionId: "douyin", isLive: true },
		]);
	});
});
