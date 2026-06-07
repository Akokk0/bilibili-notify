import { randomUUID } from "node:crypto";
import {
	type AIScene,
	buildSystemPrompt,
	type CommentaryCallOverride,
	type PersonaConfig,
} from "@bilibili-notify/ai";
import type { AIPersona, GlobalConfig } from "@bilibili-notify/internal";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_SIZE = 50;

export interface AstrBotAiBridgeOptions {
	readonly providerId?: string;
	readonly getGlobals: () => GlobalConfig;
	readonly queue?: AstrBotAiRequestQueue;
}

export interface AstrBotAiRequestInput {
	readonly providerId?: string;
	readonly systemPrompt: string;
	readonly prompt: string;
	readonly model: string;
	readonly temperature?: number;
	readonly imageUrls?: readonly string[];
}

export interface AstrBotAiRequest {
	readonly requestId: string;
	readonly providerId?: string;
	readonly systemPrompt: string;
	readonly prompt: string;
	readonly model: string;
	readonly temperature?: number;
	readonly imageUrls: readonly string[];
	readonly attempt: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly leasedUntil?: string;
}

export interface AstrBotAiRequestReceipt {
	readonly requestId: string;
	readonly ok: boolean;
	readonly ts: string;
	readonly err?: string;
}

export interface AstrBotAiRequestQueueSnapshot {
	readonly size: number;
	readonly pending: number;
	readonly inFlight: number;
	readonly maxSize: number;
}

export interface AstrBotAiRequestQueueOptions {
	readonly maxSize?: number;
	readonly requestTimeoutMs?: number;
	readonly leaseMs?: number;
}

type AiRequestStatus = "pending" | "in-flight";

interface MutableAstrBotAiRequest {
	requestId: string;
	providerId?: string;
	systemPrompt: string;
	prompt: string;
	model: string;
	temperature?: number;
	imageUrls: string[];
	attempt: number;
	createdAt: string;
	updatedAt: string;
	leasedUntil?: string;
	status: AiRequestStatus;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * AstrBot AI bridge 的内存请求队列。
 *
 * Node sidecar 不保存 OpenAI endpoint/key/model credentials；业务引擎需要 AI 时只把
 * prompt / system prompt / model hint 放进本队列，由 Python pump 调 AstrBot Provider 后回填。
 */
export class AstrBotAiRequestQueue {
	private readonly maxSize: number;
	private readonly requestTimeoutMs: number;
	private readonly leaseMs: number;
	private jobs: MutableAstrBotAiRequest[] = [];

	constructor(options: AstrBotAiRequestQueueOptions = {}) {
		this.maxSize = Math.max(1, options.maxSize ?? DEFAULT_MAX_SIZE);
		this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
	}

