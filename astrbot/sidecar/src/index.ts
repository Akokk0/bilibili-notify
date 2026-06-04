import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { closeSidecarServer, createSidecarHttpServer, listenSidecarServer } from "./http/server.js";
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
	readonly aiBackend?: AiBackend;
	readonly aiProviderId?: string;
	readonly version?: string;
}

export interface RunningSidecar {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	readonly readyFile?: string;
	readonly snapshot: () => SidecarSnapshot;
	close(reason?: string): Promise<void>;
}

const DEFAULT_VERSION = "0.0.0-dev";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

export function parseSidecarLaunchOptions(
	argv = process.argv.slice(2),
	env = process.env,
): Required<Pick<SidecarLaunchOptions, "host" | "port" | "version">> &
	Pick<SidecarLaunchOptions, "readyFile" | "aiBackend" | "aiProviderId"> {
	const parsed = parseArgs({
		args: argv,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			"ready-file": { type: "string" },
			"ai-backend": { type: "string" },
			"ai-provider-id": { type: "string" },
			version: { type: "string" },
		},
		allowPositionals: true,
	});
	const host = parsed.values.host ?? env.BN_SIDECAR_HOST ?? DEFAULT_HOST;
	const port = parseOptionalPort(parsed.values.port ?? env.BN_SIDECAR_PORT, DEFAULT_PORT);
	const readyFile = parsed.values["ready-file"] ?? env.BN_SIDECAR_READY_FILE;
	const aiBackend = normalizeAiBackend(parsed.values["ai-backend"] ?? env.BN_SIDECAR_AI_BACKEND);
	const aiProviderId = parsed.values["ai-provider-id"] ?? env.BN_SIDECAR_AI_PROVIDER_ID;
	const version = parsed.values.version ?? env.BN_SIDECAR_VERSION ?? DEFAULT_VERSION;
	return {
		host,
		port,
		version,
		readyFile,
		aiBackend,
		aiProviderId,
	};
}

export async function startSidecar(options: SidecarLaunchOptions = {}): Promise<RunningSidecar> {
	const host = options.host ?? DEFAULT_HOST;
	const port = options.port ?? DEFAULT_PORT;
	const version = options.version ?? DEFAULT_VERSION;
	const aiBackend = options.aiBackend ?? "astrbot";
	const aiProviderId = options.aiProviderId?.length ? options.aiProviderId : undefined;
	const readyFile = options.readyFile ? options.readyFile : undefined;
	let stopped = false;
	const startedAt = new Date().toISOString();
	let snapshot = createSidecarSnapshot({
		status: "starting",
		version,
		pid: process.pid,
		host,
		port,
		startedAt,
		aiBackend,
		aiProviderId,
	});
	const server = createSidecarHttpServer(() => snapshot);
	if (readyFile) {
		await removeReadyFile(readyFile);
	}
	const address = await listenSidecarServer(server, host, port);
	snapshot = createSidecarSnapshot({
		...snapshot,
		status: "ready",
		host: address.host,
		port: address.port,
		readyAt: new Date().toISOString(),
	});
	if (readyFile) {
		await writeReadyFile(readyFile, snapshot);
	}
	const close = async (reason = "shutdown"): Promise<void> => {
		if (stopped) return;
		stopped = true;
		snapshot = createSidecarSnapshot({
			...snapshot,
			status: "stopping",
		});
		let closeError: unknown;
		try {
			await closeSidecarServer(server);
		} catch (error) {
			closeError = error;
		}
		try {
			await removeReadyFile(readyFile);
		} catch (error) {
			console.error("[astrbot] failed to remove ready file during shutdown:", error);
		}
		snapshot = createSidecarSnapshot({
			...snapshot,
			status: "stopped",
			readyAt: snapshot.readyAt,
		});
		void reason;
		if (closeError) throw closeError;
	};
	return {
		host: address.host,
		port: address.port,
		get url() {
			return snapshot.url;
		},
		readyFile,
		snapshot: () => snapshot,
		close,
	};
}

async function main(): Promise<void> {
	const options = parseSidecarLaunchOptions();
	const sidecar = await startSidecar(options);
	const closeOnSignal = (signal: NodeJS.Signals) => {
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
	process.on("uncaughtException", (err) => {
		console.error(err);
		void sidecar.close("uncaughtException").finally(() => process.exit(1));
	});
	process.on("unhandledRejection", (err) => {
		console.error(err);
		void sidecar.close("unhandledRejection").finally(() => process.exit(1));
	});
}

function parseOptionalPort(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${value}`);
	}
	return port;
}

function isEntrypoint(metaUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return metaUrl === pathToFileURL(resolve(entry)).href;
}

if (isEntrypoint(import.meta.url)) {
	main().catch((err) => {
		console.error("fatal sidecar startup error", err);
		process.exit(1);
	});
}
