/**
 * 编辑器改草稿的纯函数。
 *
 * 钉四条,各对应一个静默失败:① **回新对象不动原件** —— 就地改的话脏标与预览都察觉不到
 * (界面上值变了、预览一动不动,正是「拧了没反应」那一类);② **越界夹回边界而不是拒**
 * (数字框边敲边过,拒了就永远敲不出两位数);③ **`span` 跟着起始列收** —— 不收的话清洗器
 * 那头直接判越界,主人看到的是「保存失败」而不是「刚才那一下把它挤出去了」;④ **`rowSpan`
 * 为 1 时不写进去**(缺省就是 1,写进去只是 diff 里一行噪音)。
 *
 * 增删块另钉两条:⑤ **新块的 id 与既有的撞了要让开** —— 撞了不换名的话装包门直接判
 * 「块 id 重复」,而主人看到的是保存时一句莫名其妙的报错;⑥ **删块不回收行号** ——
 * 回收等于把主人手摆好的位置全冲掉。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_KNOB_LIMITS, CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import {
	addBlock,
	addCustomBlock,
	addFont,
	addKnob,
	addKnobOption,
	adoptCard,
	blockOf,
	canAddBlock,
	cardOf,
	clampInt,
	columnsOf,
	dropBlockGrid,
	dropCard,
	fontsError,
	gridLimits,
	knobsError,
	overlappingBlocks,
	removeBlock,
	removeFont,
	removeKnob,
	removeKnobOption,
	setBlockCss,
	setBlockGrid,
	setBlockHtml,
	setBlockShowIf,
	setColumns,
	setFont,
	setFrame,
	setFrameCss,
	setKnobDecl,
	setKnobDefault,
	setKnobNumber,
	setKnobOption,
	setKnobSwitch,
	setKnobType,
	setSkinMeta,
	skinMetaError,
	stackingOf,
} from "../skin-draft-ops";

const manifest = (): CardSkinManifest =>
	({
		schemaVersion: 1,
		name: "测试皮肤",
		cards: {
			live: {
				width: 600,
				css: "",
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
					{ id: "title", kind: "builtin", builtin: "title", grid: { row: 2, column: 1, span: 6 } },
				],
			},
		},
	}) as unknown as CardSkinManifest;

/**
 * ⚠️ 形状**从真类型取**,别在这儿手抄一份 —— 抄的那份不会跟着 schema 走,给 grid 加一个
 * 字段(2026-09-15 的层次 `z`)就会在这儿冒出一串「属性不存在」,而产物其实是新的。
 */
type BlockGrid = NonNullable<ReturnType<typeof blockOf>>["grid"];

const gridOf = (m: CardSkinManifest, id: string) =>
	blockOf(cardOf(m, "live"), id)?.grid as BlockGrid;

describe("clampInt", () => {
	it("越界夹回边界,不是拒", () => {
		expect(clampInt(0, 1, 12)).toBe(1);
		expect(clampInt(99, 1, 12)).toBe(12);
		expect(clampInt(5, 1, 12)).toBe(5);
	});

	it("空框 / NaN 退到下限 —— 数字框清空时 Number('') 是 NaN,不能让它写进清单", () => {
		expect(clampInt(Number.NaN, 1, 12)).toBe(1);
		expect(clampInt(Number.POSITIVE_INFINITY, 1, 12)).toBe(1);
	});

	it("小数取整 —— 网格没有半列", () => {
		expect(clampInt(3.6, 1, 12)).toBe(4);
	});
});

describe("gridLimits", () => {
	it("跨列的上限跟着起始列收 —— 从第 10 列起最多跨 3 列", () => {
		expect(gridLimits({ row: 1, column: 10, span: 1 }).span.max).toBe(3);
		expect(gridLimits({ row: 1, column: 1, span: 1 }).span.max).toBe(12);
	});
});

describe("setBlockGrid", () => {
	it("回的是新清单,原件一个字节都没动", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const after = setBlockGrid(before, "live", "title", { column: 3 });
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(after).not.toBe(before);
		expect(gridOf(after, "title").column).toBe(3);
	});

	it("没动到的块原样带着走", () => {
		const after = setBlockGrid(manifest(), "live", "title", { column: 3 });
		expect(gridOf(after, "cover")).toEqual({ row: 1, column: 1, span: 12 });
	});

	it("起始列往右推 → 跨列跟着收,而不是留个越界的数等保存时报错", () => {
		const after = setBlockGrid(manifest(), "live", "cover", { column: 10 });
		expect(gridOf(after, "cover")).toEqual({ row: 1, column: 10, span: 3 });
	});

	it("越界的输入夹回边界", () => {
		const after = setBlockGrid(manifest(), "live", "title", { row: 0, span: 99 });
		expect(gridOf(after, "title").row).toBe(1);
		expect(gridOf(after, "title").span).toBe(12);
	});

	/**
	 * 上面那条**离了保护也不会坏** —— `column` 没动,`span` 的上界还是 12,夹哪边都对。
	 * 真正的坑在「列自己越界」那一支:`span.max = 12 - column + 1` 若拿**未夹的**列去算
	 * 就会变成 0 甚至负数,而 `clampInt(v, 1, 0)` 返回的是 **0**(先抬到 min 再压到 max)。
	 * 于是列被夹回 12、`span` 却成了 0,保存与预览一路被装包门顶回来。
	 * 判据:把 `setBlockGrid` 里的「先夹列」那一步拆掉,下面三条必须红。
	 */
	it("列越界时 span 不许变成 0 或负数 —— 13 就够,不用 99", () => {
		for (const [column, span] of [
			[13, 1],
			[14, 1],
			[99, 1],
		] as const) {
			const after = setBlockGrid(manifest(), "live", "title", { column });
			expect(gridOf(after, "title").column).toBe(12);
			expect(gridOf(after, "title").span).toBe(span);
		}
	});

	it("rowSpan 为 1 时不落进清单;大于 1 才写", () => {
		const one = setBlockGrid(manifest(), "live", "title", { rowSpan: 1 });
		expect("rowSpan" in gridOf(one, "title")).toBe(false);
		const two = setBlockGrid(manifest(), "live", "title", { rowSpan: 2 });
		expect(gridOf(two, "title").rowSpan).toBe(2);
	});

	it("这套皮肤没定义这种卡 → 原样返回(别凭空造一张出来)", () => {
		const before = manifest();
		expect(setBlockGrid(before, "sc", "title", { row: 2 })).toBe(before);
	});

	it("块 id 对不上 → 清单内容不变", () => {
		const before = manifest();
		const after = setBlockGrid(before, "live", "没这个块", { row: 2 });
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	});
});

