/**
 * 🔴 **拓展直播的一场,跨过 BN 重启、拓展重启、断流接续都还是同一场**(ADR-0020 决策 4 / 6 / 7)。
 *
 * 一场直播在盘上是 start / end 两种帧,配对推迟到读的时候、按开播时刻认场次(`stats/store.ts`)。接回同一场
 * 靠的是一串接线:BN 关机时拓展收摊 / 场次模块收摊 → 总线上的结束帧 → 统计的拓展适配 → 记录器落一帧下播、
 * 关机钩子等它落地;BN 再起来、拓展报「在播」并带着开播时刻 → 场次模块认出一场、开始帧带**原来那个**开播
 * 时刻 → 读的时候与上一段并成一场,峰值取两段里大的那个。拓展停了 / 又跑起来走的是 `extension-stopped` 那一路。
 * 断流接续按**这一位**的设置(`engines.ts` 递给场次模块的 `settings`)合并:下播后等着的那几分钟里又开播,
 * 不落下播帧、也不另开一场。
 *
 * 任何一环各自的单元测试都绿着,也证明不了串起来之后统计页上是一场:开始帧的开播时刻换成「认出它的那一刻」、
 * 关机那一帧没落盘、峰值被后一段拽下来、断流接续读的不是这一位的设置 —— 症状都只在真 BN 的统计页上露出来
 * (一场直播被记成两三场、峰值变小)。
 *
 * 两位的推送**全关着**(决策 4:统计与推送开关无关)—— 哪一层把开关当成「记不记」,这里就一场、一条都没有。
 *
 * 拓展是一个装进装载根的小探针(同 `extension-live-e2e`):假源的直播是在它自己的内存里编的,重启之后开播时刻
 * 就变了,演不了「平台报的还是同一场」。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse, UpStatsRow } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

const PROBE = "restart-probe";
/** 推送全关(决策 4):统计照记。 */
const PUSH_OFF = { dynamic: false, live: false, liveEnd: false };
/** 甲:跨 BN 重启、拓展重启的那一位。 */
const SUB = makeExtensionSubscription({
	id: "e2000000-0000-4000-8000-000000000001",
	extensionId: PROBE,
	externalId: "restart-live-1",
	enabled: true,
	overrides: { features: PUSH_OFF },
});
/** 乙:开着断流接续(按这一位的设置,全局是关的)。 */
const FLICKER = makeExtensionSubscription({
	id: "e2000000-0000-4000-8000-000000000002",
	extensionId: PROBE,
	externalId: "restart-live-2",
	enabled: true,
	overrides: { features: PUSH_OFF, schedule: { liveEndGrace: true, liveEndGraceMinutes: 10 } },
});
/** 甲那一场平台报的开播时刻:两小时前。几次报的都是这一个数 —— 平台眼里始终是同一场。 */
const T = Date.now() - 2 * 3_600_000;
const T_ISO = new Date(T).toISOString();
/** 乙那一场:一小时前。断流之后平台报的是一个新的开播时刻(晚一分钟)—— 接续的话开始帧不换。 */
const T2 = Date.now() - 3_600_000;
const T2_ISO = new Date(T2).toISOString();

/**
 * 甲:开播时累计观看 5000;重启之后报的在播状态只带 300(平台这回少报了)。读的时候这一场的峰值要留 5000。
 * 乙:第一次开播累计 700,断流后再开播 900。
 */
