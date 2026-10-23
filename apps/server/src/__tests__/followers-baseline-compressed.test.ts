/**
 * 统计总览的「窗口之前最近的一条样本当基线」在**压缩过的文件**上也对:窗口起点落在一段(`lastSampledAt`)的中间时,
 * 基线是这段的值(经 `findNearestBefore` 展开读口,不是段起点那个旧时刻),窗口首日的净增照算。
 *
 * 真粉丝仓、真文件;期望全是手写字面量。只假装 Date。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFollowersStore, FOLLOWERS_DIR } from "../followers/store.js";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";

const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
const SUB = {
	id: "b-seg",
	identity: { sourceKey: "bilibili", externalId: "1" },
	enabled: true,
} as never as Subscription;

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-followers-baseline-"));
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	// 压缩过的文件:06-10 00:50 到 06-26 10:50 每个小时末都是 500(一段),之后两个点。
	await writeFile(
		join(dataDir, ...FOLLOWERS_DIR, "b-seg.jsonl"),
		[
			{
				sampledAt: "2026-06-10T00:50:00.000Z",
				followers: 500,
				lastSampledAt: "2026-06-26T10:50:00.000Z",
			},
			{ sampledAt: "2026-06-27T09:00:00.000Z", followers: 530 },
			{ sampledAt: "2026-06-30T11:00:00.000Z", followers: 540 },
		]
			.map((row) => `${JSON.stringify(row)}\n`)
			.join(""),
	);
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

async function row(days: number, tz: number) {
	const deps = {
		store: { getSubscriptions: () => [SUB] },
		runtime: {
			engines: null,
			profileRefresh: { getLastEntries: () => [] },
			fansStore: createFollowersStore({ dataRoot: dataDir, logger: silent }),
			statsStore: {
				listPosts: async () => [],
				listLiveSessions: async () => [],
				listRecording: async () => [],
			},
			subRuntimeStore: { get: () => undefined },
			serviceCtx: { logger: silent },
		},
	} as unknown as RouteDeps;
	const res = await createStatsRoute(deps).request(`/overview?days=${days}&tz=${tz}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as StatsOverviewResponse;
	const found = body.rows[0];
	if (!found) throw new Error("没有行");
	return found;
}

describe("窗口起点落在一段中间:基线取这段的值", () => {
	// 验红:路由不读基线(只把窗口内的样本交给 `dailyFansSeries`),首日净增变 null,这条红。
	it.each([0, -480, 300])(
		"7 天窗口 06-24..06-30:首日净增 = 500 − 基线 500 = 0 [tz=%i]",
		async (tz) => {
			const got = await row(7, tz);
			// 06-24..06-26 都在段里(各日末值 500),06-27 涨到 530(+30),06-28、06-29 没有样本,06-30 是 540(+10)。
			expect(got.cumulative).toEqual([500, 500, 500, 530, null, null, 540]);
			expect(got.series).toEqual([0, 0, 0, 30, null, null, 10]);
			expect(got.net7d).toBe(40);
			expect(got.netWindow).toBe(40);
			expect(got.followers).toBe(540);
		},
	);
});
