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

function wav(seconds = 1, bits = 16, format = 1, rate = 16000) {
	const frameBytes = bits / 8;
	const length = seconds * rate * frameBytes;
	const data = Buffer.alloc(44 + length);
	data.write("RIFF");
	data.writeUInt32LE(data.length - 8, 4);
	data.write("WAVEfmt ", 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(format, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(rate, 24);
	data.writeUInt32LE(rate * frameBytes, 28);
	data.writeUInt16LE(frameBytes, 32);
	data.writeUInt16LE(bits, 34);
	data.write("data", 36);
	data.writeUInt32LE(length, 40);
	return data;
}

describe("OpenAI-compatible speech", () => {
	it("previews and encodes a WAV with the streaming lengths returned by SiliconFlow", async () => {
		const mono = wav(3.44, 16, 1, 24000);
		const info = Buffer.alloc(130);
		info.write("LIST");
		info.writeUInt32LE(122, 4);
		info.write("INFOISFT", 8);
		info.writeUInt32LE(110, 16);
		const streamed = Buffer.concat([mono.subarray(0, 36), info, mono.subarray(36)]);
		streamed.writeUInt32LE(0xffffffa6, 4);
		streamed.writeUInt32LE(0xffffff00, 170);
		const request = async () => new Response(streamed);
		const preview = await fetchSpeech(settings, "试听", request);
		expect(preview.ok && preview.wav.readUInt32LE(4)).toBe(165286);
		expect(preview.ok && preview.wav.readUInt32LE(170)).toBe(165120);
		const sent = await speechPayload(settings, "推送", request);
		expect(sent.ok && isSilk(sent.payload.audio.buffer)).toBe(true);
	});
	it("rejects truncated frames and declared lengths that do not match a streaming header", async () => {
		const complete = wav();
		for (const buffer of [complete.subarray(0, -1), complete.subarray(0, 44)]) {
			const result = await fetchSpeech(settings, "试听", async () => new Response(buffer));
			expect(result.ok).toBe(false);
		}
		complete.writeUInt32LE(0xffffff00, 40);
		const result = await fetchSpeech(settings, "试听", async () => new Response(complete));
		expect(result.ok).toBe(false);
	});
	it("uses the received PCM frames when a streamed WAV starts with an empty WAV header", async () => {
		const complete = wav();
		complete.writeInt16LE(-1234, 44);
		const streamed = Buffer.from(complete);
		streamed.writeUInt32LE(36, 4);
		streamed.writeUInt32LE(0, 40);
		const request = async () => new Response(streamed);
		const preview = await fetchSpeech(settings, "试听", request);
		expect(preview.ok && preview.wav.equals(complete)).toBe(true);
		const sent = await speechPayload(settings, "推送", request);
		expect(sent.ok && isSilk(sent.payload.audio.buffer)).toBe(true);
	});
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
	it("distinguishes long recordings from unreadable responses and unsupported WAV formats", async () => {
		const overlong = wav(61);
		overlong.writeUInt32LE(0xffffffff, 40);
		const duration = await fetchSpeech(settings, "试听", async () => new Response(overlong));
		expect(duration).toMatchObject({ ok: false, message: expect.stringContaining("60") });

		const unreadable = await fetchSpeech(
			settings,
			"试听",
			async () =>
				new Response("not audio", {
					headers: { "Content-Type": "application/json; charset=utf-8" },
				}),
		);
		expect(unreadable).toMatchObject({
			ok: false,
			message: expect.stringContaining("application/json"),
		});

		const unsupported = wav(1, 8, 6); // A-law
		const format = await fetchSpeech(settings, "试听", async () => new Response(unsupported));
		expect(format).toMatchObject({ ok: false, message: expect.stringContaining("16000") });
	});
	it.each([
		[8, 1],
		[24, 1],
		[32, 3],
	])("previews and encodes %i-bit WAV (format %i)", async (bits, format) => {
		const audio = wav(1, bits, format);
		const request = async () => new Response(audio);
		const preview = await fetchSpeech(settings, "试听", request);
		expect(preview.ok && preview.wav.equals(audio)).toBe(true);
		const sent = await speechPayload(settings, "推送", request);
		expect(sent.ok && isSilk(sent.payload.audio.buffer)).toBe(true);
	});
});
