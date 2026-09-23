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
	// v1 冻结在那天的规矩里,strict 不查。
	if (opts.v1 !== true) assertNotStrict("config schema", defOf(schema), fail);
	checkFields("", shape as Record<string, unknown>, fields, fail, {
		picked: opts.picked === true,
		listItem: false,
		keysOnly: opts.v1 === true,
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
	fail(
		`${what}是 strict 对象(z.strictObject / .strict()):存着的那份里只要多一个旧键(清单改过、旧版留下的),整份就解不开,拓展会因此起不来。改用普通的 z.object(多的键丢掉)或 z.looseObject / .passthrough()(多的键原样留着)`,
	);
}

/** zod 4 挂在每个 schema 上的定义里,对表要读的那几格。 */
interface ZodDef {
	type: string;
	innerType?: unknown;
	in?: unknown;
	out?: unknown;
	/** `z.lazy` 交里面那份 schema 的函数。 */
	getter?: () => unknown;
	defaultValue?: unknown;
	/** `.catch()` 的补值函数 —— `.catch(5)` 也被 zod 包成 `() => 5`。 */
	catchValue?: (ctx: unknown) => unknown;
	entries?: Record<string, unknown>;
	/** `z.literal` 的取值(zod 4 一个字面量可以带几个值)。 */
	values?: readonly unknown[];
	/** `z.union` 的每一支。 */
	options?: readonly unknown[];
	element?: unknown;
	shape?: Record<string, unknown>;
	/** 对象里没声明的键按什么收;strict 对象这一格是 `never`。 */
	catchall?: unknown;
	/** 挂在这一层上的检查(`.min()` / `.max()` / `.refine()` …),每一条自己也有 `_zod.def`。 */
	checks?: readonly unknown[];
}

function defOf(schema: unknown): ZodDef | undefined {
	return (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;
}

function optinOf(schema: unknown): string | undefined {
	return (schema as { _zod?: { optin?: string } } | undefined)?._zod?.optin;
}

/** 剥完包装之后,对表要的那几样。 */
interface Unwrapped {
	/** 剥完包装的那一层;认不出(不是 zod 4 造的、包得太深)就没有。 */
	def?: ZodDef;
	/**
	 * 缺了这一格时 zod 补的值:`.default()` 补的,或者 `.catch()` 补的。读值推迟到对表那一刻 ——
	 * 两种都可以交一个函数,函数是拓展写的,抛了要点名到那一格。
	 */
	fill?: { from: "default" | "catch"; read: () => unknown };
	/** 缺了这一格 zod 收不收 —— 收不下的就是必填。 */
	optional: boolean;
}

/**
 * 剥掉包装层,拿到真正的类型;顺路算出缺了这一格时补什么、收不收。
 *
 * 带转换的(`pipe`)按**输入那一侧**对:面板填进去、落盘的是输入,转换是拓展自己的事。
 * 🔴 `z.preprocess(fn, inner)` 也是一根 pipe,但方向反过来:`in` 是 fn(一格 transform)、`out`
 * 才是真类型 —— 一律取 `in` 的话它永远判成 transform、拓展加载不了。所以 `in` 是 transform 的
 * 按 `out` 对(落盘的值先过 fn 再过 `out`,fn 一般只做宽容转换);`.transform()` 照旧按 `in`。
 *
 * `z.lazy` 只是晚一步交出里面那份 schema,调它的 getter 剥开(自己套自己的递归结构由层数封顶兜住)。
 *
 * 🔴 「收不收」**不跑校验**:带异步 refine 的 schema 一被同步解析就抛(同步解析撞上 Promise),
 * 整条对表跟着崩。读的是 zod 4 自己算的 `_zod.optin` —— 对象按键解析时,缺了的键收不收看的就是
 * 它(不是 `"optional"` 的,缺了就报 nonoptional)。只有一处它会说错:preprocess 的入口是个
 * transform,那一格永远说「收」,可缺了的值过完 fn 还是 undefined,`out` 照样不收。所以包装层由
 * 这里自己一层层往里走,到 preprocess 改问 `out`,剥到底才读那一层的 `optin`。
 *
 * `.catch(v)` 缺了这一格时补 v,与 `.default(v)` 同一件事 —— 但它只在里面那层**拒了** undefined 时
 * 才出手:里面可选 / 有默认值时它什么都不补。🔴 套在 `.optional()` 里时也不补:zod 4.4 的 optional
 * 遇上「输入是 undefined、里面走了兜底」会把结果丢回 undefined(`underOptional` 就是记这个)。这是
 * 照 catalog 那版 zod 的行为写的,测试里连 zod 自己的行为一起钉着,升级 zod 改了会先红。
 */
function unwrap(schema: unknown, depth = 0, underOptional = false): Unwrapped {
	const def = defOf(schema);
	// 包装层数封顶:正常的 schema 两三层,转不出来说明读歪了(或者 lazy 自己套自己),当认不出算。
	if (!def || depth >= 16) return { optional: false };
	const inner = (next: unknown, optional = underOptional) => unwrap(next, depth + 1, optional);
	switch (def.type) {
		case "default":
		case "prefault":
			// 缺了就补这个值,里面那几层见不到 undefined —— 所以外层的默认值盖过里层的。
			return {
				...inner(def.innerType),
				fill: { from: "default", read: () => def.defaultValue },
				optional: true,
			};
		case "optional":
			return { ...inner(def.innerType, true), optional: true };
		case "catch": {
			const got = inner(def.innerType);
			if (got.optional || underOptional) return { ...got, optional: true };
			// 喂给它的与 zod 缺了这一格时喂的同形:输入是 undefined,里面那层的报错这里没有。
			const ctx = { value: undefined, input: undefined, issues: [], error: { issues: [] } };
			return {
				...got,
				fill: { from: "catch", read: () => def.catchValue?.(ctx) },
				optional: true,
			};
		}
		case "nullable":
		case "readonly":
			return inner(def.innerType);
		case "nonoptional":
			return { ...inner(def.innerType), optional: false };
		case "pipe":
			return inner(defOf(def.in)?.type === "transform" ? def.out : def.in);
		case "lazy":
			return inner(def.getter?.());
		default:
			return { def, optional: optinOf(schema) === "optional" };
	}
}

/** 设置项的类型 → zod 那边剥完包装应该是什么。enum 不止一种写法,另由 {@link enumValuesOf} 认。 */
const ZOD_TYPE_OF: Record<Exclude<ExtensionField["type"], "enum">, string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	list: "array",
};

/**
 * 一组取值在 zod 里的几种写法:`z.enum`、`z.literal`(可以带几个值)、每一支都是这两种之一的
 * `z.union`。认不出是一组取值就回 `undefined`。
 *
 * union 只要有一支不是取值(比如混了一格 `z.string()`),面板就选不全它收的值 —— 不认。
 */
function enumValuesOf(def: ZodDef): unknown[] | undefined {
	switch (def.type) {
		case "enum":
			return Object.values(def.entries ?? {});
		case "literal":
			return [...(def.values ?? [])];
		case "union": {
			const all: unknown[] = [];
			for (const option of def.options ?? []) {
				const inner = defOf(option);
				const values = inner ? enumValuesOf(inner) : undefined;
				if (!values) return undefined;
				all.push(...values);
			}
			return all;
		}
		default:
			return undefined;
	}
}

/** 数值的一头边界。 */
interface Bound {
	value: number;
	/** 含端点(`.min()` / `.gte()`)还是不含(`.gt()` / `.positive()`)。 */
	inclusive: boolean;
}

/**
 * zod 那边 number 的上下限:`.min()` / `.gte()` / `.gt()` / `.positive()` 这一族在 zod 4 里都是
 * `checks` 里一条 `greater_than`(`value` + `inclusive`),上限那一族是 `less_than`。叠了几道的
 * 取最紧的那道(数一样时不含端点的更紧)。
 *
 * 整数(`z.int()` / `.int()` / `.safe()`)是另一种检查(`number_format`),它带的「安全整数」范围
 * 不算上下限 —— 设置项表达不了它,也用不着。
 */
function numberBoundsOf(def: ZodDef): { min?: Bound; max?: Bound } {
	let min: Bound | undefined;
	let max: Bound | undefined;
	for (const check of def.checks ?? []) {
		const c = defOf(check) as { check?: string; value?: unknown; inclusive?: boolean } | undefined;
		if (typeof c?.value !== "number") continue;
		const bound = { value: c.value, inclusive: c.inclusive === true };
		if (c.check === "greater_than") min = tighter(min, bound, 1);
		else if (c.check === "less_than") max = tighter(max, bound, -1);
	}
	return { min, max };
}

/** 两道同一头的边界里更紧的那道;`dir` 为 1 是下限(大的紧),-1 是上限(小的紧)。 */
function tighter(a: Bound | undefined, b: Bound, dir: 1 | -1): Bound {
	if (!a) return b;
	if (a.value !== b.value) return (b.value - a.value) * dir > 0 ? b : a;
	return a.inclusive ? b : a;
}

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
		// 有栏的那几格,必填已经由 checkField 对过。
		if (seen.has(key)) continue;
		const path = `${prefix}${key}`;
		if (opts.keysOnly) {
			// v1 停在冻结那天的判据:收不下 `undefined` 的就是必填(可选与带默认值的都收得下)。
			if (!(member as ZodType).safeParse(undefined).success) {
				fail(`config schema 的必填键 "${path}" 在字段表里没有对应那一栏`);
			}
			continue;
		}
		const { def, optional } = unwrap(member);
		if (!def) fail(`"${path}" 的 schema 认不出类型 —— 拓展的 schema 要用 zod 4 写`);
		if (!optional) fail(`config schema 的必填键 "${path}" 在字段表里没有对应那一栏`);
	}
}

