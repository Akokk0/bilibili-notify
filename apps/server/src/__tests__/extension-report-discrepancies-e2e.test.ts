/**
 * 🔴 **拓展报坏了的东西,在真 BN 上进了拓展详情页的「上报出入」**(ADR-0019 决策 60)。
 *
 * 丢格、整条拒都从 ctx 里唯一那个出口出去(`recordDiscrepancy` → `onReportDiscrepancy`);之后要
 * `index.ts` 把它接进记录、`app.ts` 把记录递给拓展列表那一口,面板才看得见。任意一处漏接,日志里照样
 * 有那一行、类型与单元测试全绿,而主人看见「卡片少了一张图」永远不知道为什么。
 *
 * 所以装一个真的 v2 小拓展、起一台真 BN:按它的动作钮报一条丢格的、一条没声明的,读面板读的那一口。
 * bus 在这里只**旁听**(包一层真的那个,不换掉它),看面板有没有被叫去重取 —— 叫的是上报出入自己那一声,
 * 不是「拓展的视图变了」。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDTO, ExtensionsResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/** bus 上旁听到的:「上报出入变了」与「拓展的视图变了」(都是拓展 id)。 */
const heard = vi.hoisted(() => ({ discrepancies: [] as string[], status: [] as string[] }));

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("extension-report-discrepancies-changed", ({ extensionId }) => {
				heard.discrepancies.push(extensionId);
			});
			bus.on("extension-status-changed", ({ extensionId }) => {
				heard.status.push(extensionId);
			});
			return bus;
		},
	};
});

const FIXTURE_ID = "discrepancy-probe";
const PERSON = "douyin-person";
const SUB = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-00000000000a",
	extensionId: FIXTURE_ID,
	externalId: PERSON,
	enabled: true,
});

/**
 * 清单只声明作品:报下播(`live`)要被整条拒;作品图里那个不合形状的引用解不开、丢掉。
 * 第 3 版拓展:图先 `storeImage` 存成引用,上报在来源上下文上交、没有返回值。
 */
const FIXTURE_CODE = `
const T = Date.UTC(2026, 8, 23, 12);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PERSON = ${JSON.stringify(PERSON)};
export function activate(ctx) {
	let source;
	ctx.registerSource({
		start(s) { source = s; },
		stop() { source = undefined; },
		searchCreators: async () => ({ ok: true, candidates: [] }),
	});
	ctx.onAction("report.dropped", async () => {
		const stored = await source.storeImage(PNG);
		if (!stored.ok) throw new Error(stored.message);
		source.reportPost(PERSON, {
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			post: { publishedAt: T, text: "一条作品", images: ["not-a-ref", stored.ref] },
		});
	});
	ctx.onAction("report.undeclared", () => {
		// 拒掉是意料之中的:动作本身不算失败,拒的原因看上报出入。
		source.reportLive(PERSON, { kind: "end", details: { url: "https://live.douyin.com/1" } });
	});
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

describe("上报出入 e2e:丢格与整条拒进了拓展列表那一口", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

	async function probeRow(): Promise<ExtensionDTO | undefined> {
		const body = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		return body.extensions.find((e) => e.id === FIXTURE_ID);
	}

	async function press(action: string): Promise<void> {
		const res = await api(`/api/ext/${FIXTURE_ID}/actions/${action}`, { method: "POST" });
		expect(res.status, await res.clone().text()).toBe(200);
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-report-discrepancies-e2e-"));
		const extDir = join(dataDir, "extensions", FIXTURE_ID);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: FIXTURE_ID,
				name: "问题探针",
				description: "按一下动作钮报一条坏的",
				version: "0.1.0",
				apiVersion: 2,
				actions: ["report.dropped", "report.undeclared"],
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["post"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);

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
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ extensions: { [FIXTURE_ID]: { enabled: true } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		expect((await probeRow())?.state).toBe("running");
		const created = await api("/api/subscriptions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...SUB, cachedProfile: { name: "某人" } }),
		});
		expect(created.status, await created.clone().text()).toBe(200);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		heard.discrepancies.length = 0;
		heard.status.length = 0;
	});

	it("还没报过坏东西:那一行没有这一格", async () => {
		expect(await probeRow()).not.toHaveProperty("reportDiscrepancies");
	});

	it("丢了一张图:记一条「丢了」,带上哪条订阅与原因;面板被叫去重取(上报出入自己那一声)", async () => {
		await press("report.dropped");

		// 上报排串行队,动作先回、出入记得稍后:一律等。
		const discrepancies = await vi.waitFor(async () => {
			const found = (await probeRow())?.reportDiscrepancies;
			expect(found).toHaveLength(1);
			return found;
		});
		expect(discrepancies?.[0]).toMatchObject({
			kind: "post",
			externalId: PERSON,
			subscriptionIds: [SUB.id],
			outcome: "dropped",
		});
		expect(discrepancies?.[0]?.reasons).toHaveLength(1);
		expect(discrepancies?.[0]?.reasons[0]).toContain("images[0]");
		await vi.waitFor(() => expect(heard.discrepancies).toEqual([FIXTURE_ID]));
		// 「拓展的视图变了」那一声不掺和:它一响,面板就去重读视图。
		expect(heard.status).toEqual([]);
	});

	it("报了清单没声明的种类:记一条「拒了」,排在最前", async () => {
		await press("report.undeclared");

		const discrepancies = await vi.waitFor(async () => {
			const found = (await probeRow())?.reportDiscrepancies;
			expect(found).toHaveLength(2);
			return found;
		});
		expect(discrepancies?.map((p) => [p.kind, p.outcome])).toEqual([
			["live", "rejected"],
			["post", "dropped"],
		]);
		expect(discrepancies?.[0]?.reasons[0]).toContain("没声明");
	});
});
