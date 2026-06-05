export type SidecarStatus = "starting" | "ready" | "stopping" | "stopped";
export type AiBackend = "astrbot" | "own" | "disabled";

const AI_BACKENDS = new Set<AiBackend>(["astrbot", "own", "disabled"]);

export interface SidecarBusinessSnapshot {
	readonly started: boolean;
	readonly authStarted: boolean;
	readonly engines: {
		readonly dynamic: boolean;
		readonly live: boolean;
	};
	readonly subscriptions: {
		readonly count: number;
		readonly path: string;
	};
	readonly events: {
		readonly nextId: number;
		readonly size: number;
	};
	readonly login?: unknown;
}

export interface SidecarSnapshotInput {
	readonly status: SidecarStatus;
	readonly version: string;
	readonly pid: number;
	readonly host: string;
	readonly port: number;
	readonly startedAt: string;
	readonly readyAt?: string;
	readonly aiBackend: AiBackend;
	readonly aiProviderId?: string;
	readonly business?: SidecarBusinessSnapshot;
}

export interface SidecarSnapshot extends SidecarSnapshotInput {
	readonly url: string;
	readonly uptimeMs: number;
}

export function normalizeAiBackend(value: string | undefined): AiBackend {
	if (value && AI_BACKENDS.has(value as AiBackend)) return value as AiBackend;
	return "astrbot";
}

export function createSidecarSnapshot(
	input: SidecarSnapshotInput,
	now = Date.now(),
): SidecarSnapshot {
	const startedAt = Date.parse(input.startedAt);
	return {
		...input,
		url: buildRuntimeUrl(input.host, input.port),
		uptimeMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0,
	};
}

export function buildRuntimeUrl(host: string, port: number): string {
	const normalizedHost = formatRuntimeHostForUrl(normalizeRuntimeHost(host));
	return `http://${normalizedHost}:${port}`;
}

function normalizeRuntimeHost(host: string): string {
	const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bareHost === "0.0.0.0") return "127.0.0.1";
	if (bareHost === "::") return "::1";
	return bareHost;
}

function formatRuntimeHostForUrl(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) return host;
	return host.includes(":") ? `[${host}]` : host;
}
