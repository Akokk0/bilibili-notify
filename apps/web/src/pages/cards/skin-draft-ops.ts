/**
 * 编辑器改草稿的那几个纯函数 —— **不碰 React**,所以行为能单独钉住。
 *
 * 一律「回一份新的,不动原件」:草稿的脏标与预览的重画都靠**引用变了**触发,就地改的话
 * 两边都察觉不到,界面上看着值变了、预览一动不动(正是「拧了没反应」那一类)。
 */

import type { CardSkinKind, CardSkinKnob, CardSkinManifest } from "@bilibili-notify/contract";
import type { CardSkinColumn } from "@bilibili-notify/internal";
import {
	CARD_SKIN_KNOB_KEY_RE,
	CARD_SKIN_KNOB_LIMITS,
	CARD_SKIN_LIMITS,
} from "@bilibili-notify/internal/constants";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Block = Card["blocks"][number];
type Grid = Block["grid"];
/** 加完一个块:新清单 + 新块的 id(调用方要拿它立刻选中)。 */
type AddedBlock = { manifest: CardSkinManifest; blockId: string };

/** 这张卡的块表。皮肤没定义这种卡时是 `undefined`(出图跟着出厂默认)。 */
export function cardOf(manifest: CardSkinManifest | null, kind: CardSkinKind): Card | undefined {
	return manifest?.cards[kind];
}

export function blockOf(card: Card | undefined, id: string): Block | undefined {
	return card?.blocks.find((b) => b.id === id);
}

/**
 * 把一个数夹进取值域并取整。**夹不是拒**:位置那几个框是数字输入,主人边敲边过 —— 敲到
 * 一半的 `1` 在「0–12」里是合法的,拒了他就永远敲不出 `13` 之外的任何两位数。越界的值
 * 夹回边界,比弹一句错更少打断。
 */
export function clampInt(v: number, min: number, max: number): number {
	if (!Number.isFinite(v)) return min;
	return Math.min(max, Math.max(min, Math.round(v)));
}

/** 位置那四个数各自的取值域。`span` 的上限还要减去起始列 —— 跨出第 12 列没有意义。 */
export function gridLimits(grid: Grid): Record<keyof Grid, { min: number; max: number }> {
	const cols = CARD_SKIN_LIMITS.columns;
	return {
		row: { min: 1, max: CARD_SKIN_LIMITS.maxRows },
		column: { min: 1, max: cols },
		span: { min: 1, max: cols - grid.column + 1 },
		rowSpan: { min: 1, max: CARD_SKIN_LIMITS.maxRows },
	};
}

/**
 * 改一个块的位置。`span` 会跟着起始列收 —— 把块往右拖到第 10 列时,原来跨 12 列的
 * `span` 必须缩到 3,否则清洗器那头直接判它越界,主人看到的是一句「保存失败」而不是
 * 「刚才那一下把它挤出去了」。
 */
export function setBlockGrid(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	blockId: string,
	patch: Partial<Grid>,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card) return manifest;
	const blocks = card.blocks.map((b) => {
		if (b.id !== blockId) return b;
		const merged = { ...b.grid, ...patch };
		const lim = gridLimits(merged);
		const grid: Grid = {
			row: clampInt(merged.row, lim.row.min, lim.row.max),
			column: clampInt(merged.column, lim.column.min, lim.column.max),
			span: clampInt(merged.span, lim.span.min, lim.span.max),
		};
		// `rowSpan` 缺省是 1,而「写一个 1 进去」与「不写」在出图上一样 —— 不写更干净,
		// 也让 diff 里少一行噪音。
		const rowSpan = clampInt(merged.rowSpan ?? 1, lim.rowSpan.min, lim.rowSpan.max);
		if (rowSpan > 1) grid.rowSpan = rowSpan;
		return { ...b, grid };
	});
	return { ...manifest, cards: { ...manifest.cards, [kind]: { ...card, blocks } } };
}

/** 这张卡还加得下块吗。皮肤没定义这种卡(`undefined`)与块数到顶都算加不下。 */
export function canAddBlock(card: Card | undefined): boolean {
	return card !== undefined && card.blocks.length < CARD_SKIN_LIMITS.maxBlocks;
}

/**
 * 往卡里添一个内置块:落在**最后一行的下一行、整宽 12 列**。
 *
 * 这个落点是唯一不会与既有块打架的起手式 —— 往中间塞要么盖住别人、要么得把后面整体
 * 挪一行,而「先落在最底下、再拖到想要的位置」是所有版式工具的通用手势。画布上那条
 * 「空行」画的就是它。
 *
 * 回 `null` 的两种情形:这套皮肤没定义这种卡、块数到顶。**新 id 与新清单一起回** ——
 * 调用方要拿它立刻选中新块,让它自己再算一次就有算出第二个答案的机会。
 */
