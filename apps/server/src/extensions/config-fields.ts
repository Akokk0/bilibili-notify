import type { ExtensionField } from "@bilibili-notify/extension";
import type { ZodType } from "zod";

/**
 * 拓展交上来的两份声明**对不对得上** —— 对不上就拒绝加载(ADR-0012 决策 19 / 33,
 * ADR-0019 决策 17)。连接配置项与设置项都走这一道。
 *
 * 两份不是冗余:设置项给人填,zod 给机器校验。合成一份要么把设置项逼成一门 DSL,要么让
 * 校验退化成只剩类型检查 —— 而真实 config 里有「加速前缀必须 https」这种跨字段规则。
 * 代价是「两份会漂」,这道对表就是那笔账的兜底:**同进程,宿主拿得到拓展的 zod**,所以
 * 漂了当场看得见,而不是等主人在面板上填完保存不上。对的不只是键:设置项按数据类型分、
 * 与 zod 一一对应,所以**类型与默认值一起对**。
 *
 * 🔴 **判形状不用 `instanceof`。** 拓展会被打成自包含的 `index.mjs`,它那份 zod 是**另一个
 * 实例** —— `instanceof ZodObject` 当场为假,而报出来的错会把人指向完全错误的方向。对象看
 * 有没有 `.shape`,类型读 zod 4 挂在每个 schema 上的 `_zod.def`:不管几份 zod 都成立。
 *
 * 抛出来的每一条都点名到具体那一格 —— 拓展是我们自己写的,信息给足才修得快。
 */
export function assertConfigFieldsMatchSchema(
	id: string,
	schema: ZodType,
	fields: readonly ExtensionField[],
	opts: {
		/**
		 * 连接是从 `listBots` 里**挑**出来的(ADR-0012 决策 45)—— config 由拓展自己交,没有
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
		return void fail("config 的 schema 必须是一个对象(第一层只支持键值对象)");
	}
	checkFields("", shape as Record<string, unknown>, fields, fail, opts.picked === true);
}

/** zod 4 挂在每个 schema 上的定义里,对表要读的那几格。 */
interface ZodDef {
	type: string;
	innerType?: unknown;
	in?: unknown;
	defaultValue?: unknown;
	entries?: Record<string, unknown>;
	element?: unknown;
	shape?: Record<string, unknown>;
}

function defOf(schema: unknown): ZodDef | undefined {
	return (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;
}

/** 只是包一层、不改「这一格是什么类型」的那些。 */
const WRAPPERS = new Set(["optional", "nullable", "readonly", "catch", "nonoptional"]);

/**
 * 剥掉包装层,拿到真正的类型;一路上碰到的默认值记下来。
 *
 * 带转换的(`pipe`)按**输入那一侧**对:面板填进去、落盘的是输入,转换是拓展自己的事。
 */
function unwrap(schema: unknown): { def?: ZodDef; hasDefault: boolean; defaultValue?: unknown } {
	let current = schema;
	let found: { defaultValue: unknown } | undefined;
	// 包装层数封顶:正常的 schema 两三层,转不出来说明读歪了,当认不出算。
	for (let depth = 0; depth < 16; depth += 1) {
		const def = defOf(current);
		if (!def) break;
		if (def.type === "default" || def.type === "prefault") {
			found ??= { defaultValue: def.defaultValue };
			current = def.innerType;
		} else if (WRAPPERS.has(def.type)) {
			current = def.innerType;
		} else if (def.type === "pipe") {
			current = def.in;
		} else {
			return found
				? { def, hasDefault: true, defaultValue: found.defaultValue }
				: { def, hasDefault: false };
		}
	}
	return { hasDefault: found !== undefined, defaultValue: found?.defaultValue };
}

/** 设置项的类型 → zod 那边剥完包装应该是什么。 */
const ZOD_TYPE_OF: Record<ExtensionField["type"], string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	enum: "enum",
	list: "array",
};

/** 一张表对一个对象的成员 —— 顶层与列表的每一项是同一套规矩。 */
function checkFields(
	prefix: string,
	members: Record<string, unknown>,
	fields: readonly ExtensionField[],
	fail: (msg: string) => never,
	picked: boolean,
): void {
	const seen = new Set<string>();
	for (const field of fields) {
		const path = `${prefix}${field.key}`;
		if (seen.has(field.key)) {
			fail(`字段表里 "${path}" 摆了两栏 —— 哪一栏说了算没有答案`);
		}
		seen.add(field.key);
		if (!(field.key in members)) {
			fail(`字段表里的 "${path}" 不是 config schema 的键`);
		}
		checkField(path, field, members[field.key], fail);
	}

	if (picked) return;
	for (const [key, member] of Object.entries(members)) {
		// 收不下 `undefined` 的就是必填(可选与带默认值的都收得下)。
		const required = !(member as ZodType).safeParse(undefined).success;
		if (required && !seen.has(key)) {
			fail(`config schema 的必填键 "${prefix}${key}" 在字段表里没有对应那一栏`);
		}
	}
}

function checkField(
	path: string,
	field: ExtensionField,
	member: unknown,
	fail: (msg: string) => never,
): void {
	const { def, hasDefault, defaultValue } = unwrap(member);
	// 认不出就拒,而不是悄悄跳过这一格 —— 跳过的话,这一格的两份声明就再没人对了。
	if (!def) return void fail(`"${path}" 的 schema 认不出类型 —— 拓展的 schema 要用 zod 4 写`);
	const want = ZOD_TYPE_OF[field.type];
	if (def.type !== want) {
		fail(`"${path}" 声明的是 ${field.type},zod 里却是 ${def.type}`);
	}

	if (field.type === "list") {
		// 列表自己的默认值(通常是空数组)不算漂移:设置项里没有给列表写默认值那一格。
		const item = unwrap(def.element).def;
		if (item?.type !== "object" || !item.shape) {
			return void fail(`"${path}" 是列表,zod 那边每一项得是个对象`);
		}
		checkFields(`${path}.`, item.shape, field.fields, fail, false);
		return;
	}

	if (field.type === "enum") {
		// 面板能选出 zod 不收的值(或者反过来有一种永远选不到),都是漂了。
		const declared = field.options.map((option) => option.value).sort();
		const accepted = Object.values(def.entries ?? {})
			.map(String)
			.sort();
		if (declared.join("\n") !== accepted.join("\n")) {
			fail(
				`"${path}" 的选项 [${declared.join(", ")}] 与 zod 的取值 [${accepted.join(", ")}] 对不上`,
			);
		}
	}

	// 面板显示的默认值就是设置项里写的那个;与 zod 实际补上的不一样,主人看到的就是假话。
	if (field.default !== undefined && !hasDefault) {
		fail(`"${path}" 在设置项里写了默认值 ${JSON.stringify(field.default)},zod 里却没有`);
	}
	if (field.default === undefined && hasDefault) {
		fail(
			`"${path}" 在 zod 里有默认值 ${JSON.stringify(defaultValue)},设置项里没写 —— 面板显示的会和实际用的不一样`,
		);
	}
	if (field.default !== undefined && hasDefault && !Object.is(field.default, defaultValue)) {
		fail(
			`"${path}" 的默认值两边不一样:设置项写的是 ${JSON.stringify(field.default)},zod 是 ${JSON.stringify(defaultValue)}`,
		);
	}
}
