/**
 * 卡片皮肤包(ADR-0014)的 schema 契约。钉的是**什么样的包能进门**:块目录、网格边界、
 * 自定义块的口子、以及默认皮肤自己得先过自己的门。清洗(CSS / HTML)不在这层 —— 这里
 * 只量长度,内容归 server 的清洗器。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_KINDS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SCHEMA_VERSION,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	parseCardSkin,
} from "./card-skin";

function minimal(over: Partial<CardSkinManifest> = {}): unknown {
	return {
		schemaVersion: CARD_SKIN_SCHEMA_VERSION,
		dataVersion: 1,
		name: "测试皮肤",
		cards: {
			live: {
				width: 600,
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				],
			},
		},
		...over,
	};
}

/** n 个等分列 / n 个定宽列 —— `columns` 的用例全靠这两个拼。 */
const FR = (n: number, fr = 1) => Array.from({ length: n }, () => ({ fr }));
const PX = (n: number, px: number) => Array.from({ length: n }, () => ({ px }));

function ok(raw: unknown): CardSkinManifest {
	const r = parseCardSkin(raw);
	if (!r.ok) throw new Error(r.errors.join("\n"));
	return r.manifest;
}

function errorsOf(raw: unknown): string {
	const r = parseCardSkin(raw);
	if (r.ok) throw new Error("本该拒收却过了");
	return r.errors.join("\n");
}

