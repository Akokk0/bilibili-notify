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
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

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

	it("根目录的临时文件、暂存目录与子目录里的临时文件都被清掉;认不得的名字与普通文件一字不动", async () => {
		// 残留:三种形状各一个。
		await writeFile(join(dataDir, "x.json.bn-tmp.123.abcdef"), "写到一半");
		await mkdir(join(dataDir, "y.bn-tmp.123.abcdef"));
		await writeFile(join(dataDir, "y.bn-tmp.123.abcdef", "half.txt"), "暂存里的半份");
		await mkdir(join(dataDir, "sub"));
		await writeFile(join(dataDir, "sub", "z.json.bn-tmp.4242.0f0f0f"), "嵌套的临时文件");

		// 不该碰的:普通文件、隔离的坏文件、载荷目录自己的暂存名(由 prune 收,不归清扫)、
		// 以及长得像但后缀对不上的名字(清扫认 `.bn-tmp.<数字>.<十六进制>` 结尾才动手)。
		const untouched: Record<string, string> = {
			"keep.txt": "普通文件",
			"sub/keep.json": '{"keep":true}',
			"state.json.corrupt-2026-09-29T00-00-00-000Z": "{ 隔离的坏文件",
			"versions/.staging-0.9.0-aaaa/index.mjs": "// 载荷装到一半",
			"notes.bn-tmp.txt": "有标记但没有 pid 与十六进制后缀",
			"a.bn-tmp.12.xyz": "后缀不是十六进制",
		};
		for (const [rel, body] of Object.entries(untouched)) {
			await mkdir(join(dataDir, rel, ".."), { recursive: true });
			await writeFile(join(dataDir, rel), body);
		}

		const logged = await bootAndClose();

		expect(existsSync(join(dataDir, "x.json.bn-tmp.123.abcdef"))).toBe(false);
		expect(existsSync(join(dataDir, "y.bn-tmp.123.abcdef"))).toBe(false);
		expect(existsSync(join(dataDir, "sub", "z.json.bn-tmp.4242.0f0f0f"))).toBe(false);
		for (const [rel, body] of Object.entries(untouched)) {
			expect(await readFile(join(dataDir, rel), "utf8"), rel).toBe(body);
		}
		// 子目录本身还在,里面只剩普通文件。
		expect(await readdir(join(dataDir, "sub"))).toEqual(["keep.json"]);
		// 清了东西就记一行(logger 起来之后才能记,所以是开机日志里的一行,不是清扫时记的)。
		const lines = logged.split("\n").filter((line) => line.includes("开机清扫"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("清掉 3 个");
		expect(lines[0]).toContain("x.json.bn-tmp.123.abcdef");
	});

	it("什么都没清 → 不记开机清扫那一行(常态不占日志)", async () => {
		await writeFile(join(dataDir, "keep.txt"), "普通文件");

		const logged = await bootAndClose();

		expect(logged).toContain("starting bilibili-notify server");
		expect(logged).not.toContain("开机清扫");
	});

	it("换到一半的整目录替换:目标不在就把旧目录挪回原位", async () => {
		// 两次改名之间进程被杀:目标名字空着、旧的还在 `<目标>.bn-old.*`。
		const old = join(dataDir, "misc", "pack.bn-old.99.abc123");
		await mkdir(old, { recursive: true });
		await writeFile(join(old, "skin.json"), '{"id":"pack"}');

		const logged = await bootAndClose();

		expect(existsSync(old)).toBe(false);
		expect(await readFile(join(dataDir, "misc", "pack", "skin.json"), "utf8")).toBe(
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
			const locked = join(dataDir, "locked");
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

		const sweepAt = code.indexOf("sweepTempFiles(bootstrap.dataDir)");
		const runtimeAt = code.indexOf("createAppRuntime(bootstrap)");
		expect(sweepAt).toBeGreaterThan(-1);
		expect(runtimeAt).toBeGreaterThan(-1);
		expect(sweepAt).toBeLessThan(runtimeAt);
	});
});
