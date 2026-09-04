import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readDesktopLayoutFile } from "../../../scripts/desktop-layout.mjs";
import { missingServerBundleFilesIn } from "../../../scripts/server-bundle-assets.mjs";

/**
 * 把桌面壳要带走的资源摆好:一份自包含 server bundle + dashboard 静态资源 + 随包的 Node。
 *
 * 桌面版装的**就是** Docker 镜像与应用内升级载荷用的那一份 `apps/server/dist`(全部 JS
 * 依赖内联,scripts/assemble-server-bundle.mjs 已把按路径读盘的资产装配进去)。以前这里
 * 沿 node_modules 逐个搬运行时依赖、再裁掉测试与文档,三百行只为拼出一棵能跑的依赖树;
 * 而应用内更新一装上,桌面壳跑的就已经是 bundle 载荷了 —— 安装包自带那份没理由不同源。
 * 现在三种发行形态吃同一份产物,资源目录里**没有 node_modules**。
 *
 * 产物布局的**唯一声明**是 apps/desktop/layout.json。外壳与两个发版闸读的是同一份 ——
 * 这里自己写字面量,就等于给「摆的地方和找的地方不一样」留口子,而那种错只有打 tag
 * 那天才露面。
 */

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const desktopRoot = join(root, "apps", "desktop");
const layout = readDesktopLayoutFile(root);
// 载荷树的顶层目录(`app/`),由 serverDir 推出来 —— 别在下面再写字面量。
const appDir = layout.serverDir.split("/")[0];
const resourcesRoot = join(desktopRoot, "src-tauri", "resources");
// 摆载荷的三层,都从那份声明推:app/ → 服务端目录 → bundle 所在的 lib/。
const appRoot = join(resourcesRoot, appDir);
const serverRoot = join(resourcesRoot, ...layout.serverDir.split("/"));
const libRoot = join(serverRoot, layout.libDir);
const serverDist = join(root, "apps", "server", "dist");
const webDist = join(root, "apps", "web", "dist");
const nodeVersion = "24.15.0";
const nodeMajor = nodeVersion.split(".")[0];
const nodeVersionPattern = nodeVersion.replaceAll(".", "\\.");
// 预算按「bundle + dashboard + 一个 Node 二进制」定:Node 本体约 100 MiB,载荷 ~20 MiB。
// 超出就是有人把 node_modules 或 sourcemap 搬进来了 —— 那正是这份脚本刚甩掉的东西。
const maxResourceFiles = 1_000;
const maxResourceBytes = 256 * 1024 * 1024;
const maxWindowsResourceRelativePathChars = 180;

const args = new Set(process.argv.slice(2));
const skipNodeDownload = args.has("--skip-node-download");
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) await prepare();