export function addBlock(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	builtin: string,
): AddedBlock | null {
	return appendBlock(manifest, kind, builtin, (id, grid) => ({
		id,
		kind: "builtin",
		builtin,
		grid,
	}));
}

/**
 * 添一个**自定义块** —— 里面的 HTML 由作者自己写(受限子集,清洗在 server)。
 *
 * 起手那段 HTML 刻意不带占位符:占位符是**按卡种**承诺的,写死一个 `{up.name}` 在词云卡
 * 里就是一条「契约里没有这个字段」的装包错误,而块刚建出来就红着,人会以为是自己点坏了。
 */
export function addCustomBlock(manifest: CardSkinManifest, kind: CardSkinKind): AddedBlock | null {
	return appendBlock(manifest, kind, "custom", (id, grid) => ({
		id,
		kind: "custom",
		html: "<div>新的自定义块</div>",
		grid,
	}));
}

/** 新块落在**最后一行的下一行、整宽**,理由见 {@link addBlock}。 */
function appendBlock(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	idBase: string,
	make: (id: string, grid: Grid) => unknown,
): AddedBlock | null {
	const card = manifest.cards[kind];
	if (!card || !canAddBlock(card)) return null;
	const blockId = nextBlockId(card, idBase);
	const lastRow = card.blocks.reduce(
		(m, b) => Math.max(m, b.grid.row + (b.grid.rowSpan ?? 1) - 1),
		0,
	);
	const block = make(blockId, {
		row: lastRow + 1,
		column: 1,
		span: CARD_SKIN_LIMITS.columns,
	}) as Block;
	return {
		manifest: {
			...manifest,
			cards: { ...manifest.cards, [kind]: { ...card, blocks: [...card.blocks, block] } },
		},
		blockId,
	};
}

/**
 * 给新块起一个这张卡里没人用的 id。
 *
 * 内置块名今天都合规,但 id 是**存进皮肤包**的东西,而门在 schema 那头
 * (`^[a-z][a-z0-9-]{0,31}$`)—— 靠「目录里恰好都是小写」撑着,等于把一条门规矩
 * 寄存在别处的数据上。撞名也得让开:两个同 id 的块在装包门那里直接判「重复」。
 */
function nextBlockId(card: Card, base: string): string {
	const clean =
		base
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/^[^a-z]+/, "")
			.slice(0, 32) || "block";
	const taken = new Set(card.blocks.map((b) => b.id));
	if (!taken.has(clean)) return clean;
	// 候选比块数多(块数已被 `canAddBlock` 挡在上限以下),所以一定能挑出一个。
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const next = `${clean.slice(0, 32 - suffix.length)}${suffix}`;
		if (!taken.has(next)) return next;
	}
}

/**
 * 从卡里删掉一个块。**不回收行号** —— 删掉中间那行后把后面整体上移,会把主人手摆好的
 * 位置全冲掉;空出来的行在出图时高度是 0,留着不碍事。
 */
export function removeBlock(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	blockId: string,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card?.blocks.some((b) => b.id === blockId)) return manifest;
	return {
		...manifest,
		cards: {
			...manifest.cards,
			[kind]: { ...card, blocks: card.blocks.filter((b) => b.id !== blockId) },
		},
	};
}

/**
 * 改卡片外框的几个数。`gap` 写 0 **把键删掉** —— 出图时 `gap?.row ?? 0`,0 与不写同义,
 * 留一个 0 在清单里只是 diff 里的噪音(同 `rowSpan` 为 1 时的处理)。
 */
export function setFrame(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	patch: { width?: number; gapRow?: number; gapColumn?: number },
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card) return manifest;
	const L = CARD_SKIN_LIMITS;
	const next: Card = { ...card };
	if (patch.width !== undefined) next.width = clampInt(patch.width, L.width.min, L.width.max);
	if (patch.gapRow !== undefined || patch.gapColumn !== undefined) {
		const row = clampInt(patch.gapRow ?? card.gap?.row ?? 0, L.gap.min, L.gap.max);
		const column = clampInt(patch.gapColumn ?? card.gap?.column ?? 0, L.gap.min, L.gap.max);
		const gap: NonNullable<Card["gap"]> = {};
		if (row > 0) gap.row = row;
		if (column > 0) gap.column = column;
		if (Object.keys(gap).length > 0) next.gap = gap;
		else delete next.gap;
	}
	return { ...manifest, cards: { ...manifest.cards, [kind]: next } };
}