function checkField(
	path: string,
	field: ExtensionField,
	member: unknown,
	fail: (msg: string) => never,
): void {
	const { def, fill, optional } = unwrap(member);
	// 认不出就拒,而不是悄悄跳过这一格 —— 跳过的话,这一格的两份声明就再没人对了。
	if (!def) return void fail(`"${path}" 的 schema 认不出类型 —— 拓展的 schema 要用 zod 4 写`);
	const accepted = field.type === "enum" ? enumValuesOf(def) : undefined;
	if (field.type === "enum" ? !accepted : def.type !== ZOD_TYPE_OF[field.type]) {
		const hint =
			field.type === "enum" && def.type === "union"
				? " —— enum 只认每一支都是字面量(或 z.enum)的 union"
				: "";
		fail(`"${path}" 声明的是 ${field.type},zod 里却是 ${def.type}${hint}`);
	}

	// 🔴 必填也要对上。BN 保存设置前按**清单**校验,没写 `required` 也没给 `default` 的格照清单是
	// 「可以不填」;zod 却收不下 `undefined` —— 缺了这一格的设置照样存得进去,拓展读的时候解不开,
	// **整份**设置按没设过算(桥就是全部接入一起失效)。有默认值的两边已由下面对表钉住。
	const zodRequired = !optional;
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
		assertNotStrict(`"${path}" 的每一项`, item, fail);
		checkFields(`${path}.`, item.shape, field.fields, fail, {
			picked: false,
			listItem: true,
			keysOnly: false,
		});
		return;
	}

	if (field.type === "number") {
		// 🔴 面板照设置项的 min / max 拦,拓展照自己的 zod 收。zod 多一道,面板放行的值拓展一读就整份
		// 失败(设置读不了、拓展起不来);设置项多一道,面板拦下的是拓展本来收的值。
		const zod = numberBoundsOf(def);
		const sides = [
			["下限", field.min, zod.min, ["≥", ">"]],
			["上限", field.max, zod.max, ["≤", "<"]],
		] as const;
		for (const [which, declared, bound, [closed, open]] of sides) {
			if (
				declared === undefined ? bound === undefined : bound?.inclusive && bound.value === declared
			) {
				continue;
			}
			const zodSide = bound ? `${bound.inclusive ? closed : open} ${bound.value}` : "没写";
			fail(
				`"${path}" 的${which}两边不一样:设置项是 ${declared === undefined ? "没写" : `${closed} ${declared}`},zod 是 ${zodSide} —— 面板照设置项拦、拓展照 zod 收,放行的值拓展可能读不了。设置项的 min / max 含端点,对应 zod 的 .min() / .max()(即 .gte() / .lte())`,
			);
		}
	}

	if (field.type === "enum" && accepted) {
		// 面板存的永远是字符串:zod 收的是数字 1 的话,选项写 "1" 也永远存不对。
		const odd = accepted.find((value) => typeof value !== "string");
		if (odd !== undefined) {
			fail(`"${path}" 的 zod 取值里有不是字符串的 ${JSON.stringify(odd)} —— 面板存的永远是字符串`);
		}
		// 面板能选出 zod 不收的值(或者反过来有一种永远选不到),都是漂了。
		const declared = field.options.map((option) => option.value).sort();
		const values = [...new Set(accepted as string[])].sort();
		if (declared.join("\n") !== values.join("\n")) {
			fail(`"${path}" 的选项 [${declared.join(", ")}] 与 zod 的取值 [${values.join(", ")}] 对不上`);
		}
	}

	// 面板显示的默认值就是设置项里写的那个;与 zod 实际补上的不一样,主人看到的就是假话。
	let defaultValue: unknown;
	if (fill) {
		try {
			defaultValue = fill.read();
		} catch (err) {
			fail(
				`"${path}" 的 .${fill.from}() 在缺了这一格时算不出补什么(${err instanceof Error ? err.message : String(err)}) —— 对表要拿它与设置项的 default 比,改成直接给值的 .catch(值) 或 .default(值)`,
			);
		}
	}
	// 补出来是 undefined 的(`.catch(() => undefined)` 这类)等于没补。
	const hasDefault = defaultValue !== undefined;
	const from = fill?.from === "catch" ? "(.catch 补的)" : "";
	if (field.default !== undefined && !hasDefault) {
		fail(`"${path}" 在设置项里写了默认值 ${JSON.stringify(field.default)},zod 里却没有`);
	}
	if (field.default === undefined && hasDefault) {
		fail(
			`"${path}" 在 zod 里有默认值 ${JSON.stringify(defaultValue)}${from},设置项里没写 —— 面板显示的会和实际用的不一样`,
		);
	}
	if (field.default !== undefined && hasDefault && !Object.is(field.default, defaultValue)) {
		fail(
			`"${path}" 的默认值两边不一样:设置项写的是 ${JSON.stringify(field.default)},zod 是 ${JSON.stringify(defaultValue)}${from}`,
		);
	}
}
