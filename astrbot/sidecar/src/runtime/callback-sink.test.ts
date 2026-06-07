import type { NotificationPayload } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import {
	ASTRBOT_PUSH_ADAPTER,
	ASTRBOT_PUSH_TARGET,
	ASTRBOT_TARGET_ID,
	createCallbackSink,
} from "./callback-sink.js";
import { SidecarEventQueue } from "./event-queue.js";

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
		const sink = createCallbackSink({ events });
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
		const [event] = events.drain();
		expect(event).toMatchObject({
			type: "notification",
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
	});

	it("rejects unavailable targets without queueing an event", async () => {
		const events = new SidecarEventQueue();
		const sink = createCallbackSink({ events });

		const result = await sink.send("missing-target", { kind: "text", text: "hello" });

		expect(result.ok).toBe(false);
		expect(events.drain()).toEqual([]);
	});
});
