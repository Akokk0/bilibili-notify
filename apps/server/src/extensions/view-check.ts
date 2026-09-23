import type {
	ExtensionPanelBlock,
	ExtensionPanelItem,
	ExtensionPanelView,
	ExtensionViewFault,
} from "@bilibili-notify/contract";
import type {
	ExtensionBlock,
	ExtensionButton,
	ExtensionItemView,
} from "@bilibili-notify/extension";
import {
	blockButtons,
	blockImageRefs,
	EXTENSION_BLOCK_TYPES,
	EXTENSION_VIEW_MAX_BYTES,
	EXTENSION_VIEW_MAX_PAGE_BLOCKS,
	ExtensionItemViewSchema,
	type ExtensionManifestField,
	type ExtensionManifestListField,
	ExtensionPageBlockSchema,
	ExtensionViewImagesSchema,
	ExtensionViewSummarySchema,
	formatZodIssues,
	imageMissing,
	isSecretField,
	LIST_ITEM_ID_KEY,
} from "@bilibili-notify/internal";
import type { ZodError } from "zod";

/**
 * 宿主怎么核一份 v2 视图(ADR-0019 决策 39 / 40)—— ctx 的 `status()` 每被问一次就走一遍这里。
 *
 * **按主人看的单位降级**:页上按块、列表按项、摘要单独。坏的只换掉那一块 / 那一项,换成一条点名
 * 「哪儿、为什么」的 {@link ExtensionViewFault};好的原样交出去。从前是「一格不对整份不画」:一个
 * 对端报来的超长名字就让整页连同列表页那一行一起消失,逼得每个拓展抄一份宿主的上限自己截断。
 *
 * 不看清单就判得了的规矩在 `@bilibili-notify/internal` 那几块 schema 里;这里多出来的是只有宿主判
 * 得了的:`items` 的键要对得上清单与存着的设置、「改设置」只许改这一项声明过的格、整份的字节上限。
 *
 * 🔴 「坏了」的标记(`{ fault }`)是这里造的,与拓展交的 `{ block }` / `{ view }` 并列 —— 拓展那份
 * schema 里没有这一层,它造不出一条假的「宿主报错」。
 */

export interface ViewCheckInput {
	/** 清单里声明的设置项(v2 的 `settings.fields`)—— `items` 的第一层键只认其中的列表。 */
	fields: readonly ExtensionManifestField[];
	/** 存着的设置,原样 —— `items` 的第二层键只认那张列表里现存的项。 */
	settings: unknown;
	/** 整份序列化后的上限,见 {@link EXTENSION_VIEW_MAX_BYTES}。只有测试会换。 */
	maxBytes?: number;
}

export interface ViewCheck {
	/** 交给面板的那一份。 */
	view: ExtensionPanelView;
	/** 这一次不合规矩的每一处,一句一条 —— ctx 拿去记日志(同一句只记一次)。 */
	problems: string[];
}

/** 积木的中文名 —— 点名「页上第 2 块(表格)」。 */
const BLOCK_LABELS: Readonly<Record<ExtensionBlock["type"], string>> = {
	keyValue: "键值",
	table: "表格",
	notice: "提示条",
	copy: "可复制的值",
	qr: "二维码",
	button: "按钮",
};

/** 列表项那张卡上的提示点名的是它自己 —— 卡就是「哪一项」。 */
const ITEM_WHERE = "这一项";
const WHOLE_WHERE = "整份视图";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const reasonOf = (error: ZodError) => formatZodIssues(error).join(";");

function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** 念给人看的大小:到 0.1 KB。 */
function kb(bytes: number): string {
	return `${Number((bytes / 1024).toFixed(1))} KB`;
}

/** 清单里的列表设置项。Map:键是拓展起的名字,不拿普通对象按下标查。 */
function listsOf(
	fields: readonly ExtensionManifestField[],
): Map<string, ExtensionManifestListField> {
	const lists = new Map<string, ExtensionManifestListField>();
	for (const field of fields) if (field.type === "list") lists.set(field.key, field);
	return lists;
}