describe("parseCardSkin", () => {
	it("接受最小的合法包,缺的卡种不补", () => {
		const m = ok(minimal());
		expect(m.name).toBe("测试皮肤");
		expect(m.cards.live?.blocks).toHaveLength(1);
		expect(m.cards.dynamic).toBeUndefined();
	});

	it("schemaVersion 不对整包拒收", () => {
		expect(errorsOf(minimal({ schemaVersion: 99 as never }))).toMatch(/schemaVersion/);
	});

	it("内置块名必须在该卡种的目录里", () => {
		const raw = minimal();
		(raw as { cards: { live: { blocks: { builtin: string }[] } } }).cards.live.blocks[0].builtin =
			"amount";
		expect(errorsOf(raw)).toMatch(/amount/);
	});

	it("块 id 同一张卡里不许重复", () => {
		const raw = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{ id: "a", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
						{ id: "a", kind: "builtin", builtin: "title", grid: { row: 2, column: 1, span: 12 } },
					],
				},
			},
		});
		expect(errorsOf(raw)).toMatch(/id/);
	});

	it("网格:列 + 跨度不能越过 12 列", () => {
		const raw = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{ id: "a", kind: "builtin", builtin: "cover", grid: { row: 1, column: 7, span: 7 } },
					],
				},
			},
		});
		expect(errorsOf(raw)).toMatch(/12/);
	});

	it("卡宽有上下限", () => {
		const narrow = minimal({ cards: { live: { width: 10, blocks: [] } } });
		expect(errorsOf(narrow)).toMatch(/width/);
		const wide = minimal({
			cards: { live: { width: CARD_SKIN_LIMITS.width.max + 1, blocks: [] } },
		});
		expect(errorsOf(wide)).toMatch(/width/);
	});

	it("自定义块必须带 html,内置块不许带 html", () => {
		const custom = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [{ id: "c", kind: "custom", grid: { row: 1, column: 1, span: 12 } } as never],
				},
			},
		});
		expect(errorsOf(custom)).toMatch(/html/);
		const builtin = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "b",
							kind: "builtin",
							builtin: "cover",
							html: "<p>x</p>",
							grid: { row: 1, column: 1, span: 12 },
						} as never,
					],
				},
			},
		});
		expect(errorsOf(builtin)).toMatch(/html/);
	});

	it("自定义块的 html 与每块的 css 只量长度,不看内容", () => {
		const raw = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "c",
							kind: "custom",
							html: "x".repeat(CARD_SKIN_LIMITS.maxHtmlBytes + 1),
							grid: { row: 1, column: 1, span: 12 },
						},
					],
				},
			},
		});
		expect(errorsOf(raw)).toMatch(/html/);
		const css = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "b",
							kind: "builtin",
							builtin: "cover",
							css: "a".repeat(CARD_SKIN_LIMITS.maxCssBytes + 1),
							grid: { row: 1, column: 1, span: 12 },
						},
					],
				},
			},
		});
		expect(errorsOf(css)).toMatch(/css/);
	});

	it("showIf 只认字段路径,且必须是该卡种契约里有的字段", () => {
		const bad = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "a",
							kind: "builtin",
							builtin: "cover",
							showIf: "1 + 1",
							grid: { row: 1, column: 1, span: 12 },
						},
					],
				},
			},
		});
		expect(errorsOf(bad)).toMatch(/showIf/);
		const unknown = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "a",
							kind: "builtin",
							builtin: "cover",
							showIf: "sc.price",
							grid: { row: 1, column: 1, span: 12 },
						},
					],
				},
			},
		});
		expect(errorsOf(unknown)).toMatch(/sc\.price/);
		const good = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "a",
							kind: "builtin",
							builtin: "cover",
							showIf: "live.hasCover",
							grid: { row: 1, column: 1, span: 12 },
						},
					],
				},
			},
		});
		expect(ok(good).cards.live?.blocks[0].showIf).toBe("live.hasCover");
	});

	it("columns:恰好 12 项,等分与定宽混着写", () => {
		const columns = [...FR(8), ...PX(4, 43.75)];
		const m = ok(minimal({ cards: { live: { width: 600, columns, blocks: [] } } }));
		expect(m.cards.live?.columns).toHaveLength(CARD_SKIN_LIMITS.columns);
		expect(m.cards.live?.columns?.[7]).toEqual({ fr: 1 });
		expect(m.cards.live?.columns?.[11]).toEqual({ px: 43.75 });
	});

	it("columns 少一项 / 多一项都拒收(列数是固定的)", () => {
		expect(
			errorsOf(minimal({ cards: { live: { width: 600, columns: FR(11), blocks: [] } } })),
		).toMatch(/columns/);
		expect(
			errorsOf(minimal({ cards: { live: { width: 600, columns: FR(13), blocks: [] } } })),
		).toMatch(/columns/);
	});

	it("定宽列合计吃满卡宽 → 拒收(等分列没地方站)", () => {
		const full = minimal({ cards: { live: { width: 600, columns: PX(12, 50), blocks: [] } } });
		expect(errorsOf(full)).toMatch(/卡宽/);
		// 差 1px 就过:门槛是「≥ 卡宽」,不是「快满了」。
		const spare = minimal({
			cards: { live: { width: 600, columns: [...PX(11, 50), ...FR(1)], blocks: [] } },
		});
		expect(ok(spare).cards.live?.columns).toHaveLength(CARD_SKIN_LIMITS.columns);
	});

	it("一列只准 fr 或 px,形状不对拒收", () => {
		const both = Array.from({ length: 12 }, () => ({ fr: 1, px: 10 }));
		expect(
			errorsOf(minimal({ cards: { live: { width: 600, columns: both, blocks: [] } } })),
		).toMatch(/columns/);
		const neither = Array.from({ length: 12 }, () => ({ width: 10 })) as never;
		expect(
			errorsOf(minimal({ cards: { live: { width: 600, columns: neither, blocks: [] } } })),
		).toMatch(/columns/);
		// px 最多两位小数(徽章的 43.75 是极限),fr 只认整数。
		expect(
			errorsOf(minimal({ cards: { live: { width: 600, columns: PX(12, 10.125), blocks: [] } } })),
		).toMatch(/columns/);
		expect(
			errorsOf(
				minimal({
					cards: { live: { width: 600, columns: Array(12).fill({ fr: 1.5 }), blocks: [] } },
				}),
			),
		).toMatch(/columns/);
	});

	it("块数有上限", () => {
		const blocks = Array.from({ length: CARD_SKIN_LIMITS.maxBlocks + 1 }, (_, i) => ({
			id: `b${i}`,
			kind: "custom" as const,
			html: "<p>x</p>",
			grid: { row: i + 1, column: 1, span: 12 },
		}));
		expect(errorsOf(minimal({ cards: { live: { width: 600, blocks } } }))).toMatch(/块/);
	});
});

describe("目录与契约的一致性", () => {
	it("每种卡都有块目录与字段表", () => {
		for (const kind of CARD_SKIN_KINDS) {
			expect(Object.keys(CARD_SKIN_BUILTIN_BLOCKS[kind]).length, kind).toBeGreaterThan(0);
			expect(CARD_SKIN_FIELDS[kind].length, kind).toBeGreaterThan(0);
		}
	});

	it("字段路径全表唯一,且每个 showIf 能指的布尔字段都标成 bool", () => {
		for (const kind of CARD_SKIN_KINDS) {
			const paths = CARD_SKIN_FIELDS[kind].map((f) => f.path);
			expect(new Set(paths).size, kind).toBe(paths.length);
			for (const f of CARD_SKIN_FIELDS[kind]) {
				expect(f.path, kind).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
				if (/^(is|has)[A-Z]/.test(f.path.split(".").at(-1) ?? ""))
					expect(f.type, f.path).toBe("bool");
			}
		}
	});
});

