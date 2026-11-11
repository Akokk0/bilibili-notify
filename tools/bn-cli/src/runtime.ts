import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

type Profile = "web" | "dev";
interface RuntimeDescriptor {
	version: string;
	file: string;
	sha256: string;
	size: number;
}
interface LaunchOptions {
	profile: Profile;
	port: number;
	dataDir?: string;
	cacheDir?: string;
}
const MAX_ARCHIVE_SIZE = 256 * 1024 * 1024;
const ARCHIVE_FILE = ".bn-payload.zip";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function descriptorOf(catalog: unknown, profile: Profile): RuntimeDescriptor {
	const value = catalog as {
		schemaVersion?: unknown;
		runtimes?: Record<string, RuntimeDescriptor>;
	};
	const descriptor = value?.runtimes?.[profile];
	if (value?.schemaVersion !== 1 || !descriptor)
		throw new Error(`No bundled ${profile} runtime is available. Install a complete BN release.`);
	if (
		typeof descriptor.version !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(descriptor.version) ||
		!/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
		!Number.isSafeInteger(descriptor.size) ||
		descriptor.size <= 0 ||
		descriptor.size > MAX_ARCHIVE_SIZE ||
		descriptor.file !== `runtimes/${profile}.zip`
	)
		throw new Error("Invalid runtime descriptor.");
	return descriptor;
}

function entriesOf(bytes: Uint8Array, descriptor: RuntimeDescriptor, profile: Profile) {
	if (bytes.byteLength !== descriptor.size) throw new Error("Runtime size mismatch.");
	if (hash(bytes) !== descriptor.sha256) throw new Error("Runtime SHA256 mismatch.");
	let entries: [string, Uint8Array][];
	try {
		entries = Object.entries(unzipSync(bytes)).filter(([name]) => !name.endsWith("/"));
	} catch {
		throw new Error("Runtime archive could not be extracted.");
	}
	for (const [name] of entries) {
		if (
			!name ||
			name.includes("\\") ||
			name.includes(":") ||
			isAbsolute(name) ||
			name.split("/").some((part) => part === ".." || part === "." || !part) ||
			name === ARCHIVE_FILE
		)
			throw new Error("Runtime archive contains an unsafe path.");
	}
	const files = new Map(entries);
	for (const file of [
		"index.mjs",
		"boot.mjs",
		"package.json",
		"bn-runtime.json",
		"web-dist/index.html",
	])
		if (!files.has(file)) throw new Error(`Runtime archive is incomplete: missing ${file}.`);
	const marker = JSON.parse(
		Buffer.from(files.get("bn-runtime.json") as Uint8Array).toString("utf8"),
	);
	const pkg = JSON.parse(Buffer.from(files.get("package.json") as Uint8Array).toString("utf8"));
	if (
		marker.schemaVersion !== 1 ||
		marker.profile !== profile ||
		marker.version !== descriptor.version ||
		pkg.version !== descriptor.version
	)
		throw new Error("Runtime profile or version mismatch.");
	return entries;
}

async function cachedRuntime(
	root: string,
	descriptor: RuntimeDescriptor,
	profile: Profile,
	packageRoot: string,
) {
	const target = join(root, `${profile}-${descriptor.version}-${descriptor.sha256}`);
	const present = await lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (present) {
		if (!present.isDirectory() || present.isSymbolicLink())
			throw new Error("Runtime cache is not a regular directory.");
		const entries = entriesOf(await readFile(join(target, ARCHIVE_FILE)), descriptor, profile);
		for (const [name, expected] of entries) {
			const file = join(target, ...name.split("/"));
			const stat = await lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || hash(await readFile(file)) !== hash(expected))
				throw new Error(`Runtime cache is damaged: ${name}.`);
		}
		return target;
	}
	const bytes = await readFile(join(packageRoot, descriptor.file));
	const entries = entriesOf(bytes, descriptor, profile);
	await mkdir(root, { recursive: true });
	const staging = await mkdtemp(join(root, ".staging-"));
	try {
		for (const [name, content] of entries) {
			const file = join(staging, ...name.split("/"));
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, content);
		}
		await writeFile(join(staging, ARCHIVE_FILE), bytes);
		try {
			await rename(staging, target);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
			return cachedRuntime(root, descriptor, profile, packageRoot);
		}
		return target;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Vite读取自己的运行资产，保留npm安装布局；仅开发产物需要这条链接。 */
async function attachSourceLoader(runtime: string): Promise<void> {
	const loader = "@voidzero-dev/vite-plus-core";
	const source = dirname(createRequire(import.meta.url).resolve(`${loader}/package.json`));
	const target = join(runtime, "node_modules", loader);
	await mkdir(dirname(target), { recursive: true });
	const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (existing) {
		if (!existing.isSymbolicLink()) throw new Error("Development source loader link is occupied.");
		if ((await realpath(target).catch(() => "")) === (await realpath(source))) return;
		await rm(target);
	}
	try {
		await symlink(source, target, "junction");
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "EEXIST" ||
			(await realpath(target)) !== (await realpath(source))
		)
			throw error;
	}
}

/** 缓存和持久数据各自独立；宿主在同一进程运行，沿既有退出与更新生命周期。 */
export async function launchRuntime(options: LaunchOptions): Promise<void> {
	const packageRoot = fileURLToPath(new URL("./", import.meta.url));
	const descriptor = descriptorOf(
		JSON.parse(await readFile(join(packageRoot, "runtime.json"), "utf8")),
		options.profile,
	);
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (pkg.version !== descriptor.version) throw new Error("Package and runtime version mismatch.");
	const home = join(homedir(), ".bilibili-notify");
	const cache = resolve(options.cacheDir ?? join(home, "cache", "runtimes"));
	const runtime = await cachedRuntime(cache, descriptor, options.profile, packageRoot);
	const dataDir = resolve(
		options.dataDir ??
			process.env.BN_DATA_DIR ??
			join(home, options.profile === "web" ? "data" : "dev-data"),
	);
	if (dataDir === cache || dataDir.startsWith(cache + sep))
		throw new Error("Persistent data must be outside the runtime cache.");
	if (options.profile === "dev") await attachSourceLoader(runtime);
	await mkdir(dataDir, { recursive: true });
	process.env.BN_DATA_DIR = dataDir;
	process.env.BN_PORT = String(options.port);
	process.env.BN_HOST = "127.0.0.1";
	delete process.env.BN_CONFIG_DISABLED;
	process.env.BN_CONFIG = join(dataDir, "bn.config.yaml");
	process.env.BN_WEB_DIST = join(runtime, "web-dist");
	const entry = join(runtime, options.profile === "web" ? "boot.mjs" : "index.mjs");
	console.log(`BN ${options.profile}: http://127.0.0.1:${options.port}\nData: ${dataDir}`);
	process.argv = [process.execPath, entry];
	const host = await import(pathToFileURL(entry).href);
	if (options.profile === "dev") {
		if (typeof host.startServer !== "function")
			throw new Error("Development runtime has no startServer entry.");
		await host.startServer({ installProcessHandlers: true });
	}
}
