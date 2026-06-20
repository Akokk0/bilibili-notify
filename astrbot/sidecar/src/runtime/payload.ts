import type { NotificationPayload, PayloadSegment } from "@bilibili-notify/internal";

export type SerializablePayloadSegment =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly mime: string; readonly base64: string }
	| { readonly type: "link"; readonly href: string; readonly title?: string }
	| { readonly type: "at-all" };

export type SerializableNotificationPayload =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "image";
			readonly image: { readonly mime: string; readonly base64: string };
			readonly caption?: string;
	  }
	| { readonly kind: "composite"; readonly segments: readonly SerializablePayloadSegment[] }
	| {
			readonly kind: "forward-images";
			readonly images: readonly {
				readonly url: string;
				readonly width?: number;
				readonly height?: number;
			}[];
			readonly forward: boolean;
	  };

export function serializeNotificationPayload(
	payload: NotificationPayload,
): SerializableNotificationPayload {
	if (payload.kind === "text") return payload;
	if (payload.kind === "forward-images") return payload;
	if (payload.kind === "image") {
		return {
			kind: "image",
			image: {
				mime: payload.image.mime,
				base64: payload.image.buffer.toString("base64"),
			},
			caption: payload.caption,
		};
	}
	return {
		kind: "composite",
		segments: payload.segments.map(serializeSegment),
	};
}

function serializeSegment(segment: PayloadSegment): SerializablePayloadSegment {
	if (segment.type === "image") {
		return {
			type: "image",
			mime: segment.mime,
			base64: segment.buffer.toString("base64"),
		};
	}
	return segment;
}
