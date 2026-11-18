import {
	type AiSettings,
	fail,
	type NotificationPayload,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { encode } from "silk-wasm";
import { t } from "../i18n/index.js";

type Speech = AiSettings["speech"];
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 60;

// Some streaming WAV writers use 0xffffffff for lengths until the stream ends.
// Validate each chunk against the bytes actually received before invoking the encoder.
function validateWav(wav: Buffer): boolean {
	if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
		return false;
	let bytesPerSecond = 0;
	for (let pos = 12; pos + 8 <= wav.length; ) {
		const tag = wav.toString("ascii", pos, pos + 4);
		const size = wav.readUInt32LE(pos + 4);
		const start = pos + 8;
		if (tag === "data") {
			const length = size === 0xffffffff ? wav.length - start : size;
			if (
				!bytesPerSecond ||
				!length ||
				length > wav.length - start ||
				length > bytesPerSecond * MAX_SECONDS
			)
				return false;
			wav.writeUInt32LE(length, pos + 4);
			wav.writeUInt32LE(wav.length - 8, 4);
			return true;
		}
		if (size > wav.length - start) return false;
		if (tag === "fmt " && size >= 16) {
			const channels = wav.readUInt16LE(start + 2);
			const rate = wav.readUInt32LE(start + 4);
			if (
				wav.readUInt16LE(start) !== 1 ||
				wav.readUInt16LE(start + 14) !== 16 ||
				(channels !== 1 && channels !== 2) ||
				![8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(rate)
			)
				return false;
			bytesPerSecond = channels * rate * 2;
		}
		pos = start + size + (size % 2);
	}
	return false;
}

export async function fetchSpeech(
	settings: Speech,
	input: string,
	request = fetch,
): Promise<Result<{ wav: Buffer }>> {
	const { baseUrl, model, voice, apiKey } = settings;
	if (!baseUrl || !model || !voice) return fail("not_configured", t("speech.config"));
	if (!input.trim() || [...input].length > 4096) return fail("invalid", t("speech.length"));
	const signal = AbortSignal.timeout(30_000);
	try {
		const response = await request(`${baseUrl.replace(/\/+$/, "")}/audio/speech`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model, voice, input, response_format: "wav" }),
			redirect: "error",
			signal,
		});
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return fail("unavailable", t("speech.http", { status: response.status }), {
				upstreamCode: response.status,
			});
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.length;
				if (bytes > MAX_BYTES) {
					await reader.cancel();
					return fail("invalid", t("speech.audio"));
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		const wav = Buffer.concat(chunks, bytes);
		return validateWav(wav) ? ok({ wav }) : fail("invalid", t("speech.audio"));
	} catch {
		return fail(signal.aborted ? "timeout" : "unavailable", t("speech.network"));
	}
}

export async function speechPayload(
	settings: Speech,
	input: string,
	request = fetch,
): Promise<Result<{ payload: Extract<NotificationPayload, { kind: "audio" }> }>> {
	const speech = await fetchSpeech(settings, input, request);
	if (!speech.ok) return speech;
	try {
		const { data, duration } = await encode(speech.wav, 0);
		if (!data.length || duration <= 0 || duration > MAX_SECONDS * 1000)
			return fail("invalid", t("speech.audio"));
		return ok({
			payload: { kind: "audio", audio: { buffer: Buffer.from(data), mime: "audio/silk" } } as const,
		});
	} catch {
		return fail("invalid", t("speech.audio"));
	}
}
