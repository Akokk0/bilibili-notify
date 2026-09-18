/**
 * 卡片皮肤包(ADR-0014)的 schema 契约。钉的是**什么样的包能进门**:块目录、网格边界、
 * 自定义块的口子、以及默认皮肤自己得先过自己的门。清洗(CSS / HTML)不在这层 —— 这里
 * 只量长度,内容归 server 的清洗器。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	CARD_PREVIEW_SCENES,
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_KINDS,
	CARD_SKIN_KNOB_LIMITS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SCHEMA_VERSION,
	type CardSkinKind,
	type CardSkinKnob,
	CardSkinKnobValueSchema,
	type CardSkinManifest,
	cardSkinBytes,
	cardSkinKnobCss,
	cardSkinKnobDeclarations,
	cardSkinKnobVar,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	parseCardSkin,
	parseCardSkinFontKnobValue,
	parseCardSkinImageKnobValue,
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

	it("html 与 css 的上限按 UTF-8 字节算 —— 一个汉字占 3 个", () => {
		// 三层口径必须一致:清洗器量的是 UTF-8 字节,schema 若按 UTF-16 单元数放行,
		// 中文密集的块就会「过得了 schema、存的时候被清洗器退回来」。
		const cjkHtml = "字".repeat(3000);
		expect(cjkHtml.length).toBeLessThan(CARD_SKIN_LIMITS.maxHtmlBytes);
		expect(cardSkinBytes(cjkHtml)).toBeGreaterThan(CARD_SKIN_LIMITS.maxHtmlBytes);
		const html = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{ id: "c", kind: "custom", html: cjkHtml, grid: { row: 1, column: 1, span: 12 } },
					],
				},
			},
		});
		expect(errorsOf(html)).toMatch(/html/);

		const cjkCss = "字".repeat(6000);
		expect(cjkCss.length).toBeLessThan(CARD_SKIN_LIMITS.maxCssBytes);
		expect(cardSkinBytes(cjkCss)).toBeGreaterThan(CARD_SKIN_LIMITS.maxCssBytes);
		const css = minimal({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "b",
							kind: "builtin",
							builtin: "cover",
							css: cjkCss,
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

describe("出血(辉光的那圈余量)", () => {
	it("不写 = 没有出血 —— 存量皮肤一个字节都不用改", () => {
		expect(ok(minimal()).cards.live?.bleed).toBeUndefined();
	});

	it("认 size + color", () => {
		const card = ok(
			minimal({
				cards: {
					live: {
						...(minimal() as { cards: { live: object } }).cards.live,
						bleed: { size: 28, color: "#07091a" },
					},
				},
			} as never),
		).cards.live;
		expect(card?.bleed).toEqual({ size: 28, color: "#07091a" });
	});

	it("size 与 color 是一套,缺一不可 —— 缺色会在出图上变成一圈白边", () => {
		const withBleed = (bleed: unknown) =>
			errorsOf(
				minimal({
					cards: {
						live: { ...(minimal() as { cards: { live: object } }).cards.live, bleed },
					},
				} as never),
			);
		expect(withBleed({ size: 28 })).toMatch(/color/);
		expect(withBleed({ color: "#07091a" })).toMatch(/size/);
	});

	it("size 越界拒收", () => {
		const sized = (size: number) =>
			parseCardSkin(
				minimal({
					cards: {
						live: {
							...(minimal() as { cards: { live: object } }).cards.live,
							bleed: { size, color: "#07091a" },
						},
					},
				} as never),
			).ok;
		expect(sized(CARD_SKIN_LIMITS.bleed.max)).toBe(true);
		expect(sized(CARD_SKIN_LIMITS.bleed.max + 1)).toBe(false);
		expect(sized(-1)).toBe(false);
	});

	it("color 只收 hex —— 和旋钮的颜色档同一把尺子", () => {
		const colored = (color: string) =>
			parseCardSkin(
				minimal({
					cards: {
						live: {
							...(minimal() as { cards: { live: object } }).cards.live,
							bleed: { size: 8, color },
						},
					},
				} as never),
			).ok;
		expect(colored("#07091a")).toBe(true);
		expect(colored("#fff")).toBe(true);
		expect(colored("red")).toBe(false);
		expect(colored("var(--bn-knob-neon)")).toBe(false);
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

	// 锐评两张与词云原来长在旧默认皮肤上、由出厂默认展开继承,旧默认删掉时它们差点跟着
	// 静默消失:这三种整张是一个固定内置块,没有原子块、也不在「拆得开的复合块」表里,
	// 四种可编辑卡的门一条都照不到它们,出图时只会悄悄回落兜底 —— 真机才看得见。
	it("七种卡一张都不少", () => {
		expect(Object.keys(DEFAULT_CARD_SKIN.cards).sort()).toEqual([...CARD_SKIN_KINDS].sort());
	});

	it("七种卡的外框底色都由皮肤 CSS 写(frame 规则),不靠外框自画", () => {
		for (const kind of CARD_SKIN_KINDS) {
			expect(DEFAULT_CARD_SKIN.cards[kind]?.css ?? "").toMatch(
				/\[data-bn="frame"\]\{[^}]*background:var\(--bn-knob-wallpaper,/,
			);
		}
	});

	/**
	 * 玻璃两项 2026-09-14 从固定变量表退成**默认皮肤自己的旋钮**,于是「没拧过」时的
	 * 白纱靠的是各卡 CSS 里那个兜底。**逐卡钉死兜底值**:从前三档由变量注入、CSS 共用
	 * 一句,现在写成同一个数也编译得过、门也绿,只有像素门会红 —— 那太晚了。
	 */
	it("七种卡的玻璃层吃旋钮变量,兜底值就是各卡原来的白纱基线", () => {
		const BASELINE: Record<string, string> = {
			live: ".82",
			dynamic: ".82",
			sc: ".75",
			guard: ".75",
			roastBoard: ".86",
			roastSolo: ".86",
			wordcloud: ".82",
		};
		for (const kind of CARD_SKIN_KINDS) {
			const css = DEFAULT_CARD_SKIN.cards[kind]?.css ?? "";
			expect(css, kind).toContain(
				`background:rgba(255,255,255,var(--bn-knob-glass-opacity,${BASELINE[kind]}))`,
			);
			expect(css, kind).toContain("backdrop-filter:blur(var(--bn-knob-glass-blur,10px))");
		}
	});

	/**
	 * 旋钮变量名是对外 API,而默认皮肤的 CSS 是**手写字面量**(不经 `cardSkinKnobVar`)——
	 * 两处各写一份就是它破的方式:改了 key、CSS 里那句还指着旧名,拧了没反应而门全绿。
	 */
	it("默认皮肤 CSS 里引用的每个旋钮变量,都真在 knobs 里声明过", () => {
		const declared = new Set((DEFAULT_CARD_SKIN.knobs ?? []).map((k) => cardSkinKnobVar(k.key)));
		expect(declared.size).toBeGreaterThan(0);
		const used = new Set<string>();
		for (const kind of CARD_SKIN_KINDS) {
			for (const m of (DEFAULT_CARD_SKIN.cards[kind]?.css ?? "").matchAll(
				/var\((--bn-knob-[a-z0-9-]+)/g,
			)) {
				used.add(m[1] as string);
			}
		}
		expect(used.size).toBeGreaterThan(0);
		for (const v of used) expect(declared, v).toContain(v);
	});

	it("七种卡都在,id 是保留字", () => {
		for (const kind of CARD_SKIN_KINDS) expect(DEFAULT_CARD_SKIN.cards[kind], kind).toBeDefined();
		expect(DEFAULT_CARD_SKIN_ID).toBe("default");
	});

	/**
	 * 2026-09-18 起默认皮肤用原子块拼(ADR-0014 决策 8 的 🔗):用户多半是复制默认皮肤再改,
	 * 默认皮肤里只有复合块的话,能挪的就只有整行。拆得开的复合块一个都不许留;拆不开的
	 * (封面、标题、简介、附加内容、留言、文字信息)照用。
	 */
	it("四种可编辑卡不再用拆得开的复合块", () => {
		const SPLITTABLE: Record<"live" | "dynamic" | "sc" | "guard", string[]> = {
			live: ["header", "data"],
			dynamic: ["header", "content", "stats"],
			sc: ["amount", "sender"],
			guard: ["name"],
		};
		for (const [kind, composites] of Object.entries(SPLITTABLE)) {
			const used = (DEFAULT_CARD_SKIN.cards[kind as CardSkinKind]?.blocks ?? []).map((b) =>
				b.kind === "builtin" ? b.builtin : b.kind,
			);
			expect(used.length, kind).toBeGreaterThan(0);
			for (const c of composites) expect(used, `${kind}.${c}`).not.toContain(c);
		}
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

/**
 * **皮肤自定义旋钮**(ADR-0014 决策 16 的 🔗,2026-09-14 主人推翻「被否:皮肤自定义旋钮」)。
 *
 * 判据仍是「把实现改坏能红」。这一层的危险面只有一处:旋钮的值最后会注成
 * `--bn-knob-x:<值>`,而 CSS 自定义属性的值几乎是自由文本 —— 一个 `url(` 或一个 `;`
 * 就是一次取网 / 一条凭空多出来的声明。所以值域在**声明这一步**就钉死,注入那头再验一遍。
 */
describe("皮肤自定义旋钮", () => {
	const knob = (over: Record<string, unknown> = {}): unknown => ({
		key: "accent",
		label: "主色",
		type: "color",
		default: "#fb7299",
		...over,
	});
	const withKnobs = (knobs: unknown[]): unknown => minimal({ knobs } as never);

	it("四种类型都进得去:颜色 / 数值 / 下拉 / 开关", () => {
		const res = parseCardSkin(
			withKnobs([
				knob(),
				{ key: "radius", label: "圆角", type: "number", default: 12, min: 0, max: 48, unit: "px" },
				{
					key: "density",
					label: "疏密",
					type: "select",
					default: "cozy",
					options: [
						{ value: "cozy", label: "宽松" },
						{ value: "tight", label: "紧凑" },
					],
				},
				{ key: "shadow", label: "阴影", type: "switch", default: true, on: "block", off: "none" },
			]),
		);
		expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	});

	it("字体与图两档也进得去 —— 主人的字体 / 壁纸从此由皮肤决定给不给(2026-09-14 拍板)", () => {
		const res = parseCardSkin(
			withKnobs([
				{ key: "font", label: "字体", type: "font", default: "" },
				{ key: "wallpaper", label: "壁纸", type: "image" },
			]),
		);
		expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	});

	it("图片旋钮没有 default —— 图是主人自己的东西,皮肤起不出默认值来", () => {
		const res = parseCardSkin(
			withKnobs([{ key: "wallpaper", label: "壁纸", type: "image", default: "" }]),
		);
		expect(res.ok).toBe(false);
	});

	it("这两档不是纯 CSS 字面量 —— 一律不自己注,值要宿主读盘解析", () => {
		const font: CardSkinKnob = { key: "font", label: "字体", type: "font", default: "" };
		const image: CardSkinKnob = { key: "wallpaper", label: "壁纸", type: "image" };
		expect(cardSkinKnobCss(font, "Menlo")).toBe(null);
		expect(cardSkinKnobCss(image, ["a1"])).toBe(null);
		// 更要紧的是别漏进那串变量里:漏了就是把一个资产 id 原样写进 CSS。
		expect(cardSkinKnobDeclarations([font, image], { font: "Menlo", wallpaper: ["a1"] })).toBe("");
	});

	it("字体旋钮的值:`upload:` 是主人传的文件,别的就是家族名", () => {
		expect(parseCardSkinFontKnobValue("upload:f_123")).toEqual({ upload: "f_123" });
		expect(parseCardSkinFontKnobValue("Menlo")).toEqual({ family: "Menlo" });
		// 空 = 跟着兜底链走,没什么要注的;非字符串是存量里被手改过的残值。
		expect(parseCardSkinFontKnobValue("")).toBe(null);
		expect(parseCardSkinFontKnobValue("upload:")).toBe(null);
		expect(parseCardSkinFontKnobValue(42)).toBe(null);
	});

	it("图片旋钮的值是一串资产 id(多张按推送轮换,与从前的背景图库同义)", () => {
		expect(parseCardSkinImageKnobValue(["a1", "a2"])).toEqual(["a1", "a2"]);
		// 空列表 = 未选,与没拧过同义;混进来的空串 / 非字符串剔掉,别让它变成一次读盘失败。
		expect(parseCardSkinImageKnobValue([])).toBe(null);
		expect(parseCardSkinImageKnobValue(["a1", "", 7])).toEqual(["a1"]);
		expect(parseCardSkinImageKnobValue("a1")).toBe(null);
	});

	it("覆盖值收得下一串字符串 —— 图片旋钮存的就是那一串", () => {
		expect(CardSkinKnobValueSchema.safeParse(["a1", "a2"]).success).toBe(true);
		expect(CardSkinKnobValueSchema.safeParse([1, 2]).success).toBe(false);
	});

	it("变量名由 key 派生,与资产变量 / 卡片变量不撞", () => {
		expect(cardSkinKnobVar("accent")).toBe("--bn-knob-accent");
		expect(cardSkinKnobVar("glass-opacity")).toBe("--bn-knob-glass-opacity");
	});

	it("key 只准小写字母起头的 kebab;大写 / 下划线 / 中文都拒", () => {
		for (const bad of ["Accent", "accent_1", "主色", "1accent", "-accent", ""]) {
			const res = parseCardSkin(withKnobs([knob({ key: bad })]));
			expect(res.ok, bad).toBe(false);
		}
	});

	it("key 重复拒 —— 两个旋钮注同一个变量,后一个静默吃掉前一个", () => {
		const res = parseCardSkin(withKnobs([knob(), knob({ label: "另一个" })]));
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.errors.join()).toContain("accent");
	});

	it("旋钮数量与 label 长度有上限", () => {
		const many = Array.from({ length: CARD_SKIN_KNOB_LIMITS.maxKnobs + 1 }, (_, i) =>
			knob({ key: `k${i}` }),
		);
		expect(parseCardSkin(withKnobs(many)).ok).toBe(false);
		expect(
			parseCardSkin(withKnobs([knob({ label: "一".repeat(CARD_SKIN_KNOB_LIMITS.label.max + 1) })]))
				.ok,
		).toBe(false);
	});

	/**
	 * 这几条是**注入面**的闸,不是挑剔:`;` 能在一条自定义属性里塞进第二条声明,
	 * `url(` 是取网,反斜杠在 tokenizer 里先于 ident 解开(`\75 rl(` 就是 `url(`)。
	 */
	it("颜色只准 3 位 / 6 位 hex;函数与转义一律拒", () => {
		for (const good of ["#fff", "#fb7299"]) {
			expect(parseCardSkin(withKnobs([knob({ default: good })])).ok, good).toBe(true);
		}
		for (const bad of [
			'url("https://evil.example/x.png")',
			"url(x.png)",
			"image-set(x.png)",
			"var(--bn-card-font)",
			"#fff;background:url(x)",
			"\\75 rl(x)",
			"#fff}[data-bn=frame]{background:red",
		]) {
			expect(parseCardSkin(withKnobs([knob({ default: bad })])).ok, bad).toBe(false);
		}
	});

	it("下拉的候选值走同一套值域;分号 / 大括号 / url() 拒", () => {
		const sel = (value: string): unknown => ({
			key: "density",
			label: "疏密",
			type: "select",
			default: value,
			options: [{ value, label: "一档" }],
		});
		expect(parseCardSkin(withKnobs([sel("linear-gradient(#fff,#000)")])).ok).toBe(true);
		for (const bad of ["url(x.png)", "red;background:url(x)", "red}[data-bn=frame]{color:red"]) {
			expect(parseCardSkin(withKnobs([sel(bad)])).ok, bad).toBe(false);
		}
	});

	it("下拉的默认值必须是候选之一,候选数有上下限", () => {
		const base = {
			key: "density",
			label: "疏密",
			type: "select",
			options: [
				{ value: "cozy", label: "宽松" },
				{ value: "tight", label: "紧凑" },
			],
		};
		expect(parseCardSkin(withKnobs([{ ...base, default: "cozy" }])).ok).toBe(true);
		expect(parseCardSkin(withKnobs([{ ...base, default: "roomy" }])).ok).toBe(false);
		expect(parseCardSkin(withKnobs([{ ...base, default: "cozy", options: [] }])).ok).toBe(false);
		const many = Array.from({ length: CARD_SKIN_KNOB_LIMITS.maxOptions + 1 }, (_, i) => ({
			value: `v${i}`,
			label: `第 ${i}`,
		}));
		expect(parseCardSkin(withKnobs([{ ...base, default: "v0", options: many }])).ok).toBe(false);
	});

	it("数值的默认值要落在 min / max 之间,单位是固定几种", () => {
		const num = (over: Record<string, unknown>): unknown => ({
			key: "radius",
			label: "圆角",
			type: "number",
			default: 12,
			min: 0,
			max: 48,
			...over,
		});
		expect(parseCardSkin(withKnobs([num({ unit: "px" })])).ok).toBe(true);
		expect(parseCardSkin(withKnobs([num({ default: 99 })])).ok).toBe(false);
		expect(parseCardSkin(withKnobs([num({ min: 50 })])).ok).toBe(false);
		expect(parseCardSkin(withKnobs([num({ unit: "秒" })])).ok).toBe(false);
		expect(parseCardSkin(withKnobs([num({ unit: "url(" })])).ok).toBe(false);
	});

	it("开关的两个值走同一套值域", () => {
		const sw = (over: Record<string, unknown>): unknown => ({
			key: "shadow",
			label: "阴影",
			type: "switch",
			default: true,
			on: "block",
			off: "none",
			...over,
		});
		expect(parseCardSkin(withKnobs([sw({})])).ok).toBe(true);
		expect(parseCardSkin(withKnobs([sw({ on: "url(x)" })])).ok).toBe(false);
		expect(parseCardSkin(withKnobs([sw({ off: "none;color:red" })])).ok).toBe(false);
	});

	/**
	 * `cardSkinKnobCss` 是**注入前的最后一道闸**:存储里的覆盖值若被手改成脏值(或旧包
	 * 换了旋钮类型),这里返回 null = 不注入,而不是把脏值写进 CSS。把它改成直通,
	 * 下面每条都会红。
	 */
	describe("值 → CSS 字面量", () => {
		const color: CardSkinKnob = { key: "accent", label: "主色", type: "color", default: "#fb7299" };
		const radius: CardSkinKnob = {
			key: "radius",
			label: "圆角",
			type: "number",
			default: 12,
			min: 0,
			max: 48,
			unit: "px",
		};
		const ratio: CardSkinKnob = {
			key: "ratio",
			label: "比例",
			type: "number",
			default: 0.8,
			min: 0,
			max: 1,
		};
		const density: CardSkinKnob = {
			key: "density",
			label: "疏密",
			type: "select",
			default: "cozy",
			options: [
				{ value: "cozy", label: "宽松" },
				{ value: "tight", label: "紧凑" },
			],
		};
		const shadow: CardSkinKnob = {
			key: "shadow",
			label: "阴影",
			type: "switch",
			default: true,
			on: "block",
			off: "none",
		};

		it("各类型产出各自的字面量", () => {
			expect(cardSkinKnobCss(color, "#00f0ff")).toBe("#00f0ff");
			expect(cardSkinKnobCss(radius, 20)).toBe("20px");
			expect(cardSkinKnobCss(ratio, 0.35)).toBe("0.35");
			expect(cardSkinKnobCss(density, "tight")).toBe("tight");
			expect(cardSkinKnobCss(shadow, true)).toBe("block");
			expect(cardSkinKnobCss(shadow, false)).toBe("none");
		});

		/**
		 * 2026-09-14 主人拍板收紧成 hex-only:面板的取色器(`TColor`)只认 `#rgb` / `#rrggbb`,
		 * 契约从前还收命名色与 `rgb()` 族 —— 皮肤把 default 写成 `tomato`,文本框就以「格式
		 * 不对」的样子摆着。收紧之后作者**装包当场就报错**,比默默显示怪样早得多。
		 * 半透明不靠 8 位 hex,走 `color-mix(in srgb,var(--bn-knob-x) 35%,transparent)`。
		 */
		it("颜色只认 hex —— 命名色与 rgb() 族装包就拒", () => {
			const named: CardSkinKnob = {
				key: "accent",
				label: "主色",
				type: "color",
				default: "tomato",
			};
			expect(parseCardSkin(withKnobs([named])).ok).toBe(false);
			const fn: CardSkinKnob = {
				key: "accent",
				label: "主色",
				type: "color",
				default: "rgb(251,114,153)",
			};
			expect(parseCardSkin(withKnobs([fn])).ok).toBe(false);
			// 带透明度的 8 位 hex 也不收:面板那个文本框读不了,半透明走 color-mix。
			const alpha: CardSkinKnob = {
				key: "accent",
				label: "主色",
				type: "color",
				default: "#fb729980",
			};
			expect(parseCardSkin(withKnobs([alpha])).ok).toBe(false);
			// 三位与六位照收。
			for (const good of ["#fff", "#FB7299"]) {
				expect(
					parseCardSkin(withKnobs([{ key: "accent", label: "主色", type: "color", default: good }]))
						.ok,
					good,
				).toBe(true);
			}
		});

		it("用户拧出来的值同样只认 hex —— 命名色不注入", () => {
			expect(cardSkinKnobCss(color, "tomato")).toBeNull();
			expect(cardSkinKnobCss(color, "rgb(1,2,3)")).toBeNull();
			expect(cardSkinKnobCss(color, "#fb7299")).toBe("#fb7299");
		});

		it("脏值一律 null(不注入),不是兜个默认值", () => {
			expect(cardSkinKnobCss(color, "url(https://evil.example/x.png)")).toBeNull();
			expect(cardSkinKnobCss(color, "#fff;background:url(x)")).toBeNull();
			expect(cardSkinKnobCss(color, 12)).toBeNull();
			expect(cardSkinKnobCss(radius, 99)).toBeNull();
			expect(cardSkinKnobCss(radius, "20px")).toBeNull();
			expect(cardSkinKnobCss(radius, Number.NaN)).toBeNull();
			expect(cardSkinKnobCss(density, "roomy")).toBeNull();
			expect(cardSkinKnobCss(shadow, "block")).toBeNull();
			expect(cardSkinKnobCss(color, undefined)).toBeNull();
		});
	});
});

/**
 * 预览场景表。它是**契约常量**:面板照它画那排场景按钮、把 id 发回来,出图端
 * (`packages/image` 的 `preview/sample-cards.ts`)照同一张表挑示例数据 —— 少一种卡,
 * 那种卡的预览面板就是空的;id 撞车,两个按钮指同一份数据而用户看不出区别。
 */
describe("预览场景表 — CARD_PREVIEW_SCENES", () => {
	it("七种卡一种不少,每种至少一个场景", () => {
		expect(Object.keys(CARD_PREVIEW_SCENES).sort()).toEqual([...CARD_SKIN_KINDS].sort());
		for (const kind of CARD_SKIN_KINDS) {
			expect(CARD_PREVIEW_SCENES[kind].length).toBeGreaterThan(0);
		}
	});

	it("同一种卡里场景 id 不重复", () => {
		for (const kind of CARD_SKIN_KINDS) {
			const ids = CARD_PREVIEW_SCENES[kind].map((s) => s.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it("id 是小写 kebab(要进 URL / 请求体),label 非空", () => {
		for (const kind of CARD_SKIN_KINDS) {
			for (const scene of CARD_PREVIEW_SCENES[kind]) {
				expect(scene.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
				expect(scene.label.trim()).not.toBe("");
			}
		}
	});

	// 默认落在「直播中」是拍板过的(设计稿按 开播 / 直播中 / 下播 排,默认却要落在中间那张);
	// 数组第一项即默认,所以顺序本身是决策,不是排版。
	it("直播卡三态齐全,且默认(第一项)是直播中", () => {
		expect(CARD_PREVIEW_SCENES.live.map((s) => s.id)).toEqual(["streaming", "start", "ended"]);
	});

	// 默认那个堆满了字段(给写皮肤的人一次看全),所以叫「全字段」;真机上 UP 发视频推过来的
	// 那张单列成「视频投稿」,带图的单列成「图文」(2026-09-17 主人拍板)。默认的 id 仍是
	// `default` —— 存过的书签 / 旧链接送来的还是它。
	it("动态卡:全字段(默认)/ 视频投稿 / 图文 / 转发", () => {
		expect(CARD_PREVIEW_SCENES.dynamic).toEqual([
			{ id: "default", label: "全字段" },
			{ id: "video", label: "视频投稿" },
			{ id: "draw", label: "图文" },
			{ id: "forward", label: "转发" },
		]);
	});
});

/**
 * **块的层次 `grid.z`**(2026-09-15 主人拍板「重叠是特性,补层次控制」)。
 *
 * 网格允许两个块的列区间相交 —— 那是 CSS Grid 的正常行为,也真有人要(角标压在封面上)。
 * 缺的从来不是「能不能叠」,是**叠了谁在上面**:不写层次时那只看块在数组里的先后,
 * 想调就得改块的顺序,而顺序同时还管着别的事(分割线的收拢、CSS 的先后)。
 *
 * ⚠️ 与「手写 `z-index`」的关系:块 CSS 里写 `[data-bn="self"]{z-index:5}` 一直是放行的
 * (属性走黑名单)。所以这个字段**不写就不注**,老皮肤那条手写的路原样留着;写了才由
 * inline 接管(inline 恒压过 CSS,清洗器又一律摘 `!important`)。
 */
describe("块的层次", () => {
	const withZ = (z: unknown) =>
		parseCardSkin({
			schemaVersion: 1,
			dataVersion: 1,
			name: "t",
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "cover",
							kind: "builtin",
							builtin: "cover",
							grid: { row: 1, column: 1, span: 12, ...(z === undefined ? {} : { z }) },
						},
					],
				},
			},
		});

	it("不写 —— 老皮肤原样装得进来", () => {
		const r = withZ(undefined);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.manifest.cards.live?.blocks[0]?.grid.z).toBeUndefined();
	});

	it("0 到 9 都收", () => {
		for (const z of [0, 1, 9]) {
			const r = withZ(z);
			expect(r.ok, `z=${z} 该收`).toBe(true);
			if (r.ok) expect(r.manifest.cards.live?.blocks[0]?.grid.z).toBe(z);
		}
	});

	it("超出上限不收", () => {
		expect(withZ(10).ok).toBe(false);
	});

	it("**不给负数** —— 0 是地面,要沉底就把别的抬高", () => {
		expect(withZ(-1).ok).toBe(false);
	});

	it("小数不收 —— 层次是第几层,不是多少层", () => {
		expect(withZ(1.5).ok).toBe(false);
	});
});

// ── 出厂默认皮肤:声明的格子要对得起画出来的样子 ────────────────────────────────

/**
 * **块自己缩小时,就不许再声明通栏。**
 *
 * 编辑器画布只看得见 JSON 里的格子 —— 一块声明 `1–12`,画布就画一整行。角标这种块靠
 * `justify-self` 把自己收成内容宽、贴到某个角,通栏声明就成了**对画布撒的谎**:真卡上
 * 右上角一小颗,画布上横贯整行(主人 2026-09-18 指着截图说「看着非常突兀」)。
 *
 * 所以带 `justify-self` 的块必须把**列号收到它真正占的那几列**,余下的偏移才交给
 * `margin`。`justify-content` 不在此列 —— 那是「块本身通栏、内容在里头居中」,声明的
 * 是实话。
 *
 * ⚠️ 这条**只有画布上看得出来**:出图一个像素都不差(`justify-self:end` 把右边缘钉死在
 * 格子右沿,格子从第 1 列起还是第 11 列起都一样),像素门与字节门都不会红。
 */
describe("DEFAULT_CARD_SKIN — 自己缩小的块不占通栏", () => {
	for (const kind of CARD_SKIN_KINDS) {
		const card = DEFAULT_CARD_SKIN.cards[kind];
		const shrinking = (card?.blocks ?? []).filter((b) => (b.css ?? "").includes("justify-self"));
		if (shrinking.length === 0) continue;
		for (const block of shrinking) {
			it(`${kind}.${block.id}:贴角的块只占它真正占的那几列`, () => {
				expect(block.grid.span).toBeLessThan(CARD_SKIN_LIMITS.columns);
			});
		}
	}
});

/**
 * **覆盖层把格子收到最小,横竖都是。** 写了 `z` 就是明说「我叠在别人身上」,而叠上去的
 * 都是角标那种小东西:声明得越大,画布上盖住的就越多 —— 真卡上右下角一颗小标签,画布上
 * 却是一个六行高的白框(主人 2026-09-18:「视频封面右下角的标签和直播封面的问题一样」)。
 *
 * 贴哪一边由 `align-self` / `justify-self` 说,剩下那几个像素由 `margin` 说 —— 格子只负责
 * 圈出它真正占的那一小块。
 *
 * ⚠️ 只看 `align-self` 是不够的:上舰卡的徽章自己写着 `height:190px`、头像挨着上下两行
 * 胶囊,它们贴着一头放**而且真的**占着那几行,声明的是实话。
 */
describe("DEFAULT_CARD_SKIN — 覆盖层只占它真正占的那一小块", () => {
	for (const kind of CARD_SKIN_KINDS) {
		const card = DEFAULT_CARD_SKIN.cards[kind];
		for (const block of (card?.blocks ?? []).filter((b) => b.grid.z)) {
			it(`${kind}.${block.id}:不通栏、不跨行`, () => {
				expect(block.grid.span).toBeLessThan(CARD_SKIN_LIMITS.columns);
				expect(block.grid.rowSpan ?? 1).toBe(1);
			});
		}
	}
});
