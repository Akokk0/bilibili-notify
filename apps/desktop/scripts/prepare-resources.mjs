import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const desktopRoot = join(root, "apps", "desktop");
const resourcesRoot = join(desktopRoot, "src-tauri", "resources");
const nodeVersion = "24.15.0";
const nodeMajor = nodeVersion.split(".")[0];
const nodeVersionPattern = nodeVersion.replaceAll(".", "\\.");
const workspaceScope = "@bilibili-notify/";
const maxResourceFiles = 25_000;
const maxResourceBytes = 512 * 1024 * 1024;
const maxWindowsResourceRelativePathChars = 180;

const runtimeImportSeeds = [
	"@bilibili-notify/api",
	"@bilibili-notify/image",
	"@bilibili-notify/live",
	"@hono/node-server",
	"@unocss/core",
	"@unocss/preset-wind4",
	"hono",
	"openai",
	"pino",
	"puppeteer-core",
	"ws",
];
const requiredRuntimeFiles = [
	"../../node_modules/@bilibili-notify/image/lib/static/render.js",
	"../../node_modules/@bilibili-notify/image/lib/static/wordcloud2.min.js",
];
const forbiddenDevPackages = [
	"@biomejs/biome",
	"@changesets/cli",
	"@tauri-apps/cli",
	"@types/node",
	"lefthook",
	"typescript",
	"tsx",
	"vite",
	"vitest",
];

const runtimePackageExcludedDirs = new Set([
	".github",
	".nyc_output",
	".vite",
	".vite-temp",
	"__fixtures__",
	"__mocks__",
	"__tests__",
	"benchmark",
	"benchmarks",
	"coverage",
	"example",
	"examples",
	"fixture",
	"fixtures",
	"node_modules",
	"test",
	"tests",
]);
const runtimePackageExcludedFilePatterns = [
	/\.(?:bench|benchmark|spec|test)\.[cm]?[jt]sx?$/i,
	/\.map$/i,
	/\.tsbuildinfo$/i,
	/^(?:ava|babel|eslint|jest|rollup|tsup|vite|vitest|webpack)\.config\.[cm]?[jt]s$/i,
	/^(?:biome|tsconfig)\..*json$/i,
	/^\.(?:babelrc|editorconfig|eslintignore|eslintrc|gitignore|npmignore|prettierignore|prettierrc)(?:\..*)?$/i,
	/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
];

const args = new Set(process.argv.slice(2));
const skipNodeDownload = args.has("--skip-node-download");
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) await prepare();

async function prepare() {
	await assertBuiltArtifacts();
	await rm(resourcesRoot, { recursive: true, force: true });
	await mkdir(resourcesRoot, { recursive: true });

	const runtimeInfo = await copyRuntimeTree();
	const nodeRuntime = await prepareNodeRuntime();
	await assertSlimRuntimeLayout(runtimeInfo);
	await assertNoDesktopForbiddenFiles(resourcesRoot);
	await verifyPackagedServerImport();
	const buildInfo = {
		createdBy: "apps/desktop/scripts/prepare-resources.mjs",
		nodeVersion,
		nodeMajor,
		nodeRuntime,
		workspacePackages: runtimeInfo.workspacePackages,
		thirdPartyPackages: runtimeInfo.thirdPartyPackages,
	};
	const treeStats = await writeStableBuildInfo(buildInfo);
	await assertResourceBudget(treeStats);
	console.log(
		`[desktop] resources prepared at ${resourcesRoot} (${treeStats.files} files, ${formatBytes(treeStats.bytes)})`,
	);
}

async function assertBuiltArtifacts() {
	await mustExist(join(root, "apps", "server", "lib", "index.mjs"), "server build output");
	await mustExist(join(root, "apps", "web", "dist", "index.html"), "web build output");
	await mustExist(join(root, "node_modules"), "workspace node_modules (run vp install first)");
}

