import { randomUUID } from "node:crypto";
import type { AstrBotPushTarget, DeliveryResult } from "@bilibili-notify/internal";
import type { SerializableNotificationPayload } from "./payload.js";

export type SidecarEvent =
	| {
			readonly id: number;
			readonly ts: string;
			readonly type: "notification";
			readonly deliveryId?: string;
			readonly targetId: string;
			readonly private: boolean;
			readonly payload: SerializableNotificationPayload;
			readonly result: DeliveryResult;
	  }
	| {
			readonly id: number;
			readonly ts: string;
			readonly type: "delivery";
			readonly deliveryId: string;
			readonly targetId: string;
			readonly status: "queued" | "acked" | "nacked" | "dropped";
			readonly attempt: number;
			readonly err?: string;
	  }
	| {
			readonly id: number;
			readonly ts: string;
			readonly type: "engine-error";
			readonly source: string;
			readonly message: string;
	  }
	| {
			readonly id: number;
			readonly ts: string;
			readonly type: "auth-lost";
	  }
	| {
			readonly id: number;
			readonly ts: string;
			readonly type: "auth-restored";
	  };

export type SidecarEventInput =
	| Omit<Extract<SidecarEvent, { type: "notification" }>, "id" | "ts">
	| Omit<Extract<SidecarEvent, { type: "delivery" }>, "id" | "ts">
	| Omit<Extract<SidecarEvent, { type: "engine-error" }>, "id" | "ts">
	| Omit<Extract<SidecarEvent, { type: "auth-lost" }>, "id" | "ts">
	| Omit<Extract<SidecarEvent, { type: "auth-restored" }>, "id" | "ts">;

export interface EventQueueSnapshot {
	readonly nextId: number;
	readonly size: number;
}

export interface EventQueueOptions {
	readonly maxSize?: number;
}

export class SidecarEventQueue {
	private readonly maxSize: number;
	private events: SidecarEvent[] = [];
	private nextId = 1;

	constructor(options: EventQueueOptions = {}) {
		this.maxSize = Math.max(1, options.maxSize ?? 500);
	}

	push(event: SidecarEventInput): SidecarEvent {
		const next = {
			...event,
			id: this.nextId,
			ts: new Date().toISOString(),
		} as SidecarEvent;
		this.nextId += 1;
		this.events = [...this.events, next].slice(-this.maxSize);
		return next;
	}

	drain(afterId = 0): SidecarEvent[] {
		return this.events.filter((event) => event.id > afterId);
	}

	snapshot(): EventQueueSnapshot {
		return {
			nextId: this.nextId,
			size: this.events.length,
		};
	}
}

export interface DeliveryJob {
	readonly deliveryId: string;
	readonly targetId: string;
	readonly private: boolean;
	readonly session: AstrBotPushTarget["session"];
	readonly payload: SerializableNotificationPayload;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly availableAt: string;
	readonly leasedUntil?: string;
	readonly lastError?: string;
}

export interface DeliveryJobInput {
	readonly target: AstrBotPushTarget;
	readonly private: boolean;
	readonly payload: SerializableNotificationPayload;
}

export interface DeliveryReceipt {
	readonly deliveryId: string;
	readonly targetId: string;
	readonly attempt: number;
	readonly ok: boolean;
	readonly dropped: boolean;
	readonly ts: string;
	readonly err?: string;
	readonly nextAttemptAt?: string;
}

export interface DeliveryQueueSnapshot {
	readonly size: number;
	readonly pending: number;
	readonly inFlight: number;
	readonly maxSize: number;
	readonly maxAttempts: number;
}

export interface DeliveryQueueOptions {
	readonly maxSize?: number;
	readonly maxAttempts?: number;
	readonly leaseMs?: number;
	readonly baseBackoffMs?: number;
	readonly maxBackoffMs?: number;
	readonly events?: SidecarEventQueue;
}

type DeliveryStatus = "pending" | "in-flight";

interface MutableDeliveryJob {
	deliveryId: string;
	targetId: string;
	private: boolean;
	session: AstrBotPushTarget["session"];
	payload: SerializableNotificationPayload;
	attempt: number;
	maxAttempts: number;
	createdAt: string;
	updatedAt: string;
	availableAt: string;
	leasedUntil?: string;
	lastError?: string;
	status: DeliveryStatus;
}

export class SidecarDeliveryQueue {
	private readonly maxSize: number;
	private readonly maxAttempts: number;
	private readonly leaseMs: number;
	private readonly baseBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly events: SidecarEventQueue | undefined;
	private jobs: MutableDeliveryJob[] = [];

