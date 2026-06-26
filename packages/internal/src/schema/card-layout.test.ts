import { describe, expect, it } from "vite-plus/test";
import {
	type CardBlock,
	CardLayoutSchema,
	DEFAULT_CARD_LAYOUT,
	DIVIDER_TYPE,
	normalizeCardLayout,
} from "./card-layout";

describe("DEFAULT_CARD_LAYOUT", () => {
	it("lists live content blocks in order with an explicit divider, all visible", () => {
		expect(DEFAULT_CARD_LAYOUT.live.map((b) => b.type)).toEqual([
			"cover",
			"header",
			"title",
			DIVIDER_TYPE,
			"stats",
			"follower",
			"desc",
		]);
		expect(DEFAULT_CARD_LAYOUT.live.every((b) => b.visible)).toBe(true);
	});

	it("lists dynamic content blocks with additional as its own block, no standalone topic", () => {
		expect(DEFAULT_CARD_LAYOUT.dynamic.map((b) => b.type)).toEqual([
			"header",
			DIVIDER_TYPE,
			"content",
			"additional",
			DIVIDER_TYPE,
			"stats",
		]);
	});

	it("gives every block a type; content blocks use id===type", () => {
		const content = DEFAULT_CARD_LAYOUT.live.filter((b) => b.type !== DIVIDER_TYPE);
		expect(content.every((b) => b.id === b.type)).toBe(true);
	});

	it("is accepted by CardLayoutSchema", () => {
		expect(() => CardLayoutSchema.parse(DEFAULT_CARD_LAYOUT)).not.toThrow();
	});

	it("migrates v1 blocks (no type) by backfilling type from id", () => {
		const v1 = {
			...DEFAULT_CARD_LAYOUT,
			live: [{ id: "cover", visible: true }],
		};
		const parsed = CardLayoutSchema.parse(v1);
		expect(parsed.live[0]).toMatchObject({ id: "cover", type: "cover", visible: true });
	});
});

describe("normalizeCardLayout", () => {
	it("keeps known content blocks (by type) + all dividers, drops unknown, appends missing", () => {
		const stored: CardBlock[] = [
			{ id: "title", type: "title", visible: false },
			{ id: "divider-x", type: DIVIDER_TYPE, visible: true },
			{ id: "ghost", type: "ghost", visible: true }, // unknown content type → dropped
			{ id: "cover", type: "cover", visible: true },
		];
		const out = normalizeCardLayout({ ...DEFAULT_CARD_LAYOUT, live: stored }, DEFAULT_CARD_LAYOUT);

		// known content + dividers kept in stored order
		expect(out.live.slice(0, 3).map((b) => b.id)).toEqual(["title", "divider-x", "cover"]);
		expect(out.live.find((b) => b.type === "ghost")).toBeUndefined();
		// stored visibility preserved
		expect(out.live.find((b) => b.type === "title")?.visible).toBe(false);
		// missing known content types appended
		expect(out.live.map((b) => b.type)).toContain("stats");
		expect(out.live.map((b) => b.type)).toContain("follower");
	});

	it("drops a standalone topic block from dynamic layouts saved before v5", () => {
		const stored = {
			...DEFAULT_CARD_LAYOUT,
			version: 4,
			dynamic: [
				{ id: "header", type: "header", visible: true },
				{ id: "topic", type: "topic", visible: true },
				{ id: "content", type: "content", visible: true },
			],
		};
		const out = normalizeCardLayout(stored, DEFAULT_CARD_LAYOUT);
		expect(out.dynamic.map((b) => b.type)).not.toContain("topic");
	});

	it("appends the additional block to dynamic layouts saved before v4", () => {
		const stored = {
			...DEFAULT_CARD_LAYOUT,
			version: 3,
			dynamic: [
				{ id: "header", type: "header", visible: true },
				{ id: "content", type: "content", visible: true },
				{ id: "stats", type: "stats", visible: true },
			],
		};
		const out = normalizeCardLayout(stored, DEFAULT_CARD_LAYOUT);
		expect(out.dynamic.map((b) => b.type)).toContain("additional");
	});

	it("preserves per-block margins on kept blocks", () => {
		const stored: CardBlock[] = [{ id: "cover", type: "cover", visible: true, marginTop: 12 }];
		const out = normalizeCardLayout({ ...DEFAULT_CARD_LAYOUT, live: stored }, DEFAULT_CARD_LAYOUT);
		expect(out.live.find((b) => b.type === "cover")?.marginTop).toBe(12);
	});

	it("backfills spacing from defaults for pre-v3 blocks that have none", () => {
		// 老版式(无间距值)的 header → 应从默认回填(header 默认 上14/下10)。
		const stored = {
			...DEFAULT_CARD_LAYOUT,
			version: 2,
			live: [{ id: "header", type: "header", visible: true }],
		};
		const out = normalizeCardLayout(stored, DEFAULT_CARD_LAYOUT);
		const header = out.live.find((b) => b.type === "header");
		expect(header?.marginTop).toBe(14);
		expect(header?.marginBottom).toBe(10);
	});

	it("does not backfill spacing for current-version blocks (respects explicit 0)", () => {
		const stored = {
			...DEFAULT_CARD_LAYOUT,
			live: [{ id: "header", type: "header", visible: true }], // version stays current
		};
		const out = normalizeCardLayout(stored, DEFAULT_CARD_LAYOUT);
		expect(out.live.find((b) => b.type === "header")?.marginTop).toBeUndefined();
	});
});
