/**
 * 🔴 **假源页面上的上报按钮,在真 BN 上真的报到了**(ADR-0019 决策 62 的最后一条)。
 *
 * 假源造的数据是**手写**的第二份(拓展够不到宿主的上报 zod,连测试也够不到),而它存在的意义是让主人在
 * 真机上看见「报了 → 收了」:首页在播、订阅页的资料、详情页的「上报出入」。造出来的哪一格不合宿主的
 * 规矩(秒当成毫秒、链接不是 http(s)、图不是位图),假源自己的单元测试照样全绿,症状是主人按了按钮、
 * 该变的地方一动不动,或者「上报出入」里多出一条莫名其妙的拒绝。
 *
 * 所以这一条把**假源的构建产物**装进装载根、起一台真 BN:经解析门建订阅、照面板那样按动作钮,再读
 * 面板读的那几口。bus 在这里只**旁听**(包一层真的那个,不换掉它)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CreatorsResponse,
	ExtensionDTO,
	ExtensionsResponse,
	LiveListeningEntry,
	SubscriptionDTO,
} from "@bilibili-notify/contract";
import type { PostEvent } from "@bilibili-notify/internal";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isValidImageRef } from "../images/image-store.js";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

/**
 * bus 上收到的每一条 `post-detected`(拓展作品经来源登记表进核心入口后,核心对每条订阅发的中立事件)。
 * 老的 `subscription-reported` 在新路上不再发。上报排串行队,断言一律 `vi.waitFor`。
 */