/** 这张列表里现存的项的 id(照存着的设置)。 */
function itemIdsOf(settings: unknown, list: string): string[] {
	const items =
		isPlainObject(settings) && Object.hasOwn(settings, list) ? settings[list] : undefined;
	if (!Array.isArray(items)) return [];
	return items.flatMap((item) => {
		const id = isPlainObject(item) ? item[LIST_ITEM_ID_KEY] : undefined;
		return typeof id === "string" ? [id] : [];
	});
}

/**
 * 整份都用不了(不是一个对象、交回的是 Promise、回调抛了……)—— 页上一条提示,**每一条现存的项
 * 也各一条**:那张卡写「状态未知」加同一句话,主人在「配置」页签上也看得见为什么。
 */
export function faultedExtensionView(reason: string, input: ViewCheckInput): ViewCheck {
	const fault: ExtensionViewFault = { where: WHOLE_WHERE, reason };
	const items: Record<string, Record<string, ExtensionPanelItem>> = {};
	for (const list of listsOf(input.fields).keys()) {
		const ids = itemIdsOf(input.settings, list);
		if (ids.length === 0) continue;
		items[list] = Object.fromEntries(
			ids.map((id) => [id, { fault: { where: ITEM_WHERE, reason } }]),
		);
	}
	return {
		view: { page: [{ fault }], ...(Object.keys(items).length > 0 ? { items } : {}) },
		problems: [`${WHOLE_WHERE}画不出来:${reason}`],
	};
}

/** 核一份视图,见文件头。`raw` 是拓展回调交回的东西,原样。 */
export function checkExtensionView(raw: unknown, input: ViewCheckInput): ViewCheck {
	if (!isPlainObject(raw)) {
		return faultedExtensionView(
			`交来的不是一个对象(是 ${raw === null ? "null" : Array.isArray(raw) ? "数组" : typeof raw})`,
			input,
		);
	}
	const problems: string[] = [];
	const images = checkImages(raw.images, problems);
	const page: ExtensionPanelBlock[] = [];

	const extra = Object.keys(raw).filter((key) => !VIEW_KEYS.has(key));
	if (extra.length > 0) {
		page.push(
			fault(
				problems,
				WHOLE_WHERE,
				`多了 BN 不认识的一格:${extra.join("、")} —— 视图只有 summary / page / items / images 这四格`,
			),
		);
	}

	let summary: ExtensionPanelView["summary"];
	if (raw.summary !== undefined) {
		const parsed = ExtensionViewSummarySchema.safeParse(raw.summary);
		if (parsed.success) summary = parsed.data;
		else problems.push(`摘要画不出来,列表页那一行不说了:${reasonOf(parsed.error)}`);
	}

	if (raw.page !== undefined) page.push(...checkPage(raw.page, images, problems));

	const items =
		raw.items === undefined ? undefined : checkItems(raw.items, input, images, problems);

	const view = assemble(summary, page, items, images.good);
	return { view: fitWithin(view, input.maxBytes ?? EXTENSION_VIEW_MAX_BYTES, problems), problems };
}

const VIEW_KEYS: ReadonlySet<string> = new Set(["summary", "page", "items", "images"]);

/** 换上一条提示,顺手记进 `problems`。 */
function fault(problems: string[], where: string, reason: string, logAs = where) {
	problems.push(`${logAs}画不出来:${reason}`);
	return { fault: { where, reason } };
}

// ---- 图片字典 ------------------------------------------------------------------------

interface CheckedImages {
	/** 合规矩的那几张。Map:键是拓展起的名字。 */
	good: Map<string, string>;
	/** 不合规矩的那几张为什么不行 —— 引用它们的块要说得出来。 */
	bad: Map<string, string>;
}

/** 一张一张地核:坏一张不连累别的,引用它的那几块在后面各自画不出来。 */
function checkImages(raw: unknown, problems: string[]): CheckedImages {
	const good = new Map<string, string>();
	const bad = new Map<string, string>();
	if (raw === undefined) return { good, bad };
	if (!isPlainObject(raw)) {
		problems.push("images 不是一张「键 → 图片」的表,这一份里的图一张都不画");
		return { good, bad };
	}
	for (const [key, value] of Object.entries(raw)) {
		const parsed = ExtensionViewImagesSchema.safeParse({ [key]: value });
		if (parsed.success) {
			good.set(key, value as string);
		} else {
			const reason = reasonOf(parsed.error);
			bad.set(key, reason);
			problems.push(`images.${reason}`);
		}
	}
	return { good, bad };
}

