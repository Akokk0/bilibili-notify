import { z } from "zod";
import { ActionNameSchema, ExtensionImageSchema, FieldKeySchema } from "./extension-manifest";

/**
 * 拓展交给面板的「视图」—— `ctx.publishStatus` 在 v2 里交的就是它(ADR-0019 决策 20 / 26–28)。
 *
 * 一组**封闭的积木**,由 BN 照着画:拓展只说「画什么」,不说「怎么画」,也不带任何代码、HTML
 * 或表达式 —— 派生的东西(桥的四态、「对不上」)由拓展算好交来。缺一种积木就等 BN 加,加的时候
 * 抬契约档位(`EXTENSION_API_RANGE.current`),所以这份 schema 是**严格**的:多一个键就不画 ——
 * 拼错的键放过去就是一块静默不显示的积木。
 *
 * 宿主在交给面板之前拿它校验;不合规矩的整份不画,换成一条说清哪里不对的错误提示。
 */

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
export const RichTextSchema = z.union([z.string().max(2000), z.array(RichRunSchema).max(64)]);

/** 状态的语气 —— 同时决定卡角那团颜色。 */
const ToneSchema = z.enum(["ok", "warn", "error", "off"]);

/** 调拓展:清单 `actions` 里声明、代码 `ctx.onAction` 接(决策 22)。 */
const ActionButtonSchema = z.strictObject({
	label: z.string().min(1).max(32),
	action: ActionNameSchema,
});

/**
 * 让 BN 改**这一项**的一格设置(桥的「改成 AstrBot」)—— 只许挂在列表项上,见
 * {@link ExtensionViewSchema} 的那道检查。写路径仍是 BN 那一条,照样过设置校验。
 */
const SetButtonSchema = z.strictObject({
	label: z.string().min(1).max(32),
	set: z.record(FieldKeySchema, z.union([z.string(), z.number(), z.boolean()])),
});

const ButtonSchema = z.union([ActionButtonSchema, SetButtonSchema]);

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

/** 每种列的格长什么样 —— 表格那道检查逐格对。 */
const CELL_SCHEMAS = {
	icon: z.strictObject({
		image: ExtensionImageSchema.optional(),
		fallback: z.string().min(1).max(2),
	}),
	text: z.union([
		z.string().max(200),
		z.strictObject({ text: z.string().max(200), sub: z.string().max(200).optional() }),
	]),
	mono: z.string().max(200),
	tristate: z.enum(["yes", "no", "unknown"]),
} as const;

const TableSchema = z
	.strictObject({
		type: z.literal("table"),
		title: z.string().max(40).optional(),
		/** 标题旁边带一个行数。 */
		count: z.boolean().optional(),
		/** 一行都没有时那句话。 */
		empty: RichTextSchema.optional(),
		columns: z.array(ColumnSchema).min(1).max(12),
		rows: z.array(z.array(z.unknown())).max(200),
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
				const kind = (table.columns[c] as { kind: keyof typeof CELL_SCHEMAS }).kind;
				if (!CELL_SCHEMAS[kind].safeParse(cell).success) {
					ctx.addIssue({
						code: "custom",
						path: ["rows", r, c],
						message: `这一格不是 ${kind} 列该有的样子`,
					});
				}
			});
		});
	});

/** 按钮积木 —— 两种按钮各带一格 `type`,所以不能和别的积木一起按 `type` 分。 */
const ButtonBlockSchema = z.union([
	ActionButtonSchema.extend({ type: z.literal("button") }).strict(),
	SetButtonSchema.extend({ type: z.literal("button") }).strict(),
]);

/** 一块积木。 */
const OtherBlockSchema = z.discriminatedUnion("type", [
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
			.max(12),
	}),
	TableSchema,
	z.strictObject({
		type: z.literal("notice"),
		tone: z.enum(["info", "warn", "error"]),
		text: RichTextSchema,
		button: ButtonSchema.optional(),
	}),
	z.strictObject({
		type: z.literal("copy"),
		label: z.string().min(1).max(24),
		value: z.union([z.string().max(2000), z.strictObject({ host: z.literal("extensionUrl") })]),
		note: RichTextSchema.optional(),
	}),
	/** 二维码 —— 拓展生成好的图片(B 站登录那张就是这么交的),BN 只画。 */
	z.strictObject({
		type: z.literal("qr"),
		image: ExtensionImageSchema,
		caption: RichTextSchema.optional(),
	}),
]);

const BlockSchema = z.union([OtherBlockSchema, ButtonBlockSchema]);

/** 列表的一项在卡上的那几格(决策 26)。 */
const ItemViewSchema = z.strictObject({
	/** 状态字 + 卡角的颜色。停用的项由 BN 盖成「已停用」,这里报什么都不算。 */
	status: z.strictObject({ tone: ToneSchema, text: z.string().min(1).max(40) }).optional(),
	/** 标题旁的小药丸。 */
	pill: z.string().min(1).max(32).optional(),
	subtitle: RichTextSchema.optional(),
	/** 卡头右边的按钮,排在 BN 自己的「停用 / 删除」前面。 */
	buttons: z.array(ButtonSchema).max(4).optional(),
	/** 画在 BN 画的字段行(token 行这种)**上面**的积木 —— 要人先看见的提示放这儿。 */
	lead: z.array(BlockSchema).max(8).optional(),
	/** 画在字段行下面的积木。 */
	blocks: z.array(BlockSchema).max(32).optional(),
});

/** 「改设置」的按钮藏在一块积木里的哪儿 —— 页级与 summary 里都不许有。 */
function setButtonPaths(block: z.infer<typeof BlockSchema>): (string | number)[][] {
	if (block.type === "button" && "set" in block) return [["set"]];
	if (block.type === "notice" && block.button && "set" in block.button) return [["button", "set"]];
	return [];
}

export const ExtensionViewSchema = z
	.strictObject({
		/** 拓展列表页那一行(今天那句「N 个 bot 在线」是面板里专为桥写的)。 */
		summary: z.strictObject({ tone: ToneSchema.optional(), text: RichTextSchema }).optional(),
		/** 挂在头卡正文里的积木(决策 25)。 */
		page: z.array(BlockSchema).max(32).optional(),
		/** 列表设置项的 key → 项的 id → 那一项在卡上的样子。 */
		items: z.record(FieldKeySchema, z.record(z.string().min(1), ItemViewSchema)).optional(),
	})
	.superRefine((view, ctx) => {
		view.page?.forEach((block, i) => {
			for (const path of setButtonPaths(block)) {
				ctx.addIssue({
					code: "custom",
					path: ["page", i, ...path],
					message: "「改设置」的按钮改的是某一项的一格,只能挂在列表项上",
				});
			}
		});
	});
