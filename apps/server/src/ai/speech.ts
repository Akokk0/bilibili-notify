import {
	type AiSettings,
	fail,
	isDeepSeekSpeechEndpoint,
	type NotificationPayload,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { encode } from "silk-wasm";
import { t } from "../i18n/index.js";

type Speech = AiSettings["speech"];
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 60;

// A streaming writer may send an empty RIFF header before appending the actual PCM frames.
function readSpeechWav(wav: Buffer, contentType: string | null): Result<{ wav: Buffer }> {
	if (wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") {
		const type = contentType?.split(";", 1)[0]?.trim().toLowerCase() || "—";
		return fail("invalid", t("speech.notWav", { type }));
	}
	let bytesPerSecond = 0;
	let frameBytes = 0;
	for (let pos = 12; pos + 8 <= wav.length; ) {
		const tag = wav.toString("latin1", pos, pos + 4);
		const size = wav.readUInt32LE(pos + 4);
		const start = pos + 8;
		if (tag === "data") {
			const riffSize = wav.readUInt32LE(4);
			const emptyHeader =
				size === 0 && (riffSize === start - 8 || riffSize === 0 || riffSize === 0xffffffff);
			// Some encoders reserve 0xffffff00 bytes for data and include that placeholder in RIFF size.
			const reservedLength = size === 0xffffff00 && riffSize === (size + start - 8) >>> 0;
			const length =
				size === 0xffffffff || emptyHeader || reservedLength ? wav.length - start : size;
			if (!frameBytes || !length || length % frameBytes !== 0 || length > wav.length - start) break;
			if (length > bytesPerSecond * MAX_SECONDS) return fail("invalid", t("speech.duration"));
			const audio = wav.subarray(0, start + length + (length % 2));
			audio.writeUInt32LE(length, pos + 4);
			audio.writeUInt32LE(audio.length - 8, 4);
			return ok({ wav: audio });
		}
		if (size > wav.length - start) break;
		if (tag === "fmt " && size >= 16) {
			const channels = wav.readUInt16LE(start + 2);
			const rate = wav.readUInt32LE(start + 4);
			const format = wav.readUInt16LE(start);
			const bits = wav.readUInt16LE(start + 14);
			const supportedPcm =
				(format === 1 && [8, 16, 24].includes(bits)) || (format === 3 && bits === 32);
			if (
				!supportedPcm ||
				(channels !== 1 && channels !== 2) ||
				![8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(rate)
			)
				return fail("invalid", t("speech.format", { format, bits, rate, channels }));
			frameBytes = channels * (bits / 8);
			if (wav.readUInt16LE(start + 12) !== frameBytes) break;
			bytesPerSecond = frameBytes * rate;
		}
		pos = start + size + (size % 2);
	}
	return fail("invalid", t("speech.audio"));
}

export async function fetchSpeech(
	settings: Speech,
	input: string,
	request = fetch,
): Promise<Result<{ wav: Buffer }>> {
	const { baseUrl, model, voice, apiKey } = settings;
	const native = isDeepSeekSpeechEndpoint(baseUrl);
	if (native && (!apiKey.trim() || !["stella", "tide"].includes(voice)))
		return fail("not_configured", t("speech.nativeConfig"));
	if (!baseUrl || (!native && !model) || !voice) return fail("not_configured", t("speech.config"));
	if (!input.trim() || [...input].length > 4096) return fail("invalid", t("speech.length"));
	const signal = AbortSignal.timeout(30_000);
	try {
		const endpoint = native
			? "https://api.deepseek.com/v1/tools/tts"
			: `${baseUrl.replace(/\/+$/, "")}/audio/speech`;
		const response = await request(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(
				native
					? { text: input, voice_id: voice, format: "wav" }
					: { model, voice, input, response_format: "wav" },
			),
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
					return fail("invalid", t("speech.size"));
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return readSpeechWav(Buffer.concat(chunks, bytes), response.headers.get("content-type"));
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
		if (duration > MAX_SECONDS * 1000) return fail("invalid", t("speech.duration"));
		if (!data.length || duration <= 0) return fail("invalid", t("speech.encode"));
		return ok({
			payload: { kind: "audio", audio: { buffer: Buffer.from(data), mime: "audio/silk" } } as const,
		});
	} catch {
		return fail("invalid", t("speech.encode"));
	}
}
