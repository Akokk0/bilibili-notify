import type { ZodType } from "zod";
import { LIST_ITEM_ID_KEY } from "../extension/wire";
import type { SettingsField } from "../settings-field";
import { packageText } from "../texts";
import { defOf, enumValuesOf, numberBoundsOf, unwrap, type ZodDef } from "./zod-def";

/**
 * 拓展交上来的两份声明**对不对得上** —— 对不上就拒绝加载(ADR-0012 决策 19 / 33,
 * ADR-0019 决策 17)。连接配置项与设置项都走这一道。
 *
 * 设置项给人填,zod 给机器校验。官方拓展只写 zod 一份,清单里的设置项由构建从规则导出
 * (`settingsFieldsFromSchema`,经 `@bilibili-notify/extension/build`),天生对得上;手写清单的
 * (第三方、不用那道构建的)仍是两份,会漂。这道对表就是那笔账的兜底:**同进程,宿主拿得到拓展的 zod**,
 * 所以漂了当场看得见,而不是等主人在面板上填完保存不上。对的不只是键:设置项按数据类型分、
 * 与 zod 一一对应,所以**类型与默认值一起对**。构建导出完也过一遍这道,错在构建时就报。
 *
 * 🔴 **判形状不用 `instanceof`**(见 `zod-def.ts`):对象看有没有 `.shape`,类型读 `_zod.def`。
 *
 * 抛出来的每一条都点名到具体那一格 —— 拓展是我们自己写的,信息给足才修得快。
 */
export function assertConfigFieldsMatchSchema(
	id: string,
	schema: ZodType,
	fields: readonly SettingsField[],
	opts: {
		/**
		 * 连接是从候选(`listConnectionCandidates`)里**挑**出来的(ADR-0012 决策 45)—— settings 由拓展自己交,没有
		 * 一栏是人填的,所以「必填键没人填」那一半不查:那正是它的常态,不是漂了。
		 */
		picked?: boolean;
	} = {},
): void {
	const fail = (msg: string): never => {
		throw new Error(`extension ${id}: ${msg}`);
	};

	// 第一层必须是**键值对象**:面板那侧的 `set` 统一生成成 `config[key] = v`,前提就是这个。
	const shape = (schema as { shape?: unknown }).shape;
	if (typeof shape !== "object" || shape === null) {
		return void fail(packageText("internal.schema.config-fields.1"));
	}
	assertNotStrict("config schema", defOf(schema), fail);
	checkFields("", shape as Record<string, unknown>, fields, fail, {
		picked: opts.picked === true,
		listItem: false,
	});
}

/**
 * 🔴 strict 对象(`z.strictObject` / `.strict()`)不许用:存着的那份里只要多一个旧键 —— 清单改过、
 * 旧版留下的 —— 它就**整份**解不开,设置读不了、拓展起不来(ADR-0019 决策 36);连接的 config
 * 也是存下来的,一样。zod 4 里 strict 就是 `catchall` 为 `never`。
 */
function assertNotStrict(
	what: string,
	def: ZodDef | undefined,
	fail: (msg: string) => never,
): void {
	if (defOf(def?.catchall)?.type !== "never") return;
	fail(packageText("internal.schema.config-fields.2", { value0: what }));
}

/** 设置项的类型 → zod 那边剥完包装应该是什么。enum 不止一种写法,另由 {@link enumValuesOf} 认。 */
const ZOD_TYPE_OF: Record<Exclude<SettingsField["type"], "enum">, string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	list: "array",
};

/** 一张表对一个对象的成员 —— 顶层与列表的每一项是同一套规矩。 */
function checkFields(
	prefix: string,
	members: Record<string, unknown>,
	fields: readonly SettingsField[],
	fail: (msg: string) => never,
	opts: { picked: boolean; listItem: boolean },
): void {
	// zod 的 shape 是个普通对象:`in` 会顺着原型链把 `toString` 这类判成 schema 的键。只认它
	// 自己的键。
	const memberKeys: ReadonlySet<string> = new Set(Object.keys(members));
	// 列表项的 id 由 BN 生成、藏起来(ADR-0019 决策 29):清单里不声明它,zod 里却必须有 ——
	// 没有的话,BN 生成的 id 会被拓展那份 zod 当场剥掉,视图就再也挂不到这一项上。
	if (opts.listItem && !memberKeys.has(LIST_ITEM_ID_KEY)) {
		fail(
			packageText("internal.schema.config-fields.3", { value0: prefix, value1: LIST_ITEM_ID_KEY }),
		);
	}
	const seen = new Set<string>(opts.listItem ? [LIST_ITEM_ID_KEY] : []);
	for (const field of fields) {
		const path = `${prefix}${field.key}`;
		if (seen.has(field.key)) {
			fail(packageText("internal.schema.config-fields.4", { value0: path }));
		}
		seen.add(field.key);
		if (!memberKeys.has(field.key)) {
			fail(packageText("internal.schema.config-fields.5", { value0: path }));
		}
		checkField(path, field, members[field.key], fail);
	}

	if (opts.picked) return;
	for (const [key, member] of Object.entries(members)) {
		// 有栏的那几格,必填已经由 checkField 对过。
		if (seen.has(key)) continue;
		const path = `${prefix}${key}`;
		const { def, optional } = unwrap(member);
		if (!def) fail(packageText("internal.schema.config-fields.6", { value0: path }));
		if (!optional) fail(packageText("internal.schema.config-fields.7", { value0: path }));
	}
}

