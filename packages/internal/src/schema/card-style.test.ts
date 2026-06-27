import { describe, expect, it } from "vite-plus/test";
import { CardStyleSchema } from "./common";
import { DEFAULT_CARD_STYLE } from "./globals";

describe("CardStyle background / glass knobs", () => {
	it("defaults backgroundImages to [] (gradient) and leaves glassOpacity unset", () => {
		const parsed = CardStyleSchema.parse(DEFAULT_CARD_STYLE);
		expect(parsed.backgroundImages).toEqual([]);
		expect(parsed.glassOpacity).toBeUndefined();
	});

	it("accepts an explicit backgroundImages list (rotation set) and glass opacity", () => {
		const parsed = CardStyleSchema.parse({
			...DEFAULT_CARD_STYLE,
			backgroundImages: ["a.png", "b.png"],
			glassOpacity: 0.5,
		});
		expect(parsed.backgroundImages).toEqual(["a.png", "b.png"]);
		expect(parsed.glassOpacity).toBe(0.5);
	});

	// 旧 globals.json 形态:带单值 `backgroundImage`、没有 `backgroundImages`。
	const { backgroundImages: _omit, ...LEGACY_BASE } = DEFAULT_CARD_STYLE;

	it("migrates a legacy single backgroundImage into the list", () => {
		const parsed = CardStyleSchema.parse({ ...LEGACY_BASE, backgroundImage: "card-bg/abc.png" });
		expect(parsed.backgroundImages).toEqual(["card-bg/abc.png"]);
	});

	it("migrates a legacy empty backgroundImage to []", () => {
		const parsed = CardStyleSchema.parse({ ...LEGACY_BASE, backgroundImage: "" });
		expect(parsed.backgroundImages).toEqual([]);
	});

	it("an explicit backgroundImages list wins over a stale legacy backgroundImage", () => {
		const parsed = CardStyleSchema.parse({
			...LEGACY_BASE,
			backgroundImage: "old.png",
			backgroundImages: ["new.png"],
		});
		expect(parsed.backgroundImages).toEqual(["new.png"]);
	});

	it("rejects glassOpacity outside 0..1", () => {
		expect(() => CardStyleSchema.parse({ ...DEFAULT_CARD_STYLE, glassOpacity: 1.5 })).toThrow();
	});
});
