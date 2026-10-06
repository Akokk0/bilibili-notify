/**
 * 🔴 **开机清扫真的接在开机路径上**(切片 ②,`@bilibili-notify/storage` 的 `sweepTempFiles`)。
 *
 * 清扫本身的单元测试在存储层,证明的是「给它一个目录它会清」;而它有没有被开机调用、调的是不是
 * 数据目录、是不是赶在任何写入之前 —— 类型、构建、单元测试全绿都证明不了,漏接的症状是
 * 「上次被杀留下的临时文件与暂存目录永远躺在盘上」,进程照常启动、日志一个字不说。
 *
 * 所以走真的那条路:数据目录里预先摆好残留 → 起服务 → 关掉 → 看盘。摆的东西沿用存储层的临时名
 * 形状 `<名>.bn-tmp.<pid>.<十六进制>`(文件、目录、嵌套在子目录里的各一个),另摆几个「长得像但
 * 不是」的名字与一份普通文件,证明清扫只动认得的那一类。
 *
 * 数据代(ADR-0022)以后清扫只扫两处:宿主根的 `versions/`,和这次要用的那一代。宿主根上 0.x 的文件
 * 是第 0 代、别的旧代也是备份,一个字节都不动 —— 那里的残留原样留着。
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { openTestGeneration } from "./support/generation.js";

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

describe("开机清扫 e2e:上个进程被杀留下的临时文件与暂存目录,开机后没了,别的原样", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-boot-sweep-e2e-"));
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	/** 起服务再关掉,返回这一趟写到 stdout 的日志文字(pino 的 JSON 行)。 */
	async function bootAndClose(): Promise<string> {
		const port = await findFreePort();
		const stdout = vi.spyOn(process.stdout, "write");
		handle = await startServer({
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
		await handle.close("test");
		handle = undefined;
		const logged = stdout.mock.calls.map((call) => String(call[0])).join("");
		stdout.mockRestore();
		return logged;
	}

	it("在用的那一代与 versions/ 里的临时文件、暂存目录、子目录里的临时文件都被清掉;认不得的名字与普通文件一字不动", async () => {
		const generation = await openTestGeneration(dataDir);
		// 残留:三种形状各一个,都在要用的那一代里;versions/ 里再摆一个。
		await writeFile(join(generation, "x.json.bn-tmp.123.abcdef"), "写到一半");
		await mkdir(join(generation, "y.bn-tmp.123.abcdef"));
		await writeFile(join(generation, "y.bn-tmp.123.abcdef", "half.txt"), "暂存里的半份");
		await mkdir(join(generation, "sub"));
		await writeFile(join(generation, "sub", "z.json.bn-tmp.4242.0f0f0f"), "嵌套的临时文件");
		await mkdir(join(dataDir, "versions"), { recursive: true });
		await writeFile(join(dataDir, "versions", "boot-state.json.bn-tmp.7.abcdef"), "选版账写到一半");

		// 不该碰的:普通文件、隔离的坏文件、载荷目录自己的暂存名(由 prune 收,不归清扫)、
		// 长得像但后缀对不上的名字(清扫认 `.bn-tmp.<数字>.<十六进制>` 结尾才动手),
		// 以及第 0 代(宿主根上 0.x 的文件)里的残留 —— 第 0 代是备份,不扫。
		const genRel = generation.slice(dataDir.length + 1);
		const untouched: Record<string, string> = {
			[`${genRel}/keep.txt`]: "普通文件",
			[`${genRel}/sub/keep.json`]: '{"keep":true}',
			[`${genRel}/config.json.corrupt-2026-09-29T00-00-00-000Z`]: "{ 隔离的坏文件",
			"versions/.staging-0.9.0-aaaa/index.mjs": "// 载荷装到一半",
			[`${genRel}/notes.bn-tmp.txt`]: "有标记但没有 pid 与十六进制后缀",
			[`${genRel}/a.bn-tmp.12.xyz`]: "后缀不是十六进制",
			"state/globals.json.bn-tmp.9.abcdef": "第 0 代里的残留",
		};
		for (const [rel, body] of Object.entries(untouched)) {
			await mkdir(join(dataDir, rel, ".."), { recursive: true });
			await writeFile(join(dataDir, rel), body);
		}

		const logged = await bootAndClose();

		expect(existsSync(join(generation, "x.json.bn-tmp.123.abcdef"))).toBe(false);
		expect(existsSync(join(generation, "y.bn-tmp.123.abcdef"))).toBe(false);
		expect(existsSync(join(generation, "sub", "z.json.bn-tmp.4242.0f0f0f"))).toBe(false);
		expect(existsSync(join(dataDir, "versions", "boot-state.json.bn-tmp.7.abcdef"))).toBe(false);
		for (const [rel, body] of Object.entries(untouched)) {
			expect(await readFile(join(dataDir, rel), "utf8"), rel).toBe(body);
		}
		// 子目录本身还在,里面只剩普通文件。
		expect(await readdir(join(generation, "sub"))).toEqual(["keep.json"]);
		// 清了东西就记一行(logger 起来之后才能记,所以是开机日志里的一行,不是清扫时记的)。
		const lines = logged.split("\n").filter((line) => line.includes("开机清扫"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("清掉 4 个");
		expect(lines[0]).toContain("x.json.bn-tmp.123.abcdef");
	});

	/**
	 * ㉙c:删代走「先改名再删」,删到一半被杀的残骸在 `generations/` 这一层与宿主根这一层。开机清扫只补这两层、
	 * 只认那个改名规则产生的名字:旧代内部、`generations/` 里别的东西、宿主根上别人的临时文件都不碰。
	 */
	it("删代删到一半的残骸(generations/ 与宿主根第 0 代键的那一层)被收走,正常的代与旧代内部原样", async () => {
		const generation = await openTestGeneration(dataDir);
		// 一个不是当前代的旧代(格式版本比我新,选代不理它):内部的残留是备份的一部分,不扫。
		const oldGen = join(dataDir, "generations", "9");
		await mkdir(oldGen, { recursive: true });
		await writeFile(
			join(oldGen, "generation.json"),
			JSON.stringify({
				formatVersion: 99,
				migrationRevision: 1,
				createdAt: "2026-10-01T00:00:00.000Z",
				createdBy: "9.9.9",
				lastActiveAt: "2026-10-01T00:00:00.000Z",
				source: { kind: "empty" },
			}),
		);
		await writeFile(join(oldGen, "x.json.bn-tmp.1.abc"), "旧代内部的残留");
		await mkdir(join(dataDir, "generations", "4.bn-tmp.1.abc"));
		await writeFile(join(dataDir, "generations", "4.bn-tmp.1.abc", "half"), "删了一半的旧代");
		await mkdir(join(dataDir, "state.bn-tmp.1.abc"));
		await writeFile(join(dataDir, "bn.config.yaml.bn-tmp.1.abc"), "别人的临时文件");

		await bootAndClose();

		expect(existsSync(join(dataDir, "generations", "4.bn-tmp.1.abc"))).toBe(false);
		expect(existsSync(join(dataDir, "state.bn-tmp.1.abc"))).toBe(false);
		expect(existsSync(join(oldGen, "x.json.bn-tmp.1.abc"))).toBe(true);
		expect(existsSync(join(oldGen, "generation.json"))).toBe(true);
		expect(existsSync(join(generation, "generation.json"))).toBe(true);
		expect(existsSync(join(dataDir, "bn.config.yaml.bn-tmp.1.abc"))).toBe(true);
	});

	/** ㉙c 的接线:index.ts 真把旧代的列表口注入给了 `/api/system`(少一行,面板上「旧版本数据」永远读不出来)。 */
	it("起真服务:GET /api/system/generations 列出在用的这一代", async () => {
		await openTestGeneration(dataDir);
		const port = await findFreePort();
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
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		const res = await fetch(`http://127.0.0.1:${port}/api/system/generations`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { generations: { seq: number; current: boolean }[] };
		expect(body.generations).toMatchObject([{ seq: 1, current: true, lockReason: "current" }]);
	});

	it("什么都没清 → 不记开机清扫那一行(常态不占日志)", async () => {
		await writeFile(join(dataDir, "keep.txt"), "普通文件");

		const logged = await bootAndClose();

		expect(logged).toContain("starting bilibili-notify server");
		expect(logged).not.toContain("开机清扫");
	});

	it("换到一半的整目录替换:目标不在就把旧目录挪回原位", async () => {
		// 两次改名之间进程被杀:目标名字空着、旧的还在 `<目标>.bn-old.*`。
		const generation = await openTestGeneration(dataDir);
		const old = join(generation, "misc", "pack.bn-old.99.abc123");
		await mkdir(old, { recursive: true });
		await writeFile(join(old, "skin.json"), '{"id":"pack"}');

		const logged = await bootAndClose();

		expect(existsSync(old)).toBe(false);
		expect(await readFile(join(generation, "misc", "pack", "skin.json"), "utf8")).toBe(
			'{"id":"pack"}',
		);
		expect(logged).toContain("挪回原位");
	});

	/**
	 * 数据目录是主人挂出来的,里面真会有他丢进来的东西 —— 一个读不动的目录不该让整个开机起不来
	 * (清扫遇到读不动的目录会中止,而它留下的只是垃圾)。用权限位造「读不动」,root 与 Windows 上
	 * 造不出来,跳过。
	 */
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"清扫遇到读不动的目录 → 开机照常,记一行说没做完",
		async () => {
			const locked = join(await openTestGeneration(dataDir), "locked");
			await mkdir(locked);
			await chmod(locked, 0o000);
			try {
				const logged = await bootAndClose();

				expect(logged).toContain("开机清扫没做完");
				expect(logged).toContain("starting bilibili-notify server");
			} finally {
				await chmod(locked, 0o755);
			}
		},
	);

	/**
	 * 「赶在任何写入之前」不是一件能从行为上稳定观察到的事(清扫认不出哪些临时文件是这个进程正在写的,
	 * 后果是偶发地删掉自己的半个文件)。所以钉一道形状:清扫这一行要在 `createAppRuntime`(存储与日志
	 * 落盘都从它起)之前。挪到它后面,上面的行为测试照样全绿。
	 */
	it("清扫在 createAppRuntime 之前调用", async () => {
		const source = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

		const sweepAt = code.indexOf("await sweepBootRoots(");
		const runtimeAt = code.indexOf("createAppRuntime(bootstrap, { dataRoot: generation.dir })");
		expect(sweepAt).toBeGreaterThan(-1);
		expect(runtimeAt).toBeGreaterThan(-1);
		expect(sweepAt).toBeLessThan(runtimeAt);
	});
});
