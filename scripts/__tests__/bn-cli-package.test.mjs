import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE = "@bilibili-notify/bn";
const { packageManager } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));

function run(bin, args, cwd, env = {}) {
	try {
		return execFileSync(bin, args, {
			cwd,
			stdio: "pipe",
			encoding: "utf8",
			timeout: 90_000,
			maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, ...env },
		});
	} catch (error) {
		throw new Error(
			`${bin} ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
			{ cause: error },
		);
	}
}

describe("BN启动器的实际npm包", () => {
	let root;
	let host;
	const children = [];
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-cli-package-"));
		const archive = join(root, "bn.tgz");
		run("vp", ["pm", "pack", "--out", archive, "--json"], join(REPO, "tools/bn-cli"));
		host = join(root, "consumer");
		await mkdir(host);
		await writeFile(
			join(host, "package.json"),
			JSON.stringify({
				private: true,
				packageManager,
				dependencies: { [PACKAGE]: `file:${archive}` },
			}),
		);
		run("vp", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], host);
		await writeFile(
			join(root, "no-network.mjs"),
			"globalThis.fetch = async () => { throw new Error('Network is unavailable'); };",
		);
	}, 120_000);
	afterAll(async () => {
		for (const child of children) {
			if (child.process.exitCode === null && child.process.signalCode === null)
				child.process.kill("SIGINT");
			await child.exited;
		}
		if (root) await rm(root, { recursive: true, force: true });
	}, 60_000);

	it("npx能定位作用域包的bn命令，并说明web和dev两条入口", async () => {
		const manifest = JSON.parse(
			await readFile(join(host, "node_modules", PACKAGE, "package.json"), "utf8"),
		);
		expect(manifest.name).toBe(PACKAGE);
		expect(manifest.bin).toEqual({ bn: "cli.mjs" });
		expect(manifest.private).not.toBe(true);
		expect(Object.keys(manifest.dependencies)).toEqual(["@voidzero-dev/vite-plus-core"]);
		expect(() =>
			run(process.execPath, [join(host, "node_modules", PACKAGE, "verify-release.mjs")], host),
		).toThrow(/approved package version/);
		const output = run(
			"vp",
			[
				"exec",
				"--",
				"npm",
				"--offline",
				"exec",
				"--package",
				`${PACKAGE}@${manifest.version}`,
				"--",
				"bn",
				"--help",
			],
			host,
		);
		expect(output).toContain("bn web");
		expect(output).toContain("bn dev");
	});

	async function candidate(name, profile = "web", extra = {}) {
		const version = "1.0.0-alpha.1";
		const encoder = new TextEncoder();
		const bytes = zipSync({
			"index.mjs": encoder.encode(`import {createServer} from 'node:http';
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,profile:${JSON.stringify(profile)},dataDir:process.env.BN_DATA_DIR,configFile:process.env.BN_CONFIG,configDisabled:process.env.BN_CONFIG_DISABLED==='1'}));});
server.listen(Number(process.env.BN_PORT),'127.0.0.1');
process.once('SIGINT',()=>server.close(()=>process.exit(0)));`),
			"boot.mjs": encoder.encode("await import('./index.mjs');"),
			"package.json": encoder.encode(JSON.stringify({ type: "module", version })),
			"bn-runtime.json": encoder.encode(JSON.stringify({ schemaVersion: 1, profile, version })),
			"web-dist/index.html": encoder.encode("<!doctype html><title>BN runtime fixture</title>"),
			...Object.fromEntries(
				Object.entries(extra).map(([key, value]) => [key, encoder.encode(value)]),
			),
		});
		const directory = join(root, name);
		await cp(join(REPO, "tools/bn-cli/lib"), directory, { recursive: true });
		await symlink(
			dirname(dirname(await realpath(join(host, "node_modules", PACKAGE)))),
			join(directory, "node_modules"),
			"junction",
		);
		await mkdir(join(directory, "runtimes"), { recursive: true });
		await writeFile(join(directory, `runtimes/${profile}.zip`), bytes);
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		manifest.version = version;
		await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
		const catalog = join(directory, "runtime.json");
		await writeFile(
			catalog,
			JSON.stringify({
				schemaVersion: 1,
				runtimes: {
					[profile]: {
						version,
						file: `runtimes/${profile}.zip`,
						size: bytes.length,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			}),
		);
		return {
			directory,
			bytes,
			cli: join(directory, "cli.mjs"),
			catalog,
			cache: join(root, `${name}-cache`),
			dataDir: join(root, `${name}-data`),
		};
	}

	async function launch(candidate, profile = "web", extra = []) {
		const portServer = createServer();
		await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
		const port = portServer.address().port;
		await new Promise((resolve) => portServer.close(resolve));
		const child = spawn(
			process.execPath,
			[
				"--import",
				join(root, "no-network.mjs"),
				candidate.cli,
				profile,
				"--cache-dir",
				candidate.cache,
				"--data-dir",
				candidate.dataDir,
				"--port",
				String(port),
				...extra,
			],
			{ cwd: host, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const exited = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		children.push({ process: child, exited });
		return {
			child,
			exited,
			output: () => output,
			async health() {
				for (let attempt = 0; attempt < 300; attempt++) {
					if (child.exitCode !== null)
						throw new Error(`Launcher exited before readiness:\n${output}`);
					try {
						return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
					} catch {}
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				throw new Error(`Launcher was not ready:\n${output}`);
			},
			async stop() {
				child.kill("SIGINT");
				expect(await exited).toEqual({ code: 0, signal: null });
			},
		};
	}

	it("安装的npm包自带宿主，空缓存且没有网络时web直接启动", async () => {
		const fixture = await candidate("bundled");
		const development = await candidate("bundled-dev", "dev");
		const directory = join(root, "bundled-package");
		await cp(join(REPO, "tools/bn-cli/lib"), directory, { recursive: true });
		await mkdir(join(directory, "runtimes"));
		await writeFile(join(directory, "runtimes/web.zip"), fixture.bytes);
		await writeFile(join(directory, "runtimes/dev.zip"), development.bytes);
		const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
		catalog.runtimes.dev = JSON.parse(await readFile(development.catalog, "utf8")).runtimes.dev;
		await writeFile(join(directory, "runtime.json"), JSON.stringify(catalog));
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		manifest.version = "1.0.0-alpha.1";
		await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
		const assembled = join(root, "assembled-package");
		run(
			process.execPath,
			[
				join(REPO, "scripts/assemble-bn-package.mjs"),
				"--cli",
				directory,
				"--runtimes",
				directory,
				"--out",
				assembled,
			],
			REPO,
		);
		const archive = join(root, "bundled.tgz");
		run("vp", ["pm", "pack", "--out", archive, "--json"], assembled);
		const consumer = join(root, "bundled-consumer");
		await mkdir(consumer);
		await writeFile(
			join(consumer, "package.json"),
			JSON.stringify({
				private: true,
				packageManager,
				dependencies: { [PACKAGE]: `file:${archive}` },
			}),
		);
		run("vp", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], consumer);
		expect(() =>
			run(
				process.execPath,
				[join(consumer, "node_modules", PACKAGE, "verify-release.mjs")],
				consumer,
			),
		).not.toThrow();
		const running = await launch({
			...fixture,
			cli: join(consumer, "node_modules", PACKAGE, "cli.mjs"),
		});
		expect((await running.health()).profile).toBe("web");
		await running.stop();
	}, 60_000);

	it("web用指定数据目录启动，无需源码检出或主仓构建", async () => {
		const fixture = await candidate("web");
		const running = await launch(fixture);
		expect(await running.health()).toEqual({
			ok: true,
			profile: "web",
			dataDir: fixture.dataDir,
			configFile: join(fixture.dataDir, "bn.config.yaml"),
			configDisabled: false,
		});
		await running.stop();
	});

	it("复用已校验缓存，删除缓存可从包内重建；持久数据不丢，损坏缓存拒绝执行", async () => {
		const fixture = await candidate("offline");
		const first = await launch(fixture);
		await first.health();
		await first.stop();
		await writeFile(join(fixture.dataDir, "keep.txt"), "persistent");
		const second = await launch(fixture);
		expect((await second.health()).dataDir).toBe(fixture.dataDir);
		await second.stop();
		const [cached] = await readdir(fixture.cache);
		await writeFile(
			join(fixture.cache, cached, "index.mjs"),
			"throw new Error('must not execute');",
		);
		const broken = await launch(fixture);
		expect(await broken.exited).toEqual({ code: 1, signal: null });
		expect(broken.output()).toContain("Runtime cache is damaged");
		await rm(fixture.cache, { recursive: true });
		expect(await readFile(join(fixture.dataDir, "keep.txt"), "utf8")).toBe("persistent");
		const restored = await launch(fixture);
		expect((await restored.health()).dataDir).toBe(fixture.dataDir);
		await restored.stop();
	});

	it("错误的摘要、大小、用途和不安全目录都不执行，也不留下半份缓存", async () => {
		for (const [name, change, expected] of [
			[
				"hash",
				(entry) => {
					entry.sha256 = "0".repeat(64);
				},
				"SHA256 mismatch",
			],
			[
				"size",
				(entry) => {
					entry.size += 1;
				},
				"size mismatch",
			],
		]) {
			const fixture = await candidate(name);
			const catalog = JSON.parse(await readFile(fixture.catalog, "utf8"));
			change(catalog.runtimes.web);
			await writeFile(fixture.catalog, JSON.stringify(catalog));
			const running = await launch(fixture);
			expect(await running.exited).toEqual({ code: 1, signal: null });
			expect(running.output()).toContain(expected);
			expect(await readdir(fixture.cache).catch(() => [])).toEqual([]);
		}
		const unsafe = await candidate("unsafe", "web", { "../outside.txt": "must not escape" });
		const rejected = await launch(unsafe);
		expect(await rejected.exited).toEqual({ code: 1, signal: null });
		expect(rejected.output()).toContain("unsafe path");
		expect(await readdir(unsafe.cache).catch(() => [])).toEqual([]);
		const mismatch = await candidate("mismatch");
		const catalog = JSON.parse(await readFile(mismatch.catalog, "utf8"));
		catalog.runtimes.dev = { ...catalog.runtimes.web, file: "runtimes/dev.zip" };
		await cp(
			join(mismatch.directory, "runtimes/web.zip"),
			join(mismatch.directory, "runtimes/dev.zip"),
		);
		await writeFile(mismatch.catalog, JSON.stringify(catalog));
		const wrongProfile = await launch(mismatch, "dev");
		expect(await wrongProfile.exited).toEqual({ code: 1, signal: null });
		expect(wrongProfile.output()).toContain("profile or version mismatch");
	});

	it("dev成品可使用启动器提供的公开源码加载器，不需要全局vp或BN源码", async () => {
		const fixture = await candidate("dev", "dev", {
			"boot.mjs": "throw new Error('dev must bypass production update selection');",
			"source.ts": "export const message: string = 'source loaded';",
			"index.mjs": `import {createServer as createVite} from '@voidzero-dev/vite-plus-core';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
export async function startServer(options){
if(!options.installProcessHandlers)throw new Error('host shutdown handlers required');
const vite=await createVite({root:fileURLToPath(new URL('.',import.meta.url)),configFile:false,envFile:false,publicDir:false,logLevel:'silent',server:{middlewareMode:true,hmr:false,ws:false},optimizeDeps:{noDiscovery:true}});
const loaded=await vite.ssrLoadModule('/source.ts');
const server=createServer((req,res)=>res.end(JSON.stringify({profile:'dev',message:loaded.message})));
server.listen(Number(process.env.BN_PORT),'127.0.0.1');
process.once('SIGINT',async()=>{await vite.close();server.close(()=>process.exit(0));});
}`,
		});
		const running = await launch(fixture, "dev");
		expect(await running.health()).toEqual({ profile: "dev", message: "source loaded" });
		await running.stop();
	}, 30_000);
});
