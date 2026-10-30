import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assembleScript = join(repoRoot, "scripts", "assemble-server-bundle.mjs");
const distDir = join(repoRoot, "apps", "server", "dist");
const nodeBuiltins = new Set([
	...builtinModules,
	...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

// 构建 + 装配一次,各用例共享产物(build:bundle 带 clean,重复跑互相擦除)。
beforeAll(async () => {
	await execFileAsync("vp", ["run", "-F", "@bilibili-notify/server", "build:bundle"], {
		cwd: repoRoot,
		env: { ...process.env },
		timeout: 180_000,
	});
	// 🔴 拓展**不在这里构建**,吃门禁先构建好的 `extensions/*/dist`(CI 的 build 在 test 之前,同
	// `apps/server/src/__tests__/support/install-repo-extension.ts`)。在这里重打一遍会**原地**清掉再重写
	// 那几份产物,而别的测试文件正软链着它们并行开机 —— 撞上那几毫秒,桥起来了而 `devtools.mjs` 还不在,
	// 场景表里就没有 `bridge.*`(devtools-fake-bridge-e2e 满载时回 404 就是这么来的)。
	await execFileAsync(process.execPath, [assembleScript], {
		cwd: repoRoot,
		env: { ...process.env },
		timeout: 60_000,
	});
}, 240_000);

describe("assemble-server-bundle", () => {
	it("bundle 自包含:产物内无 bare 第三方 import(node 内建除外)", async () => {
		const bareImports = [];
		for (const fileName of await readdir(distDir)) {
			if (!fileName.endsWith(".mjs")) continue;
			const source = await readFile(join(distDir, fileName), "utf8");
			bareImports.push(
				...collectBareRuntimeImports(source).map((specifier) => `${fileName}: ${specifier}`),
			);
		}
		expect(bareImports).toEqual([]);
	});

	it("运行时资产齐全:wasm / 词云 static / 配置样例 / package.json", async () => {
		expect((await readFile(join(distDir, "jieba_rs_wasm_bg.wasm"))).byteLength).toBeGreaterThan(0);
		// 词云模板运行时 readFileSync(resolve(__dirname, "static/*.js"));bundle 内联
		// @bilibili-notify/image 后 __dirname 指向 dist/,static 必须随 bundle 搬运。
		expect(await readFile(join(distDir, "static", "wordcloud2.min.js"), "utf8")).toContain(
			"WordCloud",
		);
		expect(await readFile(join(distDir, "static", "render.js"), "utf8")).toContain("词云渲染函数");
		expect(await readFile(join(distDir, "bn.config.example.yaml"), "utf8")).toContain("server");
		// 开机时服务端按路径读它(「本次更新」弹窗的数据);今天 CHANGELOG 里还没有 1.x 段,所以是空数组。
		const notes = JSON.parse(await readFile(join(distDir, "release-notes.json"), "utf8"));
		expect(Array.isArray(notes.releases)).toBe(true);
		// 镜像的 CMD 指着它。少了这个文件,整个镜像连启动都做不到。
		const boot = await readFile(join(distDir, "boot.mjs"), "utf8");
		expect(boot).toContain("startServer");
		expect(boot).toContain("startStandaloneServer");
		const pkg = JSON.parse(await readFile(join(distDir, "package.json"), "utf8"));
		expect(pkg.name).toBe("@bilibili-notify/server");
		// 自包含产物的 manifest 不携带依赖声明:deps 已内联进 bundle,照抄源
		// manifest 会把 workspace 的 catalog: 占位一起带走(npm 不可解析)。
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.devDependencies).toBeUndefined();
		expect(JSON.stringify(pkg)).not.toContain("catalog:");
	});

	it("装到 monorepo 外也能起:boot + /api/health 200 + 模块版本非 0.0.0 + dashboard 就近解析", async () => {
		// 故意不 realpath:macOS tmpdir 是 /var → /private/var 的 symlink,正好在真实
		// boot 里回归验证 isEntrypoint 的 realpath 对齐(runtime/entrypoint.ts)——
		// 修复前 argv[1](symlink)与 import.meta.url(realpath)不等,静默退出 0。
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-server-bundle-"));
		const appDir = join(tempRoot, "app");
		await cp(distDir, appDir, { recursive: true });
		// dashboard 静态资源按**载荷入口**就近解析(server/src/config/web-dist.ts),
		// 镜像里 web-dist/ 就是 index.mjs 的同级目录 —— 这条只有在打成 bundle 之后才
		// 验得出:源码形态下 import.meta.url 指的是 src/index.ts,单测又一律注入
		// bundleUrl,两边都碰不到真实默认值。这里不设 BN_WEB_DIST,让它自己找。
		await mkdir(join(appDir, "web-dist"), { recursive: true });
		await writeFile(
			join(appDir, "web-dist", "index.html"),
			"<!doctype html><title>bn sibling dashboard</title>",
		);
		const port = 18900 + (process.pid % 500);
		// cwd **故意**不是 appDir:载荷自己的版本号得按模块位置解析,不能靠进程恰好
		// 待在哪(server/src/routes/health.ts)。在线升级后 cwd 仍是容器的 /app,而新
		// 载荷跑在 /data/versions/<新版>/ 下 —— 两者一旦分家,照 cwd 读就永远报旧版本。
		// 起的是 **boot.mjs** —— 镜像的 CMD 就是它。它先决定跑哪一份载荷,再在同一个
		// 进程里把那份加载起来;没有更新的载荷时就是镜像自带这份。直接起 index.mjs
		// 的话,选版那一整段在发版前根本没人跑过。
		const child = spawn(process.execPath, [join(appDir, "boot.mjs")], {
			cwd: tempRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BN_DATA_DIR: join(tempRoot, "data"),
				BN_CONFIG: join(tempRoot, "bn.config.yaml"),
				BN_HOST: "127.0.0.1",
				BN_PORT: String(port),
				BN_CHROME_PATH: join(tempRoot, "no-chrome"),
			},
		});
		const output = [];
		child.stdout?.on("data", (chunk) => output.push(String(chunk)));
		child.stderr?.on("data", (chunk) => output.push(String(chunk)));
		try {
			const body = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child, output);
			expect(body.status).toBe("ok");
			// 刻画测试的 bundle 侧闭环:静态 JSON import 内联的版本在 bundle 里也要在,
			// 不允许 createRequire 落空导致的 0.0.0 降级(health.ts 机制切换的动机)。
			// 详情口在开机段也回 200(4-19);先用已有的业务口探测等完整 app 接管,再查运行详情。
			await waitForBooted(port, child, output);
			const details = await waitForHealth(
				`http://127.0.0.1:${port}/api/health/details`,
				child,
				output,
			);
			expect(details.phase).toBe("running");
			expect(details.moduleVersions.storage).not.toBe("0.0.0");
			expect(details.moduleVersions.image).not.toBe("0.0.0");
			const { version } = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
			expect(body.version).toBe(version);
			const root = await fetch(`http://127.0.0.1:${port}/`, {
				headers: { connection: "close" },
			});
			expect(root.status).toBe(200);
			expect(await root.text()).toContain("bn sibling dashboard");
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
			await rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);
});

async function waitForHealth(url, child, output) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited early (${child.exitCode}): ${output.join("")}`);
		}
		try {
			const response = await fetch(url);
			if (response.status === 200) return await response.json();
		} catch {
			// 端口未就绪,继续轮询。
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
	}
	throw new Error(`timed out waiting for health: ${output.join("")}`);
}

/**
 * 开机第二段做完了没有。🔴 健康检查不算:先 listen 以后(ADR-0022 决策 2 下的 🔗),它在迁移与起引擎
 * 期间就回 200,那时 `/api/*` 与 `/ext/*` 回 503。换上正式的 app 与挂上拓展的 upgrade 是同步挨着的,
 * 所以 `/api/ext` 不回 503 了,`/ext/<id>` 也就认领上了;回什么(401 / 200)不管。
 */
async function waitForBooted(port, child, output) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited early (${child.exitCode}): ${output.join("")}`);
		}
		const response = await fetch(`http://127.0.0.1:${port}/api/ext`);
		if (response.status !== 503) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
	}
	throw new Error(`timed out waiting for boot: ${output.join("")}`);
}

