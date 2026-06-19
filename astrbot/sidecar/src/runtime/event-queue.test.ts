import { describe, expect, it } from "vite-plus/test";
import { ASTRBOT_PUSH_TARGET } from "./callback-sink.js";
import { SidecarDeliveryQueue, SidecarEventQueue } from "./event-queue.js";

describe("SidecarEventQueue", () => {
	it("keeps the newest events and filters by cursor", () => {
		const queue = new SidecarEventQueue({ maxSize: 2 });

		const first = queue.push({ type: "auth-lost" });
		const second = queue.push({ type: "auth-restored" });
		const third = queue.push({ type: "engine-error", source: "dynamic-engine", message: "boom" });

		expect(first.id).toBe(1);
		expect(second.id).toBe(2);
		expect(third.id).toBe(3);
		expect(queue.drain(0).map((event) => event.id)).toEqual([2, 3]);
		expect(queue.drain(2).map((event) => event.id)).toEqual([3]);
		expect(queue.snapshot()).toEqual({ nextId: 4, size: 2 });
	});
});

describe("SidecarDeliveryQueue", () => {
	it("claims queued jobs, acks receipts and emits delivery events", () => {
		const events = new SidecarEventQueue();
		const queue = new SidecarDeliveryQueue({ events, leaseMs: 100, maxAttempts: 2 });
		const job = queue.enqueue(
			{
				target: ASTRBOT_PUSH_TARGET,
				private: false,
				payload: { kind: "text", text: "hello" },
			},
			1_000,
		);

		const [claimed] = queue.claim({ now: 1_000 });

		expect(claimed).toMatchObject({
			deliveryId: job.deliveryId,
			targetId: ASTRBOT_PUSH_TARGET.id,
			attempt: 1,
			leasedUntil: new Date(1_100).toISOString(),
		});
		expect(queue.ack(job.deliveryId, 1_010)).toMatchObject({
			deliveryId: job.deliveryId,
			ok: true,
			dropped: false,
		});
		expect(queue.snapshot()).toMatchObject({ size: 0, pending: 0, inFlight: 0 });
		expect(events.drain().map((event) => event.type === "delivery" && event.status)).toEqual([
			"queued",
			"acked",
		]);
	});

	it("retries nacked jobs with capped attempts and then drops them", () => {
		const events = new SidecarEventQueue();
		const queue = new SidecarDeliveryQueue({
			events,
			maxAttempts: 2,
			baseBackoffMs: 100,
			leaseMs: 50,
		});
		const job = queue.enqueue(
			{
				target: ASTRBOT_PUSH_TARGET,
				private: true,
				payload: { kind: "text", text: "hello" },
			},
			1_000,
		);

		expect(queue.claim({ now: 1_000 })[0]?.attempt).toBe(1);
		expect(queue.nack(job.deliveryId, "send failed", 1_010)).toMatchObject({
			ok: false,
			dropped: false,
			nextAttemptAt: new Date(1_110).toISOString(),
		});
		expect(queue.claim({ now: 1_109 })).toEqual([]);
		expect(queue.claim({ now: 1_110 })[0]).toMatchObject({ attempt: 2, lastError: "send failed" });
		expect(queue.nack(job.deliveryId, "still failed", 1_120)).toMatchObject({
			ok: false,
			dropped: true,
			err: "still failed",
		});
		expect(queue.snapshot().size).toBe(0);
		expect(
			events
				.drain()
				.filter((event) => event.type === "delivery")
				.map((event) => event.status),
		).toEqual(["queued", "nacked", "dropped"]);
	});

	it("does not evict in-flight jobs when the queue is full", () => {
		const queue = new SidecarDeliveryQueue({ maxSize: 1, leaseMs: 100 });
		const first = queue.enqueue({
			target: ASTRBOT_PUSH_TARGET,
			private: false,
			payload: { kind: "text", text: "first" },
		});
		expect(queue.claim()[0]?.deliveryId).toBe(first.deliveryId);

		expect(() =>
			queue.enqueue({
				target: ASTRBOT_PUSH_TARGET,
				private: false,
				payload: { kind: "text", text: "second" },
			}),
		).toThrow("delivery queue is full");
		expect(queue.ack(first.deliveryId)).toMatchObject({ ok: true });
	});

	it("redacts sensitive details from nack receipts and delivery events", () => {
		const events = new SidecarEventQueue();
		const queue = new SidecarDeliveryQueue({ events });
		const job = queue.enqueue({
			target: ASTRBOT_PUSH_TARGET,
			private: false,
			payload: { kind: "text", text: "hello" },
		});
		queue.claim();

		expect(queue.nack(job.deliveryId, "Bearer abc token=secret")?.err).toBe(
			"Bearer [REDACTED] token=[REDACTED]",
		);
		const deliveryEvents = events.drain().filter((event) => event.type === "delivery");
		expect(deliveryEvents[deliveryEvents.length - 1]).toMatchObject({
			type: "delivery",
			status: "nacked",
			err: "Bearer [REDACTED] token=[REDACTED]",
		});
	});
});