function checkField(
	path: string,
	field: SettingsField,
	member: unknown,
	fail: (msg: string) => never,
): void {
	const { def, fill, optional } = unwrap(member);
	// 认不出就拒,而不是悄悄跳过这一格 —— 跳过的话,这一格的两份声明就再没人对了。
	if (!def) return void fail(packageText("internal.schema.config-fields.8", { value0: path }));
	const accepted = field.type === "enum" ? enumValuesOf(def) : undefined;
	if (field.type === "enum" ? !accepted : def.type !== ZOD_TYPE_OF[field.type]) {
		const hint =
			field.type === "enum" && def.type === "union"
				? packageText("internal.schema.config-fields.9")
				: "";
		fail(
			packageText("internal.schema.config-fields.10", {
				value0: path,
				value1: field.type,
				value2: def.type,
				value3: hint,
			}),
		);
	}

	// 🔴 必填也要对上。BN 保存设置前按**清单**校验,没写 `required` 也没给 `default` 的格照清单是
	// 「可以不填」;zod 却收不下 `undefined` —— 缺了这一格的设置照样存得进去,拓展读的时候解不开,
	// **整份**设置按没设过算(桥就是全部接入一起失效)。有默认值的两边已由下面对表钉住。
	const zodRequired = !optional;
	const declaredDefault = "default" in field ? field.default : undefined;
	if (zodRequired && field.required !== true && declaredDefault === undefined) {
		const fix =
			field.type === "list"
				? packageText("internal.schema.config-fields.11")
				: packageText("internal.schema.config-fields.12");
		fail(packageText("internal.schema.config-fields.13", { value0: path, value1: fix }));
	}

	if (field.type === "list") {
		// 列表自己的默认值(通常是空数组)不算漂移:设置项里没有给列表写默认值那一格。
		const item = unwrap(def.element).def;
		if (item?.type !== "object" || !item.shape) {
			return void fail(packageText("internal.schema.config-fields.14", { value0: path }));
		}
		assertNotStrict(packageText("internal.schema.config-fields.15", { value0: path }), item, fail);
		checkFields(`${path}.`, item.shape, field.fields, fail, {
			picked: false,
			listItem: true,
		});
		return;
	}

	if (field.type === "number") {
		// 🔴 面板照设置项的 min / max 拦,拓展照自己的 zod 收。zod 多一道,面板放行的值拓展一读就整份
		// 失败(设置读不了、拓展起不来);设置项多一道,面板拦下的是拓展本来收的值。
		const zod = numberBoundsOf(def);
		const sides = [
			[packageText("internal.schema.config-fields.16"), field.min, zod.min, ["≥", ">"]],
			[packageText("internal.schema.config-fields.17"), field.max, zod.max, ["≤", "<"]],
		] as const;
		for (const [which, declared, bound, [closed, open]] of sides) {
			if (
				declared === undefined ? bound === undefined : bound?.inclusive && bound.value === declared
			) {
				continue;
			}
			const zodSide = bound
				? `${bound.inclusive ? closed : open} ${bound.value}`
				: packageText("internal.schema.config-fields.18");
			fail(
				packageText("internal.schema.config-fields.20", {
					value0: path,
					value1: which,
					value2:
						declared === undefined
							? packageText("internal.schema.config-fields.19")
							: `${closed} ${declared}`,
					value3: zodSide,
				}),
			);
		}
	}

	if (field.type === "enum" && accepted) {
		// 面板存的永远是字符串:zod 收的是数字 1 的话,选项写 "1" 也永远存不对。
		const odd = accepted.find((value) => typeof value !== "string");
		if (odd !== undefined) {
			fail(
				packageText("internal.schema.config-fields.21", {
					value0: path,
					value1: JSON.stringify(odd),
				}),
			);
		}
		// 面板能选出 zod 不收的值(或者反过来有一种永远选不到),都是漂了。
		const declared = field.options.map((option) => option.value).sort();
		const values = [...new Set(accepted as string[])].sort();
		if (declared.join("\n") !== values.join("\n")) {
			fail(
				packageText("internal.schema.config-fields.22", {
					value0: path,
					value1: declared.join(", "),
					value2: values.join(", "),
				}),
			);
		}
	}

	// 面板显示的默认值就是设置项里写的那个;与 zod 实际补上的不一样,主人看到的就是假话。
	let defaultValue: unknown;
	if (fill) {
		try {
			defaultValue = fill.read();
		} catch (err) {
			fail(
				packageText("internal.schema.config-fields.23", {
					value0: path,
					value1: fill.from,
					value2: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}
	// 补出来是 undefined 的(`.catch(() => undefined)` 这类)等于没补。
	const hasDefault = defaultValue !== undefined;
	const from = fill?.from === "catch" ? packageText("internal.schema.config-fields.24") : "";
	if (field.default !== undefined && !hasDefault) {
		fail(
			packageText("internal.schema.config-fields.25", {
				value0: path,
				value1: JSON.stringify(field.default),
			}),
		);
	}
	if (field.default === undefined && hasDefault) {
		fail(
			packageText("internal.schema.config-fields.26", {
				value0: path,
				value1: JSON.stringify(defaultValue),
				value2: from,
			}),
		);
	}
	if (field.default !== undefined && hasDefault && !Object.is(field.default, defaultValue)) {
		fail(
			packageText("internal.schema.config-fields.27", {
				value0: path,
				value1: JSON.stringify(field.default),
				value2: JSON.stringify(defaultValue),
				value3: from,
			}),
		);
	}
}