/**
 * 这张卡 12 列各自多宽 —— 没写 `columns` 就是 12 等分。编辑器照它画那 12 行控件,
 * 「没写」与「写了 12 个 fr:1」在出图上本来就是同一件事。
 */
export function columnsOf(card: Card | undefined): CardSkinColumn[] {
	const fallback = Array.from({ length: CARD_SKIN_LIMITS.columns }, () => ({ fr: 1 }));
	return card?.columns ? [...card.columns] : fallback;
}

/**
 * 改 12 列的宽度。传 `undefined` 把整份 `columns` 删掉(回到 12 等分)。
 *
 * 长度**在这里补齐到恰好 12**:装包门只收 12 项,而少一项的症状是保存时一句
 * 「columns 必须恰好 12 项」—— 面板上根本看不出是哪一步弄丢的。
 */
export function setColumns(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	columns: CardSkinColumn[] | undefined,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card) return manifest;
	const next: Card = { ...card };
	if (columns === undefined) delete next.columns;
	else {
		next.columns = Array.from({ length: CARD_SKIN_LIMITS.columns }, (_, i) =>
			normalizeColumn(columns[i] ?? { fr: 1 }),
		);
	}
	return { ...manifest, cards: { ...manifest.cards, [kind]: next } };
}

/** 一列的宽度夹回门里。`px` 收两位小数 —— 175 / 4 = 43.75 是上舰卡徽章的真实数字。 */
function normalizeColumn(c: CardSkinColumn): CardSkinColumn {
	if ("px" in c) {
		const px = Math.min(CARD_SKIN_LIMITS.width.max, Math.max(1, c.px));
		return { px: Number.isFinite(px) ? Math.round(px * 100) / 100 : 1 };
	}
	return { fr: clampInt(c.fr, 1, CARD_SKIN_LIMITS.columns) };
}

/**
 * 改一个块的 CSS。**只剩空白就把键删掉** —— 装包门那头洗空的 CSS 也是当「没写」处理
 * (不留空串字段),草稿这边留个空串,存一趟回来键就没了,脏标当场又亮起来。
 */
export function setBlockCss(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	blockId: string,
	css: string,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card?.blocks.some((b) => b.id === blockId)) return manifest;
	const blocks = card.blocks.map((b) => {
		if (b.id !== blockId) return b;
		const next = { ...b };
		if (css.trim() === "") delete next.css;
		else next.css = css;
		return next;
	});
	return { ...manifest, cards: { ...manifest.cards, [kind]: { ...card, blocks } } };
}

/** 改卡片外框的 CSS(根块两层)。空白同样删键,理由见 {@link setBlockCss}。 */
export function setFrameCss(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	css: string,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card) return manifest;
	const next: Card = { ...card };
	if (css.trim() === "") delete next.css;
	else next.css = css;
	return { ...manifest, cards: { ...manifest.cards, [kind]: next } };
}

/**
 * 改一个块的 `showIf`(字段为真才画)。`undefined` = 总是显示,把键删掉 —— 空串在装包门
 * 那头过不了字段路径的形状。
 */
export function setBlockShowIf(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	blockId: string,
	showIf: string | undefined,
): CardSkinManifest {
	const card = manifest.cards[kind];
	if (!card?.blocks.some((b) => b.id === blockId)) return manifest;
	const blocks = card.blocks.map((b) => {
		if (b.id !== blockId) return b;
		const next = { ...b };
		if (showIf === undefined || showIf === "") delete next.showIf;
		else next.showIf = showIf;
		return next;
	});
	return { ...manifest, cards: { ...manifest.cards, [kind]: { ...card, blocks } } };
}

/**
 * 改一个**自定义块**的 HTML。内置块没有 html 可改(内容是模板里那一段),原样返回。
 *
 * 空串照写不误:装包门那头会判「清洗后这个块什么都不剩」,而检查器在框底下就先说了这句
 * —— 边删边改的中途状态不该被控件自己拦掉。
 */
export function setBlockHtml(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	blockId: string,
	html: string,
): CardSkinManifest {
	const card = manifest.cards[kind];
	const target = card?.blocks.find((b) => b.id === blockId);
	if (!card || target?.kind !== "custom") return manifest;
	const blocks = card.blocks.map((b) => (b.id === blockId ? { ...b, html } : b));
	return { ...manifest, cards: { ...manifest.cards, [kind]: { ...card, blocks } } };
}

