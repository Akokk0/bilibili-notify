/**
 * 🔴 **拓展报坏了的东西,在真 BN 上进了拓展详情页的「上报问题」**(ADR-0019 决策 60)。
 *
 * 丢格、整条拒都从 ctx 里唯一那个出口出去(`reportProblem` → `onSubscriptionReportProblem`);之后要
 * `index.ts` 把它接进记录、`app.ts` 把记录递给拓展列表那一口,面板才看得见。任意一处漏接,日志里照样
 * 有那一行、类型与单元测试全绿,而主人看见「卡片少了一张图」永远不知道为什么。
 *
 * 所以装一个真的 v2 小拓展、起一台真 BN:按它的动作钮报一条丢格的、一条没声明的,读面板读的那一口。
 * bus 在这里只**旁听**(包一层真的那个,不换掉它),看面板有没有被叫去重取 —— 叫的是上报问题自己那一声,
 * 不是「拓展的视图变了」。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDTO, ExtensionsResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/** bus 上旁听到的:「上报问题变了」与「拓展的视图变了」(都是拓展 id)。 */
const heard = vi.hoisted(() => ({ problems: [] as string[], status: [] as string[] }));

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("extension-report-problems-changed", (id) => {
				heard.problems.push(id);
			});
			bus.on("extension-status-changed", (id) => {
				heard.status.push(id);
			});
			return bus;
		},
	};
});

const FIXTURE_ID = "problem-probe";
const PERSON = "douyin-person";
const SUB = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-00000000000a",
	extensionId: FIXTURE_ID,
	externalId: PERSON,
	enabled: true,
});

/** 清单只声明作品:报下播要被整条拒;作品里那张 SVG 解不开、丢掉。 */
const FIXTURE_CODE = `
const T = Date.UTC(2026, 8, 23, 12);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const PERSON = ${JSON.stringify(PERSON)};
export function activate(ctx) {
	const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
	ctx.onAction("report.dropped", () =>
		handle.reportPost(PERSON, {
			id: "p1",
			url: "https://www.douyin.com/video/p1",
			publishedAt: T,
			images: [SVG, PNG],
		}),
	);
	ctx.onAction("report.undeclared", async () => {
		// 拒掉是意料之中的:动作本身不算失败,拒的原因看上报问题。
		await handle.reportLiveEnd(PERSON, { url: "https://live.douyin.com/1" }).catch(() => {});
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

describe("上报问题 e2e:丢格与整条拒进了拓展列表那一口", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
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
		dataDir = await mkdtemp(join(tmpdir(), "bn-report-problems-e2e-"));
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
		const toggled = await api("/api/globals", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ extensions: { [FIXTURE_ID]: { enabled: true } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		expect((await probeRow())?.state).toBe("running");
		const created = await api("/api/subs", {
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
		heard.problems.length = 0;
		heard.status.length = 0;
	});

	it("还没报过坏东西:那一行没有这一格", async () => {
		expect(await probeRow()).not.toHaveProperty("reportProblems");
	});

	it("丢了一张图:记一条「丢了」,带上哪条订阅与原因;面板被叫去重取(上报问题自己那一声)", async () => {
		await press("report.dropped");

		const problems = (await probeRow())?.reportProblems;
		expect(problems).toHaveLength(1);
		expect(problems?.[0]).toMatchObject({
			kind: "post",
			externalId: PERSON,
			subscriptionIds: [SUB.id],
			outcome: "dropped",
		});
		expect(problems?.[0]?.reasons).toHaveLength(1);
		expect(problems?.[0]?.reasons[0]).toContain("images[0]");
		await vi.waitFor(() => expect(heard.problems).toEqual([FIXTURE_ID]));
		// 「拓展的视图变了」那一声不掺和:它一响,面板就去重读视图。
		expect(heard.status).toEqual([]);
	});

	it("报了清单没声明的种类:记一条「拒了」,排在最前", async () => {
		await press("report.undeclared");

		const problems = (await probeRow())?.reportProblems;
		expect(problems?.map((p) => [p.kind, p.outcome])).toEqual([
			["liveEnd", "rejected"],
			["post", "dropped"],
		]);
		expect(problems?.[0]?.reasons[0]).toContain("没声明");
	});
});
