import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { closeSidecarServer, createSidecarHttpServer, listenSidecarServer } from "./http/server.js";
import { type BusinessRuntimeHandle, createBusinessRuntime } from "./runtime/business-runtime.js";
import { installParentProcessWatchdog } from "./runtime/process-watchdog.js";
import { removeReadyFile, writeReadyFile } from "./runtime/ready-file.js";
import {
	type AiBackend,
	createSidecarSnapshot,
	normalizeAiBackend,
	type SidecarSnapshot,
} from "./runtime/state.js";

export interface SidecarLaunchOptions {
	readonly host?: string;
	readonly port?: number;
	readonly readyFile?: string;
	readonly dataDir?: string;
	readonly aiBackend?: AiBackend;
	readonly aiProviderId?: string;
	readonly aiPersonaId?: string;
	readonly version?: string;
	readonly logLevel?: "debug" | "info" | "warn" | "error";
	readonly authToken?: string;
	readonly userAgent?: string;
	readonly cookieEncryptionKey?: string;
	readonly chromePath?: string;
	readonly signal?: AbortSignal;
}

export interface RunningSidecar {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	readonly readyFile?: string;
	readonly runtime: BusinessRuntimeHandle;
	readonly snapshot: () => SidecarSnapshot;
	close(reason?: string): Promise<void>;
}

const DEFAULT_VERSION = "0.0.0-dev";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_DATA_DIR = "sidecar/state";

export function parseSidecarLaunchOptions(
	argv = process.argv.slice(2),
	env = process.env,
): Required<Pick<SidecarLaunchOptions, "host" | "port" | "version">> &
	Pick<
		SidecarLaunchOptions,
		| "readyFile"
		| "dataDir"
		| "aiBackend"
		| "aiProviderId"
		| "aiPersonaId"
		| "logLevel"
		| "authToken"
		| "userAgent"
		| "cookieEncryptionKey"
		| "chromePath"
	> {
	const parsed = parseArgs({
		args: argv,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			"ready-file": { type: "string" },
			"data-dir": { type: "string" },
			"ai-backend": { type: "string" },
			"ai-provider-id": { type: "string" },
			"ai-persona-id": { type: "string" },
			"log-level": { type: "string" },
			"user-agent": { type: "string" },
			"chrome-path": { type: "string" },
			version: { type: "string" },
		},
		allowPositionals: true,
	});
	const host = DEFAULT_HOST;
	const port = parseOptionalPort(parsed.values.port ?? env.BN_SIDECAR_PORT, DEFAULT_PORT);
	const readyFile = parsed.values["ready-file"] ?? env.BN_SIDECAR_READY_FILE;
	const dataDir = parsed.values["data-dir"] ?? env.BN_SIDECAR_DATA_DIR;
	const aiBackend = normalizeAiBackend(parsed.values["ai-backend"] ?? env.BN_SIDECAR_AI_BACKEND);
	const aiProviderId = parsed.values["ai-provider-id"] ?? env.BN_SIDECAR_AI_PROVIDER_ID;
	const aiPersonaId = parsed.values["ai-persona-id"] ?? env.BN_SIDECAR_AI_PERSONA_ID;
	const logLevel = parseOptionalLogLevel(parsed.values["log-level"] ?? env.BN_SIDECAR_LOG_LEVEL);
	// 敏感项（sidecar token、cookie 加密 key）只从 env 读，绝不接受 argv —— argv 对本机
	// 任意用户 ps / /proc 可见会泄漏密钥；官方启动器本就只用 env 传。
	const authToken = env.BN_SIDECAR_TOKEN;
	const userAgent = parsed.values["user-agent"] ?? env.BN_SIDECAR_USER_AGENT;
	const cookieEncryptionKey = env.BN_SIDECAR_COOKIE_ENCRYPTION_KEY;
	// chromePath 非密钥(只是本机浏览器路径),可走 argv;缺省时 sidecar 侧按 OS 探测。
	const chromePath = parsed.values["chrome-path"] ?? env.BN_SIDECAR_CHROME_PATH;
	const version = parsed.values.version ?? env.BN_SIDECAR_VERSION ?? DEFAULT_VERSION;
	return {
		host,
		port,
		version,
		readyFile,
		dataDir,
		aiBackend,
		aiProviderId,
		aiPersonaId,
		logLevel,
		authToken,
		userAgent,
		cookieEncryptionKey,
		chromePath,
	};
}