/** 一块积木引用的图都在不在(且合规矩)—— 不在的逐格点名。 */
function imageIssues(block: ExtensionBlock, images: CheckedImages, at: string): string[] {
	return blockImageRefs(block).flatMap(({ path, key }) => {
		if (images.good.has(key)) return [];
		const where = [at, ...path].filter((part) => part !== "").join(".");
		const why = images.bad.get(key);
		return [
			why === undefined
				? `${where}: ${imageMissing(key)}`
				: `${where}: 引用的图片「${key}」不合规矩(images.${why})`,
		];
	});
}

// ---- 页:按块 --------------------------------------------------------------------------

function blockLabel(raw: unknown): string {
	const type = isPlainObject(raw) ? raw.type : undefined;
	if (typeof type !== "string") return "不是一块积木";
	return Object.hasOwn(BLOCK_LABELS, type)
		? BLOCK_LABELS[type as ExtensionBlock["type"]]
		: `「${type}」`;
}

function checkPage(raw: unknown, images: CheckedImages, problems: string[]): ExtensionPanelBlock[] {
	if (!Array.isArray(raw)) {
		return [fault(problems, "页上的积木", "page 应该是一串积木")];
	}
	const slots = raw.slice(0, EXTENSION_VIEW_MAX_PAGE_BLOCKS).map((block, i) => {
		const where = `页上第 ${i + 1} 块(${blockLabel(block)})`;
		const type = isPlainObject(block) ? block.type : undefined;
		if (typeof type === "string" && !(EXTENSION_BLOCK_TYPES as readonly string[]).includes(type)) {
			return fault(
				problems,
				where,
				`不认识「${type}」这种积木 —— 积木是封闭的一组(${EXTENSION_BLOCK_TYPES.join(" / ")}),缺了等 BN 加`,
			);
		}
		const parsed = ExtensionPageBlockSchema.safeParse(block);
		if (!parsed.success) return fault(problems, where, reasonOf(parsed.error));
		const missing = imageIssues(parsed.data, images, "");
		if (missing.length > 0) return fault(problems, where, missing.join(";"));
		return { block: parsed.data };
	});
	const dropped = raw.length - EXTENSION_VIEW_MAX_PAGE_BLOCKS;
	if (dropped > 0) {
		slots.push(
			fault(
				problems,
				`页上第 ${EXTENSION_VIEW_MAX_PAGE_BLOCKS + 1} 块起`,
				`页上最多 ${EXTENSION_VIEW_MAX_PAGE_BLOCKS} 块,后面 ${dropped} 块没画`,
			),
		);
	}
	return slots;
}

// ---- 列表:按项 ------------------------------------------------------------------------

type PanelItems = Map<string, Map<string, ExtensionPanelItem>>;

function checkItems(
	raw: unknown,
	input: ViewCheckInput,
	images: CheckedImages,
	problems: string[],
): PanelItems {
	const lists = listsOf(input.fields);
	const out: PanelItems = new Map();
	/** 这张列表整张用不了 —— 现存的每一项各一条。 */
	const faultAll = (list: string, reason: string) => {
		problems.push(`items.${list} 画不出来:${reason}`);
		const ids = itemIdsOf(input.settings, list);
		if (ids.length === 0) return;
		out.set(list, new Map(ids.map((id) => [id, { fault: { where: ITEM_WHERE, reason } }])));
	};
	if (!isPlainObject(raw)) {
		for (const list of lists.keys()) {
			faultAll(list, "items 应该是「列表的 key → 项的 id → 这一项」的一张表");
		}
		return out;
	}
	for (const [list, byId] of Object.entries(raw)) {
		const field = lists.get(list);
		if (!field) {
			problems.push(`items 里的「${list}」不是清单里声明过的列表设置项 —— 这一格不画`);
			continue;
		}
		if (!isPlainObject(byId)) {
			faultAll(list, `items.${list} 应该是「项的 id → 这一项」的一张表`);
			continue;
		}
		const existing = new Set(itemIdsOf(input.settings, list));
		const checked = new Map<string, ExtensionPanelItem>();
		for (const [id, item] of Object.entries(byId)) {
			if (!existing.has(id)) {
				problems.push(`items.${list} 里的「${id}」不是这张列表里现存的项 —— 这一格不画`);
				continue;
			}
			const verdict = checkItem(item, field, images);
			checked.set(
				id,
				"view" in verdict
					? verdict
					: fault(problems, ITEM_WHERE, verdict.reason, `items.${list} 里的「${id}」`),
			);
		}
		out.set(list, checked);
	}
	return out;
}