describe("addBlock", () => {
	it("新块落在最后一行的下一行、整宽 —— 「空行往这儿放」那句话的兑现", () => {
		const added = addBlock(manifest(), "live", "desc");
		if (!added) throw new Error("这张卡还加得下,不该回 null");
		expect(gridOf(added.manifest, added.blockId)).toEqual({ row: 3, column: 1, span: 12 });
	});

	it("id 与既有块撞了就带后缀 —— 撞了不换名的话装包门直接判「块 id 重复」", () => {
		const once = addBlock(manifest(), "live", "title");
		if (!once) throw new Error("加得下");
		expect(once.blockId).toBe("title-2");
		const twice = addBlock(once.manifest, "live", "title");
		expect(twice?.blockId).toBe("title-3");
	});

	it("回的是新清单,原件一个字节都没动", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const added = addBlock(before, "live", "desc");
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(added?.manifest).not.toBe(before);
	});

	it("一块都没有的卡 → 落在第 1 行", () => {
		const empty = manifest();
		(empty.cards.live as { blocks: unknown[] }).blocks = [];
		expect(
			gridOf(addBlock(empty, "live", "cover")?.manifest as CardSkinManifest, "cover").row,
		).toBe(1);
	});

	it("满了就加不进去 —— canAddBlock 与 addBlock 说的是同一句话", () => {
		const full = manifest();
		(full.cards.live as { blocks: unknown[] }).blocks = Array.from(
			{ length: CARD_SKIN_LIMITS.maxBlocks },
			(_, i) => ({
				id: `b${i}`,
				kind: "builtin",
				builtin: "divider",
				grid: { row: i + 1, column: 1, span: 12 },
			}),
		);
		expect(canAddBlock(cardOf(full, "live"))).toBe(false);
		expect(addBlock(full, "live", "desc")).toBe(null);
	});

	it("这套皮肤没定义这种卡 → 回 null(别凭空造一张出来)", () => {
		expect(addBlock(manifest(), "sc", "amount")).toBe(null);
		expect(canAddBlock(cardOf(manifest(), "sc"))).toBe(false);
	});
});

describe("removeBlock", () => {
	it("删掉选中那块,其余原样带着走", () => {
		const after = removeBlock(manifest(), "live", "title");
		expect(cardOf(after, "live")?.blocks.map((b) => b.id)).toEqual(["cover"]);
		expect(gridOf(after, "cover")).toEqual({ row: 1, column: 1, span: 12 });
	});

	it("回的是新清单,原件一个字节都没动", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const after = removeBlock(before, "live", "title");
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(after).not.toBe(before);
	});

	it("id 对不上 / 没这种卡 → 原样返回", () => {
		const before = manifest();
		expect(removeBlock(before, "live", "没这个块")).toBe(before);
		expect(removeBlock(before, "sc", "amount")).toBe(before);
	});
});

describe("setFrame", () => {
	it("卡宽夹在门里 —— 越界的数落进清单,主人看到的是保存时一句报错", () => {
		expect(cardOf(setFrame(manifest(), "live", { width: 99 }), "live")?.width).toBe(
			CARD_SKIN_LIMITS.width.min,
		);
		expect(cardOf(setFrame(manifest(), "live", { width: 9999 }), "live")?.width).toBe(
			CARD_SKIN_LIMITS.width.max,
		);
	});

	it("间距写 0 = 把键删掉 —— 0 与不写在出图上同义,留个 0 只是 diff 里的噪音", () => {
		const withGap = setFrame(manifest(), "live", { gapRow: 12 });
		expect(cardOf(withGap, "live")?.gap).toEqual({ row: 12 });
		const back = setFrame(withGap, "live", { gapRow: 0 });
		expect("gap" in (cardOf(back, "live") as object)).toBe(false);
	});

	it("出血:给了宽度就连色一起落进清单(schema 里两个是一套)", () => {
		const m = setFrame(manifest(), "live", { bleedSize: 24 });
		expect(cardOf(m, "live")?.bleed).toEqual({ size: 24, color: "#000000" });
	});

	it("出血写 0 = 把键删掉 —— 与间距同一条规矩", () => {
		const on = setFrame(manifest(), "live", { bleedSize: 24, bleedColor: "#07091a" });
		expect(cardOf(on, "live")?.bleed).toEqual({ size: 24, color: "#07091a" });
		const off = setFrame(on, "live", { bleedSize: 0 });
		expect("bleed" in (cardOf(off, "live") as object)).toBe(false);
	});

	it("只改色时宽度原样留着", () => {
		const on = setFrame(manifest(), "live", { bleedSize: 18, bleedColor: "#07091a" });
		const recolored = setFrame(on, "live", { bleedColor: "#ff0080" });
		expect(cardOf(recolored, "live")?.bleed).toEqual({ size: 18, color: "#ff0080" });
	});

	it("没有出血时单改色不凭空造一圈出来", () => {
		const m = setFrame(manifest(), "live", { bleedColor: "#ff0080" });
		expect(cardOf(m, "live")?.bleed).toBeUndefined();
	});

	it("出血也夹在门里", () => {
		const over = setFrame(manifest(), "live", { bleedSize: 9999 });
		expect(cardOf(over, "live")?.bleed?.size).toBe(CARD_SKIN_LIMITS.bleed.max);
	});

	it("只改行距时列距原样留着", () => {
		const both = setFrame(manifest(), "live", { gapRow: 8, gapColumn: 6 });
		const after = setFrame(both, "live", { gapRow: 10 });
		expect(cardOf(after, "live")?.gap).toEqual({ row: 10, column: 6 });
	});

	it("回的是新清单,原件一个字节都没动;没这种卡就原样返回", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		const after = setFrame(before, "live", { width: 500 });
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(after).not.toBe(before);
		expect(setFrame(before, "sc", { width: 500 })).toBe(before);
	});
});