export async function startSidecar(options: SidecarLaunchOptions = {}): Promise<RunningSidecar> {
	const signal = options.signal;
	if (signal?.aborted) {
		throw createAbortError(signal.reason);
	}
	const host = DEFAULT_HOST;
	const port = options.port ?? DEFAULT_PORT;
	const version = options.version ?? DEFAULT_VERSION;
	const aiBackend = options.aiBackend ?? "astrbot";
	const aiProviderId = options.aiProviderId?.length ? options.aiProviderId : undefined;
	const aiPersonaId = options.aiPersonaId?.length ? options.aiPersonaId : undefined;
	const readyFile = options.readyFile ? options.readyFile : undefined;
	const dataDir = resolveDataDir(options.dataDir, readyFile);
	const authToken = options.authToken?.trim() ? options.authToken : undefined;
	let stopped = false;
	const startedAt = new Date().toISOString();
	const runtime = createBusinessRuntime({
		dataDir,
		logLevel: options.logLevel,
		userAgent: options.userAgent,
		cookieEncryptionKey: options.cookieEncryptionKey,
		aiBackend,
		aiProviderId,
		aiPersonaId,
	});
	let snapshot = createSidecarSnapshot({
		status: "starting",
		version,
		pid: process.pid,
		host,
		port,
		dataDir,
		startedAt,
		aiBackend,
		aiProviderId,
		capabilities: createSidecarCapabilities(Boolean(authToken), aiBackend === "astrbot"),
		business: runtime.snapshot(),
	});
	const currentSnapshot = (): SidecarSnapshot =>
		createSidecarSnapshot({
			...snapshot,
			business: runtime.snapshot(),
		});
	const server = createSidecarHttpServer({ getSnapshot: currentSnapshot, runtime, authToken });
	const close = async (reason = "shutdown"): Promise<void> => {
		if (stopped) return;
		stopped = true;
		snapshot = createSidecarSnapshot({
			...currentSnapshot(),
			status: "stopping",
		});
		let closeError: unknown;
		const serverClosePromise = closeSidecarServer(server).catch((error) => {
			closeError ??= error;
		});
		try {
			await runtime.close(reason);
		} catch (error) {
			closeError ??= error;
		}
		await serverClosePromise;
		try {
			await removeReadyFile(readyFile);
		} catch (error) {
			console.error("[astrbot] failed to remove ready file during shutdown:", error);
		}
		snapshot = createSidecarSnapshot({
			...currentSnapshot(),
			status: "stopped",
			readyAt: snapshot.readyAt,
		});
		if (closeError) throw closeError;
	};
	try {
		if (readyFile) {
			await removeReadyFile(readyFile);
		}
		throwIfAborted(signal);
		await awaitWithAbort(runtime.start(signal), signal);
		throwIfAborted(signal);
		const address = await listenSidecarServer(server, host, port);
		throwIfAborted(signal);
		snapshot = createSidecarSnapshot({
			...currentSnapshot(),
			status: "ready",
			host: address.host,
			port: address.port,
			readyAt: new Date().toISOString(),
		});
		if (readyFile) {
			await writeReadyFile(readyFile, currentSnapshot());
		}
		throwIfAborted(signal);
		return {
			host: snapshot.host,
			port: snapshot.port,
			get url() {
				return currentSnapshot().url;
			},
			readyFile,
			runtime,
			snapshot: currentSnapshot,
			close,
		};
	} catch (error) {
		try {
			await close("startup-aborted");
		} catch (cleanupError) {
			console.error("[astrbot] failed to clean up sidecar after startup error:", cleanupError);
		}
		throw error;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAbortError(signal.reason);
	}
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		throw createAbortError(signal.reason);
	}
	let abortWon = false;
	promise.catch((error) => {
		if (abortWon && error instanceof Error && error.name !== "AbortError") {
			console.warn("[astrbot] aborted startup task finished with error:", error);
		}
	});
	let abortHandler: (() => void) | undefined;
	const abortPromise = new Promise<T>((_resolve, reject) => {
		abortHandler = () => {
			abortWon = true;
			reject(createAbortError(signal.reason));
		};
		signal.addEventListener("abort", abortHandler, { once: true });
	});
	try {
		return await Promise.race([promise, abortPromise]);
	} finally {
		if (abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
	}
}

