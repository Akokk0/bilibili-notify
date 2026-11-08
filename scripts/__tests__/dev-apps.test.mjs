import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildWindowsTreeKillArgs,
	createDevProcessSpecs,
	formatStatus,
	isCleanStatus,
	runDevApps,
	statusToExitCode,
	waitForHttpReachable,
} from "../dev-apps.mjs";

class FakeChild extends EventEmitter {
	exitCode = null;
	signalCode = null;
	signals = [];

	kill(signal) {
		this.signalCode = signal;
		this.signals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

function createFakeSpawn() {
	const children = [];
	const spawnProcess = vi.fn(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
	return { children, spawnProcess };
}

function runDevAppsNoWait(options) {
	return runDevApps({ ...options, waitForBackendReady: null });
}

describe("dev-apps supervisor", () => {
	it("直接用 vp 启动 server/web,避免 pnpm recursive Ctrl-C 被报告为失败", () => {
		const specs = createDevProcessSpecs("/repo");

		expect(specs).toEqual([
			expect.objectContaining({
				name: "apps/server dev",
				command: "vp",
				// 三路输出共用一个终端:server 重跑不许清屏(否则 Vite+ 的地址一起被擦掉),
				// 也不许因为拓展产物重写而重跑(那是 devtools 热重载的活,重跑会断直播间)。
				args: [
					"exec",
					"tsx",
					"watch",
					"--clear-screen=false",
					"--ignore",
					"../../extensions/**",
					"--tsconfig",
					"tsconfig.dev.json",
					"src/index.ts",
				],
				cwd: "/repo/apps/server",
			}),
			expect.objectContaining({
				name: "apps/web dev",
				command: "vp",
				args: ["dev"],
				cwd: "/repo/apps/web",
			}),
		]);
		expect(specs.flatMap((spec) => [spec.command, ...spec.args])).not.toContain("pnpm");
	});

	it("仓里的拓展顺带 watch 打包 —— 改完 30ms 重建,配 devtools 的自动重载就是保存即生效", async () => {
		const root = mkdtempSync(join(tmpdir(), "bn-dev-specs-"));
		try {
			mkdirSync(join(root, "extensions", "bridge"), { recursive: true });
			writeFileSync(join(root, "extensions", "bridge", "extension.json"), "{}");
			// 没有清单的目录不算拓展(node_modules、临时目录都会落在这儿)。
			mkdirSync(join(root, "extensions", "node_modules"), { recursive: true });

			const specs = createDevProcessSpecs(root);
			const packs = specs.filter((spec) => spec.args[0] === "pack");
			expect(packs).toEqual([
				expect.objectContaining({
					// 🔴 `--no-clean`:清一次 dist 会让装载器**在开机那一眼**看见一个空目录,
					// 而软链正指着它 —— 症状是拓展页上那条突然变成「装不起来」。
					args: ["pack", "-w", "--no-clean"],
					cwd: join(root, "extensions", "bridge"),
				}),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("仓里没有 extensions 目录时不多起进程", () => {
		expect(createDevProcessSpecs("/repo")).toHaveLength(2);
	});

	it("等待后端可连接后再启动 web,避免 Vite 首次请求打到未监听的 8787", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		let markReady;
		const waitForBackendReady = vi.fn(
			() =>
				new Promise((resolveReady) => {
					markReady = resolveReady;
				}),
		);
		const run = runDevApps({
			// 显式给一个空 root:不给的话这条测试悄悄依赖「仓里眼下有几个拓展」。
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
			waitForBackendReady,
		});

		expect(children).toHaveLength(1);
		expect(waitForBackendReady).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", {
			timeoutMs: 20_000,
			intervalMs: 200,
			// 停机信号:起步那 20 秒里按 Ctrl-C,轮询要当场收手。
			signal: expect.any(AbortSignal),
		});
		markReady();
		await new Promise((r) => setImmediate(r));

		expect(children).toHaveLength(2);
		process.emit("SIGINT");
		await expect(run).resolves.toBe(0);
	});

	it("把有意停止时的 SIGINT/SIGTERM 视为干净退出", () => {
		expect(isCleanStatus({ code: 0 }, false)).toBe(true);
		expect(isCleanStatus({ signal: "SIGINT" }, true)).toBe(true);
		expect(isCleanStatus({ signal: "SIGTERM" }, true)).toBe(true);
		expect(isCleanStatus({ signal: "SIGINT" }, false)).toBe(false);
	});

	it("保留非交互失败的退出码", () => {
		expect(statusToExitCode({ code: 7 })).toBe(7);
		expect(statusToExitCode({ signal: "SIGINT" })).toBe(130);
		expect(statusToExitCode({ error: new Error("spawn failed") })).toBe(1);
		expect(formatStatus({ code: 7 })).toBe("exited with code 7");
	});

	it("SIGINT 后停止两个 dev 子进程并返回 0", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		const run = runDevAppsNoWait({
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
		});

		expect(children).toHaveLength(2);
		process.emit("SIGINT");

		await expect(run).resolves.toBe(0);
		expect(children.map((child) => child.signals)).toEqual([["SIGINT"], ["SIGINT"]]);
	});

	/**
	 * 直接子进程只是 `vp exec` 那层壳,它一收到 SIGINT 就退了;真正的 tsx / server 在它下面、
	 * 同一个进程组里,还在走优雅退出。壳一退就返回,等于把 8 秒宽限期扔了 —— 组里剩下的
	 * 谁卡住了都没人管,主人 Ctrl-C 之后 server 照跑(2026-09-11 真撞过)。
	 */
	it("有意停止后,子进程壳退了但进程组还有人 → 等到组空才返回,不补 SIGKILL", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		let polls = 0;
		const probeGroupAlive = vi.fn(() => polls++ < 3);
		const run = runDevAppsNoWait({
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 1_000,
			groupPollMs: 1,
			probeGroupAlive,
		});
		process.emit("SIGINT");
		await expect(run).resolves.toBe(0);
		expect(probeGroupAlive).toHaveBeenCalled();
		expect(polls).toBeGreaterThanOrEqual(3);
		for (const child of children) expect(child.signals).not.toContain("SIGKILL");
	});

	it("宽限期过了进程组还有人 → SIGKILL 整组,再返回", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		// 组一直「有人」,直到有人对它下 SIGKILL。
		const probeGroupAlive = vi.fn((child) => !child.signals.includes("SIGKILL"));
		const run = runDevAppsNoWait({
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 30,
			groupPollMs: 1,
			probeGroupAlive,
		});
		process.emit("SIGINT");
		await expect(run).resolves.toBe(0);
		for (const child of children) expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);
	});

	it("终端被关(SIGHUP)也走同一套停止流程,不把整棵树留成孤儿", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		const run = runDevAppsNoWait({
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
			groupPollMs: 1,
			probeGroupAlive: () => false,
		});
		process.emit("SIGHUP");
		await expect(run).resolves.toBe(0);
		expect(children.map((child) => child.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
	});

	it("子进程非 0 退出时停止另一个 dev 子进程并保留退出码", async () => {
		const { children, spawnProcess } = createFakeSpawn();
		const run = runDevAppsNoWait({
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 100,
		});

		expect(children).toHaveLength(2);
		children[0].exitCode = 7;
		children[0].emit("exit", 7, null);

		await expect(run).resolves.toBe(7);
		expect(children[1].signals).toEqual(["SIGINT"]);
	});

	/**
	 * 🔴 **探活要能被叫停。**
	 *
	 * 后端起步的 20 秒里按 Ctrl-C:子进程收到信号退了,而这个轮询还在自己的 setTimeout 上
	 * 睡着 —— runner 早就 resolve 了,node 的事件循环却被那串定时器吊着,终端要一直挂到
	 * 探活的 deadline 才回来。
	 */
	it("探活收到停机信号 → 当场收手,不等到 deadline", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		// 第一轮还没连上,睡的那一下里主人按了 Ctrl-C。
		const sleep = vi.fn(async () => controller.abort());

		await expect(
			waitForHttpReachable("http://127.0.0.1:8787/api/health", {
				fetchImpl,
				sleep,
				intervalMs: 5,
				// 生产是 20 秒;这里短一点,回归时这条不至于自己先卡 20 秒再红。
				timeoutMs: 1_000,
				signal: controller.signal,
			}),
		).rejects.toThrow(/停/);
		// 没有第二次重试 —— 没这条的话它会一路重试到 deadline。
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	/**
	 * 🔴 这条钉的是**接线**:上面那条证明探活认停机信号,但证明不了 runner 真的把信号递了
	 * 进去、并且在停机时真的拉了它。剪断这一头,两个零件各自的测试照样全绿。
	 */
	it("SIGINT 时把停机信号递给探活", async () => {
		const { spawnProcess } = createFakeSpawn();
		let probeOptions;
		const run = runDevApps({
			root: "/repo",
			spawnProcess,
			processPlatform: "test",
			log: () => {},
			graceMs: 10,
			// 永远不 resolve —— 模拟「后端还没起来」那 20 秒。
			waitForBackendReady: (_url, options) => {
				probeOptions = options;
				return new Promise(() => {});
			},
		});

		expect(probeOptions?.signal?.aborted).toBe(false);
		process.emit("SIGINT");
		expect(probeOptions?.signal?.aborted).toBe(true);
		await expect(run).resolves.toBe(0);
	});

	it("waitForHttpReachable 在 HTTP 可达后返回", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({});
		const sleep = vi.fn(async () => {});

		await expect(
			waitForHttpReachable("http://127.0.0.1:8787/api/health", {
				fetchImpl,
				sleep,
				intervalMs: 1,
				timeoutMs: 100,
			}),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1);
	});

	it("Windows 下终止整棵 dev 进程树", () => {
		expect(buildWindowsTreeKillArgs(1234)).toEqual(["taskkill", ["/pid", "1234", "/T", "/F"]]);
	});
});

it("dev startup resolves current contract source even when its compiled library lacks a new export", () => {
	const root = mkdtempSync(join(tmpdir(), "bn-dev-contract-"));
	const server = join(root, "apps/server");
	const contract = join(root, "apps/contract");
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	try {
		for (const dir of [
			join(server, "src"),
			join(server, "node_modules/@bilibili-notify"),
			join(contract, "src"),
			join(contract, "lib"),
		])
			mkdirSync(dir, { recursive: true });
		writeFileSync(join(server, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(
			join(server, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { module: "esnext", moduleResolution: "bundler", target: "es2022" },
			}),
		);
		writeFileSync(
			join(server, "tsconfig.dev.json"),
			readFileSync(join(repo, "apps/server/tsconfig.dev.json")),
		);
		writeFileSync(
			join(contract, "package.json"),
			JSON.stringify({
				name: "@bilibili-notify/contract",
				type: "module",
				exports: { ".": "./lib/index.mjs" },
			}),
		);
		writeFileSync(join(contract, "lib/index.mjs"), 'export const OLD_EXPORT = "stale";');
		writeFileSync(
			join(contract, "src/index.ts"),
			'export const SKIN_CSS_MODEL_HOOK_NOTES = {page:"current source"};',
		);
		writeFileSync(
			join(server, "src/index.ts"),
			'import { SKIN_CSS_MODEL_HOOK_NOTES } from "@bilibili-notify/contract"; console.log(SKIN_CSS_MODEL_HOOK_NOTES.page);',
		);
		symlinkSync(contract, join(server, "node_modules/@bilibili-notify/contract"), "junction");
		const spec = createDevProcessSpecs(root)[0];
		const tsx = createRequire(join(repo, "apps/server/package.json")).resolve("tsx/cli");
		// Use the dev launcher's config and entry through the real tsx loader, without keeping a watcher alive.
		const result = spawnSync(
			process.execPath,
			[tsx, "--tsconfig", spec.args[spec.args.indexOf("--tsconfig") + 1], spec.args.at(-1)],
			{ cwd: spec.cwd, encoding: "utf8", timeout: 10000 },
		);
		expect(result.status, result.stderr || result.error?.message).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.stdout.trim()).toBe("current source");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("dev startup shares the package text binding between root and subpath imports", () => {
	const root = mkdtempSync(join(tmpdir(), "bn-dev-text-binding-"));
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	try {
		const probe = join(root, "probe.mts");
		writeFileSync(
			probe,
			[
				`import { i18n } from ${JSON.stringify(pathToFileURL(join(repo, "apps/server/src/i18n/index.ts")).href)};`,
				`import { CardSkinStore } from ${JSON.stringify(pathToFileURL(join(repo, "apps/server/src/card-skins/store.ts")).href)};`,
				`const store = new CardSkinStore({ dir: ${JSON.stringify(join(root, "skins"))} });`,
				'for (const locale of ["zh-CN", "en", "ja", "zh-TW"]) {',
				'i18n.set({ locale, voice: "plain" });',
				'const skin = store.list()[0]; const manifest = store.get("default");',
				"console.log(JSON.stringify({ locale, name: skin.name, description: skin.description, manifestName: manifest.name }));",
				"}",
			].join("\n"),
		);
		const spec = createDevProcessSpecs(repo)[0];
		const tsx = createRequire(join(repo, "apps/server/package.json")).resolve("tsx/cli");
		const result = spawnSync(
			process.execPath,
			[tsx, "--tsconfig", spec.args[spec.args.indexOf("--tsconfig") + 1], probe],
			{
				cwd: spec.cwd,
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(result.status, result.stderr || result.error?.message).toBe(0);
		expect(result.error).toBeUndefined();
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{
				locale: "zh-CN",
				name: "默认",
				manifestName: "默认",
				description: "Bilibili-Notify 出厂的卡片外观。",
			},
			{
				locale: "en",
				name: "Default",
				manifestName: "Default",
				description: "The default card appearance included with Bilibili-Notify.",
			},
			{
				locale: "ja",
				name: "標準",
				manifestName: "標準",
				description: "Bilibili-Notifyに付属する標準のカードデザインです。",
			},
			{
				locale: "zh-TW",
				name: "預設",
				manifestName: "預設",
				description: "Bilibili-Notify 內建的卡片外觀。",
			},
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
