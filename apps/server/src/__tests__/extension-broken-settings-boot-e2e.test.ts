/**
 * 🔴 **一个拓展的设置文件不是合法 JSON,开机照常起,只停那一个拓展**(接线守卫)。
 *
 * 配置仓记原因、装载器看原因,各自有直测;要真能停下那一个拓展、别的照跑,还得 `index.ts` 把
 * `configStore.extensionSettingsIssue` 接进装载器那一格 —— 漏接的话类型与单元测试全绿,而带默认值的拓展
 * 会拿默认值盖掉那份坏文件。所以走真入口:一台真 BN、一个设置文件是半截 JSON 的拓展(activate 一跑就炸,
 * 能看出它根本没被起)、一个好好的拓展。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { CORE_SETTINGS_FILE, extensionSettingsFile } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { activeGeneration } from "./support/generation.js";

const BROKEN_ID = "broken-settings-probe";
const HEALTHY_ID = "healthy-probe";
const BROKEN_FILE = '{"interval": 60, "links": [';

function manifestOf(id: string): string {
	return JSON.stringify({
		id,
		name: id,
		description: "测试用",
		version: "0.1.0",
		apiVersion: 3,
		contributes: {
			subscription: {
				label: "探针",
				shortLabel: "探",
				color: "#3366ff",
				supportedFeatures: ["post"],
			},
		},
	});
}

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

describe("设置文件不是合法 JSON e2e:只停那一个拓展", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;
	let settingsPath: string;

	const boot = async (listenPort: number) =>
		startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(listenPort),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-broken-settings-e2e-"));
		// 先空启动一趟让数据代与核心设置就位,再摆数据(手写 globals 缺格会整份被判废)。
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		const gen = await activeGeneration(dataDir);

		const globalsPath = join(gen, ...CORE_SETTINGS_FILE);
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { [BROKEN_ID]: { enabled: true }, [HEALTHY_ID]: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		settingsPath = join(gen, ...extensionSettingsFile(BROKEN_ID));
		await mkdir(join(settingsPath, ".."), { recursive: true });
		await writeFile(settingsPath, BROKEN_FILE);

		for (const id of [BROKEN_ID, HEALTHY_ID]) {
			// 装载根是在用那一代的 extensions/。
			const dir = join(gen, "extensions", id);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "extension.json"), manifestOf(id));
			// 坏设置的那个只要被 activate 就会炸 —— 它该是「设置读不了」而不是「加载失败」。
			await writeFile(
				join(dir, "index.mjs"),
				id === BROKEN_ID
					? 'export function activate() { throw new Error("不该被起"); }'
					: "export function activate() {}",
			);
		}

		port = await findFreePort();
		handle = await boot(port);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("开机成功;坏的那个停在「设置读不了」,别的拓展照跑;文件原样没动", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/ext`);
		const body = (await res.json()) as ExtensionsResponse;
		const broken = body.extensions.find((e) => e.id === BROKEN_ID);
		expect(broken?.state).toBe("settings-invalid");
		expect(broken?.detail).toContain("不是合法的 JSON");
		expect(body.extensions.find((e) => e.id === HEALTHY_ID)?.state).toBe("running");
		expect(await readFile(settingsPath, "utf8")).toBe(BROKEN_FILE);
	});

	// 验红:剪 `index.ts` 递给装载器的 `problems`(或 `loader.ts` 里报「设置读不了」的那一行),这条红。
	it("同一台 BN 的问题表里,坏的那个名下有一条 settings_invalid;好的那个没有", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/problems`);
		const { problems } = (await res.json()) as {
			problems: Array<{ reporter: string; code: string; message: string }>;
		};
		const mine = problems.filter((p) => p.reporter === BROKEN_ID);
		expect(mine.map((p) => p.code)).toEqual(["settings_invalid"]);
		expect(mine[0]?.message).toContain("不是合法的 JSON");
		expect(problems.some((p) => p.reporter === HEALTHY_ID)).toBe(false);
	});
});
