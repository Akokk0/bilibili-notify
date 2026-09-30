/**
 * 🔴 **数据代接在开机路径上**(ADR-0022 决策 1–3 与它们下面的 🔗;守卫「第 0 代一个字节不变」)。
 *
 * 选代、开代、迁移器各自有直测,证明的是「给它一个目录它会做对」;这里钉的是它们真的接上了,而且接对了:
 *
 * - 0.x 的数据在宿主根上(第 0 代):开机先 listen,迁移期间健康检查照答、别的接口 503 且话里说在搬家,
 *   `generations/1` 在迁完之前不存在;迁完、跑起来、改设置、关掉,第 0 代一个字节都没变,改动落在新的一代。
 *   这也是 ⑤ 欠的那一条:两个根不是同一个目录时,没有谁把东西写回宿主根。
 * - 迁移期间登录拿到的 cookie,迁完照样有效:会话签名的密钥是从第 0 代只读取的那一把,和迁过去的是同一把。
 * - 再开机用同一代,不再迁;迁移修订号对不上就从第 0 代重迁、开第 2 代,第 1 代原地留着。
 * - 新装(宿主根上没有 0.x 数据):开一代空的,不迁。
 * - 拓展页拿到的手放拓展目录是在用那一代的 `extensions/`(装载器读的那一个),不是宿主根上 0.x 的那个。
 * - 迁移抛错:启动入口抛出去,不留下半截的一代。
 *
 * 迁移卡在哪由测试决定:包一层真的迁移器(不换掉它),让它等测试放行,或者直接抛错。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { MIGRATION_REVISION } from "../migration/zero-generation.js";
import { GENERATION_FILE, type GenerationFile } from "../runtime/generations.js";

const gate = vi.hoisted(() => ({
	hold: undefined as Promise<void> | undefined,
	failure: undefined as Error | undefined,
}));

vi.mock("../migration/zero-generation.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../migration/zero-generation.js")>();
	return {
		...real,
		migrateZeroGeneration: async (...args: Parameters<typeof real.migrateZeroGeneration>) => {
			if (gate.failure) throw gate.failure;
			await gate.hold;
			return real.migrateZeroGeneration(...args);
		},
	};
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

async function waitForResponse(url: string, timeoutMs = 3_000): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await fetch(url);
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

/**
 * 第 0 代的样子:几样 0.x 的文件(设置不摆,开机时由配置仓在新的一代里补默认值)。`state/targets.json` 是最老的
 * 单文件形状,新的一代里会被改写成连接 + 目标 —— 摆它是为了让「第 0 代一个字节没变」也盯住改写:
 * 它在新代里是硬链接,不另写成新文件而是原地写的话,第 0 代跟着变。
 */
const ZERO_FILES: Record<string, string> = {
	"secrets/master.key": "ab".repeat(32),
	"state/targets.json": JSON.stringify([
		{
			id: "00000000-0000-4000-8000-000000000001",
			name: "主群",
			platform: "onebot",
			scope: "group",
			enabled: true,
			config: { baseUrl: "http://127.0.0.1:5700", groupId: "111" },
		},
	]),
	"history/2026-09-30.jsonl": '{"id":"row-1"}\n',
	"maid-skills/weekly/SKILL.md": "# 周报",
	"stats/since": "2026-09-01",
};

/** 宿主根上第 0 代那部分的摘要:路径 + 内容(不含宿主件与各代)。 */
async function zeroDigest(dataDir: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = async (dir: string): Promise<void> => {
		for (const name of (await readdir(dir)).sort()) {
			const path = join(dir, name);
			const rel = relative(dataDir, path).split(sep).join("/");
			if (["generations", "versions", "logs"].includes(rel)) continue;
			if ((await lstat(path)).isDirectory()) await walk(path);
			else hash.update(rel).update(await readFile(path));
		}
	};
	await walk(dataDir);
	return hash.digest("hex");
}

