import { randomUUID } from "node:crypto";
import type { AIScene, CommentaryCallOverride } from "@bilibili-notify/ai";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_SIZE = 50;

/**
 * 各场景的「人格中立」任务指令。AstrBot 是 AI 机器人框架,人格(声线/称呼)由它的
 * persona_manager 提供,Python pump 在调用 Provider 前注入。bilibili-notify 这边只描述
 * 「做什么」,不含任何语气、称呼或自称 —— 避免与 AstrBot 人格叠加打架。
 */
export const SCENE_TASK_PROMPTS: Record<AIScene, string> = {
	dynamic: "请客观、准确地总结这条 B 站动态的核心内容,可补充一两句简评,不要遗漏关键信息。",
	liveSummary: "请客观总结这场 B 站直播的主要内容(约 150-200 字),提炼亮点与互动热点,保持信息准确。",
};

export interface AstrBotAiBridgeOptions {
	readonly providerId?: string;
	/** 全局 AstrBot 人格 id(来自 --ai-persona-id;留空表示用 AstrBot 当前默认人格)。 */
	readonly personaId?: string;
	readonly queue?: AstrBotAiRequestQueue;
}

export interface AstrBotAiRequestInput {
	readonly providerId?: string;
	readonly personaId?: string;
	readonly systemPrompt: string;
	readonly prompt: string;
	readonly imageUrls?: readonly string[];
}

export interface AstrBotAiRequest {
	readonly requestId: string;
	readonly providerId?: string;
	readonly personaId?: string;
	readonly systemPrompt: string;
	readonly prompt: string;
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
	personaId?: string;
	systemPrompt: string;
	prompt: string;
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
 * Node sidecar 不保存 OpenAI endpoint/key/model credentials,也不再自带人格 —— 业务引擎需要
 * AI 时只把 prompt / 中性任务指令 / 人格 id 放进本队列,由 Python pump 取 AstrBot 人格 +
 * 调 AstrBot Provider 后回填。
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
				personaId: input.personaId?.trim() || undefined,
				systemPrompt: input.systemPrompt,
				prompt: input.prompt,
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
	private readonly personaId: string | undefined;
	readonly queue: AstrBotAiRequestQueue;

	constructor(options: AstrBotAiBridgeOptions) {
		this.providerId = options.providerId?.trim() || undefined;
		this.personaId = options.personaId?.trim() || undefined;
		this.queue = options.queue ?? new AstrBotAiRequestQueue();
	}

	async comment(
		content: string,
		scene?: AIScene,
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string> {
		// 人格不再由本端拼接 —— 只发场景任务指令,人格 id 交给 Python 解析 AstrBot persona。
		const systemPrompt = scene ? SCENE_TASK_PROMPTS[scene] : "";
		const personaId = override?.personaId?.trim() || this.personaId;
		return this.queue.request({
			providerId: this.providerId,
			personaId,
			systemPrompt,
			prompt: content,
			imageUrls,
		});
	}
}

function cloneRequest(job: MutableAstrBotAiRequest): AstrBotAiRequest {
	return {
		requestId: job.requestId,
		...(job.providerId ? { providerId: job.providerId } : {}),
		...(job.personaId ? { personaId: job.personaId } : {}),
		systemPrompt: job.systemPrompt,
		prompt: job.prompt,
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
