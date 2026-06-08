import type {
	ApiErrorBody,
	AstrBotPushTarget,
	DashboardBootstrap,
	DeliveryResult,
	GlobalConfig,
	LoginSnapshot,
	PairingCodeResult,
	Subscription,
	UserLookupResult,
	UserSearchResult,
} from "./types";

export const PLUGIN_NAME = "astrbot_plugin_bilibili_notify";
const PLUGIN_API_ENDPOINT_PREFIX = "api";
const REDACTED_SECRET = "__BN_REDACTED__";
const BRIDGE_PROXY_METHOD_KEY = "__bn_proxy_method";
const BRIDGE_PROXY_BODY_KEY = "__bn_proxy_body";
const BRIDGE_PROXY_PARAMS_KEY = "__bn_proxy_params";

type BridgeParams = Record<string, string>;

interface AstrBotPluginPageBridge {
	apiGet(endpoint: string, params?: BridgeParams): Promise<unknown>;
	apiPost(endpoint: string, body?: unknown): Promise<unknown>;
	subscribeSSE?(
		endpoint: string,
		handlers: {
			onOpen?: () => void;
			onError?: () => void;
			onMessage?: (message: { raw: string; parsed: unknown; lastEventId?: string }) => void;
		},
		params?: BridgeParams,
	): Promise<string>;
	unsubscribeSSE?(subscriptionId: string): Promise<unknown>;
}

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function resolveApiBase(
	input: { readonly locationPathname?: string; readonly currentScriptSrc?: string | null } = {},
): string {
	const pathname = input.locationPathname ?? globalThis.location?.pathname ?? "";
	const scriptSrc = input.currentScriptSrc ?? currentScriptPathname();
	const marker = `/${PLUGIN_NAME}/`;
	if (pathname.includes(marker) || scriptSrc?.includes(marker))
		return `/api/plug/${PLUGIN_NAME}/api`;
	return "/api";
}

export function errorDetails(error: unknown): {
	readonly summary: string;
	readonly detail?: string;
} {
	if (error instanceof ApiError) {
		const body = error.body as ApiErrorBody | undefined;
		const summary = body?.message || body?.error || error.message;
		const issues = Array.isArray(body?.issues)
			? body.issues
					.map((issue) => {
						const path = issue.path?.join(".");
						return path ? `${path}: ${issue.message ?? "配置不合法"}` : issue.message;
					})
					.filter(Boolean)
			: [];
		const detail = issues.length > 0 ? issues.join("\n") : safeJson(body);
		return { summary, detail };
	}
	if (error instanceof Error) return { summary: error.message };
	return { summary: String(error) };
}

export function redactSecretValue(value: string | undefined): string {
	return value && value.length > 0 ? REDACTED_SECRET : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
	const bridge = getPluginPageBridge();
	if (bridge) {
		return requestViaBridge<T>(bridge, method, normalizedPath, body);
	}

	const base = resolveApiBase();
	const tunneled = tunnelMethodForAstrBotPlugRoute(base, method, normalizedPath);
	const res = await fetch(`${base}/${tunneled.path}`, {
		method: tunneled.method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		credentials: "include",
	});
	if (res.status === 204) return undefined as T;
	let payload: unknown;
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		payload = await res.json().catch(() => undefined);
	} else {
		payload = await res.text().catch(() => undefined);
	}
	if (!res.ok) {
		const msg =
			typeof payload === "object" && payload && "message" in payload
				? String((payload as { message: unknown }).message)
				: `${method} ${path} → ${res.status}`;
		throw new ApiError(res.status, payload, msg);
	}
	return payload as T;
}

export const dashboardApi = {
	bootstrap: () => request<DashboardBootstrap>("GET", "bootstrap"),
	patchGlobals: (patch: Partial<GlobalConfig>) => request<GlobalConfig>("PATCH", "globals", patch),
	resetGlobals: () => request<GlobalConfig>("POST", "danger/reset-globals"),
	clearSubscriptions: () => request<Subscription[]>("POST", "danger/clear-subscriptions"),
	clearTargets: () => request<AstrBotPushTarget[]>("POST", "danger/clear-targets"),
	clearOverrides: () => request<Subscription[]>("POST", "danger/clear-overrides"),
	loginStatus: () => request<LoginSnapshot>("GET", "login/status"),
	beginLogin: () => request<LoginSnapshot>("POST", "login/qr"),
	logout: () => request<LoginSnapshot>("POST", "login/logout"),
	lookupUser: (uid: string) =>
		request<UserLookupResult>("GET", `subscriptions/lookup?uid=${encodeURIComponent(uid)}`),
	searchUsers: (query: string, page = 1) =>
		request<UserSearchResult>(
			"GET",
			`subscriptions/search?q=${encodeURIComponent(query)}&page=${encodeURIComponent(String(page))}`,
		),
	createSubscription: (input: Record<string, unknown>) =>
		request<Subscription[]>("POST", "subscriptions", input),
	patchSubscription: (id: string, patch: Record<string, unknown>) =>
		request<Subscription>("PATCH", `subscriptions/${encodeURIComponent(id)}`, patch),
	deleteSubscription: (id: string) =>
		request<void>("DELETE", `subscriptions/${encodeURIComponent(id)}`),
	createPairingCode: () => request<PairingCodeResult>("POST", "targets/pairing-codes"),
	patchTarget: (id: string, patch: Record<string, unknown>) =>
		request<AstrBotPushTarget>("PATCH", `targets/${encodeURIComponent(id)}`, patch),
	deleteTarget: (id: string) => request<void>("DELETE", `targets/${encodeURIComponent(id)}`),
	pushTest: (targetId: string, text: string) =>
		request<DeliveryResult>("POST", "push/test", { targetId, text }),
};

