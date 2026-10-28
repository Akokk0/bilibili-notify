import type { SettingsField, SettingsFieldMeta } from "../settings-field";
import { enumValuesOf, numberBoundsOf, type Unwrapped, unwrap, type ZodDef } from "./zod-def";

/**
 * 从一份 zod 规则导出设置项 —— **规则只写一份**(construction-plan「读设置的写法简化」,第 4 期):
 * 类型、默认值、必填、上下限、枚举的取值读规则本身,给人看的那几格读规则上的 `.meta({...})`
 * (形状见 {@link SettingsFieldMeta})。跨字段的校验只留在规则里,不导出。
 *
 * - 写了 `label` 的键才出一栏,顺序照规则的键;没写的不出(连接里由拓展交的键、列表项的 `id`)。
 *   必填的键没出栏是不是漂了,归 `assertConfigFieldsMatchSchema` 判(连接是挑出来的、可以没有)。
 * - `required` 是「zod 收不下 undefined、也没有补值」;`default` 是 `.default()` / `.catch()` 补的那个。
 * - 认不了的写法当场抛、点名到那一格:设置项表达不了它,导出去面板就画错。
 *
 * 内置集成(适配器描述、B 站设置)在服务端现算,官方拓展由构建写进清单(`@bilibili-notify/extension/build`),
 * 调的都是这一个。
 */
export function settingsFieldsFromSchema(schema: unknown): SettingsField[] {
	const shape = unwrap(schema).def?.shape;
	if (!shape) throw new Error("设置的规则第一层必须是一个对象(z.object)");
	return fieldsOf("", shape, false);
}

/** 一个对象的成员出几栏 —— 顶层与列表的每一项是同一套;`inList` 时项里只许单值(列表只嵌一层)。 */
function fieldsOf(
	prefix: string,
	members: Record<string, unknown>,
	inList: boolean,
): SettingsField[] {
	const out: SettingsField[] = [];
	for (const [key, member] of Object.entries(members)) {
		const got = unwrap(member);
		if (typeof got.meta?.label !== "string") continue;
		out.push(fieldOf(`${prefix}${key}`, key, got, inList));
	}
	return out;
}

/**
 * 每一种设置项从 meta 里读哪几格(`label` / `description` 各种都读)。别的种类的格写在这一种上,
 * 写了却不生效,比报错更难查,所以点名抛;不在这张表里的键是别家的 meta(备份脱敏的标记、zod 自己的),不管。
 */
const META_KEYS = {
	string: ["placeholder", "secret", "multiline", "monospace", "generate"],
	number: ["step", "unit"],
	boolean: [],
	enum: ["options"],
	list: ["itemLabel", "title", "mark", "toggle", "newItemCopy", "removeWarning"],
} as const satisfies Record<SettingsField["type"], readonly string[]>;

const ALL_META_KEYS: ReadonlySet<string> = new Set(Object.values(META_KEYS).flat());

/** 剥完包装的那一层是哪一种设置项;设置项表达不了的回 `undefined`。 */
function fieldTypeOf(def: ZodDef | undefined): SettingsField["type"] | undefined {
	switch (def?.type) {
		case "string":
		case "number":
		case "boolean":
			return def.type;
		case "enum":
		case "literal":
		case "union":
			return "enum";
		case "array":
			return "list";
		default:
			return undefined;
	}
}

