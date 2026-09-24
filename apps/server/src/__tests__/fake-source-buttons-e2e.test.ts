/**
 * 🔴 **假源页面上的上报按钮,在真 BN 上真的报到了**(ADR-0019 决策 62 的最后一条)。
 *
 * 假源造的数据是**手写**的第二份(拓展够不到宿主的上报 zod,连测试也够不到),而它存在的意义是让主人在
 * 真机上看见「报了 → 收了」:首页在播、订阅页的资料、详情页的「上报问题」。造出来的哪一格不合宿主的
 * 规矩(秒当成毫秒、链接不是 http(s)、图不是位图),假源自己的单元测试照样全绿,症状是主人按了按钮、
 * 该变的地方一动不动,或者「上报问题」里多出一条莫名其妙的拒绝。
 *
 * 所以这一条把**假源的构建产物**装进装载根、起一台真 BN:经解析门建订阅、照面板那样按动作钮,再读
 * 面板读的那几口。bus 在这里只**旁听**(包一层真的那个,不换掉它)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionDTO,
	ExtensionLookupResponse,
	ExtensionsResponse,
	LiveListeningEntry,
	SubscriptionDTO,
} from "@bilibili-notify/contract";
import type { SubscriptionReportDelivery } from "@bilibili-notify/internal";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

/** bus 上收到的每一条 `subscription-reported`。 */
const heard = vi.hoisted(() => [] as SubscriptionReportDelivery[]);

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("subscription-reported", (delivery) => {
				heard.push(delivery);
			});
			return bus;
		},
	};
});

const FAKE = "fake-source";

/** 解析门那三个候选各建一条:甲、乙开着,丙停用。 */
const SUB_IDS = {
	a: "f5000000-0000-4000-8000-000000000001",
	b: "f5000000-0000-4000-8000-000000000002",
	c: "f5000000-0000-4000-8000-000000000003",
} as const;

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