	request(input: AstrBotAiRequestInput, now = Date.now()): Promise<string> {
		if (this.jobs.length >= this.maxSize) {
			throw new Error("AstrBot AI request queue is full");
		}
		const requestId = randomUUID();
		const ts = new Date(now).toISOString();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.remove(requestId);
				reject(new Error("AstrBot AI Provider timed out"));
			}, this.requestTimeoutMs);
			timer.unref?.();
			this.jobs.push({
				requestId,
				providerId: input.providerId?.trim() || undefined,
				systemPrompt: input.systemPrompt,
				prompt: input.prompt,
				model: input.model,
				temperature: input.temperature,
				imageUrls: [...(input.imageUrls ?? [])].filter(
					(url) => typeof url === "string" && url.length > 0,
				),
				attempt: 0,
				createdAt: ts,
				updatedAt: ts,
				status: "pending",
				resolve,
				reject,
				timer,
			});
		});
	}

	claim(options: { readonly limit?: number; readonly now?: number } = {}): AstrBotAiRequest[] {
		const now = options.now ?? Date.now();
		const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 1)));
		const claimed: AstrBotAiRequest[] = [];
		for (const job of this.jobs) {
			if (claimed.length >= limit) break;
			if (!this.isClaimable(job, now)) continue;
			job.status = "in-flight";
			job.attempt += 1;
			job.updatedAt = new Date(now).toISOString();
			job.leasedUntil = new Date(now + this.leaseMs).toISOString();
			claimed.push(cloneRequest(job));
		}
		return claimed;
	}

	respond(requestId: string, text: string, now = Date.now()): AstrBotAiRequestReceipt | undefined {
		const job = this.remove(requestId);
		if (!job) return undefined;
		clearTimeout(job.timer);
		job.resolve(text);
		return { requestId, ok: true, ts: new Date(now).toISOString() };
	}

	fail(
		requestId: string,
		error: string | undefined,
		now = Date.now(),
	): AstrBotAiRequestReceipt | undefined {
		const job = this.remove(requestId);
		if (!job) return undefined;
		const safeError = sanitizeError(error) ?? "AstrBot AI Provider failed";
		clearTimeout(job.timer);
		job.reject(new Error(safeError));
		return { requestId, ok: false, ts: new Date(now).toISOString(), err: safeError };
	}

	snapshot(): AstrBotAiRequestQueueSnapshot {
		return {
			size: this.jobs.length,
			pending: this.jobs.filter((job) => job.status === "pending").length,
			inFlight: this.jobs.filter((job) => job.status === "in-flight").length,
			maxSize: this.maxSize,
		};
	}

	private isClaimable(job: MutableAstrBotAiRequest, now: number): boolean {
		if (job.status === "pending") return true;
		return Boolean(job.leasedUntil && Date.parse(job.leasedUntil) <= now);
	}

	private remove(requestId: string): MutableAstrBotAiRequest | undefined {
		const index = this.jobs.findIndex((job) => job.requestId === requestId);
		if (index === -1) return undefined;
		const [job] = this.jobs.splice(index, 1);
		return job;
	}
}

export class AstrBotAiBridge {
	private readonly providerId: string | undefined;
	private readonly getGlobals: () => GlobalConfig;
	readonly queue: AstrBotAiRequestQueue;

	constructor(options: AstrBotAiBridgeOptions) {
		this.providerId = options.providerId?.trim() || undefined;
		this.getGlobals = options.getGlobals;
		this.queue = options.queue ?? new AstrBotAiRequestQueue();
	}

	async comment(
		content: string,
		scene?: AIScene,
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string> {
		const ai = this.getGlobals().defaults.ai;
		const persona = override?.persona ?? toPersonaConfig(ai.persona);
		const dynamicPrompt = override?.dynamicPrompt ?? ai.dynamicPrompt;
		const liveSummaryPrompt = override?.liveSummaryPrompt ?? ai.liveSummaryPrompt;
		const sceneAddition =
			scene === "dynamic" ? dynamicPrompt : scene === "liveSummary" ? liveSummaryPrompt : "";
		const personaPrompt = buildSystemPrompt(persona);
		const systemPrompt = sceneAddition ? `${personaPrompt}\n${sceneAddition}` : personaPrompt;
		return this.queue.request({
			providerId: this.providerId,
			systemPrompt,
			prompt: content,
			model: override?.model ?? ai.model,
			temperature: override?.temperature ?? ai.temperature,
			imageUrls,
		});
	}
}

function toPersonaConfig(persona: AIPersona): PersonaConfig {
	return {
		preset: "custom",
		name: persona.name,
		addressUser: persona.addressUser,
		addressSelf: persona.addressSelf,
		traits: persona.traits,
		catchphrase: persona.catchphrase,
		customBase: persona.baseRole,
		extraPrompt: persona.extraSystemPrompt,
	};
}

function cloneRequest(job: AstrBotAiRequest): AstrBotAiRequest {
	return {
		requestId: job.requestId,
		...(job.providerId ? { providerId: job.providerId } : {}),
		systemPrompt: job.systemPrompt,
		prompt: job.prompt,
		model: job.model,
		...(job.temperature !== undefined ? { temperature: job.temperature } : {}),
		imageUrls: [...job.imageUrls],
		attempt: job.attempt,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		...(job.leasedUntil ? { leasedUntil: job.leasedUntil } : {}),
	};
}

function sanitizeError(value: string | undefined): string | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	return text
		.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
		.replace(/(token|secret|key|cookie|SESSDATA|bili_jct)=([^\s;&]+)/gi, "$1=[REDACTED]")
		.replace(/(https?:\/\/[^\s"']*(?:token|secret|key|cookie)[^\s"']*)/gi, "[REDACTED_URL]")
		.slice(0, 1_000);
}
