import type { NotificationPayload } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import {
	ASTRBOT_PUSH_ADAPTER,
	ASTRBOT_PUSH_TARGET,
	ASTRBOT_TARGET_ID,
	createCallbackSink,
} from "./callback-sink.js";
import { SidecarDeliveryQueue, SidecarEventQueue } from "./event-queue.js";

describe("createCallbackSink", () => {
	it("uses the canonical astrbot adapter and target", () => {
		expect(ASTRBOT_PUSH_ADAPTER).toMatchObject({
			platform: "astrbot",
			config: {},
		});
		expect(ASTRBOT_PUSH_TARGET).toMatchObject({
			adapterId: ASTRBOT_PUSH_ADAPTER.id,
			platform: "astrbot",
			session: { unified_msg_origin: "astrbot://default" },
		});
	});

	it("serializes payloads into queue events", async () => {
		const events = new SidecarEventQueue();
		const deliveries = new SidecarDeliveryQueue({ events });
		// 显式提供 target：C4 后 sink 不再隐式回退到 ASTRBOT_PUSH_TARGET，需绑定真实 target 才投递。
		const sink = createCallbackSink({ events, deliveries, target: ASTRBOT_PUSH_TARGET });
		const payload = {
			kind: "composite",
			segments: [
				{ type: "text", text: "hello" },
				{ type: "image", mime: "image/png", buffer: Buffer.from("astrbot") },
				{ type: "link", href: "https://example.com", title: "example" },
				{ type: "at-all" },
			],
		} satisfies NotificationPayload;

		const result = await sink.sendPrivate(ASTRBOT_TARGET_ID, payload);

		expect(result.ok).toBe(true);
		const [job] = deliveries.claim();
		expect(job).toMatchObject({
			targetId: ASTRBOT_TARGET_ID,
			private: true,
			payload: {
				kind: "composite",
				segments: [
					{ type: "text", text: "hello" },
					{ type: "image", mime: "image/png", base64: Buffer.from("astrbot").toString("base64") },
					{ type: "link", href: "https://example.com", title: "example" },
					{ type: "at-all" },
				],
			},
		});
		const notification = events.drain().find((event) => event.type === "notification");
		expect(notification).toMatchObject({
			type: "notification",
			deliveryId: job?.deliveryId,
			targetId: ASTRBOT_TARGET_ID,
			private: true,
		});
	});

	it("resolves AstrBot targets from a dynamic target provider", async () => {
		const events = new SidecarEventQueue();
		const deliveries = new SidecarDeliveryQueue({ events });
		const target = {
			...ASTRBOT_PUSH_TARGET,
			id: "33333333-3333-4333-8333-333333333333",
			name: "绑定群聊",
			scope: "group" as const,
			session: {
				unified_msg_origin: "aiocqhttp:GroupMessage:123456",
				platform: "aiocqhttp",
				messageType: "group",
				sessionId: "123456",
			},
		};
		const sink = createCallbackSink({ events, deliveries, targets: () => [target] });

		const result = await sink.send(target.id, { kind: "text", text: "hello" });

		expect(result.ok).toBe(true);
		expect(sink.resolve(target.id)).toEqual(target);
		expect(deliveries.claim()[0]).toMatchObject({
			targetId: target.id,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:123456" },
		});
		expect(
			events.drain().some((event) => event.type === "notification" && event.targetId === target.id),
		).toBe(true);
	});

	it("does not fall back to the hidden AstrBot target without a provider", async () => {
		const events = new SidecarEventQueue();
		const deliveries = new SidecarDeliveryQueue({ events });
		const sink = createCallbackSink({ events, deliveries });

		const result = await sink.send(ASTRBOT_TARGET_ID, { kind: "text", text: "hello" });

		expect(sink.resolve(ASTRBOT_TARGET_ID)).toBeUndefined();
		expect(sink.isAvailable(ASTRBOT_TARGET_ID)).toBe(false);
		expect(result).toMatchObject({
			ok: false,
			err: `target unavailable: ${ASTRBOT_TARGET_ID}`,
		});
		expect(deliveries.claim()).toEqual([]);
		expect(events.drain()).toEqual([]);
	});

	it("rejects unavailable targets without queueing an event", async () => {
		const events = new SidecarEventQueue();
		const deliveries = new SidecarDeliveryQueue({ events });
		const sink = createCallbackSink({ events, deliveries });

		const result = await sink.send("missing-target", { kind: "text", text: "hello" });

		expect(result.ok).toBe(false);
		expect(events.drain()).toEqual([]);
	});
});