async function prepare() {
	await assertBuiltArtifacts();
	await rm(resourcesRoot, { recursive: true, force: true });
	await mkdir(resourcesRoot, { recursive: true });

	const payload = await copyPayload();
	const nodeRuntime = await prepareNodeRuntime();
	await assertSlimRuntimeLayout();
	// 先真的 import 一遍,再扫敏感文件:载荷加载时若写出什么(首启配置、data/、缓存),
	// 得落在扫描之前 —— 否则它就跟着签进安装包。
	await verifyPackagedServerImport();
	await assertNoDesktopForbiddenFiles(resourcesRoot);
	// BUILD_INFO 统计的是它自己之外的那棵树,一次算完就写,不用来回稳定。
	const treeStats = await collectTreeStats(resourcesRoot);
	await assertResourceBudget(treeStats);
	await writeFile(
		join(resourcesRoot, "BUILD_INFO.json"),
		`${JSON.stringify(
			{
				createdBy: "apps/desktop/scripts/prepare-resources.mjs",
				nodeVersion,
				nodeMajor,
				nodeRuntime,
				payload: { version: payload.version, sha256: payload.sha256 },
				fileCount: treeStats.files,
				byteSize: treeStats.bytes,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	console.log(
		`[desktop] resources prepared at ${resourcesRoot} (${treeStats.files} files, ${formatBytes(treeStats.bytes)})`,
	);
}

async function assertBuiltArtifacts() {
	await mustExist(join(webDist, "index.html"), "web build output");
	// 装配是否完整由三处共用的清单说了算(选版入口 boot.mjs 也在里面)—— 这里少一个 wasm,
	// 用户点词云那一刻才炸。
	const missing = await missingServerBundleFilesIn(serverDist);
	if (missing.length > 0) {
		throw new Error(
			`server bundle 不完整,缺 ${missing.join(", ")}:${serverDist} —— 先跑 vp run build:update-payload`,
		);
	}
}

/**
 * 摆载荷:server dist 的内容进 `<serverDir>/<libDir>/`,dashboard 进它的同级目录 ——
 * 服务端就是按入口就近找 dashboard 的(apps/server/src/config/web-dist.ts),这样应用内
 * 更新换掉载荷时前端跟着一起换;摆在别处再用 --web-dist 指过去的话,就成了钉死旧前端的钉子。
 */
async function copyPayload() {
	await copyTree(serverDist, libRoot);
	await copyTree(webDist, join(libRoot, layout.webDistDir));
	const manifest = JSON.parse(await readFile(join(libRoot, "package.json"), "utf8"));
	return { version: manifest.version, sha256: await sha256File(join(libRoot, "index.mjs")) };
}

async function prepareNodeRuntime() {
	const nodePath = join(
		resourcesRoot,
		"node",
		"bin",
		process.platform === "win32" ? "node.exe" : "node",
	);
	await mkdir(dirname(nodePath), { recursive: true });
	const localNode = process.env.BN_DESKTOP_NODE_PATH;
	if (localNode) {
		await copyFile(localNode, nodePath);
		await chmod(nodePath, 0o755);
		const version = await assertNodeMajor(nodePath);
		return { source: "BN_DESKTOP_NODE_PATH", version };
	}
	if (skipNodeDownload) {
		await copyFile(process.execPath, nodePath);
		await chmod(nodePath, 0o755);
		const version = await assertNodeMajor(nodePath);
		return { source: "process.execPath", version };
	}
	const nodeInfo = await resolvePinnedNodePackage();
	const cacheDir = join(homedir(), ".cache", "bilibili-notify-desktop", "node");
	await mkdir(cacheDir, { recursive: true });
	const archivePath = join(cacheDir, nodeInfo.fileName);
	if (!(await exists(archivePath)) || (await sha256File(archivePath)) !== nodeInfo.sha256) {
		await download(nodeInfo.url, archivePath);
		const actual = await sha256File(archivePath);
		if (actual !== nodeInfo.sha256) {
			throw new Error(`Node archive checksum mismatch: expected ${nodeInfo.sha256}, got ${actual}`);
		}
	}
	const extractDir = join(cacheDir, nodeInfo.fileName.replace(/\.(tar\.gz|zip)$/, ""));
	await rm(extractDir, { recursive: true, force: true });
	await mkdir(extractDir, { recursive: true });
	await extractNodeArchive(archivePath, extractDir, nodeInfo.kind);
	await copyFile(nodeInfo.nodePath(extractDir), nodePath);
	await chmod(nodePath, 0o755).catch(() => {});
	const version = await assertNodeMajor(nodePath);
	if (version !== nodeVersion) throw new Error(`Expected Node ${nodeVersion}, got ${version}`);
	return {
		source: "nodejs.org",
		version,
		fileName: nodeInfo.fileName,
		sha256: nodeInfo.sha256,
		url: nodeInfo.url,
	};
}

async function resolvePinnedNodePackage() {
	const base = nodeDistBaseUrl(nodeVersion);
	const shasums = await fetchText(`${base}/SHASUMS256.txt`);
	return resolveNodePackageFromShasums(shasums, nodeDistTarget(), base);
}

function nodeDistBaseUrl(version) {
	return `https://nodejs.org/dist/v${version}`;
}

export function resolveNodePackageFromShasums(shasums, target, base) {
	const match = shasums.match(new RegExp(`^([a-f0-9]{64})\\s+(${target.filePattern})$`, "m"));
	if (!match) throw new Error(`Cannot resolve Node ${nodeVersion} ${target.label} package`);
	return {
		kind: target.kind,
		version: nodeVersion,
		sha256: match[1],
		fileName: match[2],
		url: `${base}/${match[2]}`,
		nodePath: target.nodePath,
	};
}

function nodeDistTarget() {
	if (process.platform === "darwin" && process.arch === "arm64") {
		return {
			kind: "tar.gz",
			label: "darwin-arm64",
			filePattern: `node-v${nodeVersionPattern}-darwin-arm64\\.tar\\.gz`,
			nodePath: (dir) => join(dir, "bin", "node"),
		};
	}
	if (process.platform === "win32" && process.arch === "x64") {
		return {
			kind: "zip",
			label: "win-x64",
			filePattern: `node-v${nodeVersionPattern}-win-x64\\.zip`,
			nodePath: (dir) => join(dir, "node.exe"),
		};
	}
	throw new Error(
		"默认资源准备当前只支持 darwin-arm64 / win-x64 Node 24；其他平台请设置 BN_DESKTOP_NODE_PATH 或使用 --skip-node-download。",
	);
}

async function extractNodeArchive(archivePath, extractDir, kind) {
	if (kind === "tar.gz") {
		await execFileAsync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", extractDir]);
		return;
	}
	if (kind === "zip") {
		await execFileAsync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Expand-Archive -LiteralPath $env:BN_NODE_ARCHIVE -DestinationPath $env:BN_NODE_EXTRACT_DIR -Force",
			],
			{
				env: {
					...process.env,
					BN_NODE_ARCHIVE: archivePath,
					BN_NODE_EXTRACT_DIR: extractDir,
				},
			},
		);
		const entries = await readdir(extractDir);
		if (entries.length === 1 && entries[0]?.startsWith(`node-v${nodeMajor}.`)) {
			const nested = join(extractDir, entries[0]);
			for (const entry of await readdir(nested)) {
				await cp(join(nested, entry), join(extractDir, entry), {
					recursive: true,
					dereference: false,
				});
			}
			await rm(nested, { recursive: true, force: true });
		}
		return;
	}
	throw new Error(`Unsupported Node archive kind: ${kind}`);
}

