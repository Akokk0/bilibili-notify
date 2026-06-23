import { describe, expect, it } from "vite-plus/test";
import { CardLayoutSchema, DEFAULT_CARD_LAYOUT, normalizeCardLayout } from "./card-layout";

describe("DEFAULT_CARD_LAYOUT", () => {
	it("lists live blocks in the current visual order, all visible", () => {
		expect(DEFAULT_CARD_LAYOUT.live.map((b) => b.id)).toEqual([
			"cover",
			"title",
			"stats",
			"follower",
			"desc",
		]);
		expect(DEFAULT_CARD_LAYOUT.live.every((b) => b.visible)).toBe(true);
	});

	it("is accepted by CardLayoutSchema", () => {
		expect(() => CardLayoutSchema.parse(DEFAULT_CARD_LAYOUT)).not.toThrow();
	});
});

describe("normalizeCardLayout", () => {
	it("keeps known blocks' order and visibility, drops unknown, appends missing", () => {
		const stored = {
			...DEFAULT_CARD_LAYOUT,
			live: [
				{ id: "title", visible: false },
				{ id: "ghost", visible: true }, // unknown → dropped
				{ id: "cover", visible: true },
			],
		};

		const out = normalizeCardLayout(stored, DEFAULT_CARD_LAYOUT);

		// known blocks keep stored order + visibility
		expect(out.live.slice(0, 2)).toEqual([
			{ id: "title", visible: false },
			{ id: "cover", visible: true },
		]);
		// unknown block dropped
		expect(out.live.find((b) => b.id === "ghost")).toBeUndefined();
		// missing known blocks appended at end, default-visible
		expect(out.live.filter((b) => ["stats", "follower", "desc"].includes(b.id))).toEqual([
			{ id: "stats", visible: true },
			{ id: "follower", visible: true },
			{ id: "desc", visible: true },
		]);
	});
});
