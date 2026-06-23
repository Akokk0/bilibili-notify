import { describe, expect, it } from "vite-plus/test";
import { CardStyleSchema } from "./common";
import { DEFAULT_CARD_STYLE } from "./globals";

describe("CardStyle background / glass knobs", () => {
	it("defaults backgroundImage to empty (gradient) and leaves glassOpacity unset", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.backgroundImage).toBe("");
		expect(parsed.glassOpacity).toBeUndefined();
	});

	it("accepts a custom background image and glass opacity", () => {
		const parsed = CardStyleSchema.parse({
			...DEFAULT_CARD_STYLE,
			backgroundImage: "card-bg/abc.png",
			glassOpacity: 0.5,
		});
		expect(parsed.backgroundImage).toBe("card-bg/abc.png");
		expect(parsed.glassOpacity).toBe(0.5);
	});

	it("rejects glassOpacity outside 0..1", () => {
		expect(() => CardStyleSchema.parse({ ...DEFAULT_CARD_STYLE, glassOpacity: 1.5 })).toThrow();
	});
});