	constructor(options: DeliveryQueueOptions = {}) {
		this.maxSize = Math.max(1, options.maxSize ?? 500);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
		this.leaseMs = Math.max(1, options.leaseMs ?? 30_000);
		this.baseBackoffMs = Math.max(1, options.baseBackoffMs ?? 1_000);
		this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs ?? 30_000);
		this.events = options.events;
	}

	enqueue(input: DeliveryJobInput, now = Date.now()): DeliveryJob {
		const ts = new Date(now).toISOString();
		const job: MutableDeliveryJob = {
			deliveryId: randomUUID(),
			targetId: input.target.id,
			private: input.private,
			session: structuredClone(input.target.session),
			payload: structuredClone(input.payload),
			attempt: 0,
			maxAttempts: this.maxAttempts,
			createdAt: ts,
			updatedAt: ts,
			availableAt: ts,
			status: "pending",
		};
		if (this.jobs.length >= this.maxSize) {
			const dropIdx = this.jobs.findIndex((entry) => entry.status === "pending");
			if (dropIdx === -1) {
				throw new Error("delivery queue is full");
			}
			const [dropped] = this.jobs.splice(dropIdx, 1);
			if (dropped) this.pushDeliveryEvent(dropped, "dropped", "delivery queue overflow");
		}
		this.jobs.push(job);
		this.pushDeliveryEvent(job, "queued");
		return cloneJob(job);
	}

	claim(options: { readonly limit?: number; readonly now?: number } = {}): DeliveryJob[] {
		const now = options.now ?? Date.now();
		const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 10)));
		const claimed: DeliveryJob[] = [];
		for (const job of [...this.jobs]) {
			if (claimed.length >= limit) break;
			if (!this.isClaimable(job, now)) continue;
			const nextAttempt = job.attempt + 1;
			if (nextAttempt > this.maxAttempts) {
				this.dropJob(job, "delivery lease expired after max attempts");
				continue;
			}
			const ts = new Date(now).toISOString();
			job.status = "in-flight";
			job.attempt = nextAttempt;
			job.updatedAt = ts;
			job.leasedUntil = new Date(now + this.leaseMs).toISOString();
			claimed.push(cloneJob(job));
		}
		return claimed;
	}

	ack(deliveryId: string, now = Date.now()): DeliveryReceipt | undefined {
		const job = this.removeJob(deliveryId);
		if (!job) return undefined;
		this.pushDeliveryEvent(job, "acked");
		return buildReceipt(job, true, false, now);
	}

	nack(deliveryId: string, err: string | undefined, now = Date.now()): DeliveryReceipt | undefined {
		const job = this.jobs.find((entry) => entry.deliveryId === deliveryId);
		if (!job) return undefined;
		const safeErr = sanitizeError(err);
		if (job.attempt >= this.maxAttempts) {
			this.dropJob(job, safeErr);
			return buildReceipt(job, false, true, now, safeErr);
		}
		const nextAttemptAt = now + this.backoffMs(job.attempt);
		job.status = "pending";
		job.updatedAt = new Date(now).toISOString();
		job.availableAt = new Date(nextAttemptAt).toISOString();
		delete job.leasedUntil;
		if (safeErr) job.lastError = safeErr;
		else delete job.lastError;
		this.pushDeliveryEvent(job, "nacked", safeErr);
		return buildReceipt(job, false, false, now, safeErr, job.availableAt);
	}

	snapshot(): DeliveryQueueSnapshot {
		return {
			size: this.jobs.length,
			pending: this.jobs.filter((job) => job.status === "pending").length,
			inFlight: this.jobs.filter((job) => job.status === "in-flight").length,
			maxSize: this.maxSize,
			maxAttempts: this.maxAttempts,
		};
	}

	private isClaimable(job: MutableDeliveryJob, now: number): boolean {
		if (job.status === "pending") return Date.parse(job.availableAt) <= now;
		return Boolean(job.leasedUntil && Date.parse(job.leasedUntil) <= now);
	}

	private backoffMs(attempt: number): number {
		return Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, attempt - 1));
	}

	private removeJob(deliveryId: string): MutableDeliveryJob | undefined {
		const idx = this.jobs.findIndex((entry) => entry.deliveryId === deliveryId);
		if (idx === -1) return undefined;
		const [job] = this.jobs.splice(idx, 1);
		return job;
	}

	private dropJob(job: MutableDeliveryJob, err: string | undefined): void {
		this.removeJob(job.deliveryId);
		if (err) job.lastError = err;
		else delete job.lastError;
		this.pushDeliveryEvent(job, "dropped", err);
	}

	private pushDeliveryEvent(
		job: DeliveryJob,
		status: Extract<SidecarEvent, { type: "delivery" }>["status"],
		err?: string,
	): void {
		const event: SidecarEventInput = {
			type: "delivery",
			deliveryId: job.deliveryId,
			targetId: job.targetId,
			status,
			attempt: job.attempt,
		};
		if (err) {
			this.events?.push({ ...event, err });
			return;
		}
		this.events?.push(event);
	}
}

function cloneJob(job: DeliveryJob): DeliveryJob {
	const clone: DeliveryJob = {
		deliveryId: job.deliveryId,
		targetId: job.targetId,
		private: job.private,
		session: structuredClone(job.session),
		payload: structuredClone(job.payload),
		attempt: job.attempt,
		maxAttempts: job.maxAttempts,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		availableAt: job.availableAt,
	};
	return {
		...clone,
		...(job.leasedUntil ? { leasedUntil: job.leasedUntil } : {}),
		...(job.lastError ? { lastError: job.lastError } : {}),
	};
}

function buildReceipt(
	job: DeliveryJob,
	ok: boolean,
	dropped: boolean,
	now: number,
	err?: string,
	nextAttemptAt?: string,
): DeliveryReceipt {
	const receipt: DeliveryReceipt = {
		deliveryId: job.deliveryId,
		targetId: job.targetId,
		attempt: job.attempt,
		ok,
		dropped,
		ts: new Date(now).toISOString(),
	};
	return {
		...receipt,
		...(err ? { err } : {}),
		...(nextAttemptAt ? { nextAttemptAt } : {}),
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
