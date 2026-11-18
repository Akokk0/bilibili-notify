import type {
	AiSettings,
	DeliveryResult,
	NotificationPayload,
	Result,
} from "@bilibili-notify/internal";
import { fail } from "@bilibili-notify/internal";

export interface Narration<T = NotificationPayload> {
	text: string;
	withoutText: T[];
}
export interface SpeechPolicy {
	mode(targetId: string): AiSettings["speech"]["mode"];
	support(targetId: string): Result;
	synthesize(
		text: string,
	): Promise<Result<{ payload: Extract<NotificationPayload, { kind: "audio" }> }>>;
}
type Send = (payload: NotificationPayload) => Promise<DeliveryResult>;
export interface MessageOutcome {
	payload: NotificationPayload;
	result?: DeliveryResult;
	speechNote?: string;
	speechText?: string;
}
export async function sendPayloads(
	payloads: NotificationPayload[],
	send: Send,
): Promise<MessageOutcome[]> {
	const outcomes: MessageOutcome[] = [];
	let stopped = false;
	for (const payload of payloads) {
		if (stopped) outcomes.push({ payload });
		else {
			const result = await send(payload);
			outcomes.push({ payload, result });
			stopped = !result.ok;
		}
	}
	return outcomes;
}

// One closure per generated passage. Even unsuccessful synthesis is shared for this delivery.
export function createSpeechDelivery(part: Narration, policy: SpeechPolicy) {
	let pending: ReturnType<SpeechPolicy["synthesize"]> | undefined;
	const synthesize = () => {
		pending ??= policy.synthesize(part.text);
		return pending;
	};
	return async (
		id: string,
		original: NotificationPayload[],
		send: Send,
	): Promise<MessageOutcome[]> => {
		const mode = policy.mode(id);
		if (mode === "text") return sendPayloads(original, send);
		const outcomes = mode === "both" ? await sendPayloads(original, send) : [];
		if (outcomes.some((row) => !row.result?.ok)) return outcomes;
		const support = policy.support(id);

		const speech = support.ok ? await synthesize() : support;
		if (!speech.ok) {
			if (mode === "voice") outcomes.push(...(await sendPayloads(original, send)));
			if (outcomes[0]) outcomes[0].speechNote = speech.message;
			return outcomes;
		}
		if (mode === "voice") outcomes.push(...(await sendPayloads(part.withoutText, send)));
		if (outcomes.some((row) => !row.result?.ok)) return outcomes;
		const attempt = await send(speech.payload);
		const result =
			!attempt.ok && attempt.code === "timeout" ? fail("indeterminate", attempt.message) : attempt;
		outcomes.push({ payload: speech.payload, result, speechText: part.text });
		// A recipient may already have received audio when the acknowledgement was lost.
		if (!result.ok && mode === "voice" && result.code !== "indeterminate") {
			const fallback: NotificationPayload = { kind: "text", text: part.text };
			outcomes.push({
				payload: fallback,
				result: await send(fallback),
				speechNote: result.message,
			});
		}
		return outcomes;
	};
}