describe("假源的上报按钮 e2e:按下去,首页在播 / 订阅资料 / 上报问题都跟着变", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;
	/** 三条订阅各自的外部 id(解析门候选的 id)。 */
	const external = { a: "", b: "", c: "" };

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown): RequestInit => ({
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	/** 面板按一下那颗动作钮。 */
	async function press(action: string): Promise<void> {
		const res = await api(`/api/ext/${FAKE}/actions/${action}`, { method: "POST" });
		expect(res.status, await res.clone().text()).toBe(200);
	}

	async function fakeRow(): Promise<ExtensionDTO | undefined> {
		const body = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		return body.extensions.find((e) => e.id === FAKE);
	}

	/** 首页「正在直播」里拓展那几行,按订阅 id 排。 */
	async function liveRows() {
		const res = await api("/api/live/listening");
		expect(res.status).toBe(200);
		const rows = (await res.json()) as LiveListeningEntry[];
		return rows
			.flatMap((row) => (row.kind === "extension" ? [row] : []))
			.sort((x, y) => x.subscriptionId.localeCompare(y.subscriptionId));
	}

	async function profileOf(subscriptionId: string) {
		const list = (await (await api("/api/subs")).json()) as SubscriptionDTO[];
		return list.find((s) => s.id === subscriptionId)?.cachedProfile;
	}

	/** 等甲这一次报的资料落进去(`lastRefreshedAt` 换过)。 */
	function refreshedAfter(before: Awaited<ReturnType<typeof profileOf>>) {
		return vi.waitFor(async () => {
			const now = await profileOf(SUB_IDS.a);
			expect(now?.lastRefreshedAt).not.toBe(before?.lastRefreshedAt);
			return now;
		});
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-fake-source-buttons-e2e-"));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");

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
		// 面板那条路拨开关:拨完紧接着列一次拓展,那一口会先把热装落实掉。
		const toggled = await api("/api/globals", {
			method: "PATCH",
			...json({ extensions: { [FAKE]: { enabled: true } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		expect((await fakeRow())?.state).toBe("running");

		// 面板那条路建订阅:先问解析门,拿候选建。
		const looked = await api(`/api/ext/${FAKE}/lookup?q=${encodeURIComponent("按钮探针")}`);
		expect(looked.status, await looked.clone().text()).toBe(200);
		const { candidates } = (await looked.json()) as ExtensionLookupResponse;
		expect(candidates).toHaveLength(3);
		const keys = ["a", "b", "c"] as const;
		for (const [i, key] of keys.entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			external[key] = candidate.id;
			const { id: _id, ...profile } = candidate;
			const created = await api("/api/subs", {
				method: "POST",
				...json({
					...makeExtensionSubscription({
						id: SUB_IDS[key],
						extensionId: FAKE,
						externalId: candidate.id,
						enabled: key !== "c",
					}),
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

	beforeEach(() => {
		heard.length = 0;
	});

	it("报一条作品 ×2:甲乙各收一条图文、一条视频,停用的丙没有;都过了宿主那道校验,一格没丢", async () => {
		await press("report.post");
		await press("report.post");
		expect(heard.map((d) => [d.report.kind, d.externalId, d.subscriptionIds])).toEqual([
			["post", external.a, [SUB_IDS.a]],
			["post", external.b, [SUB_IDS.b]],
			["post", external.a, [SUB_IDS.a]],
			["post", external.b, [SUB_IDS.b]],
		]);
		const posts = heard.flatMap((d) => (d.report.kind === "post" ? [d.report.value] : []));
		expect(posts[0]?.images).toHaveLength(3);
		expect(posts[0]?.stats?.likes).toEqual(expect.any(Number));
		expect(posts[2]?.video?.cover).toBeInstanceOf(Uint8Array);
		expect(posts[2]?.video?.title).toEqual(expect.any(String));
		expect((await fakeRow())?.reportProblems).toBeUndefined();
	});

	it("开播 → 首页有甲乙两行,带着标题、分区、累计观看与开播时刻", async () => {
		await press("report.liveStart");
		expect(heard.map((d) => d.report.kind)).toEqual(["liveStart", "liveStart"]);
		const rows = await liveRows();
		expect(rows.map((row) => row.subscriptionId)).toEqual([SUB_IDS.a, SUB_IDS.b]);
		for (const row of rows) {
			expect(row).toMatchObject({
				extensionId: FAKE,
				isLive: true,
				title: expect.stringContaining("第 1 场"),
				areaName: expect.any(String),
				startedAt: expect.any(String),
				totalViewers: expect.any(Number),
			});
		}
	});

	it("报直播状态 ×2 → 首页那两行的累计观看一次比一次多,开播时刻不变", async () => {
		const [start] = await liveRows();
		await press("report.liveStatus");
		const [first] = await liveRows();
		await press("report.liveStatus");
		const [second] = await liveRows();
		expect(heard.map((d) => d.report.kind)).toEqual([
			"liveStatus",
			"liveStatus",
			"liveStatus",
			"liveStatus",
		]);
		expect(first?.totalViewers).toBeGreaterThan(start?.totalViewers ?? Number.POSITIVE_INFINITY);
		expect(second?.totalViewers).toBeGreaterThan(first?.totalViewers ?? Number.POSITIVE_INFINITY);
		expect(second?.startedAt).toBe(start?.startedAt);
		expect((await fakeRow())?.reportProblems).toBeUndefined();
	});

	it("下播 → 首页没了", async () => {
		await press("report.liveEnd");
		expect(heard.map((d) => d.report.kind)).toEqual(["liveEnd", "liveEnd"]);
		expect(await liveRows()).toEqual([]);
	});

	it("报资料 → 订阅页甲的名字 / 粉丝 / 头像换了,再按一次头像又换一张;停用的丙不动", async () => {
		const seededC = await profileOf(SUB_IDS.c);
		const before = await profileOf(SUB_IDS.a);
		await press("report.profile");
		const first = await refreshedAfter(before);
		expect(first?.name).toContain("第 1 版");
		expect(first?.fans).not.toBe(before?.fans);
		expect(first?.avatar).toMatch(new RegExp(`^/api/subs/${SUB_IDS.a}/avatar\\?v=`));
		expect(first?.avatar).not.toBe(before?.avatar);

		await press("report.profile");
		const second = await refreshedAfter(first);
		expect(second?.name).toContain("第 2 版");
		expect(second?.avatar).not.toBe(first?.avatar);
		const img = await api(second?.avatar ?? "");
		expect(img.status).toBe(200);

		expect(await profileOf(SUB_IDS.c)).toEqual(seededC);
		expect((await fakeRow())?.reportProblems).toBeUndefined();
	});

	it("带坏图的作品:照样送到(少了那张 SVG),「上报问题」里甲乙各一条「丢了」,点名 images[1]", async () => {
		await press("report.badImage");
		expect(heard).toHaveLength(2);
		for (const delivery of heard) {
			expect(delivery.report.kind).toBe("post");
			if (delivery.report.kind === "post") expect(delivery.report.value.images).toHaveLength(2);
		}
		const problems = (await fakeRow())?.reportProblems ?? [];
		expect(problems.map((p) => [p.outcome, p.kind, p.subscriptionIds]).sort()).toEqual([
			["dropped", "post", [SUB_IDS.a]],
			["dropped", "post", [SUB_IDS.b]],
		]);
		for (const problem of problems) {
			expect(problem.reasons).toHaveLength(1);
			expect(problem.reasons[0]).toContain("images[1]");
		}
	});

	it("多一格的作品:整条拒 —— bus 上没有,动作照样成;「上报问题」里甲乙各一条「拒了」,点名那一格", async () => {
		await press("report.extraField");
		expect(heard).toEqual([]);
		const rejected = ((await fakeRow())?.reportProblems ?? []).filter(
			(p) => p.outcome === "rejected",
		);
		expect(rejected.map((p) => p.subscriptionIds).sort()).toEqual([[SUB_IDS.a], [SUB_IDS.b]]);
		for (const problem of rejected) expect(problem.reasons[0]).toContain("danmaku");
	});

	it("没有开着的订阅了:按了什么都不报,假源页面上说一句「还没有开着的订阅」", async () => {
		for (const id of [SUB_IDS.a, SUB_IDS.b]) {
			const off = await api(`/api/subs/${id}`, { method: "PATCH", ...json({ enabled: false }) });
			expect(off.status, await off.clone().text()).toBe(200);
		}
		await press("report.post");
		expect(heard).toEqual([]);
		const status = await api(`/api/ext/${FAKE}/status`);
		expect(status.status).toBe(200);
		expect(JSON.stringify(await status.json())).toContain("还没有开着的订阅");
	});
});
