/**
 * 🔴 **入口真的把「设置里标了机密的格」接到了日志按值打码上(接线的守卫)。**
 *
 * `bindSettingsRedaction` 与登记册各有单元测试,证明不了 `src/index.ts` 真在配置读完之后绑了它、
 * 也证明不了拓展装好之后那一次 `sync()` 真叫了 —— 那两句剪断,类型、构建、单元测试全绿,只是机密值
 * 从此原样进日志。这里起一台真服务端(真入口、真配置仓、真装进来的桥),盘上摆好机密:
 * 桥的接入 token、一条 OneBot 连接的 accessToken。不经任何改动,开机后日志里就该遮;然后经真路由
 * 改 / 删,遮的跟着变。假值一律 `FAKE-…`,长度 ≥ 8。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { CONFIG_DIR, CORE_SETTINGS_FILE, extensionSettingsFile } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import type { NodeServiceContext } from "../runtime/service-context.js";
import type { LogEntry } from "../ws/types.js";
import { snapshotFor } from "./support/connection-snapshot.js";
import { activeGeneration } from "./support/generation.js";
import { installBridgeInto } from "./support/install-bridge.js";

const captured = vi.hoisted(() => ({ ctx: undefined as unknown }));

vi.mock("../runtime/service-context.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/service-context.js")>();
	return {
		...real,
		createNodeServiceContext: (opts: Parameters<typeof real.createNodeServiceContext>[0]) => {
			const ctx = real.createNodeServiceContext(opts);
			captured.ctx = ctx;
			return ctx;
		},
	};
});

vi.mock("../bilibili/source.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../bilibili/source.js")>();
	return {
		...real,
		createBiliSource: () => ({
			descriptor: { label: "B 站", postNoun: "动态" },
			async start() {},
			async stop() {},
			// 入口把 `builtins.bilibili.api()`(来源造好的 `Api`)交给 `createApp`;假来源没有。
			api: () => undefined,
		}),
	};
});

const CONNECTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINK_ID = "link-home";
const LINK_NAME = "FAKE-link-name-visible";
const OLD_TOKEN = "FAKE-bridge-token-old";
const NEW_TOKEN = "FAKE-bridge-token-new";
const ACCESS_TOKEN = "FAKE-onebot-access-token";
const ONEBOT_URL = "http://FAKE-onebot-host:5700/";
const AI_KEY = "FAKE-ai-api-key-value";

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

describe("设置里的机密接在开机路径上", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let say: (text: string) => string;

	function boot(port: number): Promise<ServerHandle> {
		return startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"info",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-settings-redaction-boot-e2e-"));
		// 先空启动一趟让 globals 落盘(手写的缺格会整份被判废),再摆机密。
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		const gen = await activeGeneration(dataDir);
		const globalsPath = join(gen, ...CORE_SETTINGS_FILE);
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { bridge: { enabled: true } };
		const settingsPath = join(gen, ...extensionSettingsFile("bridge"));
		await mkdir(join(settingsPath, ".."), { recursive: true });
		await writeFile(
			settingsPath,
			JSON.stringify({
				links: [
					{
						id: LINK_ID,
						name: LINK_NAME,
						enabled: true,
						token: OLD_TOKEN,
						bridgeKind: "koishi",
					},
				],
			}),
		);
		await installBridgeInto(dataDir);
		await writeFile(globalsPath, JSON.stringify(globals));
		await writeFile(
			join(gen, ...CONFIG_DIR, "connections.json"),
			JSON.stringify([
				{
					id: CONNECTION_ID,
					name: "测试 bot",
					enabled: false,
					adapterKey: "onebot",
					platform: "onebot",
					settings: { transport: "http", baseUrl: ONEBOT_URL, accessToken: ACCESS_TOKEN },
					platformSnapshot: snapshotFor("onebot"),
				},
			]),
		);

		handle = await boot(await findFreePort());
		const ctx = captured.ctx as NodeServiceContext;
		const seen: LogEntry[] = [];
		ctx.setLogHook((entry) => seen.push(entry));
		say = (text) => {
			seen.length = 0;
			ctx.logger.info(text);
			return seen.map((entry) => entry.msg).join("|");
		};
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	// 验红:删掉 `index.ts` 里 `bindSettingsRedaction({ … })` 那一句,两格都红。
	// 验红:删掉 `loadExtensions` 之后那次 `settingsRedaction.sync()`,桥设置里的名字被整份遮掉,可见的那条红。
	it("盘上摆好的机密,开机后不经任何改动就被遮;backupOnly 的地址与别的格照显", () => {
		expect(say(`bridge ${OLD_TOKEN} / onebot ${ACCESS_TOKEN}`)).toBe("bridge *** / onebot ***");
		expect(say(`连 ${ONEBOT_URL} 失败`)).toBe(`连 ${ONEBOT_URL} 失败`);
		expect(say(`接入 ${LINK_NAME}`)).toBe(`接入 ${LINK_NAME}`);
	});

	// 验红:`bindSettingsRedaction` 里不订 `configStore.onChange`,这条红。
	it("经真路由换桥的 token、换 AI key、删连接:新的遮、旧的露", async () => {
		const read = await fetch(`${handle?.url}/api/ext/bridge/settings`);
		const { revision } = (await read.json()) as { revision: string };
		const patchedToken = await fetch(`${handle?.url}/api/ext/bridge/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				revision,
				ops: [{ op: "update", list: "links", id: LINK_ID, values: { token: NEW_TOKEN } }],
			}),
		});
		expect(patchedToken.status).toBe(200);
		expect(say(`${OLD_TOKEN} ${NEW_TOKEN}`)).toBe(`${OLD_TOKEN} ***`);

		const patchedAi = await fetch(`${handle?.url}/api/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			// AI 没开,不触发探活;桶要给整份(新桶没有默认值可补)。
			body: JSON.stringify({
				core: {
					ai: {
						providers: {
							deepseek: {
								provider: "deepseek",
								apiFlavor: "chat",
								label: "",
								apiKey: AI_KEY,
								baseUrl: "https://FAKE-ai.example/v1",
								model: "m",
								enableThinking: false,
								thinkingLevel: "medium",
								extraParams: "",
								enableVision: false,
								vision: { baseUrl: "", apiKey: "", model: "" },
							},
						},
					},
				},
			}),
		});
		expect(patchedAi.status).toBe(200);
		expect(say(`key=${AI_KEY}`)).toBe("key=***");

		const deleted = await fetch(`${handle?.url}/api/connections/${CONNECTION_ID}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(204);
		expect(say(ACCESS_TOKEN)).toBe(ACCESS_TOKEN);
	});
});
