/**
 * 🔴 **「在记」的账压缩前后,统计页的显示逐字节相同**(ADR-0027 决策 13、15;㉘d)。账只许让盘上的行变少,
 * `/overview` 每一行的 `recording` 三个数组(每个本地日这一项在不在记)与由它派生的各格(活动次数的 null、热力图)
 * 一个字都不许变。
 *
 * 夹具是记录器平时落的样子 —— **每个小时一行**:一条订阅作品每小时都在记(中间缺两天)、直播只有 06-05..06-10、
 * 粉丝每天只有 08–20 点;一条拓展订阅零星几个小时。压缩前后各读一遍 `/overview`(四个时区,含一个不是整点的 UTC+5:30)。
 * 再把「现在」往后推 10 天、再记几个小时、再压,与「同样的数据从没压过」读出来的相同。
 *
 * 只假装 Date(固定「现在」),定时器是真的。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFollowersStore } from "../followers/store.js";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";
import {
	createStatsStore,
	type RecordingEntry,
	type RecordingKind,
	STATS_RECORDING_DIR,
} from "../stats/store.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-06-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZS = [0, -480, 300, -330] as const;
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;

const SUBS: Subscription[] = [
	{ id: "b-all", identity: { sourceKey: "bilibili", externalId: "1001" }, enabled: true } as never,
	makeExtensionSubscription({ id: "e-1", extensionId: "douyin", externalId: "s1", enabled: true }),
];

/** 一行 = 一个整点小时。 */
const hourRow = (kind: RecordingKind, hourMs: number): RecordingEntry => ({
	kind,
	startedAt: new Date(hourMs).toISOString(),
	endedAt: new Date(hourMs + HOUR).toISOString(),
});

/** `[fromMs, toMs)` 里每个小时(整点对齐)按 `keep` 过滤出一行。 */
function hours(
	kind: RecordingKind,
	fromMs: number,
	toMs: number,
	keep: (hourMs: number) => boolean = () => true,
): RecordingEntry[] {
	const out: RecordingEntry[] = [];
	for (let h = fromMs; h < toMs; h += HOUR) if (keep(h)) out.push(hourRow(kind, h));
	return out;
}

const day = (iso: string) => at(`${iso}T00:00:00.000Z`);
const hourOfDay = (ms: number) => new Date(ms).getUTCHours();

const BASE: Record<string, RecordingEntry[]> = {
	"b-all": [
		// 作品:06-01 起每个小时都在记,06-14、06-15 两天缺(BN 关着)。
		...hours(
			"posts",
			day("2026-06-01"),
			NOW,
			(h) => h < day("2026-06-14") || h >= day("2026-06-16"),
		),
		// 直播:只有 06-05..06-10。
		...hours("live", day("2026-06-05"), day("2026-06-11")),
		// 粉丝:每天只有 08–20 点(各自成一段、不跨天)。
		...hours("followers", day("2026-06-01"), NOW, (h) => hourOfDay(h) >= 8 && hourOfDay(h) < 21),
	],
	"e-1": [
		...hours("posts", day("2026-06-03"), day("2026-06-04")),
		...hours("posts", day("2026-06-20") + 10 * HOUR, day("2026-06-20") + 12 * HOUR),
		...hours("live", day("2026-06-20") + 10 * HOUR, day("2026-06-20") + 11 * HOUR),
	],
};

