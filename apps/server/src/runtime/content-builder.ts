import type { PayloadSegment } from "@bilibili-notify/internal";
import type { LiveContentBuilder } from "@bilibili-notify/live";

/**
 * Standalone {@link LiveContentBuilder} — produces tagged plain objects that
 * the {@link buildPushLike} adapter unpacks into a NotificationPayload.
 *
 * Each fragment is one of:
 *   - `{ kind: "text"; text }`
 *   - `{ kind: "image-url"; url }`
 *   - `{ kind: "image-buf"; buffer; mime }`
 *   - `{ kind: "atAll" }`
 *   - `{ kind: "message"; segments: SegmentValue[] }`
 *
 * The koishi side wraps koishi's `h(...)` factory; we don't have koishi here,
 * so we keep the data structure flat and decode it on the way out to the sink.
 */
export type SegmentValue =
	| { kind: "text"; text: string }
	| { kind: "image-url"; url: string }
	| { kind: "image-buf"; buffer: Buffer; mime: string }
	| { kind: "atAll" }
	| { kind: "message"; segments: SegmentValue[] };

export const standaloneContentBuilder: LiveContentBuilder = {
	text(text: string): SegmentValue {
		return { kind: "text", text };
	},
	image(source: string | Buffer, mime?: string): SegmentValue {
		if (typeof source === "string") return { kind: "image-url", url: source };
		return { kind: "image-buf", buffer: source, mime: mime ?? "image/jpeg" };
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
		return value.length > 0 ? [{ type: "text", text: value }] : [];
	}
	const v = value as SegmentValue;
	switch (v.kind) {
		case "text":
			return v.text.length > 0 ? [{ type: "text", text: v.text }] : [];
		case "image-url":
			return [{ type: "link", href: v.url }];
		case "image-buf":
			return [{ type: "image", buffer: v.buffer, mime: v.mime }];
		case "atAll":
			return [{ type: "text", text: "@全体成员 " }];
		case "message":
			return v.segments.flatMap((s) => segmentToPayload(s));
	}
}
