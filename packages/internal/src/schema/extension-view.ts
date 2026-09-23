import { z } from "zod";
import { ActionNameSchema, ExtensionImageSchema, FieldKeySchema } from "./extension-manifest";

/**
 * 拓展交给面板的「视图」—— v2 的 `ctx.publishView` 交的就是它(ADR-0019 决策 20 / 26–28,
 * 09-23 决策 39 改过一轮)。
 *
 * 一组**封闭的积木**,由 BN 照着画:拓展只说「画什么」,不说「怎么画」,也不带任何代码、HTML
 * 或表达式 —— 派生的东西(桥的四态、「对不上」)由拓展算好交来。缺一种积木就等 BN 加,加的时候
 * 抬契约档位(`EXTENSION_API_RANGE.current`),所以这份 schema 是**严格**的:多一个键就不画 ——
 * 拼错的键放过去就是一块静默不显示的积木。
 *
 * 宿主**逐块 / 逐项**拿这里的几块校验(决策 40):页上按块、列表按项、摘要单独,坏的只换掉那一块
 * (`apps/server/src/extensions/view-check.ts`)。要看清单与存着的设置才判得了的几条(`items` 的
 * 键是不是声明过的列表、项还在不在、「改设置」改的格合不合那一格的声明)与整份的字节上限也在
 * 那头 —— 这里只有不看清单就判得了的。
 *
 * 🔴 `@bilibili-notify/extension` 的 `wire.ts` 有一份手写镜像(拓展与面板认的是它),两份由宿主
 * 那头的类型断言**双向严格相等**地钉住(`apps/server/src/extensions/view-shape-pin.ts`)——
 * 这里改一格,那边不跟着改就过不了类型检查。数组与字典标 `.readonly()` 是为了对上那份的 `readonly`。
 */

/**
 * 整份视图序列化(JSON、UTF-8)之后的上限。面板每收到一声 `statusChanged()` 就整份重拉一次,
 * 两百个 bot 的桥视图内联图片时八百多 KB —— 这是图片挪进字典(决策 39)之后仍要有的那道闸。
 * 超了宿主按块 / 按项降级,先放下最重的那几块。
 */
export const EXTENSION_VIEW_MAX_BYTES = 256 * 1024;

/** 一段字里的一片 —— 只有这五种(决策 28)。没有表达式、没有 HTML。 */
const RichRunSchema = z.union([
	z.string().max(2000),
	z.strictObject({ b: z.string().max(2000) }),
	z.strictObject({ mono: z.string().max(2000) }),
	/**
	 * 一个时刻(毫秒),浏览器按「N 分钟前」画 —— 服务端算好的相对时间发到面板就冻住了。
	 * `suffix` 接在后面(「连上」→「12 分钟前连上」)。
	 */
	z.strictObject({ time: z.number().int().nonnegative(), suffix: z.string().max(40).optional() }),
	/**
	 * BN **在浏览器里**现算的地址:`ws(s)://<地址栏的 host>/ext/<id>`。服务端不知道外面经哪个
	 * 地址访问它,而那正是桥那台机器要填的。
	 */
	z.strictObject({ host: z.literal("extensionUrl") }),
]);

/** 一段字:一个字符串,或者一串片段。 */
export const RichTextSchema = z.union([
	z.string().max(2000),
	z.array(RichRunSchema).max(64).readonly(),
]);

/** 状态的语气 —— 同时决定卡角那团颜色。 */
const ToneSchema = z.enum(["ok", "warn", "error", "off"]);

/**
 * 图片字典的键 —— 格子与二维码拿它引用 `images` 里的一张。
 *
 * 🔴 拓展多半拿对端报的名字(平台名)去凑键,而字典在面板那头是个普通对象:`constructor` /
 * `__proto__` 这种按下标一读就摸到原型上的东西,所以与设置项的 key 同一条,单独拒。
 */
const ViewImageKeySchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "图片的键只能是字母或数字开头的字母、数字与 _ . : -")
	.refine(
		(key) => !Object.hasOwn(Object.prototype, key),
		"图片的键不能用 JS 对象原型上的名字(constructor / toString 这类)",
	);

