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
 * - 再开机用到已有的一代,它的 `lastActiveAt` 往前走(只给系统页显示「最后使用时间」);以后的版本往
 *   generation.json 里加的格不剥掉 —— 那一代以后还要给那个版本用。
 * - 新装(宿主根上没有 0.x 数据):开一代空的,不迁。
 * - 拓展页拿到的手放拓展目录是在用那一代的 `extensions/`(装载器读的那一个),不是宿主根上 0.x 的那个。
 * - 迁移抛错:启动入口抛出去,不留下半截的一代。
 * - 主人要求开新代(⑧,`generations/pending.json`):全新开始开空代、主密钥带过去(不登出);从旧代重新迁移
 *   开从第 0 代迁来的一代;新代里记一条「迁好了」。要求的新代没开成:留在原来那一代、失败原因记在它的提示里,
 *   有人拉起来就正常退出等着被拉起,没人拉就照旧抛出去。第 0 代已经不在了就照常用原来那一代、记一条失败。
 * - 启动器判死过比正在跑的新的版本:记一条「X 起不来」。
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
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { MIGRATION_REVISION } from "../migration/zero-generation.js";
import {
	GENERATION_FILE,
	type GenerationFile,
	writePendingGeneration,
} from "../runtime/generations.js";
import { createSystemNoticeStore } from "../runtime/system-notices.js";

const gate = vi.hoisted(() => ({
	hold: undefined as Promise<void> | undefined,
	failure: undefined as Error | undefined,
	copyFailure: undefined as Error | undefined,
}));

// 复制也包一层真的(不换掉它):测试要它在全新开始拷主密钥时抛。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const real = await importOriginal<typeof import("@bilibili-notify/storage")>();
	return {
		...real,
		copyFileAtomic: async (...args: Parameters<typeof real.copyFileAtomic>) => {
			if (gate.copyFailure) throw gate.copyFailure;
			return real.copyFileAtomic(...args);
		},
	};
});

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
 * 单文件形状,新的一代里会被改写成连接 + 目标 —— 摆它是为了让「第 0 代一个字节没变」也盯住改写。
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
	// 「这一代是从第 0 代迁出来的」的记号:原样复制、开机不会再碰的一份(女仆技能 3b-53 起不迁,不能再拿它当记号)。
	"card-bg-cursors.json": "{}",
	"stats/since": "2026-09-01",
};