async function writeStableBuildInfo(buildInfo) {
	let previousStats = { files: 0, bytes: 0 };
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await writeBuildInfo({
			...buildInfo,
			fileCount: previousStats.files,
			byteSize: previousStats.bytes,
		});
		const nextStats = await collectTreeStats(resourcesRoot);
		if (nextStats.files === previousStats.files && nextStats.bytes === previousStats.bytes) {
			return nextStats;
		}
		previousStats = nextStats;
	}
	throw new Error("BUILD_INFO.json stats did not stabilize");
}

async function writeBuildInfo(info) {
	await writeFile(
		join(resourcesRoot, "BUILD_INFO.json"),
		`${JSON.stringify(info, null, 2)}\n`,
		"utf8",
	);
}

async function copyRuntimeTree() {
	const appRoot = join(resourcesRoot, "app");
	const nodeModulesRoot = join(appRoot, "node_modules");
	const serverRoot = join(appRoot, "apps", "server");
	await mkdir(nodeModulesRoot, { recursive: true });

	await copyFileOrDir(
		join(root, "apps", "server", "package.json"),
		join(serverRoot, "package.json"),
	);
	await copyFileOrDir(join(root, "apps", "server", "lib"), join(serverRoot, "lib"));
	await copyFileOrDir(join(root, "apps", "web", "dist"), join(appRoot, "apps", "web", "dist"));

	const workspacePackages = await stageWorkspaceRuntimePackages(nodeModulesRoot);
	const thirdPartyPackages = await stageThirdPartyRuntimePackages(
		nodeModulesRoot,
		workspacePackages,
	);
	return { appRoot, nodeModulesRoot, serverRoot, workspacePackages, thirdPartyPackages };
}

async function stageWorkspaceRuntimePackages(nodeModulesRoot) {
	const workspaceMap = await readWorkspacePackageMap();
	const serverManifest = await readJson(join(root, "apps", "server", "package.json"));
	const queue = dependencyNames(serverManifest).filter(isWorkspacePackage);
	const selected = new Map();

	while (queue.length > 0) {
		const name = queue.shift();
		if (!name || selected.has(name)) continue;
		const source = workspaceMap.get(name);
		if (!source) throw new Error(`Workspace dependency ${name} is not under packages/*`);
		const manifest = await readJson(join(source, "package.json"));
		selected.set(name, { source, manifest });
		for (const dep of dependencyNames(manifest).filter(isWorkspacePackage)) queue.push(dep);
	}

	for (const [name, info] of selected) {
		const target = packageTargetRoot(nodeModulesRoot, name);
		await copyFileOrDir(join(info.source, "package.json"), join(target, "package.json"));
		await copyFileOrDir(join(info.source, "lib"), join(target, "lib"));
	}

	return Array.from(selected.keys()).sort();
}

async function stageThirdPartyRuntimePackages(nodeModulesRoot, workspacePackages) {
	const workspacePackageSet = new Set(workspacePackages);
	const workspaceMap = await readWorkspacePackageMap();
	const stagedPackageVersions = new Map();
	const stagedTargets = new Set();
	const processedPackages = new Set();
	const stagedPackages = new Set();
	const context = {
		nodeModulesRoot,
		workspacePackageSet,
		stagedPackageVersions,
		stagedTargets,
		processedPackages,
		stagedPackages,
	};

	const serverManifest = await readJson(join(root, "apps", "server", "package.json"));
	const serverDeps = [];
	enqueueManifestRuntimeDeps(serverDeps, serverManifest);
	for (const item of serverDeps) {
		await stageThirdPartyPackage(
			item,
			[join(root, "apps", "server"), root],
			nodeModulesRoot,
			context,
			{ deferDeps: true },
		);
	}
	for (const item of serverDeps) {
		await stageThirdPartyPackage(
			item,
			[join(root, "apps", "server"), root],
			nodeModulesRoot,
			context,
		);
	}

	for (const name of workspacePackages) {
		const source = workspaceMap.get(name);
		const manifest = await readJson(join(source, "package.json"));
		const deps = [];
		enqueueManifestRuntimeDeps(deps, manifest, workspacePackageSet);
		const workspaceNodeModules = join(packageTargetRoot(nodeModulesRoot, name), "node_modules");
		for (const item of deps) {
			await stageThirdPartyPackage(item, [source, root], workspaceNodeModules, context, {
				deferDeps: true,
			});
		}
		for (const item of deps) {
			await stageThirdPartyPackage(item, [source, root], workspaceNodeModules, context);
		}
	}

	return Array.from(stagedPackages).sort();
}