describe("columnsOf / setColumns", () => {
	it("没写 columns 时算出来的是 12 等分 —— 编辑器照它画那 12 行", () => {
		expect(columnsOf(cardOf(manifest(), "live"))).toEqual(
			Array.from({ length: CARD_SKIN_LIMITS.columns }, () => ({ fr: 1 })),
		);
	});

	it("传 undefined = 删掉整份 columns(回到 12 等分)", () => {
		const custom = setColumns(manifest(), "live", [{ px: 40 }]);
		expect(cardOf(custom, "live")?.columns).toHaveLength(CARD_SKIN_LIMITS.columns);
		const back = setColumns(custom, "live", undefined);
		expect("columns" in (cardOf(back, "live") as object)).toBe(false);
	});

	it("不足 12 项就补等分、超了就截断 —— 装包门只收恰好 12 项", () => {
		const short = setColumns(manifest(), "live", [{ px: 40 }, { fr: 2 }]);
		const cols = cardOf(short, "live")?.columns;
		expect(cols).toHaveLength(CARD_SKIN_LIMITS.columns);
		expect(cols?.[0]).toEqual({ px: 40 });
		expect(cols?.[1]).toEqual({ fr: 2 });
		expect(cols?.[11]).toEqual({ fr: 1 });
	});

	it("越界的列宽夹回门里,px 收到两位小数", () => {
		const cols = cardOf(
			setColumns(manifest(), "live", [{ px: 43.756 }, { fr: 99 }]),
			"live",
		)?.columns;
		expect(cols?.[0]).toEqual({ px: 43.76 });
		expect(cols?.[1]).toEqual({ fr: CARD_SKIN_LIMITS.columns });
	});
});

describe("setBlockCss / setFrameCss", () => {
	const CSS = '[data-bn="self"]{color:red}';

	it("写进去的就是那一份;清空 = 把键删掉(清洗器那头也把洗空的当没写)", () => {
		const withCss = setBlockCss(manifest(), "live", "title", CSS);
		expect(blockOf(cardOf(withCss, "live"), "title")?.css).toBe(CSS);
		const cleared = setBlockCss(withCss, "live", "title", "   ");
		expect("css" in (blockOf(cardOf(cleared, "live"), "title") as object)).toBe(false);
	});

	it("外框 CSS 同理", () => {
		const withCss = setFrameCss(manifest(), "live", CSS);
		expect(cardOf(withCss, "live")?.css).toBe(CSS);
		expect("css" in (cardOf(setFrameCss(withCss, "live", ""), "live") as object)).toBe(false);
	});

	it("回的是新清单,原件一个字节都没动;对不上的块 / 卡原样返回", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		expect(setBlockCss(before, "live", "title", CSS)).not.toBe(before);
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(setBlockCss(before, "live", "没这个块", CSS)).toBe(before);
		expect(setBlockCss(before, "sc", "title", CSS)).toBe(before);
		expect(setFrameCss(before, "sc", CSS)).toBe(before);
	});
});

describe("setBlockShowIf", () => {
	it("选一个字段就写进去,选「总是显示」把键删掉", () => {
		const gated = setBlockShowIf(manifest(), "live", "title", "live.isStreaming");
		expect(blockOf(cardOf(gated, "live"), "title")?.showIf).toBe("live.isStreaming");
		const always = setBlockShowIf(gated, "live", "title", undefined);
		expect("showIf" in (blockOf(cardOf(always, "live"), "title") as object)).toBe(false);
	});

	it("回的是新清单,原件一个字节都没动;对不上的块 / 卡原样返回", () => {
		const before = manifest();
		const snapshot = JSON.stringify(before);
		expect(setBlockShowIf(before, "live", "title", "live.isEnded")).not.toBe(before);
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(setBlockShowIf(before, "live", "没这个块", "live.isEnded")).toBe(before);
		expect(setBlockShowIf(before, "sc", "title", "live.isEnded")).toBe(before);
	});
});

describe("addCustomBlock / setBlockHtml", () => {
	it("自定义块也落在最底下那一行,自带一段能看见的起手 HTML", () => {
		const added = addCustomBlock(manifest(), "live");
		if (!added) throw new Error("加得下");
		const block = blockOf(cardOf(added.manifest, "live"), added.blockId);
		expect(block?.kind).toBe("custom");
		expect((block as { html: string }).html.trim()).not.toBe("");
		expect(gridOf(added.manifest, added.blockId)).toEqual({ row: 3, column: 1, span: 12 });
	});

	it("第二个自定义块换个 id —— 撞名在装包门那头是「块 id 重复」", () => {
		const one = addCustomBlock(manifest(), "live");
		if (!one) throw new Error("加得下");
		const two = addCustomBlock(one.manifest, "live");
		expect(two?.blockId).not.toBe(one.blockId);
	});

	it("改 HTML → 写进那一块;内置块没有 html 可改,原样返回", () => {
		const one = addCustomBlock(manifest(), "live");
		if (!one) throw new Error("加得下");
		const edited = setBlockHtml(one.manifest, "live", one.blockId, "<div>{up.name}</div>");
		expect((blockOf(cardOf(edited, "live"), one.blockId) as { html: string }).html).toBe(
			"<div>{up.name}</div>",
		);
		expect(setBlockHtml(edited, "live", "title", "<div>x</div>")).toBe(edited);
	});
});