/**
 * 用随包的 Node 真的把载荷加载一遍:入口、选版器、dashboard。bundle 里没有裸的第三方
 * import 可解析,所以这一步过了,装外就能跑 —— 这是 Docker 那条路已经验过的同一份产物。
 */
async function verifyPackagedServerImport() {
	const nodePath = join(
		resourcesRoot,
		"node",
		"bin",
		process.platform === "win32" ? "node.exe" : "node",
	);
	const script = `
		import { statSync } from 'node:fs';
		await import('./${layout.libDir}/index.mjs');
		// 外壳真正起的是它;少了这一句,boot 那条路要到用户双击图标才第一次被跑到。
		await import('./${layout.libDir}/${layout.entry}');
		statSync('./${layout.libDir}/${layout.webDistDir}/index.html');
		console.log('ok');
	`;
	await execFileAsync(nodePath, ["-e", script], { cwd: serverRoot, timeout: 30_000 });
}

/**
 * 资源目录只许长成「bundle + dashboard + Node」。node_modules、workspace 源码、sourcemap
 * 出现在这里都说明有人把旧的搬运方式带回来了。
 */
async function assertSlimRuntimeLayout() {
	const forbidden = [
		join(appRoot, "package.json"),
		join(appRoot, "packages"),
		join(appRoot, "pnpm-workspace.yaml"),
		join(appRoot, "node_modules"),
		join(serverRoot, "node_modules"),
		join(serverRoot, "src"),
	];
	for (const path of forbidden) {
		if (await exists(path)) throw new Error(`Desktop slim runtime must not contain ${path}`);
	}
	// 拷贝出来的这份才是装进安装包的:清单再核一遍,搬丢一块在这里红。
	const missing = await missingServerBundleFilesIn(libRoot);
	if (missing.length > 0) {
		throw new Error(`Desktop runtime is missing bundle files: ${missing.join(", ")}`);
	}
	const sourcemaps = [];
	await walk(libRoot, async (path) => {
		if (path.endsWith(".map")) sourcemaps.push(relative(resourcesRoot, path));
	});
	if (sourcemaps.length > 0) {
		throw new Error(`Desktop runtime must not ship sourcemaps:\n${sourcemaps.join("\n")}`);
	}
	await assertWindowsResourcePathBudget(resourcesRoot);
}

async function assertWindowsResourcePathBudget(dir) {
	const tooLong = [];
	await walk(dir, async (path) => {
		const rel = relative(dir, path).split("\\").join("/");
		if (rel.length > maxWindowsResourceRelativePathChars) tooLong.push(rel);
	});
	if (tooLong.length > 0) {
		throw new Error(`Desktop runtime paths are too deep for Windows NSIS:\n${tooLong.join("\n")}`);
	}
}