async function stageThirdPartyPackage(item, searchRoots, targetNodeModules, context, options = {}) {
	if (!item || isWorkspacePackage(item.name) || isTypesPackage(item.name)) return;
	let source;
	try {
		source = await resolveInstalledPackageRoot(item.name, searchRoots);
	} catch (err) {
		if (item.optional) {
			console.warn(`[desktop] optional dependency not installed, skipped: ${item.name}`);
			return;
		}
		throw err;
	}
	const manifest = await readJson(join(source, "package.json"));
	const packageName = manifest.name ?? item.name;
	const packageVersion = manifest.version ?? "0.0.0";
	const existingVersion = context.stagedPackageVersions.get(packageName);
	const shouldNest = existingVersion && existingVersion !== packageVersion;
	if (shouldNest && resolve(targetNodeModules) === resolve(context.nodeModulesRoot)) {
		throw new Error(
			`Desktop runtime cannot place direct duplicate ${packageName} versions: ${existingVersion} and ${packageVersion}`,
		);
	}

	const target = packageTargetRoot(
		shouldNest ? targetNodeModules : context.nodeModulesRoot,
		packageName,
	);
	const targetKey = resolve(target);
	const packageKey = `${targetKey}:${packageName}@${packageVersion}`;

	if (!context.stagedTargets.has(targetKey)) {
		await copyFileOrDir(source, target, { dereference: true, runtimePackage: true });
		context.stagedTargets.add(targetKey);
		context.stagedPackages.add(`${packageName}@${packageVersion}`);
	}
	if (!shouldNest) context.stagedPackageVersions.set(packageName, packageVersion);
	if (options.deferDeps) return;
	if (context.processedPackages.has(packageKey)) return;
	context.processedPackages.add(packageKey);

	const deps = [];
	enqueueManifestRuntimeDeps(deps, manifest, context.workspacePackageSet);
	for (const dep of deps) {
		await stageThirdPartyPackage(
			dep,
			[source, ...searchRoots],
			join(target, "node_modules"),
			context,
		);
	}
}

async function readWorkspacePackageMap() {
	const packagesDir = join(root, "packages");
	const result = new Map();
	for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(packagesDir, entry.name);
		const manifest = await readJson(join(dir, "package.json"));
		if (manifest.name?.startsWith(workspaceScope)) result.set(manifest.name, dir);
	}
	return result;
}

function enqueueManifestRuntimeDeps(queue, manifest, workspacePackageSet = new Set()) {
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		if (!workspacePackageSet.has(name) && !isTypesPackage(name)) {
			queue.push({ name, optional: false });
		}
	}
	for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
		if (!workspacePackageSet.has(name) && !isTypesPackage(name)) {
			queue.push({ name, optional: true });
		}
	}
	for (const name of Object.keys(manifest.peerDependencies ?? {})) {
		if (workspacePackageSet.has(name) || isTypesPackage(name)) continue;
		if (manifest.peerDependenciesMeta?.[name]?.optional === true) continue;
		queue.push({ name, optional: false });
	}
}

function isTypesPackage(name) {
	return name.startsWith("@types/");
}

function dependencyNames(manifest) {
	return [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	];
}

async function resolveInstalledPackageRoot(name, searchRoots) {
	for (const searchRoot of searchRoots) {
		for (const dir of ancestors(searchRoot)) {
			const pkgJson = join(dir, "node_modules", ...packageNameParts(name), "package.json");
			if (await exists(pkgJson)) return dirname(pkgJson);
		}
	}
	throw new Error(`Cannot resolve runtime dependency ${name} from installed node_modules`);
}

function ancestors(start) {
	const result = [];
	let current = resolve(start);
	while (true) {
		result.push(current);
		const parent = dirname(current);
		if (parent === current) return result;
		current = parent;
	}
}