/**
 * 接管一种卡:把出厂默认那张**整份抄进来**,作者在它的基础上改。
 *
 * 抄的必须是深拷贝 —— 源是 react-query 缓存里出厂皮肤的那一份,共用同一批块对象的话,
 * 在这套皮肤里挪一格会顺手改掉缓存里的出厂皮肤(下一次接管抄到的就是改过的)。
 *
 * 已经定义了这种卡就不动它:接管只对空着的卡种开口,覆盖是另一件事(那是「恢复出厂」)。
 */
export function adoptCard(
	manifest: CardSkinManifest,
	kind: CardSkinKind,
	source: Card,
): CardSkinManifest {
	if (manifest.cards[kind]) return manifest;
	return {
		...manifest,
		cards: { ...manifest.cards, [kind]: structuredClone(source) },
	};
}

/** 交还一种卡:整张从清单里删掉,出图时它跟着出厂默认走。 */
export function dropCard(manifest: CardSkinManifest, kind: CardSkinKind): CardSkinManifest {
	if (!manifest.cards[kind]) return manifest;
	const cards = { ...manifest.cards };
	delete cards[kind];
	return { ...manifest, cards };
}

/** 皮肤级元信息的补丁。没给的键不动 —— 三个框各自独立地改。 */
export type SkinMetaPatch = { name?: string; author?: string; description?: string };

/**
 * 改皮肤的名字 / 作者 / 说明。
 *
 * 作者与说明是可选的,**留空删键**(理由同 {@link setBlockCss}:存个空串,皮肤库那行
 * 就画出一个空作者,看着像坏了)。名字不一样 —— 它是必填的,但空的照样落进草稿:在这儿
 * 偷偷保留旧名的话,主人看到的是一个「怎么删都弹回去」的框。拦在 {@link skinMetaError}。
 */
export function setSkinMeta(manifest: CardSkinManifest, patch: SkinMetaPatch): CardSkinManifest {
	const next: CardSkinManifest = { ...manifest };
	if (patch.name !== undefined) next.name = patch.name;
	for (const key of ["author", "description"] as const) {
		const v = patch[key];
		if (v === undefined) continue;
		if (v.trim() === "") delete next[key];
		else next[key] = v;
	}
	return next;
}

/**
 * 这份草稿存不存得下去 —— 保存钮照它变灰。回 `null` = 没问题。
 *
 * 不让主人按下去吃一个 400:装包门那头只回一句「name: 太短」,而皮肤里带名字的东西有
 * 好几样(块有 id、字体有 family),主人根本不知道说的是哪一个。
 */
export function skinMetaError(manifest: CardSkinManifest): string | null {
	const L = CARD_SKIN_LIMITS;
	if (manifest.name.trim().length < L.name.min) return "皮肤得有个名字";
	// 三个框都**不设 `maxLength`**:截断等于悄悄吞掉按键(同 `clampInt` 那条「夹不是拒」
	// 的反面 —— 那边夹的是数,这边吞的是字)。敲得进去,存不下去当场说。
	const over: Array<[string, string, number]> = [
		["皮肤名", manifest.name, L.name.max],
		["作者", manifest.author ?? "", L.author.max],
		["说明", manifest.description ?? "", L.description.max],
	];
	for (const [label, value, max] of over) {
		if (value.length > max) return `${label}最多 ${max} 个字,现在是 ${value.length}`;
	}
	return null;
}

// ---- 旋钮声明 ---------------------------------------------------------------
//
// 皮肤声明几枚旋钮,卡片页那个旋钮区就照声明画几个控件(ADR-0014 决策 16)。编辑器从前
// 一枚都编不了 —— 自制皮肤的旋钮区于是永远是空的,只有出厂那套有。

/** 加完一枚旋钮:新清单 + 新旋钮的 key(调用方要拿它立刻选中)。 */
type AddedKnob = { manifest: CardSkinManifest; key: string };

type Knob = CardSkinKnob;
type KnobType = Knob["type"];

/**
 * 各档的**出厂形状**。改档时整份换成这里的 —— 只改 `type` 不换值的话,
 * 「颜色 → 数值」留下的 `default: "#e0c3fc"` 当场违约,而主人只看见保存失败。
 *
 * `image` 连 `default` 都没有(图是主人自己的东西,皮肤起不出默认值),而清单是 `strict`
 * 的:多带一个键就整份拒收。
 */
const KNOB_SHAPES: { [T in KnobType]: Omit<Extract<Knob, { type: T }>, "key" | "label" | "type"> } =
	{
		color: { default: "#ffffff" },
		number: { default: 0, min: 0, max: 100 },
		select: { default: "none", options: [{ value: "none", label: "候选一" }] },
		switch: { default: false, on: "block", off: "none" },
		font: { default: "" },
		image: {},
	};