const heard = vi.hoisted(() => [] as PostEvent[]);

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("post-detected", (event) => {
				heard.push(event);
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

describe("假源的上报按钮 e2e:按下去,首页在播 / 订阅资料 / 上报出入都跟着变", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
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
		return rows.sort((x, y) => x.subscriptionId.localeCompare(y.subscriptionId));
	}

	async function profileOf(subscriptionId: string) {
		const list = (await (await api("/api/subscriptions")).json()) as SubscriptionDTO[];
		return list.find((s) => s.id === subscriptionId)?.cachedProfile;
	}

	/** 等甲这一次报的资料落进去(`refreshedAt` 换过)。 */
	function refreshedAfter(before: Awaited<ReturnType<typeof profileOf>>) {
		return vi.waitFor(async () => {
			const now = await profileOf(SUB_IDS.a);
			expect(now?.refreshedAt).not.toBe(before?.refreshedAt);
			return now;
		});
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-fake-source-buttons-e2e-"));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");

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
		// 面板那条路拨开关:拨完紧接着列一次拓展,那一口会先把热装落实掉。
		const toggled = await api("/api/settings", {
			method: "PATCH",
			...json({ core: { extensions: { [FAKE]: { enabled: true } } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		expect((await fakeRow())?.state).toBe("running");

		// 面板那条路建订阅:先问解析门,拿候选建。
		const looked = await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent("按钮探针")}`);
		expect(looked.status, await looked.clone().text()).toBe(200);
		const { candidates } = (await looked.json()) as CreatorsResponse;
		expect(candidates).toHaveLength(3);
		const keys = ["a", "b", "c"] as const;
		for (const [i, key] of keys.entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			external[key] = candidate.externalId;
			const { externalId: _id, ...profile } = candidate;
			const created = await api("/api/subscriptions", {
				method: "POST",
				...json({
					...makeExtensionSubscription({
						id: SUB_IDS[key],
						extensionId: FAKE,
						externalId: candidate.externalId,
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
		await vi.waitFor(() =>
			expect(heard.map((d) => [d.identity.externalId, d.subscriptionId])).toEqual([
				[external.a, SUB_IDS.a],
				[external.b, SUB_IDS.b],
				[external.a, SUB_IDS.a],
				[external.b, SUB_IDS.b],
			]),
		);
		const posts = heard.map((d) => d.post);
		expect(posts[0]?.images).toHaveLength(3);
		expect(posts[0]?.stats?.likes).toEqual(expect.any(Number));
		// 作品图与封面是拓展经 `storeImage` 存的图库引用,宿主补宽高。
		expect(posts[0]?.images?.[0]?.ref && isValidImageRef(posts[0].images[0].ref)).toBe(true);
		expect(posts[2]?.video?.cover?.ref).toEqual(expect.any(String));
		expect(posts[2]?.video?.title).toEqual(expect.any(String));
		// 视频作品不再有宿主替平台写的「投稿了视频」(主人 2026-10-24 定)。
		expect(JSON.stringify(posts[2])).not.toContain("投稿了视频");
		expect((await fakeRow())?.reportDiscrepancies).toBeUndefined();
	});

	it("开播 → 首页有甲乙两行,带着标题、分区、累计观看与开播时刻", async () => {
		await press("report.liveStart");
		const rows = await vi.waitFor(async () => {
			const rows = await liveRows();
			expect(rows.map((row) => row.subscriptionId)).toEqual([SUB_IDS.a, SUB_IDS.b]);
			return rows;
		});
		expect(rows.map((row) => row.subscriptionId)).toEqual([SUB_IDS.a, SUB_IDS.b]);
		for (const row of rows) {
			expect(row).toMatchObject({
				identity: { sourceKey: FAKE, externalId: expect.any(String) },
				isLive: true,
				title: expect.stringContaining("第 1 场"),
				category: expect.any(String),
				startedAt: expect.any(String),
				totalViewers: expect.any(Number),
			});
		}
	});

	it("报直播状态 ×2 → 首页那两行的累计观看一次比一次多,开播时刻不变", async () => {
		const [start] = await liveRows();
		await press("report.liveStatus");
		const first = await vi.waitFor(async () => {
			const [first] = await liveRows();
			expect(first?.totalViewers).toBeGreaterThan(start?.totalViewers ?? Number.POSITIVE_INFINITY);
			return first;
		});
		await press("report.liveStatus");
		const second = await vi.waitFor(async () => {
			const [second] = await liveRows();
			expect(second?.totalViewers).toBeGreaterThan(first?.totalViewers ?? Number.POSITIVE_INFINITY);
			return second;
		});
		expect(first?.totalViewers).toBeGreaterThan(start?.totalViewers ?? Number.POSITIVE_INFINITY);
		expect(second?.totalViewers).toBeGreaterThan(first?.totalViewers ?? Number.POSITIVE_INFINITY);
		expect(second?.startedAt).toBe(start?.startedAt);
		expect((await fakeRow())?.reportDiscrepancies).toBeUndefined();
	});

	it("下播 → 首页没了", async () => {
		await press("report.liveEnd");
		await vi.waitFor(async () => expect(await liveRows()).toEqual([]));
	});

	it("报资料 → 订阅页甲的名字 / 粉丝 / 头像换了,再按一次头像又换一张;停用的丙不动", async () => {
		const seededC = await profileOf(SUB_IDS.c);
		const before = await profileOf(SUB_IDS.a);
		await press("report.profile");
		const first = await refreshedAfter(before);
		expect(first?.name).toContain("第 1 版");
		expect(first?.followers).not.toBe(before?.followers);
		expect(first?.avatar && isValidImageRef(first.avatar)).toBe(true);
		expect(first?.avatar).not.toBe(before?.avatar);

		await press("report.profile");
		const second = await refreshedAfter(first);
		expect(second?.name).toContain("第 2 版");
		expect(second?.avatar).not.toBe(first?.avatar);
		const img = await api(`/api/images/${second?.avatar}`);
		expect(img.status).toBe(200);

		expect(await profileOf(SUB_IDS.c)).toEqual(seededC);
		expect((await fakeRow())?.reportDiscrepancies).toBeUndefined();
	});

	it("带坏图的作品:照样送到(少了那个坏引用),「上报出入」里甲乙各一条「丢了」,点名 images[1]", async () => {
		await press("report.badImage");
		await vi.waitFor(() => expect(heard).toHaveLength(2));
		for (const event of heard) expect(event.post.images).toHaveLength(2);
		const discrepancies = await vi.waitFor(async () => {
			const found = (await fakeRow())?.reportDiscrepancies ?? [];
			expect(found).toHaveLength(2);
			return found;
		});
		expect(discrepancies.map((p) => [p.outcome, p.kind, p.subscriptionIds]).sort()).toEqual([
			["dropped", "post", [SUB_IDS.a]],
			["dropped", "post", [SUB_IDS.b]],
		]);
		for (const discrepancy of discrepancies) {
			expect(discrepancy.reasons).toHaveLength(1);
			expect(discrepancy.reasons[0]).toContain("images[1]");
		}
	});

	it("多一格的作品:整条拒 —— bus 上没有,动作照样成;「上报出入」里甲乙各一条「拒了」,点名那一格", async () => {
		await press("report.extraField");
		const rejected = await vi.waitFor(async () => {
			const found = ((await fakeRow())?.reportDiscrepancies ?? []).filter(
				(p) => p.outcome === "rejected",
			);
			expect(found).toHaveLength(2);
			return found;
		});
		expect(heard).toEqual([]);
		expect(rejected.map((p) => p.subscriptionIds).sort()).toEqual([[SUB_IDS.a], [SUB_IDS.b]]);
		for (const discrepancy of rejected) expect(discrepancy.reasons[0]).toContain("danmaku");
	});

	it("没有开着的订阅了:按了什么都不报,假源页面上说一句「还没有开着的订阅」", async () => {
		for (const id of [SUB_IDS.a, SUB_IDS.b]) {
			const off = await api(`/api/subscriptions/${id}`, {
				method: "PATCH",
				...json({ enabled: false }),
			});
			expect(off.status, await off.clone().text()).toBe(200);
		}
		await press("report.post");
		expect(heard).toEqual([]);
		const status = await api(`/api/ext/${FAKE}/status`);
		expect(status.status).toBe(200);
		expect(JSON.stringify(await status.json())).toContain("还没有开着的订阅");
	});
});