function createAbortError(reason: unknown): Error {
	const message = typeof reason === "string" && reason.length ? reason : "Sidecar startup aborted";
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

async function main(): Promise<void> {
	const options = parseSidecarLaunchOptions();
	const startupAbortController = new AbortController();
	let sidecar: RunningSidecar | undefined;
	let pendingShutdownSignal: NodeJS.Signals | undefined;
	const parentWatchdog = installParentProcessWatchdog(
		{
			close: async (reason) => {
				if (!sidecar) {
					return false;
				}
				await sidecar.close(reason);
				return true;
			},
		},
		parseOptionalParentPid(process.env.BN_SIDECAR_PARENT_PID),
	);
	const closeOnSignal = (signal: NodeJS.Signals) => {
		parentWatchdog.stop();
		if (!sidecar) {
			pendingShutdownSignal = signal;
			startupAbortController.abort(signal);
			return;
		}
		void sidecar.close(signal).then(
			() => process.exit(0),
			(err) => {
				console.error(err);
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", closeOnSignal);
	process.on("SIGTERM", closeOnSignal);
	try {
		sidecar = await startSidecar({ ...options, signal: startupAbortController.signal });
	} catch (error) {
		parentWatchdog.stop();
		if (pendingShutdownSignal) {
			process.exit(0);
		}
		throw error;
	}
	if (pendingShutdownSignal) {
		parentWatchdog.stop();
		void sidecar.close(pendingShutdownSignal).then(
			() => process.exit(0),
			(err) => {
				console.error(err);
				process.exit(1);
			},
		);
		return;
	}
	process.on("uncaughtException", (err) => {
		parentWatchdog.stop();
		console.error(err);
		void sidecar.close("uncaughtException").finally(() => process.exit(1));
	});
	process.on("unhandledRejection", (err) => {
		parentWatchdog.stop();
		console.error(err);
		void sidecar.close("unhandledRejection").finally(() => process.exit(1));
	});
}

function resolveDataDir(value: string | undefined, readyFile: string | undefined): string {
	if (value) return resolve(value);
	if (readyFile) return dirname(resolve(readyFile));
	return resolve(DEFAULT_DATA_DIR);
}

function parseOptionalPort(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${value}`);
	}
	return port;
}

function parseOptionalLogLevel(value: string | undefined): SidecarLaunchOptions["logLevel"] {
	if (value === "debug" || value === "info" || value === "warn" || value === "error") {
		return value;
	}
	return undefined;
}

function createSidecarCapabilities(tokenAuthEnabled: boolean, aiProviderBridge: boolean) {
	return {
		tokenAuth: tokenAuthEnabled,
		pluginPageProxy: true,
		sse: true,
		deliveryQueue: true,
		aiProviderBridge,
	};
}

export function parseOptionalParentPid(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	if (!/^[1-9]\d*$/.test(value)) {
		return undefined;
	}
	const parentPid = Number(value);
	if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
		return undefined;
	}
	return parentPid;
}

function isEntrypoint(metaUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
	} catch {
		return metaUrl === pathToFileURL(resolve(entry)).href;
	}
}

if (isEntrypoint(import.meta.url)) {
	main().catch((err) => {
		console.error("fatal sidecar startup error", err);
		process.exit(1);
	});
}