const lines = (rows: RecordingEntry[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

const dirs: string[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(async () => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seededRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bn-stats-compaction-display-"));
	dirs.push(root);
	await mkdir(join(root, ...STATS_RECORDING_DIR), { recursive: true });
	for (const [key, rows] of Object.entries(BASE)) {
		await writeFile(join(root, ...STATS_RECORDING_DIR, `${key}.jsonl`), lines(rows));
	}
	return root;
}

const statsStoreOf = (root: string) => createStatsStore({ dataRoot: root, logger: silent });
const ledgerText = (root: string, key: string) =>
	readFile(join(root, ...STATS_RECORDING_DIR, `${key}.jsonl`), "utf8");
const rowCount = async (root: string, key: string) =>
	(await ledgerText(root, key)).split("\n").filter(Boolean).length;

async function compactAll(root: string, now: Date): Promise<void> {
	const store = statsStoreOf(root);
	for (const key of await store.recordingKeys()) await store.compactRecording(key, now);
}

async function overviewText(root: string, days: number, tz: number): Promise<string> {
	const deps = {
		store: { getSubscriptions: () => SUBS },
		runtime: {
			engines: null,
			fansPoller: { getLastEntries: () => [] },
			fansStore: createFollowersStore({ dataRoot: root, logger: silent }),
			statsStore: statsStoreOf(root),
			subRuntimeStore: { get: () => undefined },
			serviceCtx: { logger: silent },
		},
	} as unknown as RouteDeps;
	const res = await createStatsRoute(deps).request(`/overview?days=${days}&tz=${tz}`);
	expect(res.status).toBe(200);
	return res.text();
}

describe("压缩前后:GET /api/stats/overview 的「在记」各格逐字节相同", () => {
	it.each(TZS)("同一份账压缩前后各读一遍,整份返回相同(30 天窗口)[tz=%i]", async (tz) => {
		const root = await seededRoot();
		const before = await overviewText(root, 30, tz);
		const rowsBefore = await rowCount(root, "b-all");

		await compactAll(root, new Date(NOW));

		// 压缩真的发生了:每小时一行的账缩成几段 —— 否则「相同」什么都证明不了。
		expect(rowsBefore).toBeGreaterThan(500);
		expect(await rowCount(root, "b-all")).toBeLessThan(rowsBefore / 2);
		expect(await overviewText(root, 30, tz)).toBe(before);
		// 读到的不是空的:缺的两天(按时区至少有一天整个落在缺口里)是 false。
		const body = JSON.parse(before) as {
			rows: { subscriptionId: string; recording: { posts: boolean[] } }[];
		};
		const posts = body.rows.find((r) => r.subscriptionId === "b-all")?.recording.posts ?? [];
		expect(posts.filter(Boolean).length).toBeGreaterThan(20);
		expect(posts.filter((on) => !on).length).toBeGreaterThanOrEqual(1);
	});

	it("窗口换成 7 天与 90 天也相同", async () => {
		const root = await seededRoot();
		const before = await Promise.all([7, 90].map((days) => overviewText(root, days, -480)));
		await compactAll(root, new Date(NOW));
		expect(await Promise.all([7, 90].map((days) => overviewText(root, days, -480)))).toEqual(
			before,
		);
	});
});

describe("压缩、再往后走:「现在」推后 10 天、再记几个小时、再压", () => {
	const LATER = NOW + 10 * DAY;
	/** 10 天后又记的:b-all 的作品与粉丝最后 6 个小时、e-1 一个小时。 */
	const MORE: Record<string, RecordingEntry[]> = {
		"b-all": [
			...hours("posts", LATER - 6 * HOUR, LATER),
			...hours("followers", LATER - 5 * HOUR, LATER - 2 * HOUR),
		],
		"e-1": [hourRow("posts", LATER - 3 * HOUR)],
	};

	async function appendMore(root: string): Promise<void> {
		const store = statsStoreOf(root);
		for (const [key, rows] of Object.entries(MORE)) {
			for (const row of rows) await store.appendRecording(key, row);
		}
	}

	it.each(TZS)("与「同样的数据从没压过」读出来逐字节相同 [tz=%i]", async (tz) => {
		const squeezed = await seededRoot();
		const never = await seededRoot();
		await compactAll(squeezed, new Date(NOW));
		vi.setSystemTime(LATER);
		await appendMore(squeezed);
		await appendMore(never);
		await compactAll(squeezed, new Date(LATER));

		expect(await rowCount(squeezed, "b-all")).toBeLessThan(await rowCount(never, "b-all"));
		expect(await overviewText(squeezed, 30, tz)).toBe(await overviewText(never, 30, tz));
	});

	it("再压一次(同一个「现在」)不改任何文件", async () => {
		const root = await seededRoot();
		await compactAll(root, new Date(NOW));
		const first = await Promise.all(Object.keys(BASE).map((key) => ledgerText(root, key)));
		const store = statsStoreOf(root);
		for (const key of Object.keys(BASE)) {
			expect((await store.compactRecording(key, new Date(NOW))).rewritten).toBe(false);
		}
		expect(await Promise.all(Object.keys(BASE).map((key) => ledgerText(root, key)))).toEqual(first);
	});
});
