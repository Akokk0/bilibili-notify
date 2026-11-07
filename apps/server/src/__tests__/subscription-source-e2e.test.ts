/**
 * 🔴 **订阅源那一口在真 BN 上是接着的**(ADR-0019 决策 52)。
 *
 * 来源经 `registerSource` 拿到的核心 `SourceContext` 现读订阅表,并听 `onSubscriptionsChanged`;
 * 路由经引擎的 `searchCreators` 问来源。核心来源上下文的单测用的是自己握着的订阅表与通知 ——
 * 这里任意一根漏接或接成空的,那边全绿,症状是拓展以为自己名下一条订阅都没有(永远不轮询)、
 * 或者面板上改了订阅它一声都没听见(新订阅不补基线)。
 *
 * 所以装一个真的 v3 小拓展进装载根、起一台真 BN:它的 `searchCreators` 把来源名单与
 * 「听到过几次变更」原样念出来,从面板那条 HTTP 口读。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreatorsResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { CONFIG_DIR, CORE_SETTINGS_FILE } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration } from "./support/generation.js";
import { subscriptionsFileText } from "./support/subscriptions-file.js";

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
	let source;
	ctx.registerSource({
		start(current) {
			source = current;
			source.onSubscriptionsChanged(() => {
				changes += 1;
			});
		},
		stop() {},
		searchCreators() {
			return { ok: true, candidates: (source?.subscriptions() ?? []).map((row) => ({
				externalId: row.externalId,
				name: \`on:\${changes}\`,
			})) };
		},
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
	let handle: ServerHandle | undefined;
	let port: number;

	function boot(at: number): Promise<ServerHandle> {
		return startServer({
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
		});
	}

	/**
	 * globals 先跑一趟空启动再改(`GlobalSettingsSchema` 有几段没默认值,手写一份缺格的会在开机时
	 * 整份被判废);拓展摆进唯一那个装载根、开关拨开;订阅直接写进拓展订阅住的那个文件。
	 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sub-source-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		const gen = await activeGeneration(dataDir);

		const globalsPath = join(gen, ...CORE_SETTINGS_FILE);
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { [FIXTURE_ID]: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		const extDir = join(gen, "extensions", FIXTURE_ID);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: FIXTURE_ID,
				name: "订阅源探针",
				description: "把自己读到的订阅从解析门念出来",
				version: "0.1.0",
				apiVersion: 1,
				contributes: {
					subscription: {
						label: "探针",
						shortLabel: "探",
						color: "#3366ff",
						supportedFeatures: ["post"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);

		await writeFile(
			join(gen, ...CONFIG_DIR, "subscriptions.json"),
			subscriptionsFileText([ENABLED_ROW, DISABLED_ROW, FOREIGN_ROW]),
		);

		port = await findFreePort();
		handle = await boot(port);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	async function lookup(): Promise<CreatorsResponse["candidates"]> {
		const res = await fetch(`http://127.0.0.1:${port}/api/sources/${FIXTURE_ID}/creators?q=x`);
		const body = (await res.json()) as CreatorsResponse;
		expect(res.status, JSON.stringify(body)).toBe(200);
		return body.candidates;
	}

	/** 候选按 externalId 排好 —— 名单的次序不是这里要钉的东西。 */
	function byId(candidates: CreatorsResponse["candidates"]) {
		return [...candidates].sort((a, b) => a.externalId.localeCompare(b.externalId));
	}

	it("开机即读得到自己名下启用中的一条,停用的与别的拓展那条都不在;还没听到过变更", async () => {
		expect(byId(await lookup())).toEqual([{ externalId: "ext-on", name: "on:0" }]);
	});

	it("经面板那条 API 改开关 → 拓展现读到停用的不在,而且每一次都听到了变更", async () => {
		const enabled = await fetch(`http://127.0.0.1:${port}/api/subscriptions/${DISABLED_ROW.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(enabled.status, await enabled.clone().text()).toBe(200);

		expect(byId(await lookup())).toEqual([
			{ externalId: "ext-off", name: "on:1" },
			{ externalId: "ext-on", name: "on:1" },
		]);

		const disabled = await fetch(`http://127.0.0.1:${port}/api/subscriptions/${ENABLED_ROW.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(disabled.status, await disabled.clone().text()).toBe(200);
		expect(byId(await lookup())).toEqual([{ externalId: "ext-off", name: "on:2" }]);
	});
});
