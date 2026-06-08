import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LoginSnapshot } from "@bilibili-notify/api";
import {
	type AstrBotAdapter,
	type AstrBotPushTarget,
	AstrBotPushTargetSchema,
	type AstrBotSession,
	AstrBotSessionSchema,
	type DeliveryResult,
	type GlobalConfig,
	GlobalConfigSchema,
	type NotificationPayload,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import type { AstrBotAiRequest, AstrBotAiRequestReceipt } from "../runtime/ai-bridge.js";
import { SidecarUpstreamError, type UserSearchResult } from "../runtime/business-runtime.js";
import {
	AstrBotConfigValidationError,
	type AstrBotPairingCode,
	type AstrBotPairingConfirmResult,
} from "../runtime/config-store.js";
import type { DeliveryJob, DeliveryReceipt, SidecarEvent } from "../runtime/event-queue.js";
import {
	createAstrBotSubscription,
	resolveAstrBotDefaultTargetIds,
	type StoredSubscriptionInput,
} from "../runtime/persistence.js";
import type { SidecarSnapshot } from "../runtime/state.js";

export interface SidecarHttpRuntime {
	ensureAuthStarted(): Promise<LoginSnapshot>;
	beginLogin(): Promise<LoginSnapshot>;
	logout(): Promise<LoginSnapshot>;
	getGlobals(): GlobalConfig;
	setGlobals(next: GlobalConfig): Promise<GlobalConfig>;
	resetGlobals(): Promise<GlobalConfig>;
	listSubscriptions(): Subscription[];
	listAdapters(): AstrBotAdapter[];
	listTargets(): AstrBotPushTarget[];
	upsertSubscription(input: StoredSubscriptionInput | Subscription): Promise<Subscription>;
	patchSubscription(id: string, patch: Record<string, unknown>): Promise<Subscription>;
	removeSubscription(id: string): Promise<Subscription | undefined>;
	upsertTarget(target: AstrBotPushTarget): Promise<AstrBotPushTarget>;
	patchTarget(id: string, patch: Record<string, unknown>): Promise<AstrBotPushTarget>;
	removeTarget(id: string): Promise<AstrBotPushTarget | undefined>;
	createTargetPairingCode(): AstrBotPairingCode;
	confirmTargetPairingCode(
		code: string,
		session: AstrBotSession,
	): Promise<AstrBotPairingConfirmResult | undefined>;
	clearSubscriptions(): Promise<Subscription[]>;
	clearTargets(): Promise<AstrBotPushTarget[]>;
	clearSubscriptionOverrides(): Promise<Subscription[]>;
	lookupUser(uid: string): Promise<{
		readonly uid: string;
		readonly name: string;
		readonly avatar: string;
		readonly sign: string;
		readonly fans: number;
	}>;
	searchUsers(query: string, page?: number): Promise<UserSearchResult>;
	drainEvents(afterId?: number): SidecarEvent[];
	claimDeliveries(limit?: number): DeliveryJob[];
	ackDelivery(deliveryId: string): Promise<DeliveryReceipt | undefined>;
	nackDelivery(deliveryId: string, error?: string): Promise<DeliveryReceipt | undefined>;
	claimAiRequests(limit?: number): AstrBotAiRequest[];
	respondAiRequest(requestId: string, text: string): Promise<AstrBotAiRequestReceipt | undefined>;
	failAiRequest(requestId: string, error?: string): Promise<AstrBotAiRequestReceipt | undefined>;
	pushTest(targetId: string, payload: NotificationPayload): Promise<DeliveryResult>;
}

export type SnapshotProvider = () => SidecarSnapshot;

export interface SidecarHttpServerOptions {
	readonly getSnapshot: SnapshotProvider;
	readonly runtime: SidecarHttpRuntime;
	readonly authToken?: string;
}

const REDACTED_SECRET = "__BN_REDACTED__";
const DEFAULT_TEST_TEXT = "[bilibili-notify] AstrBot 测试推送已送达 ✓";

export function createSidecarHttpServer(options: SidecarHttpServerOptions): Server {
	return createServer(createSidecarRequestListener(options));
}

export function createSidecarRequestListener(options: SidecarHttpServerOptions) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		void handleSidecarRequest(req, res, options).catch((error) => {
			console.error("[astrbot] sidecar http request failed:", redactError(error));
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
		server.closeAllConnections?.();
	});
}

