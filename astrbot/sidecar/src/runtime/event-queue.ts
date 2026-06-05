import type { DeliveryResult } from "@bilibili-notify/internal";
import type { SerializableNotificationPayload } from "./payload.js";

export type SidecarEvent =
	| {
			readonly id: number;
			readonly ts: string;
			readonly type: "notification";
			readonly targetId: string;
			readonly private: boolean;
			readonly payload: SerializableNotificationPayload;
			readonly result: DeliveryResult;
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
