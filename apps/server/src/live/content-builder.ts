import type { MessageLayoutSegment } from "@bilibili-notify/internal";

/**
 * Platform-neutral content-builder injection point.
 *
 * live-engine never touches a concrete message format: it builds fragments through
 * a `LiveContentBuilder` provided by the host, and the standalone runtime maps each
 * call onto its own `NotificationPayload` shape.
 *
 * Each method returns an opaque `unknown` — the engine never inspects the
 * result; it only passes the value back to the adapter via `PushLike`.
 */
export interface LiveContentBuilder {
	/** Wrap a plain text run. Equivalent to `h.text(text)`. */
	text(text: string): unknown;
	/**
	 * Wrap a remote image URL or in-memory buffer.
	 * `mime` is provided when `source` is a `Buffer`.
	 */
	image(source: string | Buffer, mime?: string): unknown;
	/** Equivalent to `h.at("all")` (i.e. mention everyone in a group / channel). */
	atAll(): unknown;
	/**
	 * Compose a message with an array of segments (text / image / atAll fragments
	 * created by this same builder, plus `null` / `undefined` placeholders that
	 * are dropped). Equivalent to `h("message", segments)`.
	 */
	message(segments: Array<unknown>): unknown;
}

/**
 * 把中立的消息段翻成内容构造口的一条消息(直播卡、醒目留言等凡是「段 → 内容」的地方共用这一份)。
 * 单个图段直接是 `image`(与醒目留言一直以来的形状一致,载荷里本来就会收成图);其余一律包进 `message`。
 */
export function segmentsToContent(
	builder: LiveContentBuilder,
	segments: readonly MessageLayoutSegment[],
): unknown {
	const [only] = segments;
	if (segments.length === 1 && only?.kind === "image") {
		return builder.image(only.buffer, only.mime);
	}
	return builder.message(
		segments.map((s) =>
			s.kind === "image" ? builder.image(s.buffer, s.mime) : builder.text(s.text),
		),
	);
}