async function assertResourceBudget(treeStats) {
	const errors = [];
	if (treeStats.files > maxResourceFiles) {
		errors.push(`file count ${treeStats.files} exceeds budget ${maxResourceFiles}`);
	}
	if (treeStats.bytes > maxResourceBytes) {
		errors.push(
			`size ${formatBytes(treeStats.bytes)} exceeds budget ${formatBytes(maxResourceBytes)}`,
		);
	}
	if (errors.length > 0) throw new Error(`Desktop resources too large:\n${errors.join("\n")}`);
}

async function assertNodeMajor(nodePath) {
	const { stdout } = await execFileAsync(nodePath, ["--version"]);
	const rawVersion = stdout.trim();
	const version = rawVersion.replace(/^v/, "");
	if (!version.startsWith(`${nodeMajor}.`)) {
		throw new Error(`Expected Node ${nodeMajor}.x, got ${rawVersion}`);
	}
	return version;
}

async function assertNoDesktopForbiddenFiles(dir) {
	const forbidden = [];
	await walk(dir, async (path) => {
		const rel = relative(dir, path).split("\\").join("/");
		const base = basename(path);
		if (["bn.config.yaml", "bn.config.yml", "bn.config.json", "master.key"].includes(base)) {
			forbidden.push(rel);
		}
		if (base.startsWith(".env") || /\.(pem|key|enc)$/i.test(base)) {
			forbidden.push(rel);
		}
		// 禁止出现的目录来自那份声明,两个发版闸扫的也是同一份。
		if (layout.forbiddenUnderResources.some((p) => rel === p || rel.startsWith(`${p}/`))) {
			forbidden.push(rel);
		}
		if (await mayContainSensitiveText(path)) {
			const raw = await readFile(path, "utf8").catch(() => "");
			if (containsMaterialSecret(raw)) {
				forbidden.push(`${rel} (sensitive-looking content)`);
			}
		}
	});
	if (forbidden.length > 0) {
		throw new Error(`Desktop resources contain forbidden runtime files:\n${forbidden.join("\n")}`);
	}
}

async function mayContainSensitiveText(path) {
	const info = await stat(path);
	if (info.size > 512 * 1024) return false;
	const ext = path.split(".").pop()?.toLowerCase();
	return ["cjs", "css", "html", "js", "json", "mjs", "txt", "xml", "yaml", "yml"].includes(
		ext ?? "",
	);
}

function containsMaterialSecret(raw) {
	return [
		/SESSDATA=[^;\s"']{20,}/,
		/bili_jct=[a-f0-9]{16,}/i,
		/refresh_token["'\s:=]+[A-Za-z0-9._~+/=-]{20,}/i,
		/OPENAI_API_KEY["'\s:=]+sk-[A-Za-z0-9_-]{20,}/,
		/Bearer [A-Za-z0-9._~+/=-]{20,}/,
		/BN_COOKIE_KEY["'\s:=]+[A-Za-z0-9._~+/=-]{20,}/,
	].some((pattern) => pattern.test(raw));
}

/** 整棵目录照搬(解 symlink),只丢 .DS_Store 这类桌面噪音。 */
async function copyTree(source, target) {
	await mustExist(source, source);
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target, {
		recursive: true,
		dereference: true,
		filter: (path) => basename(path) !== ".DS_Store",
	});
}

async function copyFile(source, target) {
	await mustExist(source, source);
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target, { dereference: true });
}

async function collectTreeStats(dir) {
	const stats = { files: 0, bytes: 0 };
	await walk(dir, async (path) => {
		const info = await stat(path);
		stats.files += 1;
		stats.bytes += info.size;
	});
	return stats;
}

async function walk(dir, visit) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(path, visit);
		} else if (entry.isFile()) {
			await visit(path);
		}
	}
}

async function mustExist(path, label) {
	try {
		await access(path);
	} catch {
		throw new Error(`Missing ${label}: ${path}`);
	}
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(await readFile(path));
	return hash.digest("hex");
}

async function fetchText(url) {
	return new Promise((resolveFetch, reject) => {
		get(url, (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`GET ${url} failed with ${res.statusCode}`));
				res.resume();
				return;
			}
			res.setEncoding("utf8");
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolveFetch(body));
		}).on("error", reject);
	});
}

async function download(url, path) {
	await mkdir(dirname(path), { recursive: true });
	await new Promise((resolveDownload, reject) => {
		const file = createWriteStream(path);
		get(url, (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`GET ${url} failed with ${res.statusCode}`));
				res.resume();
				return;
			}
			res.pipe(file);
			file.on("finish", () => {
				file.close(resolveDownload);
			});
		}).on("error", reject);
	});
}

function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}