describe("adoptCard / dropCard", () => {
	const source = () => cardOf(manifest(), "live") as NonNullable<ReturnType<typeof cardOf>>;

	it("接管:把出厂那张卡整份抄进来,而且连块都是新的一份(不是同一批对象)", () => {
		const src = source();
		const after = adoptCard(manifest(), "sc", src);
		expect(cardOf(after, "sc")?.blocks).toHaveLength(2);
		// 钉的是**引用**:源是 react-query 缓存里出厂皮肤的那一份,共用同一批块对象的话,
		// 哪天有人写了个就地改的 op,改的就是缓存里的出厂皮肤。
		expect(cardOf(after, "sc")).not.toBe(src);
		expect(cardOf(after, "sc")?.blocks[0]).not.toBe(src.blocks[0]);
	});

	it("已经有这种卡就不动它 —— 接管只对空着的卡种开口", () => {
		const before = manifest();
		expect(adoptCard(before, "live", source())).toBe(before);
	});

	it("交还:整张卡从清单里消失(出图时跟着出厂默认)", () => {
		const before = manifest();
		const after = dropCard(before, "live");
		expect("live" in after.cards).toBe(false);
		expect(dropCard(after, "live")).toBe(after);
		expect(JSON.stringify(before)).toBe(JSON.stringify(manifest()));
	});
});

/**
 * 皮肤级的元信息(名字 / 作者 / 说明)。装皮肤时定下的名字从前**再也改不了** ——
 * 编辑器与皮肤库都没有入口。
 *
 * 钉三条静默失败:① 可选的两项留空要**删键**(留个空串,皮肤库那行就显示一个空作者 /
 * 空说明,看着像坏了);② 名字留空**照样存进草稿**,让上层当场说「皮肤得有个名字」——
 * 悄悄保留旧名的话,主人会看到一个「怎么删都弹回去」的框;③ patch 语义,没给的键不动。
 */
describe("setSkinMeta", () => {
	it("改名回一份新的,原件一个字没动", () => {
		const before = manifest();
		const after = setSkinMeta(before, { name: "青柠" });
		expect(after.name).toBe("青柠");
		expect(before.name).toBe("测试皮肤");
		expect(after).not.toBe(before);
	});

	it("作者 / 说明留空 → 删键(不是存个空串)", () => {
		const withMeta = setSkinMeta(manifest(), { author: "伦伦酱", description: "试的" });
		expect(withMeta.author).toBe("伦伦酱");
		expect(withMeta.description).toBe("试的");

		const cleared = setSkinMeta(withMeta, { author: "  ", description: "" });
		expect("author" in cleared).toBe(false);
		expect("description" in cleared).toBe(false);
	});

	it("名字留空照样落进草稿 —— 拦是上层的事,不在这儿偷偷弹回去", () => {
		expect(setSkinMeta(manifest(), { name: "" }).name).toBe("");
	});

	it("没给的键不动", () => {
		const withAuthor = setSkinMeta(manifest(), { author: "伦伦酱" });
		const renamed = setSkinMeta(withAuthor, { name: "青柠" });
		expect(renamed.author).toBe("伦伦酱");
		expect(renamed.cards.live?.blocks).toHaveLength(2);
	});
});

/**
 * 存不存得下去 —— 保存钮照它变灰。**不能让主人按下去吃一个 400**:装包门那头只会回
 * 一句「name: 太短」,而主人根本不知道是哪儿的名字(块也有 id、字体也有 family)。
 */
describe("skinMetaError", () => {
	it("名字空了 / 全是空格 → 说出是哪儿不对", () => {
		expect(skinMetaError(setSkinMeta(manifest(), { name: "" }))).toBe("皮肤得有个名字");
		expect(skinMetaError(setSkinMeta(manifest(), { name: "   " }))).toBe("皮肤得有个名字");
	});

	it.each([
		["name", "皮肤名", CARD_SKIN_LIMITS.name.max],
		["author", "作者", CARD_SKIN_LIMITS.author.max],
		["description", "说明", CARD_SKIN_LIMITS.description.max],
	])("%s 超上限 → 说出是哪一项、超了多少(三个框都不截断)", (key, label, max) => {
		const long = "绫".repeat(max + 1);
		const err = skinMetaError(setSkinMeta(manifest(), { [key]: long }));
		expect(err).toContain(label);
		expect(err).toContain(String(max));
	});

	it("正常的皮肤没有错", () => {
		expect(skinMetaError(manifest())).toBeNull();
	});
});

/**
 * 旋钮声明 —— 皮肤自己决定给面板几个控件(ADR-0014 决策 16)。编辑器从前一枚都编不了,
 * 于是**自制皮肤的旋钮区永远是空的**,只有出厂那套有旋钮。
 *
 * 钉的都是「存不下去」那一类静默失败:① 改档得把值**整个重建**成那一档的合法形状 ——
 * 从颜色改成数值,`default` 还是 `"#e0c3fc"` 的话装包门当场拒,而主人只看见保存失败;
 * ② 新旋钮的 key 撞了要让开(同块 id 那条);③ key 非法 / 撞了 / label 空了要当场说,
 * 而不是等装包门回一句 `knobs[3]: …`。
 */
