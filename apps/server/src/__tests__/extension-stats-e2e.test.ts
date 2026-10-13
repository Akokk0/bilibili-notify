/**
 * 🔴 **拓展订阅的上报,在真 BN 上落进了统计**(ADR-0020 决策 4–9 / 16 / 17)。
 *
 * 假源报作品 / 资料 / 开播 / 直播状态 → ctx 核过、对上订阅 → 总线 `subscription-reported`(与场次算出来的
 * `extension-live-session`)→ 统计的拓展适配 → 记录器 → 盘上按**订阅 id** 命名的四份文件。中间任意一处漏接
 * (适配没挂上、bootstrap 没把粉丝仓递进去、挂的次序反了),假源那头照样 resolve、单元测试全绿,症状是统计页上
 * 抖音那几行一直是空的。
 *
 * 关机那一段也走真的:拓展先收摊(`extension-stopped`)→ 引擎拆 → runtime 的钩子。`close()` 一返回,开着的
 * 那一场就得恰好有一帧下播在盘上。
 *
 * 首页粉丝面板(决策 8)也走真的:记录器写下的那条粉丝样本 → 粉丝轮询从同一个粉丝仓读回来 → `GET /api/stats/followers`。
 * 轮询与记录器拿的不是同一个仓、或轮询不看拓展订阅,单元测试照样全绿,症状是首页面板上一直没有抖音那一行。
 *
 * 装的是**假源的构建产物**(同 `fake-source-buttons-e2e`),按面板那条路建订阅、按动作钮。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionLookupResponse,
	ExtensionsResponse,
	FansResponse,
	StatsOverviewResponse,
} from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration } from "./support/generation.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

const FAKE = "fake-source";
/** 解析门前两个候选各建一条:甲开着,乙停用。 */
const ON = "f6000000-0000-4000-8000-000000000001";
const OFF = "f6000000-0000-4000-8000-000000000002";

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