function packageNameParts(name) {
	return name.startsWith("@") ? name.split("/") : [name];
}

function packageTargetRoot(nodeModulesRoot, name) {
	return join(nodeModulesRoot, ...packageNameParts(name));
}

function isWorkspacePackage(name) {
	return name.startsWith(workspaceScope);
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
		await copyFileOrDir(localNode, nodePath, { dereference: true });
		await chmod(nodePath, 0o755);
		const version = await assertNodeMajor(nodePath);
		return { source: "BN_DESKTOP_NODE_PATH", version };
	}
	if (skipNodeDownload) {
		await copyFileOrDir(process.execPath, nodePath, { dereference: true });
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
	await copyFileOrDir(nodeInfo.nodePath(extractDir), nodePath, { dereference: true });
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

async function verifyPackagedServerImport() {
	const nodePath = join(
		resourcesRoot,
		"node",
		"bin",
		process.platform === "win32" ? "node.exe" : "node",
	);
	const serverDir = join(resourcesRoot, "app", "apps", "server");
	const script = `
		import { statSync } from 'node:fs';
		await import('./lib/index.mjs');
		await Promise.all(${JSON.stringify(runtimeImportSeeds)}.map((specifier) => import(specifier)));
		for (const file of ${JSON.stringify(requiredRuntimeFiles)}) statSync(file);
		console.log('ok');
	`;
	await execFileAsync(nodePath, ["-e", script], { cwd: serverDir, timeout: 30_000 });
}

async function assertSlimRuntimeLayout(runtimeInfo) {
	const forbidden = [
		join(runtimeInfo.appRoot, "package.json"),
		join(runtimeInfo.appRoot, "packages"),
		join(runtimeInfo.appRoot, "pnpm-workspace.yaml"),
		join(runtimeInfo.serverRoot, "node_modules"),
		join(runtimeInfo.nodeModulesRoot, ".pnpm"),
		join(runtimeInfo.nodeModulesRoot, ".vite"),
		join(runtimeInfo.nodeModulesRoot, ".vite-temp"),
	];
	for (const path of forbidden) {
		if (await exists(path)) throw new Error(`Desktop slim runtime must not contain ${path}`);
	}
	for (const name of runtimeInfo.workspacePackages) {
		const root = packageTargetRoot(runtimeInfo.nodeModulesRoot, name);
		await mustExist(join(root, "package.json"), `${name} package.json`);
		await mustExist(join(root, "lib"), `${name} lib`);
		if (await exists(join(root, "src"))) throw new Error(`Workspace source leaked into ${root}`);
	}
	for (const name of forbiddenDevPackages) {
		if (await exists(join(runtimeInfo.nodeModulesRoot, ...packageNameParts(name)))) {
			throw new Error(`Desktop runtime unexpectedly contains dev package ${name}`);
		}
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
		if (rel.startsWith("app/apps/server/data/")) forbidden.push(rel);
		if (rel.startsWith("app/apps/server/logs/")) forbidden.push(rel);
		if (/^app\/node_modules\/@bilibili-notify\/[^/]+\/src\//.test(rel)) {
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

async function copyFileOrDir(source, target, options = {}) {
	await mustExist(source, source);
	await mkdir(dirname(target), { recursive: true });
	const dereference = options.dereference ?? false;
	const cpOptions = {
		recursive: true,
		dereference,
		filter: (path) => shouldCopyPath(source, path, options),
	};
	if (!dereference) cpOptions.verbatimSymlinks = true;
	await cp(source, target, cpOptions);
}

export function shouldCopyPath(source, path, options) {
	const rel = relative(source, path).split("\\").join("/");
	if (!rel) return true;
	const name = basename(path);
	const parts = rel.split("/");
	if (name === ".DS_Store" || name === ".git" || name === ".cache") return false;
	if (options.runtimePackage) {
		if (parts[0] === "doc" || parts[0] === "docs") return false;
		if (parts.some((part) => runtimePackageExcludedDirs.has(part))) return false;
		if (runtimePackageExcludedFilePatterns.some((pattern) => pattern.test(name))) return false;
	}
	return true;
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

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
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