async function waitForExit(child) {
	if (child.exitCode !== null) return;
	await new Promise((resolvePromise) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolvePromise(undefined);
		}, 5_000);
		child.on("exit", () => {
			clearTimeout(timeout);
			resolvePromise(undefined);
		});
	});
}

function collectBareRuntimeImports(source) {
	const specifiers = [];
	for (const line of source.split("\n")) {
		if (!line.startsWith("import ") && !line.startsWith("export ")) continue;
		for (const match of line.matchAll(
			/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
		)) {
			const specifier = match[1] ?? match[2];
			if (specifier && isBareRuntimeImport(specifier)) {
				specifiers.push(specifier);
			}
		}
	}
	return specifiers;
}

function isBareRuntimeImport(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
		return false;
	}
	return !nodeBuiltins.has(specifier);
}

/**
 * 🔴 **本体一个拓展都不带**(主人 2026-09-09 拍板推翻 ADR-0012 决策 34 的「随载荷预装」)。
 *
 * 拓展只有两条来路:下载,或者主人自己放进 `<dataDir>/extensions/`。所以这里钉两件事 ——
 * 载荷里确实**没有**拓展,以及**手放进去的那份真的能跑起来**。
 *
 * 第二条刻意走**行为**而不是看文件在不在:401 是桥自己回的(token 不对),404 是宿主回的
 * (`/ext/bridge` 没人认领)。收到 401 = 包是自包含的(装外没有 node_modules)+ 清单读得懂
 * + 入口 import 得动 + `activate` 跑完了 + upgrade 认领上了,一次问清。
 */