async function handleSidecarRequest(
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
): Promise<void> {
	const method = req.method ?? "GET";
	const { pathname, searchParams } = getRequestUrl(req);

	if (isProtectedRoute(method, pathname) && !isAuthorizedRequest(req, options.authToken)) {
		writeJson(res, 401, {
			error: "unauthorized",
			message: "sidecar token is required",
		});
		return;
	}

	if (method === "GET" && pathname === "/api/health") {
		writeJson(res, 200, options.getSnapshot());
		return;
	}
	if (method === "GET" && pathname === "/api/meta") {
		writeJson(res, 200, options.getSnapshot());
		return;
	}
	if (method === "GET" && pathname === "/api/bootstrap") {
		writeJson(res, 200, buildBootstrapPayload(options));
		return;
	}
	if (method === "GET" && pathname === "/") {
		writeText(res, 200, "bilibili-notify AstrBot sidecar");
		return;
	}
	if (method === "GET" && pathname === "/api/events/stream") {
		try {
			const after = parseEventCursor(searchParams.get("after"));
			await writeEventStream(req, res, options, after);
		} catch (error) {
			if (!res.headersSent) writeEventCursorError(res, error);
		}
		return;
	}
	if (method === "GET" && pathname === "/api/events") {
		try {
			const after = parseEventCursor(searchParams.get("after"));
			writeJson(res, 200, options.runtime.drainEvents(after));
		} catch (error) {
			writeEventCursorError(res, error);
		}
		return;
	}
	if (method === "GET" && pathname === "/api/deliveries") {
		writeJson(
			res,
			200,
			options.runtime.claimDeliveries(parseDeliveryLimit(searchParams.get("limit"))),
		);
		return;
	}
	const deliveryAction = matchDeliveryAction(pathname);
	if (deliveryAction) {
		await handleDeliveryAction(method, req, res, options, deliveryAction);
		return;
	}
	if (method === "GET" && pathname === "/api/ai/requests") {
		writeJson(
			res,
			200,
			options.runtime.claimAiRequests(parseAiRequestLimit(searchParams.get("limit"))),
		);
		return;
	}
	const aiRequestAction = matchAiRequestAction(pathname);
	if (aiRequestAction) {
		await handleAiRequestAction(method, req, res, options, aiRequestAction);
		return;
	}
	if (method === "GET" && pathname === "/api/globals") {
		writeJson(res, 200, redactGlobals(options.runtime.getGlobals()));
		return;
	}
	if (method === "PATCH" && pathname === "/api/globals") {
		await handlePatchGlobals(req, res, options);
		return;
	}
	if (method === "POST" && pathname === "/api/danger/reset-globals") {
		try {
			writeJson(res, 200, redactGlobals(await options.runtime.resetGlobals()));
		} catch (error) {
			writeConfigMutationError(res, error, "failed to reset globals");
		}
		return;
	}
	if (method === "POST" && pathname === "/api/danger/clear-subscriptions") {
		try {
			writeJson(res, 200, await options.runtime.clearSubscriptions());
		} catch (error) {
			writeConfigMutationError(res, error, "failed to clear subscriptions");
		}
		return;
	}
	if (method === "POST" && pathname === "/api/danger/clear-targets") {
		try {
			writeJson(res, 200, await options.runtime.clearTargets());
		} catch (error) {
			writeConfigMutationError(res, error, "failed to clear targets");
		}
		return;
	}
	if (method === "POST" && pathname === "/api/danger/clear-overrides") {
		try {
			writeJson(res, 200, await options.runtime.clearSubscriptionOverrides());
		} catch (error) {
			writeConfigMutationError(res, error, "failed to clear subscription overrides");
		}
		return;
	}

	if (isSubscriptionsCollectionPath(pathname)) {
		await handleSubscriptionsCollection(method, req, res, options, searchParams, pathname);
		return;
	}
	const subscriptionId = matchResourceId(pathname, ["/api/subscriptions", "/api/subs"]);
	if (subscriptionId !== null) {
		await handleSubscriptionItem(method, req, res, options, subscriptionId);
		return;
	}
	if (method === "GET" && pathname === "/api/adapters") {
		writeJson(res, 200, options.runtime.listAdapters());
		return;
	}
	const adapterId = matchResourceId(pathname, ["/api/adapters"]);
	if (adapterId !== null) {
		writeJson(res, 405, {
			error: "method_not_allowed",
			message: "AstrBot sidecar adapters are managed internally",
			id: adapterId,
		});
		return;
	}
	if (method === "GET" && pathname === "/api/targets") {
		writeJson(res, 200, options.runtime.listTargets());
		return;
	}
	if (method === "POST" && pathname === "/api/targets/pairing-codes") {
		writeJson(res, 200, options.runtime.createTargetPairingCode());
		return;
	}
	const pairingConfirm = matchTargetPairingConfirm(pathname);
	if (pairingConfirm !== null) {
		await handleConfirmTargetPairing(method, req, res, options, pairingConfirm);
		return;
	}
	if (method === "POST" && pathname === "/api/targets") {
		await handleCreateTarget(req, res, options);
		return;
	}
	const targetId = matchResourceId(pathname, ["/api/targets"]);
	if (targetId !== null) {
		await handleTargetItem(method, req, res, options, targetId);
		return;
	}
	if (method === "POST" && pathname === "/api/push/test") {
		await handlePushTest(req, res, options);
		return;
	}
	if (method === "GET" && (pathname === "/api/login/status" || pathname === "/api/auth/status")) {
		try {
			const login = await options.runtime.ensureAuthStarted();
			writeJson(res, 200, login);
		} catch (error) {
			writeRuntimeError(res, error, "failed to read login status");
		}
		return;
	}
	if (method === "POST" && (pathname === "/api/login/qr" || pathname === "/api/auth/qr")) {
		try {
			const login = await options.runtime.beginLogin();
			writeJson(res, 200, login);
		} catch (error) {
			writeRuntimeError(res, error, "failed to start login qr");
		}
		return;
	}
	if (method === "POST" && (pathname === "/api/login/logout" || pathname === "/api/auth/logout")) {
		try {
			const login = await options.runtime.logout();
			writeJson(res, 200, login);
		} catch (error) {
			writeRuntimeError(res, error, "failed to log out");
		}
		return;
	}

	writeJson(res, 404, { error: "not_found" });
}