/**
 * 视图顶层的图片字典:键 → 图片的 base64 data URL(决策 39)。单张的类型与大小沿用选项图标那一条
 * ({@link ExtensionImageSchema},决策 31);同一张图只放一份,格子按键引用。
 */
export const ExtensionViewImagesSchema = z
	.record(ViewImageKeySchema, ExtensionImageSchema)
	.readonly();

/**
 * 按钮 —— 显式带 `kind`(决策 39)。从前靠「有没有 `action` / `set` 这个键」分,类型挡不住两个键
 * 同时写,面板按哪一种画全凭它先查哪个键。
 */
export const ExtensionButtonSchema = z.discriminatedUnion("kind", [
	/**
	 * 调拓展:清单 `actions` 里声明、代码 `ctx.onAction` 接(决策 22)。名字在不在清单里要看清单,
	 * 那一道在宿主那头(决策 42)。
	 */
	z.strictObject({
		kind: z.literal("action"),
		label: z.string().min(1).max(32),
		action: ActionNameSchema,
	}),
	/**
	 * 让 BN 改**这一项**的一格设置(桥的「改成 AstrBot」)—— 只许挂在列表项上;改哪几格要合那张
	 * 列表的声明(不碰 `id`、密钥与生成的格,值的类型对得上),那两道要看清单,在宿主那头。
	 * 写路径仍是 BN 那一条,照样过设置校验。
	 */
	z.strictObject({
		kind: z.literal("set"),
		label: z.string().min(1).max(32),
		set: z
			.record(FieldKeySchema, z.union([z.string(), z.number(), z.boolean()]))
			.refine((set) => Object.keys(set).length > 0, "「改设置」的按钮至少要改一格")
			.readonly(),
	}),
]);

/** 表格的一列。 */
const ColumnSchema = z.discriminatedUnion("kind", [
	/** 方块:拓展给的图,没有就两个字(决策 31 —— BN 不拿自己的平台表去补)。 */
	z.strictObject({ kind: z.literal("icon") }),
	/** 字,可带第二行(等宽小字);`width` 定宽 —— 让后面的列在同一条竖线上起排。 */
	z.strictObject({ kind: z.literal("text"), width: z.number().int().min(40).max(480).optional() }),
	z.strictObject({ kind: z.literal("mono") }),
	/** 三态:支持 / 不支持 / 还不知道。页上一出现,BN 就在列表头挂一次图例。 */
	z.strictObject({ kind: z.literal("tristate"), label: z.string().min(1).max(24) }),
]);

/**
 * 表格的一格 —— **自带种类**,与列的 `kind` 同一套词(决策 39)。宿主只核「这一格与这一列同种」;
 * 从前按位置对列,格子在类型里只能是 `unknown`,一个字符串落在 icon 列上照样过得了类型检查。
 */
export const ExtensionTableCellSchema = z.discriminatedUnion("kind", [
	/** `image` 是 `images` 字典里的键;没有(或没给)就印 `fallback` 那两个字。 */
	z.strictObject({
		kind: z.literal("icon"),
		image: ViewImageKeySchema.optional(),
		fallback: z.string().min(1).max(2),
	}),
	z.strictObject({
		kind: z.literal("text"),
		text: z.string().max(200),
		sub: z.string().max(200).optional(),
	}),
	z.strictObject({ kind: z.literal("mono"), text: z.string().max(200) }),
	z.strictObject({ kind: z.literal("tristate"), value: z.enum(["yes", "no", "unknown"]) }),
]);