describe("拓展不进载荷,手放进在用的那一代就能跑", () => {
	it("载荷里一个拓展都没有", async () => {
		const { files } = JSON.parse(await readFile(join(distDir, "bundle-manifest.json"), "utf8"));
		expect(files.filter((file) => file.startsWith("extensions/"))).toEqual([]);
	});

	it("把构建好的包放进在用的那一代的 extensions/bridge/、拨开开关 → 桥认领了 /ext/bridge", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-payload-ext-"));
		const appDir = join(tempRoot, "app");
		await cp(distDir, appDir, { recursive: true });
		const dataDir = join(tempRoot, "data");
		const port = 18400 + (process.pid % 500);
		const run = async () => {
			const child = spawn(process.execPath, [join(appDir, "boot.mjs")], {
				cwd: tempRoot,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					BN_DATA_DIR: dataDir,
					BN_CONFIG: join(tempRoot, "bn.config.yaml"),
					BN_HOST: "127.0.0.1",
					BN_PORT: String(port),
					BN_CHROME_PATH: join(tempRoot, "no-chrome"),
				},
			});
			const output = [];
			child.stdout?.on("data", (chunk) => output.push(String(chunk)));
			child.stderr?.on("data", (chunk) => output.push(String(chunk)));
			try {
				await waitForHealth(`http://127.0.0.1:${port}/api/health`, child, output);
				await waitForBooted(port, child, output);
			} catch (err) {
				// 起不来就把它收掉再抛,别给 CI 留一个占着端口的孤儿。
				child.kill("SIGKILL");
				throw err;
			}
			return child;
		};

		try {
			// 先空跑一趟让它把核心设置写全:`app` / `master` / `defaults` 都没有默认值,
			// 手写一份缺格的会在开机 parse 时整份被判废。
			const seed = await run();
			seed.kill("SIGTERM");
			await waitForExit(seed);

			// **主人手放的那一下**:构建出来的 dist/ 原样拷进在用的那一代的 extensions/bridge/
			// (1.0 起数据在 <dataDir>/generations/<序号>/,拓展包跟着代走,ADR-0022 决策 8)。
			const generationsDir = join(dataDir, "generations");
			const seq = Math.max(
				...(await readdir(generationsDir)).filter((name) => /^\d+$/.test(name)).map(Number),
			);
			const generationDir = join(generationsDir, String(seq));
			const bridgeDist = join(repoRoot, "extensions", "bridge", "dist");
			// 没构建过就抛、不静默跳过:这条正是「手放进去的那份能跑」的守卫。
			await access(join(bridgeDist, "index.mjs")).catch(() => {
				throw new Error(
					`桥还没构建:${bridgeDist} 里没有 index.mjs。先跑 vp run -F @bilibili-notify/extension-bridge build`,
				);
			});
			await cp(bridgeDist, join(generationDir, "extensions", "bridge"), {
				recursive: true,
			});
			// 核心设置文件在 config/settings/core.json(.mjs 导不了 TS 里的 CORE_SETTINGS_FILE,写字面量)。
			const corePath = join(generationDir, "config", "settings", "core.json");
			const core = JSON.parse(await readFile(corePath, "utf8"));
			core.extensions = { bridge: { enabled: true } };
			await mkdir(dirname(corePath), { recursive: true });
			await writeFile(corePath, JSON.stringify(core));

			const live = await run();
			try {
				// 不带 token 的 upgrade:桥认领了就是 401,没人认领是宿主的 404。
				expect(await upgradeStatus(port, "/ext/bridge")).toBe(401);
			} finally {
				live.kill("SIGTERM");
				await waitForExit(live);
			}
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	}, 90_000);
});

/** 发一次真 upgrade 握手,回**状态码**(101 = 收下了)。 */
async function upgradeStatus(port, path) {
	return new Promise((resolvePromise, reject) => {
		const req = httpRequest({
			host: "127.0.0.1",
			port,
			path,
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		req.on("response", (res) => {
			res.resume();
			resolvePromise(res.statusCode);
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolvePromise(101);
		});
		req.on("error", reject);
		req.end();
	});
}
