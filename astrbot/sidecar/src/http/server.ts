import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LoginSnapshot } from "@bilibili-notify/api";
import { type Subscription, SubscriptionSchema } from "@bilibili-notify/internal";
import type { SidecarEvent } from "../runtime/event-queue.js";
import { createAstrBotSubscription, type StoredSubscriptionInput } from "../runtime/persistence.js";
import type { SidecarSnapshot } from "../runtime/state.js";

export interface SidecarHttpRuntime {
	ensureAuthStarted(): Promise<LoginSnapshot>;
	beginLogin(): Promise<LoginSnapshot>;
	listSubscriptions(): Subscription[];
	upsertSubscription(input: StoredSubscriptionInput | Subscription): Promise<Subscription>;
	removeSubscription(id: string): Promise<Subscription | undefined>;
	drainEvents(afterId?: number): SidecarEvent[];
}

export type SnapshotProvider = () => SidecarSnapshot;

export interface SidecarHttpServerOptions {
	readonly getSnapshot: SnapshotProvider;
	readonly runtime: SidecarHttpRuntime;
}

export function createSidecarHttpServer(options: SidecarHttpServerOptions): Server {
	return createServer(createSidecarRequestListener(options));
}

export function createSidecarRequestListener(options: SidecarHttpServerOptions) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		void handleSidecarRequest(req, res, options).catch((error) => {
			console.error("[astrbot] sidecar http request failed:", error);
			if (!res.writableEnded) {
				writeJson(res, 500, {
					error: "internal_error",
					message: "sidecar request failed",
				});
			}
		});
	};
}

export async function listenSidecarServer(
	server: Server,
	host: string,
	port: number,
): Promise<{ host: string; port: number }> {
	return new Promise((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("error", onError);
			reject(err);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.off("error", onError);
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				reject(new Error("sidecar server did not expose a TCP address"));
				return;
			}
			resolve({ host, port: address.port });
		});
	});
}

export async function closeSidecarServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

async function handleSidecarRequest(
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
): Promise<void> {
	const method = req.method ?? "GET";
	const { pathname, searchParams } = getRequestUrl(req);

	if (method === "GET" && pathname === "/api/health") {
		writeJson(res, 200, options.getSnapshot());
		return;
	}
	if (method === "GET" && pathname === "/api/meta") {
		writeJson(res, 200, options.getSnapshot());
		return;
	}
	if (method === "GET" && pathname === "/") {
		writeText(res, 200, "bilibili-notify AstrBot sidecar");
		return;
	}
	if (method === "GET" && pathname === "/api/events") {
		try {
			const after = parseEventCursor(searchParams.get("after"));
			writeJson(res, 200, options.runtime.drainEvents(after));
		} catch (error) {
			writeJson(res, 400, {
				error: "invalid_after",
				message: error instanceof Error ? error.message : "invalid after cursor",
			});
		}
		return;
	}
	if (method === "GET" && pathname === "/api/subscriptions") {
		writeJson(res, 200, options.runtime.listSubscriptions());
		return;
	}
	if (method === "POST" && pathname === "/api/subscriptions") {
		let body: unknown;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			writeRequestBodyError(res, error);
			return;
		}
		const parsed = SubscriptionSchema.safeParse(body);
		if (parsed.success) {
			await saveSubscription(res, options, parsed.data);
			return;
		}
		const stored = parseStoredSubscriptionInput(body);
		if (!stored) {
			writeJson(res, 400, {
				error: "invalid_subscription",
				message: "request body must be a full subscription or a minimal AstrBot subscription",
			});
			return;
		}
		try {
			await saveSubscription(res, options, createAstrBotSubscription(stored));
		} catch (error) {
			writeJson(res, 400, {
				error: "invalid_subscription",
				message: error instanceof Error ? error.message : "invalid subscription payload",
			});
		}
		return;
	}
	if (method === "DELETE" && pathname.startsWith("/api/subscriptions/")) {
		const id = pathname.slice("/api/subscriptions/".length);
		if (!id || id.includes("/")) {
			writeJson(res, 400, {
				error: "invalid_subscription_id",
				message: "subscription id is required",
			});
			return;
		}
		try {
			const removed = await options.runtime.removeSubscription(id);
			if (!removed) {
				writeJson(res, 404, { error: "not_found", id });
				return;
			}
			writeNoContent(res, 204);
			return;
		} catch (error) {
			console.error("[astrbot] DELETE /api/subscriptions/:id failed:", error);
			writeJson(res, 500, {
				error: "internal_error",
				message: "failed to delete subscription",
			});
			return;
		}
	}
	if (method === "GET" && pathname === "/api/login/status") {
		try {
			const login = await options.runtime.ensureAuthStarted();
			writeJson(res, 200, login);
		} catch (error) {
			console.error("[astrbot] GET /api/login/status failed:", error);
			writeJson(res, 500, {
				error: "internal_error",
				message: "failed to read login status",
			});
		}
		return;
	}
	if (method === "POST" && pathname === "/api/login/qr") {
		try {
			const login = await options.runtime.beginLogin();
			writeJson(res, 200, login);
		} catch (error) {
			console.error("[astrbot] POST /api/login/qr failed:", error);
			writeJson(res, 500, {
				error: "internal_error",
				message: "failed to start login qr",
			});
		}
		return;
	}

	writeJson(res, 404, { error: "not_found" });
}

async function saveSubscription(
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	subscription: Subscription,
): Promise<void> {
	try {
		await options.runtime.upsertSubscription(subscription);
		writeJson(res, 200, options.runtime.listSubscriptions());
	} catch (error) {
		console.error("[astrbot] POST /api/subscriptions failed:", error);
		writeJson(res, 500, {
			error: "internal_error",
			message: "failed to save subscription",
		});
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > 1_048_576) {
			throw new Error("request body too large");
		}
		chunks.push(buffer);
	}
	if (chunks.length === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("request body must be valid JSON");
	}
}

function parseStoredSubscriptionInput(body: unknown): StoredSubscriptionInput | null {
	if (!isPlainObject(body) || typeof body.uid !== "string") return null;
	if (
		"routing" in body ||
		"atAllDefaults" in body ||
		"atAll" in body ||
		"overrides" in body ||
		"specialUsers" in body ||
		"groups" in body ||
		"notes" in body
	) {
		return null;
	}
	return body as unknown as StoredSubscriptionInput;
}

function parseEventCursor(value: string | null): number {
	if (value === null || value.trim() === "") return 0;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`invalid after cursor: ${value}`);
	}
	const after = Number(trimmed);
	if (!Number.isSafeInteger(after)) {
		throw new Error(`invalid after cursor: ${value}`);
	}
	return after;
}

function getRequestUrl(req: IncomingMessage): URL {
	const host = req.headers.host ?? "127.0.0.1";
	return new URL(req.url ?? "/", `http://${host}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(`${JSON.stringify(payload)}\n`);
}

function writeRequestBodyError(res: ServerResponse, error: unknown): void {
	const message = error instanceof Error ? error.message : "request body must be valid JSON";
	if (message === "request body too large") {
		writeJson(res, 413, {
			error: "payload_too_large",
			message,
		});
		return;
	}
	writeJson(res, 400, {
		error: "invalid_json",
		message,
	});
}

function writeNoContent(res: ServerResponse, statusCode: number): void {
	res.writeHead(statusCode, {
		"cache-control": "no-store",
	});
	res.end();
}

function writeText(res: ServerResponse, statusCode: number, text: string): void {
	res.writeHead(statusCode, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(`${text}\n`);
}