const TableSchema = z
	.strictObject({
		type: z.literal("table"),
		title: z.string().max(40).optional(),
		/** 标题旁边带一个行数。 */
		count: z.boolean().optional(),
		/** 一行都没有时那句话。 */
		empty: RichTextSchema.optional(),
		columns: z.array(ColumnSchema).min(1).max(12).readonly(),
		rows: z.array(z.array(ExtensionTableCellSchema).readonly()).max(200).readonly(),
	})
	.superRefine((table, ctx) => {
		table.rows.forEach((row, r) => {
			if (row.length !== table.columns.length) {
				ctx.addIssue({
					code: "custom",
					path: ["rows", r],
					message: `这一行有 ${row.length} 格,表头是 ${table.columns.length} 列`,
				});
				return;
			}
			row.forEach((cell, c) => {
				const column = table.columns[c]?.kind;
				if (cell.kind !== column) {
					ctx.addIssue({
						code: "custom",
						path: ["rows", r, c],
						message: `这一格是 ${cell.kind},那一列是 ${column}`,
					});
				}
			});
		});
	});

/** 一块积木。 */
export const ExtensionBlockSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("keyValue"),
		items: z
			.array(
				z.strictObject({
					label: z.string().min(1).max(24),
					value: RichTextSchema,
					tone: ToneSchema.optional(),
				}),
			)
			.min(1)
			.max(12)
			.readonly(),
	}),
	TableSchema,
	z.strictObject({
		type: z.literal("notice"),
		tone: z.enum(["info", "warn", "error"]),
		text: RichTextSchema,
		button: ExtensionButtonSchema.optional(),
	}),
	z.strictObject({
		type: z.literal("copy"),
		label: z.string().min(1).max(24),
		value: z.union([z.string().max(2000), z.strictObject({ host: z.literal("extensionUrl") })]),
		note: RichTextSchema.optional(),
	}),
	/** 二维码 —— 拓展生成好的图片(B 站登录那张就是这么交的),BN 只画。`image` 是字典里的键。 */
	z.strictObject({
		type: z.literal("qr"),
		image: ViewImageKeySchema,
		caption: RichTextSchema.optional(),
	}),
	/** 一颗单独的按钮。按钮自己带 `kind`,所以包一层,不和积木的 `type` 摊在一处(决策 39)。 */
	z.strictObject({ type: z.literal("button"), button: ExtensionButtonSchema }),
]);

/** 积木的种类 —— 宿主点名「页上第几块(表格)」时拿它认。 */
export const EXTENSION_BLOCK_TYPES = ExtensionBlockSchema.options.map(
	(option) => option.shape.type.value,
);

const SET_ON_PAGE = "「改设置」的按钮改的是某一项的一格,只能挂在列表项上";

/** 页级积木的规矩外加一条:「改设置」的按钮改的是某一项的一格,页上没有「这一项」。 */
export const ExtensionPageBlockSchema = ExtensionBlockSchema.superRefine((block, ctx) => {
	for (const { path, button } of blockButtons(block)) {
		if (button.kind === "set") {
			ctx.addIssue({ code: "custom", path: [...path, "set"], message: SET_ON_PAGE });
		}
	}
});

/** 列表的一项在卡上的那几格(决策 26)。 */
export const ExtensionItemViewSchema = z.strictObject({
	/** 状态字 + 卡角的颜色。停用的项由 BN 盖成「已停用」,这里报什么都不算。 */
	status: z.strictObject({ tone: ToneSchema, text: z.string().min(1).max(40) }).optional(),
	/** 标题旁的小药丸。 */
	pill: z.string().min(1).max(32).optional(),
	subtitle: RichTextSchema.optional(),
	/** 卡头右边的按钮,排在 BN 自己的「编辑 / 停用 / 删除」前面。 */
	buttons: z.array(ExtensionButtonSchema).max(4).readonly().optional(),
	/** 画在 BN 画的字段行(token 行这种)**上面**的积木 —— 要人先看见的提示放这儿。 */
	lead: z.array(ExtensionBlockSchema).max(8).readonly().optional(),
	/** 画在字段行下面的积木。 */
	blocks: z.array(ExtensionBlockSchema).max(32).readonly().optional(),
});

/** 拓展列表页那一行(今天那句「N 个 bot 在线」是面板里专为桥写的)。 */
export const ExtensionViewSummarySchema = z.strictObject({
	tone: ToneSchema.optional(),
	text: RichTextSchema,
});

/** 页上最多几块。多出来的宿主不画,换一条提示说清少画了几块。 */
export const EXTENSION_VIEW_MAX_PAGE_BLOCKS = 32;