function isProtectedRoute(_method: string, pathname: string): boolean {
	return pathname.startsWith("/api/");
}

function isAuthorizedRequest(req: IncomingMessage, authToken: string | undefined): boolean {
	if (!authToken) return true;
	const authorization = req.headers.authorization;
	if (authorization === `Bearer ${authToken}`) return true;
	const headerToken = req.headers["x-bilibili-notify-token"];
	if (headerToken === authToken) return true;
	return Array.isArray(headerToken) && headerToken.includes(authToken);
}

async function handleDeliveryAction(
	method: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	input: { readonly deliveryId: string; readonly action: "ack" | "nack" },
): Promise<void> {
	if (method !== "POST") {
		writeJson(res, 405, { error: "method_not_allowed" });
		return;
	}
	if (!input.deliveryId) {
		writeJson(res, 400, { error: "invalid_delivery_id", message: "delivery id is required" });
		return;
	}
	let nackError: string | undefined;
	if (input.action === "nack") {
		try {
			nackError = await readNackError(req);
		} catch (error) {
			writeRequestBodyError(res, error);
			return;
		}
	}
	try {
		const receipt =
			input.action === "ack"
				? await options.runtime.ackDelivery(input.deliveryId)
				: await options.runtime.nackDelivery(input.deliveryId, nackError);
		if (!receipt) {
			writeJson(res, 404, { error: "not_found", id: input.deliveryId });
			return;
		}
		writeJson(res, 200, receipt);
	} catch (error) {
		writeRuntimeError(res, error, `failed to ${input.action} delivery`);
	}
}