const knobsOf = (manifest: CardSkinManifest): Knob[] => manifest.knobs ?? [];

/** 回一份换了旋钮表的清单。空表**删键** —— 清单里留个空数组只是噪音。 */
function withKnobs(manifest: CardSkinManifest, knobs: Knob[]): CardSkinManifest {
	const next: CardSkinManifest = { ...manifest };
	if (knobs.length === 0) delete next.knobs;
	else next.knobs = knobs;
	return next;
}

/** 加一枚颜色旋钮(六档里最常用的那个起手)。加满 {@link CARD_SKIN_KNOB_LIMITS.maxKnobs} 回 `null`。 */
export function addKnob(manifest: CardSkinManifest): AddedKnob | null {
	const knobs = knobsOf(manifest);
	if (knobs.length >= CARD_SKIN_KNOB_LIMITS.maxKnobs) return null;
	const key = nextKnobKey(knobs, "knob");
	return {
		manifest: withKnobs(manifest, [
			...knobs,
			{ key, label: "新旋钮", type: "color", ...KNOB_SHAPES.color },
		]),
		key,
	};
}

/** 让开已经占着的 key。同 {@link nextBlockId}:撞了不换名的话装包门直接判重复。 */
function nextKnobKey(knobs: Knob[], base: string): string {
	const used = new Set(knobs.map((k) => k.key));
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

export function removeKnob(manifest: CardSkinManifest, key: string): CardSkinManifest {
	const knobs = knobsOf(manifest);
	if (!knobs.some((k) => k.key === key)) return manifest;
	return withKnobs(
		manifest,
		knobs.filter((k) => k.key !== key),
	);
}

/** 改一枚旋钮的 key / 人话名。都**照敲的存**,合不合法交给 {@link knobsError} 当场说。 */
export function setKnobDecl(
	manifest: CardSkinManifest,
	key: string,
	patch: { key?: string; label?: string },
): CardSkinManifest {
	return mapKnob(manifest, key, (k) => ({
		...k,
		...(patch.key !== undefined ? { key: patch.key } : {}),
		...(patch.label !== undefined ? { label: patch.label } : {}),
	}));
}

/** 改档。key 与人话名留着,其余整份换成那一档的出厂形状(理由见 {@link KNOB_SHAPES})。 */
export function setKnobType(
	manifest: CardSkinManifest,
	key: string,
	type: KnobType,
): CardSkinManifest {
	return mapKnob(manifest, key, (k) =>
		k.type === type
			? k
			: ({ key: k.key, label: k.label, type, ...KNOB_SHAPES[type] } as unknown as Knob),
	);
}

/** 改起手位置。各档的 `default` 类型不同(颜色是 hex、数值是数、开关是布尔)。 */
export function setKnobDefault(
	manifest: CardSkinManifest,
	key: string,
	value: string | number | boolean,
): CardSkinManifest {
	return mapKnob(manifest, key, (k) =>
		k.type === "image" ? k : ({ ...k, default: value } as unknown as Knob),
	);
}

function mapKnob(
	manifest: CardSkinManifest,
	key: string,
	fn: (knob: Knob) => Knob,
): CardSkinManifest {
	const knobs = knobsOf(manifest);
	if (!knobs.some((k) => k.key === key)) return manifest;
	return withKnobs(
		manifest,
		knobs.map((k) => (k.key === key ? fn(k) : k)),
	);
}

/**
 * 这套旋钮声明存不存得下去。装包门那头回的是 `knobs[3]: 旋钮 key「accent」重复` ——
 * 那个 3 对不上界面上第几行(主人得自己数),而且要按保存才看得见。这里提前说人话。
 */
export function knobsError(manifest: CardSkinManifest): string | null {
	const seen = new Set<string>();
	for (const knob of knobsOf(manifest)) {
		if (!CARD_SKIN_KNOB_KEY_RE.test(knob.key) || knob.key.length > CARD_SKIN_KNOB_LIMITS.key.max) {
			return `旋钮 key「${knob.key}」不合法 —— 只准小写字母起头的 kebab(如 accent / glass-opacity)`;
		}
		if (seen.has(knob.key)) return `旋钮 key「${knob.key}」重复了 —— 两枚注的是同一个变量`;
		seen.add(knob.key);
		if (knob.label.trim() === "") return `旋钮「${knob.key}」得有个名字`;
		if (knob.label.length > CARD_SKIN_KNOB_LIMITS.label.max) {
			return `旋钮「${knob.key}」的名字最多 ${CARD_SKIN_KNOB_LIMITS.label.max} 个字`;
		}
	}
	return null;
}