type Block = z.infer<typeof ExtensionBlockSchema>;
type Button = z.infer<typeof ExtensionButtonSchema>;

/**
 * 一块积木里的按钮(单独一颗的、提示条上的),路径相对这一块。宿主拿它核「改设置」:页上不许有,
 * 列表项上的只许改那一项声明过的格。
 */
export function blockButtons(block: Block): { path: (string | number)[]; button: Button }[] {
	if (block.type === "button") return [{ path: ["button"], button: block.button }];
	if (block.type === "notice" && block.button) return [{ path: ["button"], button: block.button }];
	return [];
}

/**
 * 一块积木引用了字典里的哪几张图(表格的图标格、二维码),路径相对这一块。宿主拿它核「引用的都在
 * 字典里」、算一块连同它的图有多重,也拿它把没人引用的图从下发的那份里剔掉。
 */
export function blockImageRefs(block: Block): { path: (string | number)[]; key: string }[] {
	if (block.type === "qr") return [{ path: ["image"], key: block.image }];
	if (block.type !== "table") return [];
	const refs: { path: (string | number)[]; key: string }[] = [];
	block.rows.forEach((row, r) => {
		row.forEach((cell, c) => {
			if (cell.kind === "icon" && cell.image !== undefined) {
				refs.push({ path: ["rows", r, c, "image"], key: cell.image });
			}
		});
	});
	return refs;
}

/** 这几块积木一共引用了哪几张图(去重)。 */
export function viewImageKeysOf(blocks: readonly Block[]): Set<string> {
	return new Set(blocks.flatMap((block) => blockImageRefs(block).map((ref) => ref.key)));
}

/**
 * 整份视图,**全都合规矩**时长这样 —— 契约的全貌,也是 wire 那份手写镜像对着钉的那一个。
 *
 * 宿主不拿它一口判整份(那是决策 40 改掉的「一格不对整份不画」),而是拆成上面几块逐块判;这里的
 * 两道整份检查(页上不许有「改设置」、引用的图都在字典里)与宿主逐块时用的是同一份判据。
 */
export const ExtensionViewSchema = z
	.strictObject({
		summary: ExtensionViewSummarySchema.optional(),
		/** 挂在头卡正文里的积木(决策 25)。 */
		page: z.array(ExtensionBlockSchema).max(EXTENSION_VIEW_MAX_PAGE_BLOCKS).readonly().optional(),
		/** 列表设置项的 key → 项的 id → 那一项在卡上的样子。 */
		items: z
			.record(FieldKeySchema, z.record(z.string().min(1), ExtensionItemViewSchema).readonly())
			.readonly()
			.optional(),
		/** 图片字典 —— 格子与二维码按键引用(决策 39)。 */
		images: ExtensionViewImagesSchema.optional(),
	})
	.superRefine((view, ctx) => {
		const images = view.images ?? {};
		/** 一块积木里引用了字典里没有的图 —— 点到那一格。 */
		const checkImages = (block: Block, at: (string | number)[]) => {
			for (const ref of blockImageRefs(block)) {
				if (Object.hasOwn(images, ref.key)) continue;
				ctx.addIssue({
					code: "custom",
					path: [...at, ...ref.path],
					message: imageMissing(ref.key),
				});
			}
		};
		view.page?.forEach((block, i) => {
			for (const { path, button } of blockButtons(block)) {
				if (button.kind === "set") {
					ctx.addIssue({ code: "custom", path: ["page", i, ...path, "set"], message: SET_ON_PAGE });
				}
			}
			checkImages(block, ["page", i]);
		});
		for (const [list, byId] of Object.entries(view.items ?? {})) {
			for (const [id, item] of Object.entries(byId)) {
				for (const section of ["lead", "blocks"] as const) {
					item[section]?.forEach((block, i) => {
						checkImages(block, ["items", list, id, section, i]);
					});
				}
			}
		}
	});

/** 「引用的图不在字典里」那句 —— 整份检查与宿主逐块时说同一句。 */
export function imageMissing(key: string): string {
	return `引用的图片「${key}」不在 images 里`;
}
