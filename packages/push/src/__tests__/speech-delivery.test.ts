import { fail, type NotificationPayload, ok } from "@bilibili-notify/internal";
import { expect, it, vi } from "vite-plus/test";
import { createSpeechDelivery, type SpeechPolicy } from "../speech-delivery";

const original: NotificationPayload[] = [{ kind: "text", text: "点评\n链接" }];
const withoutText: NotificationPayload[] = [{ kind: "text", text: "链接" }];
const audio = {
	kind: "audio",
	audio: { buffer: Buffer.from("audio"), mime: "audio/silk" },
} as const;
const part = { text: "点评", withoutText };
function policy(mode: "voice" | "both"): SpeechPolicy {
	return {
		mode: () => mode,
		support: () => ok(),
		synthesize: vi.fn(async () => ok({ payload: audio })),
	};
}
it("synthesizes once across targets; preserves ordered messages in each mode", async () => {
	const p = policy("voice");
	p.mode = (id) => (id === "a" ? "both" : "voice");
	const send = vi.fn(async () => ok({ latencyMs: 1 }));
	const deliver = createSpeechDelivery(part, p);
	expect((await deliver("a", original, send)).map((r) => r.payload)).toEqual([...original, audio]);
	expect((await deliver("b", original, send)).map((r) => r.payload)).toEqual([
		...withoutText,
		audio,
	]);
	expect(p.synthesize).toHaveBeenCalledExactlyOnceWith("点评");
});
it.each(["unsupported", "indeterminate"] as const)(
	"audio %s preserves links and does not duplicate uncertain messages",
	async (code) => {
		const deliver = createSpeechDelivery(part, policy("voice"));
		const sent = await deliver("a", original, async (p) =>
			p.kind === "audio" ? fail(code, "reason") : ok({ latencyMs: 1 }),
		);
		expect(sent.map((row) => row.payload)).toEqual(
			code === "indeterminate"
				? [...withoutText, audio]
				: [...withoutText, audio, { kind: "text", text: "点评" }],
		);
	},
);
it("unsupported destination uses original once and incurs no synthesis", async () => {
	const p = policy("voice");
	p.support = () => fail("unsupported", "scope");
	const sent = await createSpeechDelivery(part, p)("a", original, async () => ok({ latencyMs: 1 }));
	expect(sent.map((r) => r.payload)).toEqual(original);
	expect(sent[0]?.speechNote).toBe("scope");
	expect(p.synthesize).not.toHaveBeenCalled();
});

it.each(["voice", "both"] as const)(
	"synthesis failure preserves one original in %s mode",
	async (mode) => {
		const p = policy(mode);
		p.synthesize = vi.fn(async () => fail("unavailable", "service failure"));
		const deliver = createSpeechDelivery(part, p);
		for (const target of ["a", "b"]) {
			const sent = await deliver(target, original, async () => ok({ latencyMs: 1 }));
			expect(sent).toMatchObject([{ payload: original[0], speechNote: "service failure" }]);
		}
		expect(p.synthesize).toHaveBeenCalledTimes(1);
	},
);