describe("DEFAULT_CARD_SKIN", () => {
	it("自己先过自己的门", () => {
		const m = ok(DEFAULT_CARD_SKIN);
		expect(m.name).toBeTruthy();
	});

	it("七种卡的外框底色都由皮肤 CSS 写(frame 规则),不靠外框自画", () => {
		for (const kind of CARD_SKIN_KINDS) {
			expect(DEFAULT_CARD_SKIN.cards[kind]?.css ?? "").toMatch(
				/\[data-bn="frame"\]\{[^}]*background:var\(--bn-card-bg-image,/,
			);
		}
	});

	it("七种卡都在,id 是保留字", () => {
		for (const kind of CARD_SKIN_KINDS) expect(DEFAULT_CARD_SKIN.cards[kind], kind).toBeDefined();
		expect(DEFAULT_CARD_SKIN_ID).toBe("default");
	});

	it("复刻现状:四种可编辑卡的内置块顺序与今天的 DEFAULT_CARD_LAYOUT 一致", async () => {
		const { DEFAULT_CARD_LAYOUT } = await import("./card-layout");
		const names = (kind: "live" | "dynamic" | "sc") =>
			DEFAULT_CARD_SKIN.cards[kind]?.blocks.map((b) => (b.kind === "builtin" ? b.builtin : b.kind));
		expect(names("live")).toEqual(DEFAULT_CARD_LAYOUT.live.map((b) => b.type));
		expect(names("dynamic")).toEqual(DEFAULT_CARD_LAYOUT.dynamic.map((b) => b.type));
		expect(names("sc")).toEqual(DEFAULT_CARD_LAYOUT.sc.map((b) => b.type));
	});
});

describe("资产变量与皮肤字体(ADR-0014 决策 13 的 🔗)", () => {
	const live = (over: Record<string, unknown>) =>
		minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "cover",
							kind: "builtin",
							builtin: "cover",
							grid: { row: 1, column: 1, span: 12 },
						},
					],
					...over,
				},
			},
		} as Partial<CardSkinManifest>);

	it("根与块各带一张 assets 表:变量名 → asset:assets/<文件>", () => {
		const r = parseCardSkin(
			live({
				assets: { hud: "asset:assets/hud.png" },
				blocks: [
					{
						id: "cover",
						kind: "builtin",
						builtin: "cover",
						grid: { row: 1, column: 1, span: 12 },
						assets: { tex: "asset:assets/tex.webp" },
					},
				],
			}),
		);
		expect(r.ok).toBe(true);
	});

	it.each([
		["变量名带大写", { Hud: "asset:assets/hud.png" }],
		["变量名以数字起头", { "1x": "asset:assets/hud.png" }],
		["值不带 asset: 前缀", { hud: "assets/hud.png" }],
		["值指向包外", { hud: "asset:../etc/passwd" }],
		["值带 http", { hud: "asset:http://x/y.png" }],
	])("assets 表形状不对(%s)→ 拒收", (_label, assets) => {
		expect(parseCardSkin(live({ assets })).ok).toBe(false);
	});

	it("一张 assets 表最多 maxAssetVars 项", () => {
		const ok = Object.fromEntries(
			Array.from({ length: CARD_SKIN_LIMITS.maxAssetVars }, (_, i) => [
				`a${i}`,
				"asset:assets/a.png",
			]),
		);
		expect(parseCardSkin(live({ assets: ok })).ok).toBe(true);
		const over = { ...ok, more: "asset:assets/a.png" };
		expect(parseCardSkin(live({ assets: over })).ok).toBe(false);
	});

	it("皮肤级 fonts:family + asset,family 只准字母数字空格连字符", () => {
		expect(
			parseCardSkin(
				minimal({ fonts: [{ family: "Orbitron Bold", asset: "asset:assets/orbitron.woff2" }] }),
			).ok,
		).toBe(true);
		expect(
			parseCardSkin(minimal({ fonts: [{ family: 'Bad"Name', asset: "asset:assets/a.ttf" }] })).ok,
		).toBe(false);
		expect(parseCardSkin(minimal({ fonts: [{ family: "A", asset: "assets/a.ttf" }] })).ok).toBe(
			false,
		);
	});

	it("fonts:family 不许重复,数量有上限", () => {
		const dup = parseCardSkin(
			minimal({
				fonts: [
					{ family: "A", asset: "asset:assets/a.ttf" },
					{ family: "A", asset: "asset:assets/b.ttf" },
				],
			}),
		);
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.errors.join()).toContain("A");
		const many = Array.from({ length: CARD_SKIN_LIMITS.maxFonts + 1 }, (_, i) => ({
			family: `F${i}`,
			asset: "asset:assets/a.ttf",
		}));
		expect(parseCardSkin(minimal({ fonts: many })).ok).toBe(false);
	});
});
