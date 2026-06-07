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
const REDACTED_SECRET = "__BN_REDACTED__";

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
	if (pathname.includes(marker) || scriptSrc?.includes(marker)) return `/${PLUGIN_NAME}/api`;
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
	const base = resolveApiBase();
	const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
	const res = await fetch(`${base}/${normalizedPath}`, {
		method,
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

function safeJson(value: unknown): string | undefined {
	if (value == null) return undefined;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