describe("旋钮声明", () => {
	const withKnobs = (...knobs: unknown[]) =>
		({ ...manifest(), knobs }) as unknown as CardSkinManifest;

	it("加一枚:落在末尾,给一个不撞的 key,并把它回给调用方去选中", () => {
		const first = addKnob(manifest());
		expect(first?.manifest.knobs).toHaveLength(1);
		expect(first?.key).toMatch(/^[a-z][a-z0-9-]*$/);

		const second = addKnob(first?.manifest as CardSkinManifest);
		const keys = second?.manifest.knobs?.map((k) => k.key);
		expect(new Set(keys).size).toBe(2);
	});

	it("加满 16 枚就加不动了(装包门的上限,不是我编的)", () => {
		let m = manifest();
		for (let i = 0; i < CARD_SKIN_KNOB_LIMITS.maxKnobs; i++) {
			m = (addKnob(m) as { manifest: CardSkinManifest }).manifest;
		}
		expect(m.knobs).toHaveLength(CARD_SKIN_KNOB_LIMITS.maxKnobs);
		expect(addKnob(m)).toBeNull();
	});

	it("删最后一枚 → 整个 knobs 键删掉(别在清单里留个空数组)", () => {
		const one = addKnob(manifest()) as { manifest: CardSkinManifest; key: string };
		expect("knobs" in removeKnob(one.manifest, one.key)).toBe(false);
	});

	it.each([
		["number", { default: 0, min: 0, max: 100 }],
		["switch", { default: false, on: "block", off: "none" }],
		["font", { default: "" }],
	] as const)("改档到 %s:值整个重建成那一档的形状,key 与 label 留着", (type, shape) => {
		const m = withKnobs({ key: "accent", label: "主色", type: "color", default: "#e0c3fc" });
		const after = setKnobType(m, "accent", type);
		expect(after.knobs?.[0]).toEqual({ key: "accent", label: "主色", type, ...shape });
	});

	it("改成当前这一档 = 什么都不动 —— 否则点一下现在选着的档位就把值冲掉了", () => {
		const m = withKnobs({ key: "accent", label: "主色", type: "color", default: "#e0c3fc" });
		expect(setKnobType(m, "accent", "color").knobs?.[0]).toMatchObject({ default: "#e0c3fc" });
	});

	it("改档到 image:连 default 都不该留 —— 图没有默认值(装包门是 strict 的)", () => {
		const m = withKnobs({ key: "wall", label: "壁纸", type: "color", default: "#e0c3fc" });
		expect(setKnobType(m, "wall", "image").knobs?.[0]).toEqual({
			key: "wall",
			label: "壁纸",
			type: "image",
		});
	});

	it("改档到 select:带一个能用的候选 —— 空候选表存不下去", () => {
		const m = withKnobs({ key: "corner", label: "圆角", type: "color", default: "#e0c3fc" });
		const knob = setKnobType(m, "corner", "select").knobs?.[0] as {
			options: Array<{ value: string; label: string }>;
			default: string;
		};
		expect(knob.options.length).toBeGreaterThan(0);
		expect(knob.options.some((o) => o.value === knob.default)).toBe(true);
	});

	it("改 key / label / default 各改各的,不动别枚", () => {
		const m = withKnobs(
			{ key: "a", label: "甲", type: "color", default: "#000000" },
			{ key: "b", label: "乙", type: "color", default: "#ffffff" },
		);
		const renamed = setKnobDecl(m, "a", { key: "accent" });
		expect(renamed.knobs?.map((k) => k.key)).toEqual(["accent", "b"]);

		const relabelled = setKnobDecl(renamed, "accent", { label: "主色" });
		expect(relabelled.knobs?.[0]).toMatchObject({ key: "accent", label: "主色" });

		const recoloured = setKnobDefault(relabelled, "accent", "#123456");
		expect(recoloured.knobs?.[0]).toMatchObject({ default: "#123456" });
		expect(recoloured.knobs?.[1]).toMatchObject({ key: "b", default: "#ffffff" });
	});
});

/**
 * 旋钮声明存不存得下去。装包门那头回的是 `knobs[3]: 旋钮 key「…」重复` —— 序号对不上
 * 界面上第几行,主人得自己数。这里提前说人话。
 */
describe("knobsError", () => {
	const withKnobs = (...knobs: unknown[]) =>
		({ ...manifest(), knobs }) as unknown as CardSkinManifest;

	it("没有旋钮 → 没有错", () => {
		expect(knobsError(manifest())).toBeNull();
	});

	it("key 撞了 → 说出是哪个 key", () => {
		const m = withKnobs(
			{ key: "accent", label: "甲", type: "color", default: "#000000" },
			{ key: "accent", label: "乙", type: "color", default: "#ffffff" },
		);
		expect(knobsError(m)).toContain("accent");
	});

	it.each([["Accent"], ["1accent"], ["accent_2"], [""]])(
		"key「%s」不合法 → 说清楚要什么形状",
		(key) => {
			const m = withKnobs({ key, label: "甲", type: "color", default: "#000000" });
			expect(knobsError(m)).toContain("kebab");
		},
	);

	it("label 空了 → 也拦(面板上会画出一个没名字的控件)", () => {
		const m = withKnobs({ key: "accent", label: "  ", type: "color", default: "#000000" });
		expect(knobsError(m)).toContain("名字");
	});
});

/**
 * 三档的附加字段:数值的取值域与单位、下拉的候选表、开关两端的字面量。不补这些,那三档
 * 在编辑器里就是「声明得出、调不了」—— 加一枚数值旋钮永远是 0~100 无单位。
 *
 * 钉的仍是「存不下去」:改窄取值域会把起手位置甩到域外、删候选会把起手位置删成悬空。
 * 两样都**不偷偷改起手位置** —— 那是主人自己摆的,冲掉了他不会知道。当场说。
 */