describe("拓展订阅的统计 e2e:假源报上来的,关机之后都在盘上、按订阅 id 命名", () => {
	let dataDir: string;
	/** 开机后在用的那一代;盘上读写都对它。 */
	let gen: string;
	let handle: ServerHandle | undefined;
	let port: number;

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown): RequestInit => ({
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	async function press(action: string): Promise<void> {
		const res = await api(`/api/ext/${FAKE}/actions/${action}`, { method: "POST" });
		expect(res.status, await res.clone().text()).toBe(200);
	}

	/** 一个 jsonl 的每一行;文件不在是 `undefined`。 */
	async function lines(...path: string[]): Promise<Record<string, unknown>[] | undefined> {
		try {
			const raw = await readFile(join(gen, ...path), "utf8");
			return raw
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-extension-stats-e2e-"));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");
		gen = await activeGeneration(dataDir);
		port = await findFreePort();
		handle = await startServer({
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
		});
		const toggled = await api("/api/settings", {
			method: "PATCH",
			...json({ extensions: { [FAKE]: { enabled: true } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		const list = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		expect(list.extensions.find((e) => e.id === FAKE)?.state).toBe("running");

		const looked = await api(`/api/ext/${FAKE}/lookup?q=${encodeURIComponent("统计探针")}`);
		expect(looked.status, await looked.clone().text()).toBe(200);
		const { candidates } = (await looked.json()) as ExtensionLookupResponse;
		for (const [i, id] of [ON, OFF].entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			const { id: externalId, ...profile } = candidate;
			const created = await api("/api/subscriptions", {
				method: "POST",
				...json({
					// 推送目标一个都没配:统计与推送开关无关(决策 4)。
					...makeExtensionSubscription({ id, extensionId: FAKE, externalId, enabled: id === ON }),
					cachedProfile: profile,
				}),
			});
			expect(created.status, await created.clone().text()).toBe(200);
		}
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("作品 ×2、资料 ×2、开播、直播状态 → 关机 → 作品两行 / 一个粉丝样本 / 一条「在记」/ 一场带峰值的直播", async () => {
		// 假源:第 1 条是图文、第 2 条是视频;资料的粉丝数第 1 版 1111、第 2 版 2222;开播时累计观看 1000,
		// 每报一次直播状态涨 1000。只报给开着的甲(停用的乙假源不报,资料更新宿主也不会替它记统计)。
		await press("report.post");
		await press("report.post");
		await press("report.profile");
		await press("report.profile");
		await press("report.liveStart");
		await press("report.liveStatus");

		// 统计页读得到这两条(ADR-0020 S4):键是订阅 id、带着身份;停用的乙照样列着。甲这一场在场次模块手里 →
		// 在播 —— 路由从引擎的 `liveSession` 读它,路由测试用的是替身,接没接上只有这里看得出来。
		// 场次开不开是总线上同步定的(上报交到总线,按钮才 resolve),所以这一刻已经定了。
		const res = await api("/api/stats/overview?days=7&tz=0");
		expect(res.status).toBe(200);
		const { rows } = (await res.json()) as StatsOverviewResponse;
		expect(rows.find((row) => row.subscriptionId === ON)).toMatchObject({
			identity: { sourceKey: FAKE },
			live: true,
		});
		expect(rows.find((row) => row.subscriptionId === OFF)).toMatchObject({
			identity: { sourceKey: FAKE },
			live: false,
		});

		// 首页粉丝面板(决策 8):甲有了粉丝时序,那一行进 `GET /api/stats/followers` —— 键是订阅 id、带身份;当前数是最近报的
		// 资料(2222),起点是时序的第一条(1111);24h / 7d 之前还没有样本。停用的乙不上。样本是记录器排队写的,
		// 所以按 devtools 的「粉丝轮询现在就跑」、等它读到。
		await vi.waitFor(
			async () => {
				const polled = await api("/api/dev/run/bilibili.fans.poll-now", {
					method: "POST",
					...json({ params: {} }),
				});
				expect(polled.status, await polled.clone().text()).toBe(200);
				const { entries } = (await (await api("/api/stats/followers")).json()) as FansResponse;
				expect(entries).toEqual([
					{
						subscriptionId: ON,
						extensionId: FAKE,
						externalId: expect.any(String),
						current: 2222,
						ts: expect.any(String),
						deltaSubscribed: 1111,
						delta24h: null,
						delta7d: null,
					},
				]);
			},
			{ timeout: 3_000, interval: 100 },
		);

		await handle?.close("test shutdown");
		handle = undefined;

		const posts = await lines("stats", "posts", `${ON}.jsonl`);
		expect(posts?.map((row) => row.hasVideo)).toEqual([false, true]);
		for (const row of posts ?? []) {
			// 三格老的,加上多收的五格(㉖g,可选):假源的作品都带链接与正文,所以有 url 与 summary;不会有别的格。
			expect(row).toMatchObject({
				id: expect.any(String),
				hasVideo: row.hasVideo,
				publishedAt: expect.any(String),
				url: expect.stringContaining("fake-source.invalid"),
				summary: expect.any(String),
			});
			const allowed = [
				"id",
				"hasVideo",
				"publishedAt",
				"url",
				"title",
				"summary",
				"topic",
				"videoDurationSec",
			];
			expect(Object.keys(row).filter((key) => !allowed.includes(key))).toEqual([]);
		}

		// 两份资料是紧挨着报的,不密过 B 站粉丝轮询(默认每 10 分钟):只留先到的那份。
		expect(await lines(...FOLLOWERS_DIR, `${ON}.jsonl`)).toEqual([
			{ sampledAt: expect.any(String), followers: 1111 },
		]);

		// 六条上报都在同一个小时里(跨整点的几毫秒之差留给测试之外):作品、直播、粉丝三项各一行,每行正好一个整点小时。
		const recording = (await lines("stats", "recording", `${ON}.jsonl`)) ?? [];
		expect([...new Set(recording.map((row) => row.kind))].sort()).toEqual([
			"followers",
			"live",
			"posts",
		]);
		for (const row of recording) {
			expect(Date.parse(String(row.endedAt)) - Date.parse(String(row.startedAt))).toBe(3_600_000);
			expect(Date.parse(String(row.startedAt)) % 3_600_000).toBe(0);
		}

		// 关机补的下播恰好一帧,峰值是报过的最大累计观看。
		const frames = await lines("stats", "live", `${ON}.jsonl`);
		expect(frames).toEqual([
			{ kind: "start", occurredAt: expect.any(String) },
			{ kind: "end", occurredAt: expect.any(String), peakTotalViewers: 2000 },
		]);

		// 停用的乙一份都没有;盘上只有甲那几份。
		for (const dir of [
			["stats", "posts"],
			["stats", "live"],
			["stats", "recording"],
			FOLLOWERS_DIR,
		]) {
			expect(await readdir(join(gen, ...dir))).toEqual([`${ON}.jsonl`]);
		}
		expect(await lines(...FOLLOWERS_DIR, `${OFF}.jsonl`)).toBeUndefined();
	});
});