async function handleAiRequestAction(
	method: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	input: { readonly requestId: string; readonly action: "respond" | "fail" },
): Promise<void> {
	if (method !== "POST") {
		writeJson(res, 405, { error: "method_not_allowed" });
		return;
	}
	if (!input.requestId) {
		writeJson(res, 400, { error: "invalid_ai_request_id", message: "AI request id is required" });
		return;
	}
	let receipt: AstrBotAiRequestReceipt | undefined;
	if (input.action === "respond") {
		let body: Record<string, unknown>;
		try {
			body = await readJsonObjectBody(req, "request body must be a JSON object");
		} catch (error) {
			writeRequestBodyError(res, error);
			return;
		}
		const text = typeof body.text === "string" ? body.text : "";
		if (!text.trim()) {
			writeJson(res, 400, { error: "invalid_ai_response", message: "text is required" });
			return;
		}
		try {
			receipt = await options.runtime.respondAiRequest(input.requestId, text);
		} catch (error) {
			writeRuntimeError(res, error, "failed to respond AI request");
			return;
		}
	} else {
		let failError: string | undefined;
		try {
			failError = await readNackError(req);
		} catch (error) {
			writeRequestBodyError(res, error);
			return;
		}
		try {
			receipt = await options.runtime.failAiRequest(input.requestId, failError);
		} catch (error) {
			writeRuntimeError(res, error, "failed to fail AI request");
			return;
		}
	}
	if (!receipt) {
		writeJson(res, 404, { error: "not_found", id: input.requestId });
		return;
	}
	writeJson(res, 200, receipt);
}

async function handlePatchGlobals(
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
): Promise<void> {
	let patch: Record<string, unknown>;
	try {
		patch = await readJsonObjectBody(req, "PATCH body must be a JSON object");
	} catch (error) {
		writeRequestBodyError(res, error);
		return;
	}
	const merged = deepMerge(options.runtime.getGlobals(), unredactGlobalsPatch(patch));
	const parsed = GlobalConfigSchema.safeParse(merged);
	if (!parsed.success) {
		writeJson(res, 400, {
			error: "validation_failed",
			scope: "globals",
			issues: parsed.error.issues,
		});
		return;
	}
	try {
		writeJson(res, 200, redactGlobals(await options.runtime.setGlobals(parsed.data)));
	} catch (error) {
		writeConfigMutationError(res, error, "failed to update globals");
	}
}

async function handleSubscriptionsCollection(
	method: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	searchParams: URLSearchParams,
	pathname: string,
): Promise<void> {
	if (method === "GET" && pathname.endsWith("/lookup")) {
		const uid = searchParams.get("uid")?.trim();
		if (!uid || !/^\d+$/.test(uid)) {
			writeJson(res, 400, { error: "invalid_uid", message: "uid 必须是纯数字 UID" });
			return;
		}
		try {
			writeJson(res, 200, await options.runtime.lookupUser(uid));
		} catch (error) {
			writeUpstreamError(res, error, "lookup failed");
		}
		return;
	}
	if (method === "GET" && pathname.endsWith("/search")) {
		const query = searchParams.get("q")?.trim();
		if (!query) {
			writeJson(res, 400, { error: "invalid_query", message: "搜索关键词不能为空" });
			return;
		}
		try {
			writeJson(
				res,
				200,
				await options.runtime.searchUsers(query, Number(searchParams.get("page") ?? 1)),
			);
		} catch (error) {
			writeUpstreamError(res, error, "search failed");
		}
		return;
	}
	if (pathname !== "/api/subscriptions" && pathname !== "/api/subs") {
		writeJson(res, 405, { error: "method_not_allowed" });
		return;
	}
	if (method === "GET") {
		writeJson(res, 200, options.runtime.listSubscriptions());
		return;
	}
	if (method === "POST") {
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
			await saveSubscription(
				res,
				options,
				createAstrBotSubscription(stored, {
					defaultTargetIds: defaultSubscriptionTargetIds(options.runtime),
					defaultFeatures: options.runtime.getGlobals().defaults.features,
				}),
			);
		} catch (error) {
			writeJson(res, 400, {
				error: "invalid_subscription",
				message: sanitizeText(
					error instanceof Error ? error.message : "invalid subscription payload",
				),
			});
		}
		return;
	}
	writeJson(res, 405, { error: "method_not_allowed" });
}