describe("旋钮的附加字段", () => {
	const oneKnob = (knob: unknown) =>
		({ ...manifest(), knobs: [knob] }) as unknown as CardSkinManifest;
	/** 第一枚旋钮的候选表。夹具只放一枚,取不到就是用例自己写错了。 */
	const optionsOf = (m: CardSkinManifest): Array<{ value: string; label: string }> => {
		const knob = m.knobs?.[0];
		if (knob === undefined || knob.type !== "select") throw new Error("第一枚不是下拉旋钮");
		return knob.options;
	};
	const num = () =>
		oneKnob({ key: "blur", label: "糊化", type: "number", default: 8, min: 0, max: 40 });
	const sel = () =>
		oneKnob({
			key: "corner",
			label: "圆角",
			type: "select",
			default: "12px",
			options: [{ value: "12px", label: "圆" }],
		});

	it("数值:取值域与步长各改各的", () => {
		const after = setKnobNumber(num(), "blur", { min: 2, max: 24, step: 0.5 });
		expect(after.knobs?.[0]).toMatchObject({ min: 2, max: 24, step: 0.5, default: 8 });
	});

	it("数值:步长清零 / 单位选「无」都是**删键** —— optional 的键留个 0 在清单里是噪音", () => {
		const withExtras = setKnobNumber(num(), "blur", { step: 2, unit: "px" });
		expect(withExtras.knobs?.[0]).toMatchObject({ step: 2, unit: "px" });

		const cleared = setKnobNumber(withExtras, "blur", { step: 0, unit: "" });
		expect("step" in (cleared.knobs?.[0] ?? {})).toBe(false);
		expect("unit" in (cleared.knobs?.[0] ?? {})).toBe(false);
	});

	it("开关:两端的字面量各改各的", () => {
		const m = oneKnob({
			key: "badge",
			label: "徽章",
			type: "switch",
			default: true,
			on: "block",
			off: "none",
		});
		expect(setKnobSwitch(m, "badge", { on: "flex" }).knobs?.[0]).toMatchObject({
			on: "flex",
			off: "none",
		});
	});

	it("下拉:加一个候选,值不撞已有的", () => {
		const after = addKnobOption(sel(), "corner");
		const options = optionsOf(after);
		expect(options).toHaveLength(2);
		expect(new Set(options.map((o) => o.value)).size).toBe(2);
	});

	it("下拉:加满 8 个就加不动了", () => {
		let m = sel();
		for (let i = 1; i < CARD_SKIN_KNOB_LIMITS.maxOptions; i++) m = addKnobOption(m, "corner");
		expect(optionsOf(m)).toHaveLength(CARD_SKIN_KNOB_LIMITS.maxOptions);
		// 加不动时**整份原样返回**:回一份内容相同的新清单会让脏标凭空亮起来。
		expect(addKnobOption(m, "corner")).toBe(m);
	});

	it("下拉:改一个候选的值 / 人话名,删一个候选", () => {
		const two = addKnobOption(sel(), "corner");
		const edited = setKnobOption(two, "corner", 1, { value: "0px", label: "直角" });
		expect(optionsOf(edited)[1]).toEqual({ value: "0px", label: "直角" });
		const dropped = removeKnobOption(edited, "corner", 0);
		expect(optionsOf(dropped)).toEqual([{ value: "0px", label: "直角" }]);
	});

	it("下拉:最后一个候选删不掉 —— 空候选表存不下去", () => {
		const m = sel();
		expect(removeKnobOption(m, "corner", 0)).toBe(m);
	});
});

describe("knobsError 也管这三档", () => {
	const oneKnob = (knob: unknown) =>
		({ ...manifest(), knobs: [knob] }) as unknown as CardSkinManifest;

	it("数值:min 大于 max", () => {
		const m = oneKnob({ key: "blur", label: "糊化", type: "number", default: 8, min: 40, max: 0 });
		expect(knobsError(m)).toContain("糊化");
	});

	it("数值:改窄取值域把起手位置甩出去了 → 说清楚,不偷偷把它夹回来", () => {
		const m = setKnobNumber(
			oneKnob({ key: "blur", label: "糊化", type: "number", default: 30, min: 0, max: 40 }),
			"blur",
			{ max: 24 },
		);
		// 起手位置原样留着 —— 主人自己摆的,冲掉了他不会知道。
		expect(m.knobs?.[0]).toMatchObject({ default: 30 });
		expect(knobsError(m)).toContain("30");
	});

	it("下拉:起手位置不在候选里", () => {
		const m = oneKnob({
			key: "corner",
			label: "圆角",
			type: "select",
			default: "99px",
			options: [{ value: "12px", label: "圆" }],
		});
		expect(knobsError(m)).toContain("圆角");
	});

	it("下拉 / 开关:字面量带 `;` 或 `}` → 拦下来(那是凭空多出来的 CSS 声明)", () => {
		const m = oneKnob({
			key: "badge",
			label: "徽章",
			type: "switch",
			default: true,
			on: "block;color:red",
			off: "none",
		});
		expect(knobsError(m)).toContain("徽章");
	});
});

/**
 * 皮肤自带字体。清单里的 `asset:assets/<文件>` 只能指**包内**文件 —— 指到别处的话导出的
 * zip 里没有那份文件,别人装上是回落字体,而门禁与本机全绿。
 */
describe("自带字体", () => {
	const withFonts = (...fonts: unknown[]) =>
		({ ...manifest(), fonts }) as unknown as CardSkinManifest;

	it("加一行 / 改 / 删;删空了整个 fonts 键也没了", () => {
		const one = addFont(manifest());
		expect(one.fonts).toHaveLength(1);
		const filled = setFont(setFont(one, 0, { family: "Song" }), 0, {
			asset: "asset:assets/song.ttf",
		});
		expect(filled.fonts?.[0]).toEqual({ family: "Song", asset: "asset:assets/song.ttf" });
		expect("fonts" in removeFont(filled, 0)).toBe(false);
	});

	it("加满上限就加不动了,而且原样返回(空操作不该让草稿变脏)", () => {
		let m = manifest();
		for (let i = 0; i < CARD_SKIN_LIMITS.maxFonts; i++) m = addFont(m);
		expect(m.fonts).toHaveLength(CARD_SKIN_LIMITS.maxFonts);
		expect(addFont(m)).toBe(m);
	});

	it("指着一份还没传上去的资产 → 说清楚(最常见的那一种:先写名字、忘了传文件)", () => {
		const m = withFonts({ family: "Song", asset: "asset:assets/song.ttf" });
		expect(fontsError(m, [])).toContain("没有这份资产");
		expect(fontsError(m, ["assets/song.ttf"])).toBeNull();
	});

	it("名字空了 / 重了 / 没选资产,各说各的", () => {
		expect(fontsError(withFonts({ family: " ", asset: "" }), [])).toContain("名字");
		expect(fontsError(withFonts({ family: "Song", asset: "" }), [])).toContain("哪份资产");
		expect(
			fontsError(
				withFonts(
					{ family: "Song", asset: "asset:assets/a.ttf" },
					{ family: "Song", asset: "asset:assets/b.ttf" },
				),
				["assets/a.ttf", "assets/b.ttf"],
			),
		).toContain("重复");
	});
});

