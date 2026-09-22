import type { ExtensionField } from "@bilibili-notify/extension";
import { LIST_ITEM_ID_KEY } from "@bilibili-notify/internal";
import type { ZodType } from "zod";

/**
 * 拓展交上来的两份声明**对不对得上** —— 对不上就拒绝加载(ADR-0012 决策 19 / 33,
 * ADR-0019 决策 17)。连接配置项与设置项都走这一道。
 *
 * 两份不是冗余:设置项给人填,zod 给机器校验。合成一份要么把设置项逼成一门 DSL,要么让
 * 校验退化成只剩类型检查 —— 而真实 config 里有「加速前缀必须 https」这种跨字段规则。
 * 代价是「两份会漂」,这道对表就是那笔账的兜底:**同进程,宿主拿得到拓展的 zod**,所以
 * 漂了当场看得见,而不是等主人在面板上填完保存不上。对的不只是键:设置项按数据类型分、
 * 与 zod 一一对应,所以**类型与默认值一起对**(v1 除外,见 `v1` 那一格)。
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
		/**
		 * v1 拓展在代码里交的连接配置项(收下时已翻译成新形状)。🔴 **v1 格式已冻结**
		 * (`ExtensionManifestV1Schema`),对表也停在冻结那天:第一层是对象、键不重复、键在 zod
		 * 里、zod 的必填键都有栏。类型 / 选项 / 默认值、读 zod 4 的 `_zod.def` 是 v2 才加的 ——
		 * 加到已经发出去的 v1 包身上,宿主一升级它就加载不了。
		 */
		v1?: boolean;
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
	checkFields("", shape as Record<string, unknown>, fields, fail, {
		picked: opts.picked === true,
		listItem: false,
		keysOnly: opts.v1 === true,
	});
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
	opts: { picked: boolean; listItem: boolean; keysOnly: boolean },
): void {
	// zod 的 shape 是个普通对象:`in` 会顺着原型链把 `toString` 这类判成 schema 的键。只认它
	// 自己的键 —— v1 的字段表不过清单校验,只剩这一道。
	const memberKeys: ReadonlySet<string> = new Set(Object.keys(members));
	// 列表项的 id 由 BN 生成、藏起来(ADR-0019 决策 29):清单里不声明它,zod 里却必须有 ——
	// 没有的话,BN 生成的 id 会被拓展那份 zod 当场剥掉,视图就再也挂不到这一项上。
	if (opts.listItem && !memberKeys.has(LIST_ITEM_ID_KEY)) {
		fail(`列表项 "${prefix}${LIST_ITEM_ID_KEY}" 由 BN 生成,zod 的项里要有这一格`);
	}
	const seen = new Set<string>(opts.listItem ? [LIST_ITEM_ID_KEY] : []);
	for (const field of fields) {
		const path = `${prefix}${field.key}`;
		if (seen.has(field.key)) {
			fail(`字段表里 "${path}" 摆了两栏 —— 哪一栏说了算没有答案`);
		}
		seen.add(field.key);
		if (!memberKeys.has(field.key)) {
			fail(`字段表里的 "${path}" 不是 config schema 的键`);
		}
		// 只对键的(v1)到这里为止,这一格的类型 / 默认值不看。
		if (!opts.keysOnly) checkField(path, field, members[field.key], fail);
	}

	if (opts.picked) return;
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

	// 🔴 必填也要对上。BN 保存设置前按**清单**校验,没写 `required` 也没给 `default` 的格照清单是
	// 「可以不填」;zod 却收不下 `undefined` —— 缺了这一格的设置照样存得进去,拓展读的时候解不开,
	// **整份**设置按没设过算(桥就是全部接入一起失效)。有默认值的两边已由下面对表钉住。
	const zodRequired = !(member as ZodType).safeParse(undefined).success;
	const declaredDefault = "default" in field ? field.default : undefined;
	if (zodRequired && field.required !== true && declaredDefault === undefined) {
		const fix =
			field.type === "list"
				? `要么写 "required": true,要么给 zod 那边一个默认值(比如 .default([]))`
				: `要么写 "required": true,要么两边都给同一个 default`;
		fail(
			`"${path}" 在 zod 里是必填(收不下 undefined),设置项里却没写 "required": true 也没给 default —— 按清单保存时缺了它照样放行,拓展自己的 zod 却解不开(设置会整份当没设过)。${fix}`,
		);
	}

	if (field.type === "list") {
		// 列表自己的默认值(通常是空数组)不算漂移:设置项里没有给列表写默认值那一格。
		const item = unwrap(def.element).def;
		if (item?.type !== "object" || !item.shape) {
			return void fail(`"${path}" 是列表,zod 那边每一项得是个对象`);
		}
		checkFields(`${path}.`, item.shape, field.fields, fail, {
			picked: false,
			listItem: true,
			keysOnly: false,
		});
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