async function handleSubscriptionItem(
	method: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	id: string,
): Promise<void> {
	if (!id) {
		writeJson(res, 400, {
			error: "invalid_subscription_id",
			message: "subscription id is required",
		});
		return;
	}
	if (method === "PATCH") {
		let patch: Record<string, unknown>;
		try {
			patch = await readJsonObjectBody(req, "PATCH body must be a JSON object");
		} catch (error) {
			writeRequestBodyError(res, error);
			return;
		}
		try {
			writeJson(res, 200, await options.runtime.patchSubscription(id, patch));
		} catch (error) {
			writeConfigMutationError(res, error, "failed to patch subscription");
		}
		return;
	}
	if (method === "DELETE") {
		try {
			const removed = await options.runtime.removeSubscription(id);
			if (!removed) {
				writeJson(res, 404, { error: "not_found", id });
				return;
			}
			writeNoContent(res, 204);
		} catch (error) {
			writeConfigMutationError(res, error, "failed to delete subscription");
		}
		return;
	}
	writeJson(res, 405, { error: "method_not_allowed" });
}

function defaultSubscriptionTargetIds(runtime: SidecarHttpRuntime): string[] {
	return resolveAstrBotDefaultTargetIds(runtime.listTargets());
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
		writeConfigMutationError(res, error, "failed to save subscription");
	}
}

async function handleCreateTarget(
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
): Promise<void> {
	let body: unknown;
	try {
		body = await readJsonBody(req);
	} catch (error) {
		writeRequestBodyError(res, error);
		return;
	}
	const parsed = AstrBotPushTargetSchema.safeParse(body);
	if (!parsed.success) {
		writeJson(res, 400, {
			error: "validation_failed",
			scope: "targets",
			issues: parsed.error.issues,
		});
		return;
	}
	try {
		await options.runtime.upsertTarget(parsed.data);
		writeJson(res, 200, options.runtime.listTargets());
	} catch (error) {
		writeConfigMutationError(res, error, "failed to save target");
	}
}

async function handleConfirmTargetPairing(
	method: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	code: string,
): Promise<void> {
	if (method !== "POST") {
		writeJson(res, 405, { error: "method_not_allowed" });
		return;
	}
	let body: Record<string, unknown>;
	try {
		body = await readJsonObjectBody(req, "request body must be a JSON object");
	} catch (error) {
		writeRequestBodyError(res, error);
		return;
	}
	const parsed = AstrBotSessionSchema.safeParse(body);
	if (!parsed.success) {
		writeJson(res, 400, {
			error: "validation_failed",
			scope: "targets",
			issues: parsed.error.issues,
		});
		return;
	}
	try {
		const result = await options.runtime.confirmTargetPairingCode(code, parsed.data);
		if (!result) {
			writeJson(res, 404, {
				error: "pairing_code_not_found",
				message: "pairing code is invalid or expired",
			});
			return;
		}
		writeJson(res, 200, result);
	} catch (error) {
		writeConfigMutationError(res, error, "failed to confirm target pairing");
	}
}

async function handleTargetItem(
	method: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	id: string,
): Promise<void> {
	if (!id) {
		writeJson(res, 400, { error: "invalid_target_id", message: "target id is required" });
		return;
	}
	if (method === "PATCH") {
		let patch: Record<string, unknown>;
		try {
			patch = await readJsonObjectBody(req, "PATCH body must be a JSON object");
		} catch (error) {
			writeRequestBodyError(res, error);
			return;
		}
		try {
			writeJson(res, 200, await options.runtime.patchTarget(id, patch));
		} catch (error) {
			writeConfigMutationError(res, error, "failed to patch target");
		}
		return;
	}
	if (method === "DELETE") {
		try {
			const removed = await options.runtime.removeTarget(id);
			if (!removed) {
				writeJson(res, 404, { error: "not_found", id });
				return;
			}
			writeNoContent(res, 204);
		} catch (error) {
			writeConfigMutationError(res, error, "failed to delete target");
		}
		return;
	}
	writeJson(res, 405, { error: "method_not_allowed" });
}

