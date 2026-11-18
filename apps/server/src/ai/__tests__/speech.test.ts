import { isSilk } from "silk-wasm";
import { describe, expect, it, vi } from "vite-plus/test";
import { fetchSpeech, speechPayload } from "../speech.js";

const settings = {
	baseUrl: "https://tts.example/v1/",
	apiKey: "test-key",
	model: "m",
	voice: "v",
	mode: "text" as const,
	byTarget: {},
};

function wav(seconds = 1) {
	const length = seconds * 16000 * 2;
	const data = Buffer.alloc(44 + length);
	data.write("RIFF");
	data.writeUInt32LE(data.length - 8, 4);
	data.write("WAVEfmt ", 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(16000, 24);
	data.writeUInt32LE(32000, 28);
	data.writeUInt16LE(2, 32);
	data.writeUInt16LE(16, 34);
	data.write("data", 36);
	data.writeUInt32LE(length, 40);
	return data;
}

describe("OpenAI-compatible speech", () => {
	it("requests only the supplied speech, previews WAV and encodes a real SILK message", async () => {
		const request = vi.fn(async () => new Response(wav()));
		const preview = await fetchSpeech(settings, "女仆原话", request);
		expect(preview.ok && preview.wav).toEqual(wav());
		expect(request).toHaveBeenCalledWith(
			"https://tts.example/v1/audio/speech",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
				body: JSON.stringify({ model: "m", voice: "v", input: "女仆原话", response_format: "wav" }),
			}),
		);
		const result = await speechPayload(settings, "女仆原话", request);
		expect(
			result.ok && result.payload.kind === "audio" && isSilk(result.payload.audio.buffer),
		).toBe(true);
	});
	it("rejects overlong text before requesting and rejects invalid or overlong audio", async () => {
		const request = vi.fn(async () => new Response(wav(61)));
		expect((await fetchSpeech(settings, "a".repeat(4097), request)).ok).toBe(false);
		expect(request).not.toHaveBeenCalled();
		expect((await fetchSpeech(settings, "a", request)).ok).toBe(false);
		expect((await fetchSpeech(settings, "a", async () => new Response("bad audio"))).ok).toBe(
			false,
		);
	});
});
