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