/** 核一项:合规矩交出核过的那份,不合规矩说清哪里。 */
function checkItem(
	raw: unknown,
	field: ExtensionManifestListField,
	images: CheckedImages,
): { view: ExtensionItemView } | { reason: string } {
	const parsed = ExtensionItemViewSchema.safeParse(raw);
	if (!parsed.success) return { reason: reasonOf(parsed.error) };
	const item = parsed.data;
	const issues: string[] = [];
	const sections = [
		["lead", item.lead ?? []],
		["blocks", item.blocks ?? []],
	] as const;
	const buttons: { at: string; button: ExtensionButton }[] = (item.buttons ?? []).map(
		(button, i) => ({ at: `buttons.${i}`, button }),
	);
	for (const [section, blocks] of sections) {
		blocks.forEach((block, i) => {
			issues.push(...imageIssues(block, images, `${section}.${i}`));
			for (const { path, button } of blockButtons(block)) {
				buttons.push({ at: [section, i, ...path].join("."), button });
			}
		});
	}
	for (const { at, button } of buttons) {
		if (button.kind === "set") issues.push(...setIssues(button.set, field, `${at}.set`));
	}
	return issues.length > 0 ? { reason: issues.join(";") } : { view: item };
}

/**
 * 「改设置」的按钮只许改**这一项声明过的格**(决策 39):`id` 是 BN 给的身份(决策 29);密钥与
 * 生成的格有自己的路(重新生成),一颗按钮换掉它等于替主人作废对面正用着的钥匙;值的类型要对得上
 * —— 不然那一发写要么被拒(主人按了没反应),要么写进去一份拓展自己一读就整份失败的设置。
 */
function setIssues(
	set: Readonly<Record<string, string | number | boolean>>,
	list: ExtensionManifestListField,
	at: string,
): string[] {
	const fields = new Map(list.fields.map((sub) => [sub.key, sub]));
	return Object.entries(set).flatMap(([key, value]) => {
		const where = `${at}.${key}`;
		if (key === LIST_ITEM_ID_KEY) return [`${where}: id 是 BN 给每一项的身份,按钮改不了`];
		const sub = fields.get(key);
		if (!sub) return [`${where}: 「${key}」不是这张列表声明过的格`];
		if (isSecretField(sub)) {
			return [`${where}: 「${key}」是密钥 / 生成的格,按钮改不了 —— 要换走「重新生成」`];
		}
		const expected = sub.type === "enum" ? "string" : sub.type;
		if (typeof value !== expected) {
			return [`${where}: 「${key}」是 ${sub.type},给的是 ${typeof value}`];
		}
		if (sub.type === "enum" && !sub.options.some((option) => option.value === value)) {
			return [`${where}: 「${key}」的选项里没有 ${JSON.stringify(value)}`];
		}
		return [];
	});
}

// ---- 拼起来,再按字节上限降级 ---------------------------------------------------------

/** 块与项里还有人引用的图。 */
function referencedImages(
	page: readonly ExtensionPanelBlock[],
	items: PanelItems | undefined,
): Set<string> {
	const blocks: ExtensionBlock[] = [];
	for (const slot of page) if ("block" in slot) blocks.push(slot.block);
	for (const byId of items?.values() ?? []) {
		for (const slot of byId.values()) {
			if ("view" in slot) blocks.push(...(slot.view.lead ?? []), ...(slot.view.blocks ?? []));
		}
	}
	return new Set(blocks.flatMap((block) => blockImageRefs(block).map((ref) => ref.key)));
}