async function handlePushTest(
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
): Promise<void> {
	let body: Record<string, unknown>;
	try {
		body = await readJsonObjectBody(req, "request body must be a JSON object");
	} catch (error) {
		writeRequestBodyError(res, error);
		return;
	}
	const targetId = typeof body.targetId === "string" ? body.targetId : "";
	if (!targetId) {
		writeJson(res, 400, {
			ok: false,
			error: "invalid_request",
			message: "targetId is required",
		});
		return;
	}
	const text = typeof body.text === "string" && body.text.trim() ? body.text : DEFAULT_TEST_TEXT;
	try {
		const result = await options.runtime.pushTest(targetId, { kind: "text", text });
		writeJson(res, result.ok ? 200 : result.err === "target not found" ? 404 : 200, result);
	} catch (error) {
		writeRuntimeError(res, error, "failed to send test push");
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

async function readJsonObjectBody(
	req: IncomingMessage,
	message: string,
): Promise<Record<string, unknown>> {
	const body = await readJsonBody(req);
	if (!isPlainObject(body)) {
		const error = new Error(message);
		error.name = "InvalidPayloadError";
		throw error;
	}
	return body;
}

async function readNackError(req: IncomingMessage): Promise<string | undefined> {
	const body = await readJsonBody(req);
	if (!isPlainObject(body)) return undefined;
	return typeof body.error === "string" ? sanitizeText(body.error) : undefined;
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

function parseDeliveryLimit(value: string | null): number {
	if (value === null || value.trim() === "") return 10;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1) return 10;
	return Math.min(limit, 50);
}

function parseAiRequestLimit(value: string | null): number {
	if (value === null || value.trim() === "") return 1;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, 10);
}

function getRequestUrl(req: IncomingMessage): URL {
	const host = req.headers.host ?? "127.0.0.1";
	return new URL(req.url ?? "/", `http://${host}`);
}

function isSubscriptionsCollectionPath(pathname: string): boolean {
	return (
		pathname === "/api/subscriptions" ||
		pathname === "/api/subs" ||
		pathname === "/api/subscriptions/lookup" ||
		pathname === "/api/subs/lookup" ||
		pathname === "/api/subscriptions/search" ||
		pathname === "/api/subs/search"
	);
}

function matchResourceId(pathname: string, bases: readonly string[]): string | null {
	for (const base of bases) {
		const prefix = `${base}/`;
		if (!pathname.startsWith(prefix)) continue;
		const raw = pathname.slice(prefix.length);
		if (!raw || raw.includes("/")) return "";
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	return null;
}

function matchTargetPairingConfirm(pathname: string): string | null {
	const prefix = "/api/targets/pairing-codes/";
	const suffix = "/confirm";
	if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
	const rawCode = pathname.slice(prefix.length, -suffix.length);
	if (!rawCode || rawCode.includes("/")) return "";
	try {
		return decodeURIComponent(rawCode);
	} catch {
		return rawCode;
	}
}

function matchAiRequestAction(
	pathname: string,
): { readonly requestId: string; readonly action: "respond" | "fail" } | null {
	const prefix = "/api/ai/requests/";
	if (!pathname.startsWith(prefix)) return null;
	const parts = pathname.slice(prefix.length).split("/");
	if (parts.length !== 2) return { requestId: "", action: "fail" };
	const rawId = parts[0] ?? "";
	const rawAction = parts[1];
	if (rawAction !== "respond" && rawAction !== "fail") return { requestId: "", action: "fail" };
	try {
		return { requestId: decodeURIComponent(rawId), action: rawAction };
	} catch {
		return { requestId: rawId, action: rawAction };
	}
}

function matchDeliveryAction(
	pathname: string,
): { readonly deliveryId: string; readonly action: "ack" | "nack" } | null {
	const prefix = "/api/deliveries/";
	if (!pathname.startsWith(prefix)) return null;
	const parts = pathname.slice(prefix.length).split("/");
	if (parts.length !== 2) return { deliveryId: "", action: "ack" };
	const rawId = parts[0] ?? "";
	const rawAction = parts[1];
	if (rawAction !== "ack" && rawAction !== "nack") return { deliveryId: "", action: "ack" };
	try {
		return { deliveryId: decodeURIComponent(rawId), action: rawAction };
	} catch {
		return { deliveryId: rawId, action: rawAction };
	}
}

function buildBootstrapPayload(options: SidecarHttpServerOptions) {
	return {
		snapshot: options.getSnapshot(),
		globals: redactGlobals(options.runtime.getGlobals()),
		subscriptions: options.runtime.listSubscriptions(),
		adapters: options.runtime.listAdapters(),
		targets: options.runtime.listTargets(),
	};
}

async function writeEventStream(
	req: IncomingMessage,
	res: ServerResponse,
	options: SidecarHttpServerOptions,
	after: number,
): Promise<void> {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.write(": connected\n\n");
	let cursor = after;
	const writeSse = (event: string, data: unknown): void => {
		if (res.writableEnded) return;
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};
	writeSse("hydrate", buildBootstrapPayload(options));
	const flush = (): void => {
		const events = options.runtime.drainEvents(cursor);
		for (const event of events) {
			cursor = Math.max(cursor, event.id);
			writeSse(event.type, event);
		}
	};
	flush();
	const timer = setInterval(flush, 1000);
	timer.unref?.();
	await new Promise<void>((resolve) => {
		let done = false;
		const cleanup = () => {
			if (done) return;
			done = true;
			clearInterval(timer);
			resolve();
		};
		req.on("close", cleanup);
		res.on("close", cleanup);
	});
}

function redactGlobals(globals: GlobalConfig): GlobalConfig {
	const value = structuredClone(globals);
	if (value.defaults.ai.apiKey) {
		value.defaults.ai.apiKey = REDACTED_SECRET;
	}
	return value;
}

function unredactGlobalsPatch(patch: Record<string, unknown>): Record<string, unknown> {
	const clone = structuredClone(patch);
	const defaults = isPlainObject(clone.defaults) ? clone.defaults : undefined;
	const ai = defaults && isPlainObject(defaults.ai) ? defaults.ai : undefined;
	if (ai?.apiKey === REDACTED_SECRET) delete ai.apiKey;
	return clone;
}

function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (value === null) {
			delete out[key];
			continue;
		}
		out[key] = deepMerge(out[key], value);
	}
	return out;
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

function writeEventCursorError(res: ServerResponse, error: unknown): void {
	writeJson(res, 400, {
		error: "invalid_after",
		message: sanitizeText(error instanceof Error ? error.message : "invalid after cursor"),
	});
}

function writeRequestBodyError(res: ServerResponse, error: unknown): void {
	const message = sanitizeText(
		error instanceof Error ? error.message : "request body must be valid JSON",
	);
	if (message === "request body too large") {
		writeJson(res, 413, {
			error: "payload_too_large",
			message,
		});
		return;
	}
	writeJson(res, error instanceof Error && error.name === "InvalidPayloadError" ? 400 : 400, {
		error:
			error instanceof Error && error.name === "InvalidPayloadError"
				? "invalid_payload"
				: "invalid_json",
		message,
	});
}

function writeConfigMutationError(
	res: ServerResponse,
	error: unknown,
	fallbackMessage: string,
): void {
	if (error instanceof AstrBotConfigValidationError) {
		writeJson(res, 400, {
			error: "validation_failed",
			scope: error.scope,
			issues: error.issues,
		});
		return;
	}
	if (error instanceof Error && /not found/.test(error.message)) {
		writeJson(res, 404, {
			error: "not_found",
			message: sanitizeText(error.message),
		});
		return;
	}
	writeRuntimeError(res, error, fallbackMessage);
}

function writeUpstreamError(res: ServerResponse, error: unknown, fallbackMessage: string): void {
	if (error instanceof SidecarUpstreamError) {
		writeJson(res, error.statusCode, {
			error: error.error,
			code: error.upstreamCode,
			message: sanitizeText(error.message),
		});
		return;
	}
	writeRuntimeError(res, error, fallbackMessage, 502);
}

function writeRuntimeError(
	res: ServerResponse,
	error: unknown,
	fallbackMessage: string,
	statusCode = 500,
): void {
	console.error("[astrbot] sidecar request failed:", redactError(error));
	writeJson(res, statusCode, {
		error: statusCode >= 500 ? "internal_error" : "request_failed",
		message: sanitizeText(fallbackMessage),
		detail: sanitizeText(error instanceof Error ? error.message : String(error)),
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

function sanitizeText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
		.replace(/(token|secret|key|cookie|SESSDATA|bili_jct)=([^\s;&]+)/gi, "$1=[REDACTED]")
		.replace(/(https?:\/\/[^\s"']*(?:token|secret|key|cookie)[^\s"']*)/gi, "[REDACTED_URL]");
}

function redactError(error: unknown): unknown {
	if (error instanceof Error) {
		return `${error.name}: ${sanitizeText(error.message)}`;
	}
	return sanitizeText(String(error));
}