const FIXTURE_CODE = `
const T = ${T};
const T2 = ${T2};
const URL = "https://live.restart-probe.invalid/1";
export function activate(ctx) {
	const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
	const id = ${JSON.stringify(SUB.externalId)};
	const flicker = ${JSON.stringify(FLICKER.externalId)};
	ctx.onAction("report.post", () =>
		handle.reportPost(id, { id: "restart-post-1", url: URL, publishedAt: Date.now(), text: "推送关着也记" }),
	);
	ctx.onAction("report.liveStart", () =>
		handle.reportLiveStart(id, { url: URL, startedAt: T, title: "开播了", viewers: 50, totalViewers: 5000 }),
	);
	ctx.onAction("report.liveStatus", () =>
		handle.reportLiveStatus(id, { live: true, url: URL, startedAt: T, title: "还在播", viewers: 30, totalViewers: 300 }),
	);
	ctx.onAction("report.liveEnd", () => handle.reportLiveEnd(id, { url: URL }));
	let starts = 0;
	ctx.onAction("report.flickerStart", () => {
		starts += 1;
		return handle.reportLiveStart(flicker, {
			url: URL,
			startedAt: T2 + (starts - 1) * 60000,
			title: "断流探针",
			viewers: 10,
			totalViewers: 500 + starts * 200,
		});
	});
	ctx.onAction("report.flickerEnd", () => handle.reportLiveEnd(flicker, { url: URL }));
}
`;

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

