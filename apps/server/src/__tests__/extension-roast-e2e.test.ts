/**
 * 🔴 **拓展订阅在真 BN 上进了锐评的那张榜**(ADR-0020 决策 12 / 18)。
 *
 * 装着假源、两条拓展订阅 → `POST /api/stats/roast` → 路由内部代理一次 `/overview` → 生成把每一行翻成提示词里的
 * 一行 → 女仆(这里是替身)→ 结果按订阅 id 回指。「平台」那一列要写假源清单里的平台名 —— 那个名字从装载器经
 * `index.ts` 递进引擎、再由引擎交给锐评;生成的单元测试用的是替身引擎,这一段接没接上只有这里看得出来(剪断了
 * 平台列退成拓展 id,单元测试照样全绿)。
 *
 * **不碰真模型**:`CommentaryGenerator` 换成真类的子类,只把 `comment()` 换掉 —— 引擎那台常驻的照常建、照常
 * 挂工具,锐评那台每次新建的也是它;`baseUrl` 指向本机一个没人听的端口,万一哪条路漏了替身,也只会当场连不上。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsRoastResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

const prompts = vi.hoisted(() => [] as string[]);

vi.mock("@bilibili-notify/ai", async (importOriginal) => {
	const real = await importOriginal<typeof import("@bilibili-notify/ai")>();
	class CommentaryGenerator extends real.CommentaryGenerator {
		override async comment(content: string): Promise<string> {
			prompts.push(content);
			return JSON.stringify({
				pigeon: { i: 1, reason: "鸽" },
				diligent: { i: 0, reason: "勤" },
				scores: [
					{ i: 0, score: 80 },
					{ i: 1, score: 20 },
				],
				pushText: "i=1 本周鸽了",
			});
		}
	}
	return { ...real, CommentaryGenerator };
});

const FAKE = "fake-source";
const A = "f7000000-0000-4000-8000-000000000001";
const B = "f7000000-0000-4000-8000-000000000002";

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

describe("拓展订阅的锐评 e2e:两条拓展订阅进同一张榜,平台列写清单里的平台名", () => {
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

	/** 先空启动一趟拿到完整的 globals,再开拓展、开女仆(不经 PATCH 的探活,那会去连 baseUrl)、写订阅。 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-extension-roast-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as {
			extensions: Record<string, unknown>;
			defaults: { ai: Record<string, unknown> };
		};
		globals.extensions = { [FAKE]: { enabled: true } };
		globals.defaults.ai = {
			...globals.defaults.ai,
			enabled: true,
			activeProfile: "stub",
			providers: {
				stub: {
					provider: "custom",
					apiKey: "stub-key",
					// 本机 9 号口(discard)没人听:替身漏了也只会当场连不上,不会打到任何真模型。
					baseUrl: "http://127.0.0.1:9/v1",
					model: "stub-model",
				},
			},
		};
		await writeFile(globalsPath, JSON.stringify(globals));

		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");
		await writeFile(
			join(dataDir, "state", "extension-subscriptions.json"),
			JSON.stringify([
				makeExtensionSubscription({ id: A, extensionId: FAKE, externalId: "ext-a", name: "甲号" }),
				makeExtensionSubscription({ id: B, extensionId: FAKE, externalId: "ext-b", name: "乙号" }),
			]),
		);

		port = await findFreePort();
		handle = await boot(port);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("榜单:两行都进提示词(平台列 = 假源清单里的「假源」),结果按订阅 id 回指,pushText 里的下标换回名字", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/stats/roast?days=7&tz=0`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const body = (await res.json()) as StatsRoastResponse;
		expect(res.status, JSON.stringify(body)).toBe(200);

		expect(prompts).toHaveLength(1);
		const prompt = prompts[0] ?? "";
		expect(prompt).not.toContain("B 站 UP 主");
		const table = JSON.parse(prompt.split("\n")[1] ?? "[]") as Array<Record<string, unknown>>;
		expect(table.map((row) => [row.名称, row.平台])).toEqual([
			["甲号", "假源"],
			["乙号", "假源"],
		]);

		expect(body.result?.pigeon.subscriptionId).toBe(B);
		expect(body.result?.diligent.subscriptionId).toBe(A);
		expect(body.result?.scores.map((s) => s.subscriptionId)).toEqual([A, B]);
		expect(body.result?.pushText).toBe("乙号 本周鸽了");
	});
});