/**
 * **层次**(2026-09-15 主人拍板「重叠是特性,补层次控制」)。
 *
 * 与 `rowSpan` 同一套处置:**等于默认值就不落进清单**。理由多一条 —— 层次 0 的语义是
 * 「没声明」,而「没声明」是个有用的档:块 CSS 里手写的 `z-index` 一直是放行的,把旋钮
 * 调回 0 就是把这件事交还给它。写一个 `z: 0` 进去反而会永久压住那条手写的路。
 */
describe("setBlockGrid — 层次", () => {
	it("拧上去就写进清单", () => {
		expect(gridOf(setBlockGrid(manifest(), "live", "title", { z: 3 }), "title").z).toBe(3);
	});

	it("调回 0 = 删键,不是写一个 0 进去", () => {
		const up = setBlockGrid(manifest(), "live", "title", { z: 3 });
		const down = setBlockGrid(up, "live", "title", { z: 0 });
		expect(gridOf(down, "title").z).toBeUndefined();
		expect("z" in gridOf(down, "title")).toBe(false);
	});

	it("越界夹回边界", () => {
		expect(gridOf(setBlockGrid(manifest(), "live", "title", { z: 99 }), "title").z).toBe(9);
		expect(gridOf(setBlockGrid(manifest(), "live", "title", { z: -5 }), "title").z).toBeUndefined();
	});

	it("改位置不会把层次弄丢 —— 拖一下就掉一层是最难查的那种", () => {
		const up = setBlockGrid(manifest(), "live", "title", { z: 2 });
		expect(gridOf(setBlockGrid(up, "live", "title", { column: 4 }), "title").z).toBe(2);
	});
});

/**
 * **谁和谁占着同一片格子。**
 *
 * 判据是**行区间与列区间都相交** —— 同一行不同列是分栏(决策 6 要的那个),不算叠。
 *
 * ⚠️ 这不是错误检查:靠 `showIf` 互斥地占同一格是**合法技巧**(有视频画视频卡、有图廊
 * 画图廊,两个块摆同一处),而编辑器判不出运行时哪个为真。所以它只用来在面板上说一句
 * 「你俩在同一片格子上,层次大的在上面」,不出警告、不拦保存。
 */
describe("overlappingBlocks", () => {
	const card = (blocks: Array<Record<string, unknown>>) => ({ width: 600, blocks }) as never;
	const at = (id: string, row: number, column: number, span: number, over = {}) => ({
		id,
		kind: "builtin",
		builtin: "title",
		grid: { row, column, span, ...over },
	});

	it("同行、列区间相交 → 叠上了", () => {
		const c = card([at("a", 1, 1, 8), at("b", 1, 6, 6)]);
		expect(overlappingBlocks(c, "a")).toEqual(["b"]);
		expect(overlappingBlocks(c, "b")).toEqual(["a"]);
	});

	it("**同行不同列 → 不算叠**,那是分栏(上舰卡的徽章就靠它)", () => {
		expect(overlappingBlocks(card([at("a", 1, 1, 4), at("b", 1, 5, 8)]), "a")).toEqual([]);
	});

	it("紧挨着不算叠 —— 1–4 与 5–8 之间没有共用的列", () => {
		expect(overlappingBlocks(card([at("a", 1, 1, 4), at("b", 1, 5, 4)]), "a")).toEqual([]);
	});

	it("不同行 → 不算叠,哪怕列整个重合", () => {
		expect(overlappingBlocks(card([at("a", 1, 1, 12), at("b", 2, 1, 12)]), "a")).toEqual([]);
	});

	it("跨行的块与它盖住的那几行都算叠", () => {
		const c = card([at("a", 1, 1, 6, { rowSpan: 3 }), at("b", 3, 1, 6)]);
		expect(overlappingBlocks(c, "a")).toEqual(["b"]);
	});

	it("叠了好几个就都列出来,按块的先后", () => {
		const c = card([at("a", 1, 1, 12), at("b", 1, 1, 3), at("c", 1, 10, 3)]);
		expect(overlappingBlocks(c, "a")).toEqual(["b", "c"]);
	});

	it("卡没定义 / 块不在里头 → 空,别在这儿抛", () => {
		expect(overlappingBlocks(undefined, "a")).toEqual([]);
		expect(overlappingBlocks(card([at("a", 1, 1, 4)]), "没这个块")).toEqual([]);
	});
});

/**
 * 画布**放下**一个块(拖块身 / 拉边)——— 与检查器那几个数字框刻意**不是**同一个口:
 * 放下带着「我把它摆到这儿」的意思,所以叠上了就该在上面;数字框是精确编辑,不该悄悄
 * 改块的先后。
 */
