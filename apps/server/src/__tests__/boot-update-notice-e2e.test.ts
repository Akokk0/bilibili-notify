/**
 * 🔴 **升级之后的「本次更新」接在开机路径上**(ADR-0005 决策 16 下 2026-10-02 的 🔗)。
 *
 * `recordUpdate` / `readReleaseNotes` 各有直测,证明的是「给它输入它会做对」;这里钉的是 `startServer` 真的调了它们:
 *
 * - 用 1.0.0 开机一次(开出这一代),再用 1.1.0 开机 → `GET /api/system/notices` 里有一条 `updated`,版本 1.1.0,
 *   说明来自 `bundleUrl` 旁那份 `release-notes.json`;再用 1.1.0 开一次不再多记。
 * - 开发版开机什么都不记。
 * - 载荷旁的说明是空表(CHANGELOG 里还没有 1.x 段)或根本没有这份文件 → 照记,`releases` 是空表,开机不失败。
 *
 * `APP_VERSION` 被更新服务、健康检查等多处读,所以这里换的是它本身(mock `routes/health.js`),不是只换提示清单那一处。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SystemNoticesResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

const running = vi.hoisted(() => ({ version: "1.0.0" }));

vi.mock("../routes/health.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../routes/health.js")>();
	return Object.defineProperty({ ...real }, "APP_VERSION", {
		enumerable: true,
		get: () => running.version,
	});
});

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

describe("升级之后的「本次更新」接在开机路径上 e2e", () => {
	let dataDir: string;
	let payloadDir: string;
	let port: number;
	let handle: ServerHandle | undefined;

	const url = (path: string) => `http://127.0.0.1:${port}${path}`;
	const boot = async (version: string, extraEnv: NodeJS.ProcessEnv = {}) => {
		running.version = version;
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
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", ...extraEnv },
			bundleUrl: pathToFileURL(join(payloadDir, "index.mjs")).href,
		});
	};
	const shutdown = async () => {
		await handle?.close("test");
		handle = undefined;
	};
	const noticesOf = async () =>
		((await (await fetch(url("/api/system/notices"))).json()) as SystemNoticesResponse).notices;
	const writeNotes = (releases: unknown[]) =>
		writeFile(join(payloadDir, "release-notes.json"), JSON.stringify({ releases }));

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-boot-update-notice-e2e-"));
		payloadDir = await mkdtemp(join(tmpdir(), "bn-boot-update-notice-payload-"));
		await mkdir(payloadDir, { recursive: true });
		port = await findFreePort();
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
		await rm(payloadDir, { recursive: true, force: true });
	});

	it("用 1.0.0 开机,再用 1.1.0 开机 → 清单里有一条 updated,说明来自载荷旁的数据文件;再开一次不再多记", async () => {
		await writeNotes([
			{ version: "1.1.0", summary: "**新功能**", caution: "⚠️ 先停掉旧任务" },
			{ version: "1.0.0", summary: "第一版" },
		]);
		await boot("1.0.0");
		expect(await noticesOf()).toEqual([]);
		await shutdown();

		await boot("1.1.0");
		const [notice, ...rest] = await noticesOf();
		expect(rest).toEqual([]);
		expect(notice).toMatchObject({ kind: "updated", version: "1.1.0" });
		expect(notice).toMatchObject({
			releases: [
				{
					version: "1.1.0",
					summary: "**新功能**",
					caution: "⚠️ 先停掉旧任务",
					releaseUrl: "https://github.com/Akokk0/bilibili-notify/releases/tag/v1.1.0",
				},
			],
		});
		await shutdown();

		await boot("1.1.0");
		expect(await noticesOf()).toHaveLength(1);
	});

	it.each([
		[{ BN_PREINSTALLED_VERSION: "0.9.0", BN_IMAGE_VERSION: "0.8.0" }, "0.9.0"],
		[{ BN_IMAGE_VERSION: "0.8.0" }, "0.8.0"],
		[{ BN_PREINSTALLED_VERSION: "  ", BN_IMAGE_VERSION: "0.8.0" }, "0.8.0"],
		[{}, null],
	])("预装版本新名优先、旧名回退，直接启动以自身为底：%j", async (env, expected) => {
		await boot("1.0.0", env);
		const response = await fetch(url("/api/system/update"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			currentVersion: "1.0.0",
			rollbackTarget: expected,
		});
	});

	it("开发版开机什么都不记", async () => {
		await boot("0.0.0-dev");
		await shutdown();
		// 读不到 package.json 时版本兜底成 "dev"。按数字比它高过 "0.0.0-dev",不拦的话会被当成升级。
		await boot("dev");

		expect(await noticesOf()).toEqual([]);
	});

	it("载荷旁的说明是空表 → 照记,releases 是空表,开机不失败", async () => {
		await writeNotes([]);
		await boot("1.0.0");
		await shutdown();

		await boot("1.1.0");
		expect(await noticesOf()).toMatchObject([{ kind: "updated", version: "1.1.0", releases: [] }]);
	});

	it("载荷旁没有数据文件 → 同样照记,开机不失败", async () => {
		await boot("1.0.0");
		await shutdown();

		await boot("1.1.0");
		expect(await noticesOf()).toMatchObject([{ kind: "updated", version: "1.1.0", releases: [] }]);
	});
});
