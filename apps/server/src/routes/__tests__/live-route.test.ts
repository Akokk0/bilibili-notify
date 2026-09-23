/**
 * `GET /api/live/listening`:首页「正在直播」的数据源(ADR-0019 决策 12)。
 *
 * B 站那几行照直播引擎的快照原样交(形状一格不变);拓展订阅的在播从在播表来,按订阅 id 认、
 * 带 `kind: "extension"`,并在 B 站那几行后面。
 */

import type { LiveListenerSnapshot, LiveListeningEntry } from "@bilibili-notify/contract";
import type { Disposable } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionLiveTable } from "../../runtime/extension-live.js";
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
		viewers: "1.2万",
	},
];

const NO_TIMERS = { setTimeout: (): Disposable => ({ dispose() {} }) };

function setup(opts: { engines: boolean }) {
	const bus = createNodeMessageBus();
	const extensionLive = createExtensionLiveTable({ bus, timers: NO_TIMERS, now: () => T0 });
	const runtime = {
		engines: opts.engines ? { listLiveRooms: () => BILI_ROWS } : null,
		extensionLive,
	};
	const app = createLiveRoute({ runtime } as unknown as RouteDeps);
	async function listening(): Promise<LiveListeningEntry[]> {
		const res = await app.request("/listening");
		expect(res.status).toBe(200);
		return (await res.json()) as LiveListeningEntry[];
	}
	return { bus, listening };
}

describe("GET /api/live/listening", () => {
	it("只有 B 站在播:原样交,一格不多", async () => {
		const { listening } = setup({ engines: true });
		expect(await listening()).toStrictEqual(BILI_ROWS);
	});

	it("拓展订阅在播:并在 B 站那几行后面,按订阅 id 认、标着 kind;下播了就没了", async () => {
		const { bus, listening } = setup({ engines: true });
		bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-1",
			subscriptionIds: [EXT_SUB],
			report: {
				kind: "liveStart",
				value: {
					url: "https://live.douyin.com/1",
					startedAt: T0,
					title: "抖音这一场",
					category: "聊天",
					viewers: 30,
					cover: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				},
			},
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
				viewers: 30,
			},
		]);

		bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-1",
			subscriptionIds: [EXT_SUB],
			report: { kind: "liveEnd", value: { url: "https://live.douyin.com/1" } },
		});
		expect(await listening()).toStrictEqual(BILI_ROWS);
	});

	it("直播引擎还没挂上(开机早期):B 站那几行是空的,拓展的照样有", async () => {
		const { bus, listening } = setup({ engines: false });
		bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-1",
			subscriptionIds: [EXT_SUB],
			report: { kind: "liveStatus", value: { live: true } },
		});
		expect(await listening()).toStrictEqual([
			{ kind: "extension", subscriptionId: EXT_SUB, extensionId: "douyin", isLive: true },
		]);
	});
});
