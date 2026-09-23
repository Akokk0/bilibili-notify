/**
 * 🔴 **拓展订阅的在播,在真 BN 上进得了首页**(ADR-0019 决策 12 / 57 / 61)。
 *
 * 拓展报开播 / 下播 / 直播状态 → ctx 核过、对上订阅 → bus 上的 `subscription-reported` → 在播表 →
 * `GET /api/live/listening`。拓展停了 → 它那面 ctx 收摊 → 装载器递过去的回调 → `index.ts` 发到 bus 上的
 * `extension-stopped` → 在播表清掉它名下的。中间任意一处漏接,拓展那头照样 resolve、类型与单元测试
 * 全绿,症状是首页上抖音的直播一条都不出来,或者拓展关了它还一直「在播」。
 *
 * 所以装一个真的 v2 小拓展进装载根、起一台真 BN:面板按它的动作钮报,再照面板那样读接口。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveListeningEntry } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

const FIXTURE_ID = "live-probe";
const EXTERNAL = "douyin-live-1";
const SUB = makeExtensionSubscription({
	id: "e1000000-0000-4000-8000-000000000001",
	extensionId: FIXTURE_ID,
	externalId: EXTERNAL,
	enabled: true,
});
const T = Date.UTC(2026, 8, 23, 12);

/** 每个动作真调一次 `handle.report*`,把它的 Promise 原样交回 —— 拒掉的原因就是面板收到的原话。 */
const FIXTURE_CODE = `
const T = ${T};
const URL = "https://live.douyin.com/1";
export function activate(ctx) {
	const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
	const id = ${JSON.stringify(EXTERNAL)};
	ctx.onAction("report.liveStart", () =>
		handle.reportLiveStart(id, { url: URL, startedAt: T, title: "开播了", category: "聊天", viewers: 7 }),
	);
	ctx.onAction("report.liveEnd", () => handle.reportLiveEnd(id, { url: URL }));
	ctx.onAction("report.liveStatus", () =>
		handle.reportLiveStatus(id, { live: true, startedAt: T, title: "一直在播", viewers: 9 }),
	);
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

describe("拓展订阅的在播 e2e:报上来的进首页,拓展停了就出去", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	function boot(at: number): Promise<StandaloneServerHandle> {
		return startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(at),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
	}

	/** 同 `subscription-report-e2e`:先空启动一趟拿到完整的 globals,再摆拓展、开开关、写订阅。 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-live-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { [FIXTURE_ID]: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		const extDir = join(dataDir, "extensions", FIXTURE_ID);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: FIXTURE_ID,
				name: "在播探针",
				description: "按一下动作钮报一条直播",
				version: "0.1.0",
				apiVersion: 2,
				actions: ["report.liveStart", "report.liveEnd", "report.liveStatus"],
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["liveStart", "liveEnd"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);

		await writeFile(join(dataDir, "state", "extension-subscriptions.json"), JSON.stringify([SUB]));

		port = await findFreePort();
		handle = await boot(port);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	const base = () => `http://127.0.0.1:${port}`;

	/** 面板按一下那个动作钮。 */
	async function press(action: string): Promise<void> {
		const res = await fetch(`${base()}/api/ext/${FIXTURE_ID}/actions/${action}`, {
			method: "POST",
		});
		expect(res.status, await res.clone().text()).toBe(200);
	}

	/** 首页「正在直播」读的那一口里,拓展那几行。 */
	async function extensionRows(): Promise<LiveListeningEntry[]> {
		const res = await fetch(`${base()}/api/live/listening`);
		expect(res.status).toBe(200);
		const rows = (await res.json()) as LiveListeningEntry[];
		return rows.filter((row) => row.kind === "extension");
	}

	/** 拓展现在什么状态 —— 这一口会先把还没落地的开关 settle 掉,是「等它收完摊」的正路。 */
	async function probeState(): Promise<string | undefined> {
		const res = await fetch(`${base()}/api/ext`);
		const body = (await res.json()) as { extensions: Array<{ id: string; state: string }> };
		return body.extensions.find((e) => e.id === FIXTURE_ID)?.state;
	}

	it("报开播 → 首页有它:按订阅 id 认,带着标题、分区、人数与开播时刻", async () => {
		expect(await probeState()).toBe("running");
		await press("report.liveStart");
		expect(await extensionRows()).toEqual([
			{
				kind: "extension",
				subscriptionId: SUB.id,
				extensionId: FIXTURE_ID,
				isLive: true,
				title: "开播了",
				areaName: "聊天",
				startedAt: new Date(T).toISOString(),
				viewers: 7,
			},
		]);
	});

	it("报下播 → 没了", async () => {
		await press("report.liveEnd");
		expect(await extensionRows()).toEqual([]);
	});

	it("只报过直播状态(BN 重启过、开播没见着)也进得来;拓展停掉 → 没了", async () => {
		await press("report.liveStatus");
		expect((await extensionRows()).map((row) => row.subscriptionId)).toEqual([SUB.id]);

		const res = await fetch(`${base()}/api/globals`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ extensions: { [FIXTURE_ID]: { enabled: false } } }),
		});
		expect(res.status).toBe(200);
		expect(await probeState()).toBe("disabled");
		expect(await extensionRows()).toEqual([]);
	});
});