describe("拓展直播跨重启 e2e:BN 重启、拓展重启、断流接续之后都按开播时刻认成同一场,峰值留大的", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	async function boot(): Promise<void> {
		port = await findFreePort();
		handle = await startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
	}

	async function shutdown(): Promise<void> {
		await handle?.close("test restart");
		handle = undefined;
	}

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

	async function press(action: string): Promise<void> {
		const res = await api(`/api/ext/${PROBE}/actions/${action}`, { method: "POST" });
		expect(res.status, await res.clone().text()).toBe(200);
	}

	/** 拓展此刻的状态 —— 这一口会先把还没落地的开关 settle 掉。 */
	async function probeState(): Promise<string | undefined> {
		const res = await api("/api/ext");
		const body = (await res.json()) as { extensions: Array<{ id: string; state: string }> };
		return body.extensions.find((e) => e.id === PROBE)?.state;
	}

	async function setExtensionEnabled(enabled: boolean): Promise<void> {
		const res = await api("/api/globals", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ extensions: { [PROBE]: { enabled } } }),
		});
		expect(res.status, await res.clone().text()).toBe(200);
		expect(await probeState()).toBe(enabled ? "running" : "disabled");
	}

	/**
	 * 统计页上这一行。`days` 每次换一个:overview 有 30 秒的缓存,键里只有在播与粉丝两样内存快照 ——
	 * 同一个在播状态隔几秒再问一次会拿到上一次的数,看不见中间落盘的帧。
	 */
	async function row(days: number, id = SUB.id): Promise<UpStatsRow> {
		const res = await api(`/api/stats/overview?days=${days}&tz=0`);
		expect(res.status).toBe(200);
		const { rows } = (await res.json()) as StatsOverviewResponse;
		const found = rows.find((r) => r.subscriptionId === id);
		if (!found) throw new Error(`统计页上没有 ${id} 这一行`);
		return found;
	}

	/** 盘上一个 jsonl 的每一行;文件不在是空的。 */
	async function lines(dir: string, id: string): Promise<Array<Record<string, unknown>>> {
		try {
			const raw = await readFile(join(dataDir, "stats", dir, `${id}.jsonl`), "utf8");
			return raw
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	}
	/** 盘上这一位的直播帧。 */
	const frames = (id = SUB.id) => lines("live", id);

	const start = (ts = T_ISO) => ({ k: "start", ts });
	const end = (peak: number) => ({ k: "end", ts: expect.any(String), peak });

	/**
	 * 等盘上的帧长成这样。帧是记录器排队写的(按钮 resolve 时只是交出去了),先等它们落地再问统计页 ——
	 * 不然读到的是半截的盘,数对不对全看谁先跑完。
	 */
	async function framesSettle(expected: unknown[], id = SUB.id): Promise<void> {
		await vi.waitFor(async () => expect(await frames(id)).toEqual(expected), {
			timeout: 3_000,
			interval: 50,
		});
	}

	/** 先空启动一趟拿到完整的 globals,再摆拓展、开开关、写订阅。 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-live-restart-e2e-"));
		await boot();
		await shutdown();

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { [PROBE]: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		const extDir = join(dataDir, "extensions", PROBE);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: PROBE,
				name: "重启探针",
				description: "按动作钮报同一场直播",
				version: "0.1.0",
				apiVersion: 2,
				actions: [
					"report.post",
					"report.liveStart",
					"report.liveStatus",
					"report.liveEnd",
					"report.flickerStart",
					"report.flickerEnd",
				],
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["post", "liveStart", "liveEnd"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);
		await writeFile(
			join(dataDir, "state", "extension-subscriptions.json"),
			JSON.stringify([SUB, FLICKER]),
		);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("第一趟:推送全关也记作品;开播 → 统计页在播、一场;关机 → 盘上恰好一帧下播,带着本场累计观看", async () => {
		await boot();
		expect(await probeState()).toBe("running");
		await press("report.post");
		await vi.waitFor(
			async () =>
				expect(await lines("dyn", SUB.id)).toEqual([
					{ id: "restart-post-1", kind: "post", ts: expect.any(String) },
				]),
			{ timeout: 3_000, interval: 50 },
		);
		await press("report.liveStart");
		await framesSettle([start()]);
		expect(await row(7)).toMatchObject({ live: true, liveSessions: 1, dynamics: 1 });

		await shutdown();
		expect(await frames()).toEqual([start(), end(5000)]);
	}, 15_000);

	it("BN 重启:报在播、带着同一个开播时刻 → 接回同一场(一场、在播、峰值还是 5000)", async () => {
		await boot();
		expect(await probeState()).toBe("running");
		await press("report.liveStatus");
		// 开始帧带的是平台报的开播时刻,不是 BN 这次认出它的那一刻。
		await framesSettle([start(), end(5000), start()]);
		expect(await row(8)).toMatchObject({ live: true, liveSessions: 1, maxViewers: 5000 });
	}, 15_000);

	it("拓展停了 → 补一帧下播;又跑起来、报在播 → 还是同一场", async () => {
		await setExtensionEnabled(false);
		// 拓展停了,这一场观测到此为止:一帧下播,峰值是这一段报过的(300)。
		await framesSettle([start(), end(5000), start(), end(300)]);
		expect(await row(9)).toMatchObject({ live: false, liveSessions: 1, maxViewers: 5000 });

		await setExtensionEnabled(true);
		await press("report.liveStatus");
		await framesSettle([start(), end(5000), start(), end(300), start()]);
		expect(await row(10)).toMatchObject({ live: true, liveSessions: 1, maxViewers: 5000 });
	}, 15_000);

	it("断流接续(按这一位的设置):下播后等着的时候又开播 → 同一场,开始帧还是第一次的开播时刻", async () => {
		await press("report.flickerStart");
		await framesSettle([start(T2_ISO)], FLICKER.id);
		await press("report.flickerEnd");
		await press("report.flickerStart");
		// 这里还看不出「没落下播帧」(交出去的写入可能还在路上);关机之后那一口才是准的,见最后一条。
		expect(await row(11, FLICKER.id)).toMatchObject({ live: true });
	}, 15_000);

	it("真下播 → 一帧下播;统计页一场、峰值留 5000 不被后一段拽下来;关机不再补帧", async () => {
		await press("report.liveEnd");
		const all = [start(), end(5000), start(), end(300), start(), end(300)];
		await framesSettle(all);
		expect(await row(12)).toMatchObject({
			live: false,
			liveSessions: 1,
			maxViewers: 5000,
			avgViewers: 5000,
		});

		await shutdown();
		expect(await frames()).toEqual(all);
		// 断流接续的那一位:整段只有一场 —— 中间那次下播没落帧,再开播也没另开一场;关机补的下播带着
		// 两次开播报过的最大累计观看。
		expect(await frames(FLICKER.id)).toEqual([start(T2_ISO), end(900)]);
	}, 15_000);
});