export function subscribeDashboardEvents(handlers: {
	onHydrate(data: DashboardBootstrap): void;
	onRefresh(): void;
	onOpen(): void;
	onError(): void;
}): (() => void) | undefined {
	const bridge = getPluginPageBridge();
	if (!bridge?.subscribeSSE) return undefined;
	let closed = false;
	let subscriptionId: string | undefined;
	void bridge
		.subscribeSSE(toPluginApiEndpoint("events/stream"), {
			onOpen: handlers.onOpen,
			onError: handlers.onError,
			onMessage(message) {
				const parsed = message.parsed;
				if (isDashboardBootstrap(parsed)) {
					handlers.onHydrate(parsed);
					return;
				}
				handlers.onRefresh();
			},
		})
		.then((id) => {
			subscriptionId = id;
			if (closed) void bridge.unsubscribeSSE?.(id);
		})
		.catch(() => handlers.onError());
	return () => {
		closed = true;
		if (subscriptionId) void bridge.unsubscribeSSE?.(subscriptionId);
	};
}

function toPluginApiEndpoint(endpoint: string): string {
	return endpoint.startsWith(`${PLUGIN_API_ENDPOINT_PREFIX}/`)
		? endpoint
		: `${PLUGIN_API_ENDPOINT_PREFIX}/${endpoint}`;
}

async function requestViaBridge<T>(
	bridge: AstrBotPluginPageBridge,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const upperMethod = method.toUpperCase();
	const parsed = parseEndpoint(path);
	const endpoint = toPluginApiEndpoint(parsed.endpoint);
	if (upperMethod === "GET") {
		return (await bridge.apiGet(endpoint, parsed.params)) as T;
	}
	if (upperMethod === "POST") {
		return (await bridge.apiPost(endpoint, body)) as T;
	}
	if (upperMethod === "PATCH" || upperMethod === "DELETE") {
		return (await bridge.apiPost(
			endpoint,
			buildBridgeProxyTunnelPayload(upperMethod, body, parsed.params),
		)) as T;
	}
	throw new ApiError(405, { error: "method_not_allowed" }, `${method} ${path} is not supported`);
}

function buildBridgeProxyTunnelPayload(
	method: "PATCH" | "DELETE",
	body: unknown,
	params: BridgeParams,
): Record<string, unknown> {
	const payload: Record<string, unknown> = { [BRIDGE_PROXY_METHOD_KEY]: method };
	if (Object.keys(params).length > 0) payload[BRIDGE_PROXY_PARAMS_KEY] = params;
	if (method === "PATCH") payload[BRIDGE_PROXY_BODY_KEY] = body;
	return payload;
}

function tunnelMethodForAstrBotPlugRoute(
	base: string,
	method: string,
	path: string,
): { readonly method: string; readonly path: string } {
	const upperMethod = method.toUpperCase();
	if (!base.includes("/api/plug/") || (upperMethod !== "PATCH" && upperMethod !== "DELETE")) {
		return { method, path };
	}
	const parsed = parseEndpoint(path);
	return {
		method: "POST",
		path: withParams(parsed.endpoint, { ...parsed.params, _method: upperMethod }),
	};
}

function getPluginPageBridge(): AstrBotPluginPageBridge | undefined {
	const candidate = (globalThis as typeof globalThis & { AstrBotPluginPage?: unknown })
		.AstrBotPluginPage;
	if (!candidate || typeof candidate !== "object") return undefined;
	const bridge = candidate as Partial<AstrBotPluginPageBridge>;
	if (typeof bridge.apiGet === "function" && typeof bridge.apiPost === "function") {
		return bridge as AstrBotPluginPageBridge;
	}
	return undefined;
}

function parseEndpoint(path: string): { readonly endpoint: string; readonly params: BridgeParams } {
	const [endpoint, query = ""] = path.split("?", 2);
	const params: BridgeParams = {};
	for (const [key, value] of new URLSearchParams(query)) {
		params[key] = value;
	}
	return { endpoint, params };
}

function withParams(endpoint: string, params: BridgeParams): string {
	const query = new URLSearchParams(params).toString();
	return query ? `${endpoint}?${query}` : endpoint;
}

function currentScriptPathname(): string | null {
	const script = globalThis.document?.currentScript;
	if (typeof HTMLScriptElement === "undefined" || !(script instanceof HTMLScriptElement)) {
		return null;
	}
	try {
		return new URL(script.src, globalThis.location?.href).pathname;
	} catch {
		return null;
	}
}

function isDashboardBootstrap(value: unknown): value is DashboardBootstrap {
	return Boolean(
		value &&
			typeof value === "object" &&
			"snapshot" in value &&
			"globals" in value &&
			"subscriptions" in value &&
			"targets" in value,
	);
}

function safeJson(value: unknown): string | undefined {
	if (value == null) return undefined;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