describe("数据代接在开机路径上 e2e", () => {
	let dataDir: string;
	let port: number;
	let handle: ServerHandle | undefined;

	const url = (path: string) => `http://127.0.0.1:${port}${path}`;
	const generationsDir = () => join(dataDir, "generations");
	const start = (
		env: Record<string, string> = { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
	) =>
		startServer({
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
			env,
		});

	async function placeZeroGeneration(): Promise<void> {
		for (const [rel, body] of Object.entries(ZERO_FILES)) {
			await mkdir(dirname(join(dataDir, rel)), { recursive: true });
			await writeFile(join(dataDir, rel), body);
		}
	}

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-boot-generations-e2e-"));
		port = await findFreePort();
		gate.hold = undefined;
		gate.failure = undefined;
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("从第 0 代迁:迁的时候健康检查照答、别的接口 503 说在搬家,新的一代迁完才出现;跑完关掉,第 0 代一个字节没变", async () => {
		await placeZeroGeneration();
		const before = await zeroDigest(dataDir);
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});

		const starting = start();
		expect((await waitForResponse(url("/api/health"))).status).toBe(200);
		const busy = await fetch(url("/api/subs"));
		expect(busy.status).toBe(503);
		const body = (await busy.json()) as { code: string; message: string };
		expect(body.code).toBe("unavailable");
		expect(body.message).toContain("搬家");
		expect(existsSync(join(generationsDir(), "1"))).toBe(false);

		release();
		handle = await starting;
		const generation = join(generationsDir(), "1");
		const file = JSON.parse(
			await readFile(join(generation, GENERATION_FILE), "utf8"),
		) as GenerationFile;
		expect(file).toMatchObject({
			formatVersion: 1,
			migrationRevision: MIGRATION_REVISION,
			source: { kind: "zero" },
		});
		expect(await readFile(join(generation, "maid-skills", "weekly", "SKILL.md"), "utf8")).toBe(
			"# 周报",
		);

		const patched = await fetch(url("/api/globals"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ onboarding: { skipped: true } }),
		});
		expect(patched.status, await patched.clone().text()).toBe(200);
		await handle.close("test");
		handle = undefined;

		expect(await zeroDigest(dataDir)).toBe(before);
		const globals = JSON.parse(
			await readFile(join(generation, "config", "globals.json"), "utf8"),
		) as {
			onboarding: { skipped: boolean };
		};
		expect(globals.onboarding.skipped).toBe(true);
	});

	it("迁移期间登录拿到的 cookie,迁完照样有效", async () => {
		await placeZeroGeneration();
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});

		const starting = start({
			BN_CONFIG_DISABLED: "1",
			BN_DASHBOARD_USER: "master",
			BN_DASHBOARD_PASS: "correct horse battery staple",
		});
		await waitForResponse(url("/api/health"));
		const login = await fetch(url("/api/session/login"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "master", password: "correct horse battery staple" }),
		});
		expect(login.status, await login.clone().text()).toBe(200);
		const cookie = login.headers.get("set-cookie")?.split(";")[0];
		expect(cookie).toBeTruthy();

		release();
		handle = await starting;
		const health = await fetch(url("/api/health"), { headers: { cookie: cookie ?? "" } });
		expect(health.status).toBe(200);
	});

	it("再开机用同一代,不再迁;迁移修订号对不上就从第 0 代重迁、开第 2 代,第 1 代原地留着", async () => {
		await placeZeroGeneration();
		handle = await start();
		await handle.close("test");
		handle = await start();
		await handle.close("test");
		handle = undefined;
		expect((await readdir(generationsDir())).sort()).toEqual(["1"]);

		const fileOf1 = join(generationsDir(), "1", GENERATION_FILE);
		const file = JSON.parse(await readFile(fileOf1, "utf8")) as GenerationFile;
		await writeFile(
			fileOf1,
			JSON.stringify({ ...file, migrationRevision: MIGRATION_REVISION + 100 }),
		);

		handle = await start();
		await handle.close("test");
		handle = undefined;
		expect((await readdir(generationsDir())).sort()).toEqual(["1", "2"]);
		expect(
			await readFile(join(generationsDir(), "2", "maid-skills", "weekly", "SKILL.md"), "utf8"),
		).toBe("# 周报");
	});

	it("新装(宿主根上没有 0.x 的数据)→ 开一代空的,不迁", async () => {
		gate.failure = new Error("新装不该走迁移");

		handle = await start();
		await handle.close("test");
		handle = undefined;

		const file = JSON.parse(
			await readFile(join(generationsDir(), "1", GENERATION_FILE), "utf8"),
		) as GenerationFile;
		expect(file.source).toEqual({ kind: "empty" });
	});

	it("拓展页拿到的手放拓展目录是在用那一代的 extensions/,不是宿主根上的", async () => {
		handle = await start();

		const res = await fetch(url("/api/ext"));
		expect(res.status, await res.clone().text()).toBe(200);
		const body = (await res.json()) as ExtensionsResponse;
		expect(body.root).toBe(resolve(generationsDir(), "1", "extensions"));
	});

	it("迁移抛错 → 启动入口抛出去,不留下一代,也不留半截", async () => {
		await placeZeroGeneration();
		const before = await zeroDigest(dataDir);
		gate.failure = new Error("disk on fire");

		await expect(start()).rejects.toThrow("disk on fire");

		expect(await readdir(generationsDir()).catch(() => [])).toEqual([]);
		expect(await zeroDigest(dataDir)).toBe(before);
	});
});