describe("dropBlockGrid", () => {
	const manifest = (blocks: Array<Record<string, unknown>>) =>
		({
			schemaVersion: 1,
			name: "测试皮肤",
			cards: { live: { width: 600, blocks } },
		}) as never;
	const at = (id: string, row: number, column: number, span: number, over = {}) => ({
		id,
		kind: "builtin",
		builtin: "title",
		grid: { row, column, span, ...over },
	});
	const ids = (m: CardSkinManifest) => cardOf(m, "live")?.blocks.map((b) => b.id);
	const blockOf = (m: CardSkinManifest, id: string) =>
		cardOf(m, "live")?.blocks.find((b) => b.id === id);

	it("落到没人的地方 → 只改位置,块的先后一个字不动", () => {
		const m = manifest([at("a", 1, 1, 4), at("b", 2, 1, 4)]);
		const next = dropBlockGrid(m, "live", "a", { row: 3 });
		expect(ids(next)).toEqual(["a", "b"]);
		expect(blockOf(next, "a")?.grid.row).toBe(3);
	});

	it("落到别人身上 → 排到那块之后,于是压在它上面(主人 2026-09-15 报的那条)", () => {
		const m = manifest([at("a", 1, 1, 12), at("b", 2, 1, 12)]);
		const next = dropBlockGrid(m, "live", "a", { row: 2 });
		expect(ids(next)).toEqual(["b", "a"]);
	});

	it("只排到**最后一个压着的块**之后,不是甩到数组末尾 —— diff 别无谓地变大", () => {
		const m = manifest([at("a", 1, 1, 12), at("b", 1, 1, 12), at("c", 9, 1, 12)]);
		const next = dropBlockGrid(m, "live", "a", { row: 1 });
		expect(ids(next)).toEqual(["b", "a", "c"]);
	});

	it("对方写了层次 → 抬到与它**持平**,剩下的交给块的先后", () => {
		const m = manifest([at("a", 1, 1, 12), at("b", 2, 1, 12, { z: 4 })]);
		const next = dropBlockGrid(m, "live", "a", { row: 2 });
		expect(blockOf(next, "a")?.grid.z).toBe(4);
		expect(ids(next)).toEqual(["b", "a"]);
	});

	it("只抬到持平,不凭空发明更高的层 —— 所以永远撞不到上限", () => {
		const m = manifest([at("a", 1, 1, 12), at("b", 2, 1, 12, { z: CARD_SKIN_LIMITS.layer.max })]);
		const next = dropBlockGrid(m, "live", "a", { row: 2 });
		expect(blockOf(next, "a")?.grid.z).toBe(CARD_SKIN_LIMITS.layer.max);
	});

	it("自己层次已经更高 → 不往下降", () => {
		const m = manifest([at("a", 1, 1, 12, { z: 6 }), at("b", 2, 1, 12, { z: 2 })]);
		const next = dropBlockGrid(m, "live", "a", { row: 2 });
		expect(blockOf(next, "a")?.grid.z).toBe(6);
	});

	it("谁都没写层次就一个字节都不写 —— 0 的语义是没声明", () => {
		const m = manifest([at("a", 1, 1, 12), at("b", 2, 1, 12)]);
		const next = dropBlockGrid(m, "live", "a", { row: 2 });
		expect(blockOf(next, "a")?.grid.z).toBeUndefined();
	});

	it("卡没定义 / 块不在里头 → 原样回,别在这儿抛", () => {
		const m = manifest([at("a", 1, 1, 4)]);
		expect(dropBlockGrid(m, "sc", "a", { row: 2 })).toBe(m);
		expect(ids(dropBlockGrid(m, "live", "没这个块", { row: 2 }))).toEqual(["a"]);
	});
});

/**
 * 叠放的**方向**。画布要按深浅把叠起来的块画出来(上层抬升、下层错位露边),
 * 而「相交」本身不分上下 —— 排序规矩必须与渲染器一模一样:先比层次,层次一样退回
 * 数组先后(后来者在上)。
 */
describe("stackingOf", () => {
	const card = (blocks: Array<Record<string, unknown>>) => ({ width: 600, blocks }) as never;
	const at = (id: string, row: number, column: number, span: number, over = {}) => ({
		id,
		kind: "builtin",
		builtin: "title",
		grid: { row, column, span, ...over },
	});

	it("没写层次 → 数组在后的压在上面(与渲染器同一条规矩)", () => {
		const c = card([at("a", 1, 1, 12), at("b", 1, 3, 5)]);
		expect(stackingOf(c, "a")).toEqual({ above: ["b"], below: [] });
		expect(stackingOf(c, "b")).toEqual({ above: [], below: ["a"] });
	});

	it("写了层次就按层次,压得过数组先后", () => {
		const c = card([at("a", 1, 1, 12, { z: 5 }), at("b", 1, 3, 5)]);
		expect(stackingOf(c, "a")).toEqual({ above: [], below: ["b"] });
		expect(stackingOf(c, "b")).toEqual({ above: ["a"], below: [] });
	});

	it("层次一样 → 退回数组先后", () => {
		const c = card([at("a", 1, 1, 12, { z: 3 }), at("b", 1, 3, 5, { z: 3 })]);
		expect(stackingOf(c, "a")).toEqual({ above: ["b"], below: [] });
	});

	it("不写层次 = 没声明,不是第 0 层 —— 写了 0 的与没写的照数组先后比", () => {
		const c = card([at("a", 1, 1, 12), at("b", 1, 3, 5, { z: 1 })]);
		expect(stackingOf(c, "a").above).toEqual(["b"]);
	});

	it("三个叠一起时,中间那块上下都有", () => {
		const c = card([at("a", 1, 1, 12), at("b", 1, 1, 12), at("c", 1, 1, 12)]);
		expect(stackingOf(c, "b")).toEqual({ above: ["c"], below: ["a"] });
	});

	it("不相交的块不参与 —— 同行不同列是分栏", () => {
		const c = card([at("a", 1, 1, 4), at("b", 1, 5, 8)]);
		expect(stackingOf(c, "a")).toEqual({ above: [], below: [] });
	});

	it("卡没定义 / 块不在里头 → 两边都空,别在这儿抛", () => {
		expect(stackingOf(undefined, "a")).toEqual({ above: [], below: [] });
		expect(stackingOf(card([at("a", 1, 1, 4)]), "没这个块")).toEqual({ above: [], below: [] });
	});
});