function fieldOf(path: string, key: string, got: Unwrapped, inList: boolean): SettingsField {
	const { def, meta = {} } = got;
	const type = fieldTypeOf(def);
	if (!def || !type) throw new Error(`"${path}" 是 ${def?.type ?? "认不出的类型"},设置项表达不了`);
	const own: readonly string[] = META_KEYS[type];
	const stray = Object.keys(meta).filter((k) => ALL_META_KEYS.has(k) && !own.includes(k));
	if (stray.length > 0) {
		throw new Error(`"${path}" 是 ${type},meta 里的 ${stray.join(" / ")} 用不上`);
	}
	const fill = fillOf(path, got);
	const field = {
		key,
		type,
		label: meta.label as string,
		...pick(meta, ["description"]),
		...(!got.optional && fill === undefined ? { required: true } : {}),
		// 列表自己的默认值(通常是空数组)不出:设置项的列表没有默认值那一格。
		...(fill === undefined || type === "list" ? {} : { default: fill }),
		...pick(
			meta,
			own.filter((k) => k !== "options"),
		),
	};
	switch (type) {
		case "number":
			return { ...field, ...boundsOf(path, def) } as SettingsField;
		case "enum":
			return { ...field, options: enumOptionsOf(path, def, meta.options) } as SettingsField;
		case "list": {
			if (inList) throw new Error(`"${path}" 是列表项里的列表,设置项的列表只嵌一层`);
			const item = unwrap(def.element).def;
			if (item?.type !== "object" || !item.shape) {
				throw new Error(`"${path}" 是列表,每一项得是个对象(z.object)`);
			}
			return { ...field, fields: fieldsOf(`${path}.`, item.shape, true) } as SettingsField;
		}
		default:
			return field as SettingsField;
	}
}

/** number 的上下限:设置项的 min / max 含端点,规则里不含端点的那一道(`.gt()` / `.positive()`)表达不了。 */
function boundsOf(path: string, def: ZodDef): { min?: number; max?: number } {
	const { min, max } = numberBoundsOf(def);
	for (const bound of [min, max]) {
		if (bound && !bound.inclusive) {
			throw new Error(
				`"${path}" 的上下限不含端点(.gt() / .lt() / .positive() …),设置项的 min / max 含端点,改用 .min() / .max()`,
			);
		}
	}
	return { ...(min ? { min: min.value } : {}), ...(max ? { max: max.value } : {}) };
}

/**
 * 枚举的选项:取值与顺序读规则(`z.enum`、字面量、每一支都是这两种的 union),标签与图标读 meta 的
 * `options`(取值 → `{ label, icon? }`)。两边的取值要一一对上:规则里有、meta 里没标签的,面板上是
 * 一个没名字的选项;meta 多写的那个永远选不到。
 */
function enumOptionsOf(
	path: string,
	def: ZodDef,
	labels: unknown,
): { value: string; label: string; icon?: string }[] {
	const values = enumValuesOf(def);
	if (!values)
		throw new Error(`"${path}" 是 union,设置项的枚举只认每一支都是字面量(或 z.enum)的 union`);
	const odd = values.find((value) => typeof value !== "string");
	if (odd !== undefined) {
		throw new Error(
			`"${path}" 的取值里有不是字符串的 ${JSON.stringify(odd)} —— 面板存的永远是字符串`,
		);
	}
	const table = (labels ?? {}) as Record<string, { label: string; icon?: string } | undefined>;
	const unique = [...new Set(values as string[])];
	const extra = Object.keys(table).filter((value) => !unique.includes(value));
	if (extra.length > 0) {
		throw new Error(`"${path}" 的 meta.options 里有规则里没有的取值:${extra.join(", ")}`);
	}
	return unique.map((value) => {
		const option = table[value];
		if (typeof option?.label !== "string") {
			throw new Error(`"${path}" 的取值 ${value} 在 meta.options 里没写标签`);
		}
		return {
			value,
			label: option.label,
			...(option.icon === undefined ? {} : { icon: option.icon }),
		};
	});
}

/** 缺了这一格时 zod 补的值;补出来是 undefined 的等于没补。 */
function fillOf(path: string, got: Unwrapped): unknown {
	if (!got.fill) return undefined;
	try {
		return got.fill.read();
	} catch (err) {
		throw new Error(
			`"${path}" 的 .${got.fill.from}() 算不出补什么(${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

function pick(
	meta: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): Record<string, unknown> {
	return Object.fromEntries(keys.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));
}
