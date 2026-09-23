/**
 * 🔴 **订阅源那一口在真 BN 上是接着的**(ADR-0019 决策 52)。
 *
 * `index.ts` 给装载器递了两根线:`subscriptions`(现读订阅表、只递拓展那一支)与
 * `onSubscriptionsChanged`(bus 上 `config-changed` / `subscriptions` 转过去);再给路由递了
 * `lookup`。装载器那层的测试(`extensions/__tests__/subscription-source.test.ts`)用的是**自己
 * 握着**的订阅表与通知 —— 这里任意一根漏接或接成空的,那边全绿,症状是拓展以为自己名下一条
 * 订阅都没有(永远不轮询)、或者面板上改了订阅它一声都没听见(新订阅不补基线)。
 *
 * 所以装一个真的 v2 小拓展进装载根、起一台真 BN:它的解析门把 `handle.subscriptions()` 与
 * 「听到过几次变更」原样念出来,从面板那条 HTTP 口读。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionLookupResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

const FIXTURE_ID = "sub-probe";
/** 别的拓展名下的一条 —— 它不该出现在 fixture 读到的名单里。那个拓展装都没装,不影响。 */
const OTHER_ID = "other-source";

const ENABLED_ROW = makeExtensionSubscription({
	id: "a0000000-0000-4000-8000-000000000001",
	extensionId: FIXTURE_ID,
	externalId: "ext-on",
	enabled: true,
});
const DISABLED_ROW = makeExtensionSubscription({
	id: "a0000000-0000-4000-8000-000000000002",
	extensionId: FIXTURE_ID,
	externalId: "ext-off",
	enabled: false,
});
const FOREIGN_ROW = makeExtensionSubscription({
	id: "a0000000-0000-4000-8000-000000000003",
	extensionId: OTHER_ID,
	externalId: "ext-foreign",
	enabled: true,
});

/**
 * 解析门不查人,只把自己读到的订阅念出来:一条订阅一个候选,`id` 是 externalId,`name` 是
 * 「开没开:听到过几次变更」。
 */
const FIXTURE_CODE = `
export function activate(ctx) {
	let changes = 0;
	const handle = ctx.registerSubscriptionSource({
		lookup() {
			return handle.subscriptions().map((row) => ({
				id: row.externalId,
				name: \`\${row.enabled ? "on" : "off"}:\${changes}\`,
			}));
		},
	});
	handle.onSubscriptionsChanged(() => {
		changes += 1;
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

describe("订阅源 e2e:装载器读到的订阅与变更通知,是 BN 真的那一份", () => {
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

	/**
	 * globals 先跑一趟空启动再改(`GlobalConfigSchema` 有几段没默认值,手写一份缺格的会在开机时
	 * 整份被判废);拓展摆进唯一那个装载根、开关拨开;订阅直接写进拓展订阅住的那个文件。
	 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sub-source-e2e-"));
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
				name: "订阅源探针",
				description: "把自己读到的订阅从解析门念出来",
				version: "0.1.0",
				apiVersion: 2,
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["post"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);

		await writeFile(
			join(dataDir, "state", "extension-subscriptions.json"),
			JSON.stringify([ENABLED_ROW, DISABLED_ROW, FOREIGN_ROW]),
		);

		port = await findFreePort();
		handle = await boot(port);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	async function lookup(): Promise<ExtensionLookupResponse["candidates"]> {
		const res = await fetch(`http://127.0.0.1:${port}/api/ext/${FIXTURE_ID}/lookup?q=x`);
		const body = (await res.json()) as ExtensionLookupResponse;
		expect(res.status, JSON.stringify(body)).toBe(200);
		return body.candidates;
	}

	/** 候选按 externalId 排好 —— 名单的次序不是这里要钉的东西。 */
	function byId(candidates: ExtensionLookupResponse["candidates"]) {
		return [...candidates].sort((a, b) => a.id.localeCompare(b.id));
	}

	it("开机即读得到自己名下的两条(停用的也在),别的拓展那条不在;还没听到过变更", async () => {
		expect(byId(await lookup())).toEqual([
			{ id: "ext-off", name: "off:0" },
			{ id: "ext-on", name: "on:0" },
		]);
	});

	it("经面板那条 API 停用一条 → 拓展现读到它停了,而且听到了变更", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/subs/${ENABLED_ROW.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status, await res.clone().text()).toBe(200);

		const candidates = byId(await lookup());
		expect(candidates.map((c) => c.id)).toEqual(["ext-off", "ext-on"]);
		for (const c of candidates) {
			const [state, changes] = c.name.split(":");
			expect(state, c.id).toBe("off");
			expect(Number(changes), c.id).toBeGreaterThanOrEqual(1);
		}
	});
});