function assemble(
	summary: ExtensionPanelView["summary"],
	page: ExtensionPanelBlock[],
	items: PanelItems | undefined,
	images: ReadonlyMap<string, string>,
): ExtensionPanelView {
	const used = referencedImages(page, items);
	const kept = [...images].filter(([key]) => used.has(key));
	return {
		...(summary === undefined ? {} : { summary }),
		...(page.length > 0 ? { page } : {}),
		...(items === undefined
			? {}
			: {
					items: Object.fromEntries(
						[...items].map(([list, byId]) => [list, Object.fromEntries(byId)]),
					),
				}),
		...(kept.length > 0 ? { images: Object.fromEntries(kept) } : {}),
	};
}

/** 一块 / 一项 / 摘要 —— 超了上限时能放下的单位。 */
type Unit =
	| { kind: "summary"; weight: number }
	| { kind: "page"; index: number; weight: number }
	| { kind: "item"; list: string; id: string; weight: number };

/**
 * 整份超了字节上限(决策 39):**按块 / 按项**降级,先放下最重的那一块(连同它引用的图一起算 ——
 * 字少图大的那块才是真正的分量),直到整份回到上限以内。放下的那块换成一条说清「整份多大、上限
 * 多大、它多大」的提示;摘要放下就是不画。
 */
function fitWithin(view: ExtensionPanelView, max: number, problems: string[]): ExtensionPanelView {
	const total = bytesOf(view);
	if (total <= max) return view;

	const images = view.images ?? {};
	const imageBytes = (blocks: readonly ExtensionBlock[]) => {
		const keys = new Set(blocks.flatMap((block) => blockImageRefs(block).map((ref) => ref.key)));
		let sum = 0;
		for (const key of keys) if (Object.hasOwn(images, key)) sum += bytesOf(images[key]);
		return sum;
	};
	const units: Unit[] = [];
	if (view.summary) units.push({ kind: "summary", weight: bytesOf(view.summary) });
	view.page?.forEach((slot, index) => {
		if ("block" in slot) {
			units.push({ kind: "page", index, weight: bytesOf(slot) + imageBytes([slot.block]) });
		}
	});
	for (const [list, byId] of Object.entries(view.items ?? {})) {
		for (const [id, slot] of Object.entries(byId)) {
			if (!("view" in slot)) continue;
			const blocks = [...(slot.view.lead ?? []), ...(slot.view.blocks ?? [])];
			units.push({ kind: "item", list, id, weight: bytesOf(slot) + imageBytes(blocks) });
		}
	}
	units.sort((a, b) => b.weight - a.weight);

	let summary = view.summary;
	const page = [...(view.page ?? [])];
	const items: PanelItems | undefined = view.items
		? new Map(
				Object.entries(view.items).map(([list, byId]) => [list, new Map(Object.entries(byId))]),
			)
		: undefined;
	const goodImages = new Map(Object.entries(images));
	let current = view;
	for (const unit of units) {
		const reason = `整份视图序列化后 ${kb(total)},超过上限 ${kb(max)};这一块连同它引用的图有 ${kb(unit.weight)},先不画它 —— 把它拆小,或者少放几张图`;
		if (unit.kind === "summary") {
			summary = undefined;
			problems.push(`摘要画不出来,列表页那一行不说了:${reason}`);
		} else if (unit.kind === "page") {
			const where = `页上第 ${unit.index + 1} 块(${blockLabel((page[unit.index] as { block: unknown }).block)})`;
			page[unit.index] = fault(problems, where, reason);
		} else {
			items
				?.get(unit.list)
				?.set(
					unit.id,
					fault(problems, ITEM_WHERE, reason, `items.${unit.list} 里的「${unit.id}」`),
				);
		}
		current = assemble(summary, page, items, goodImages);
		if (bytesOf(current) <= max) break;
	}
	return current;
}
