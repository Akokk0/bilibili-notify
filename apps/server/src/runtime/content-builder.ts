import type { PayloadSegment } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "../live/content-builder.js";

/**
 * The server's {@link LiveContentBuilder} — produces tagged plain objects that
 * the {@link buildPushLike} adapter unpacks into a NotificationPayload.
 *
 * Each fragment is one of:
 *   - `{ kind: "text"; text }`
 *   - `{ kind: "image-buf"; buffer; mime }`
 *   - `{ kind: "atAll" }`
 *   - `{ kind: "message"; segments: SegmentValue[] }`
 *
 * No framework message factory here: we keep the data structure flat and decode
 * it on the way out to the sink.
 */
export type SegmentValue =
	| { kind: "text"; text: string }
	| { kind: "image-buf"; buffer: Buffer; mime: string }
	| { kind: "atAll" }
	| { kind: "message"; segments: SegmentValue[] };

export const segmentContentBuilder: LiveContentBuilder = {
	text(text: string): SegmentValue {
		return { kind: "text", text };
	},
	image(buffer: Buffer, mime: string): SegmentValue {
		return { kind: "image-buf", buffer, mime };
	},
	atAll(): SegmentValue {
		return { kind: "atAll" };
	},
	message(segments: Array<unknown>): SegmentValue {
		const filtered = segments.filter((s): s is SegmentValue => s != null) as SegmentValue[];
		return { kind: "message", segments: filtered };
	},
};

/** Flatten a SegmentValue tree into a flat list of {@link PayloadSegment}s. */
export function segmentToPayload(value: unknown): PayloadSegment[] {
	if (value == null) return [];
	if (typeof value === "string") {
		return value.length > 0 ? [{ kind: "text", text: value }] : [];
	}
	const v = value as SegmentValue;
	switch (v.kind) {
		case "text":
			return v.text.length > 0 ? [{ kind: "text", text: v.text }] : [];
		case "image-buf":
			return [{ kind: "image", buffer: v.buffer, mime: v.mime }];
		case "atAll":
			return [{ kind: "text", text: "@全体成员 " }];
		case "message":
			return v.segments.flatMap((s) => segmentToPayload(s));
	}
}