/** 上面那份记号在代里的位置(相对代根)。 */
const MIGRATED_MARKER = join("runtime", "card-bg-cursors.json");

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
		gate.copyFailure = undefined;
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
		const busy = await fetch(url("/api/subscriptions"));
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
		expect(await readFile(join(generation, MIGRATED_MARKER), "utf8")).toBe("{}");
		// 女仆技能不迁(3b-53):第 0 代摆着,新的一代里没有。
		expect(existsSync(join(generation, "maid-skills"))).toBe(false);

		const patched = await fetch(url("/api/settings"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ core: { onboarding: { skipped: true } } }),
		});
		expect(patched.status, await patched.clone().text()).toBe(200);
		await handle.close("test");
		handle = undefined;

		expect(await zeroDigest(dataDir)).toBe(before);
		const globals = JSON.parse(await readFile(join(generation, ...CORE_SETTINGS_FILE), "utf8")) as {
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
		expect(await readFile(join(generationsDir(), "2", MIGRATED_MARKER), "utf8")).toBe("{}");
	});

	it("再开机用到已有的一代 → 它的 lastActiveAt 往前走,别的格原样,以后的版本加的格也留着", async () => {
		handle = await start();
		await handle.close("test");
		handle = undefined;
		const fileOf1 = join(generationsDir(), "1", GENERATION_FILE);
		const file = JSON.parse(await readFile(fileOf1, "utf8")) as GenerationFile;
		const longAgo = "2020-01-01T00:00:00.000Z";
		await writeFile(
			fileOf1,
			JSON.stringify({ ...file, lastActiveAt: longAgo, addedLater: { x: 1 } }),
		);

		handle = await start();
		await handle.close("test");
		handle = undefined;

		const after = JSON.parse(await readFile(fileOf1, "utf8")) as GenerationFile;
		expect(Date.parse(after.lastActiveAt)).toBeGreaterThan(Date.parse(longAgo));
		expect(after).toEqual({ ...file, lastActiveAt: after.lastActiveAt, addedLater: { x: 1 } });
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

	const quietEnv = { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" };
	/** 有人会把退出的进程拉起来(桌面壳):开新代失败时才会正常退出、等着被拉起。 */
	const supervisedEnv = { ...quietEnv, BN_PARENT_PID: String(process.ppid) };
	const noticesOf = (seq: number) =>
		createSystemNoticeStore({
			dir: join(generationsDir(), String(seq)),
			runningVersion: "0.0.0-dev",
		}).list();
	const fileOf = async (seq: number) =>
		JSON.parse(
			await readFile(join(generationsDir(), String(seq), GENERATION_FILE), "utf8"),
		) as GenerationFile;
	async function bootOnce(env: Record<string, string> = quietEnv): Promise<void> {
		handle = await start(env);
		await handle.close("test");
		handle = undefined;
	}

	it("全新开始:开下一个号的空代,主密钥带过去,旧代原地留着,标记用掉就没了", async () => {
		await placeZeroGeneration();
		await bootOnce();
		await writePendingGeneration(dataDir, { kind: "empty" });

		await bootOnce();

		expect((await readdir(generationsDir())).sort()).toEqual(["1", "2"]);
		expect((await fileOf(2)).source).toEqual({ kind: "empty" });
		expect(await readFile(join(generationsDir(), "2", "secrets", "master.key"))).toEqual(
			await readFile(join(generationsDir(), "1", "secrets", "master.key")),
		);
		expect(existsSync(join(generationsDir(), "2", MIGRATED_MARKER))).toBe(false);
		expect(existsSync(join(generationsDir(), "1", MIGRATED_MARKER))).toBe(true);
		expect(await noticesOf(2)).toEqual([]);
	});

	it("从旧代重新迁移:开下一个号、从第 0 代迁;新代里记一条「迁好了」,老卡片皮肤没迁就说出来", async () => {
		await placeZeroGeneration();
		await mkdir(join(dataDir, "card-skins", "old"), { recursive: true });
		await writeFile(join(dataDir, "card-skins", "old", "skin.json"), "{}");
		await bootOnce();
		expect(await noticesOf(1)).toMatchObject([{ kind: "migrated", cardSkinsDropped: true }]);
		await writePendingGeneration(dataDir, { kind: "empty" });
		await bootOnce();
		await writePendingGeneration(dataDir, { kind: "zero" });

		await bootOnce();

		expect((await readdir(generationsDir())).sort()).toEqual(["1", "2", "3"]);
		expect((await fileOf(3)).source).toEqual({ kind: "zero" });
		expect(await readFile(join(generationsDir(), "3", MIGRATED_MARKER), "utf8")).toBe("{}");
		expect(await noticesOf(3)).toMatchObject([{ kind: "migrated", cardSkinsDropped: true }]);
	});

	it("要求的新代没开成、有人会拉起来:不留半截,失败原因记在原来那一代,正常退出;再开机接着用它", async () => {
		await placeZeroGeneration();
		await bootOnce();
		await writePendingGeneration(dataDir, { kind: "zero" });
		gate.failure = new Error("disk on fire");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			await expect(start(supervisedEnv)).rejects.toThrow("disk on fire");
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
		}
		gate.failure = undefined;

		expect((await readdir(generationsDir())).sort()).toEqual(["1"]);
		expect(await noticesOf(1)).toMatchObject([
			{ kind: "migrated" },
			{
				kind: "generation-failed",
				source: "zero",
				message: expect.stringContaining("disk on fire"),
			},
		]);

		await bootOnce();
		expect((await readdir(generationsDir())).sort()).toEqual(["1"]);
	});

	it("要求的新代没开成、没人会拉起来:照旧抛出去,失败原因照样记下", async () => {
		await placeZeroGeneration();
		await bootOnce();
		await writePendingGeneration(dataDir, { kind: "zero" });
		gate.failure = new Error("disk on fire");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			await expect(start()).rejects.toThrow("disk on fire");
			expect(exit).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
		}

		expect((await readdir(generationsDir())).sort()).toEqual(["1"]);
		expect(await noticesOf(1)).toMatchObject([{ kind: "migrated" }, { kind: "generation-failed" }]);
	});

	it("全新开始没开成:不留半截,接着用原来那一代,失败原因记下", async () => {
		await placeZeroGeneration();
		await bootOnce();
		await writePendingGeneration(dataDir, { kind: "empty" });
		gate.copyFailure = new Error("copy refused");

		await bootOnce();

		expect((await readdir(generationsDir())).sort()).toEqual(["1"]);
		expect(await noticesOf(1)).toMatchObject([
			{ kind: "migrated" },
			{
				kind: "generation-failed",
				source: "empty",
				message: expect.stringContaining("copy refused"),
			},
		]);
	});

	it("要求从第 0 代迁、第 0 代已经不在了:照常用原来那一代,记一条失败", async () => {
		await bootOnce();
		await writePendingGeneration(dataDir, { kind: "zero" });

		await bootOnce();

		expect((await readdir(generationsDir())).sort()).toEqual(["1"]);
		expect(await noticesOf(1)).toMatchObject([{ kind: "generation-failed", source: "zero" }]);
	});

	it("面板这一头真接上了:迁完能读到「迁好了」、标已读;点全新开始 → 写下标记、重启,被拉起来以后是新的一代", async () => {
		await placeZeroGeneration();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			handle = await start(supervisedEnv);

			const listed = (await (await fetch(url("/api/system/notices"))).json()) as {
				notices: { id: string; kind: string }[];
			};
			expect(listed.notices).toMatchObject([{ kind: "migrated" }]);
			const [migrated] = listed.notices;
			if (!migrated) throw new Error("expected a notice");
			const acked = await fetch(url(`/api/system/notices/${migrated.id}/acknowledge`), {
				method: "POST",
			});
			expect(((await acked.json()) as { notices: unknown[] }).notices).toEqual([]);

			const res = await fetch(url("/api/system/generations"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "empty" }),
			});
			expect(res.status).toBe(200);
			expect(existsSync(join(generationsDir(), "pending.json"))).toBe(true);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
			// 真关了、端口放掉了:退出是替身,不能拿「第二次开机没撞端口」去倒推。
			await expect(fetch(url("/api/health"))).rejects.toThrow();
		} finally {
			exit.mockRestore();
		}
		handle = undefined;

		await bootOnce();

		expect((await readdir(generationsDir())).sort()).toEqual(["1", "2"]);
		expect((await fileOf(2)).source).toEqual({ kind: "empty" });
	});

	it("启动器判死过比正在跑的新的版本 → 记一条「X 起不来」", async () => {
		await mkdir(join(dataDir, "versions"), { recursive: true });
		await writeFile(
			join(dataDir, "versions", "boot-state.json"),
			JSON.stringify({ attempts: {}, failed: ["99.0.0"], revoked: [] }),
		);

		await bootOnce();

		expect(await noticesOf(1)).toMatchObject([{ kind: "rolled-back", version: "99.0.0" }]);
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
