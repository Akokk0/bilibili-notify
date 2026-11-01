/**
 * 读 zod 4 规则的那几样 —— 设置项与规则对表(`assertConfigFieldsMatchSchema`)、从规则导出设置项
 * (`settingsFieldsFromSchema`)读的是同一套,两边对「这一格是什么」才不会各说各的。
 *
 * 🔴 **判形状不用 `instanceof`。** 拓展会被打成自包含的 `index.mjs`,它那份 zod 是**另一个
 * 实例** —— `instanceof ZodObject` 当场为假。类型读 zod 4 挂在每个 schema 上的 `_zod.def`,
 * 给人看的那几格读规则对象自己的 `.meta()`(读的是**它那份** zod 的登记表):不管几份 zod 都成立。
 */

/** zod 4 挂在每个 schema 上的定义里,对表要读的那几格。 */
export interface ZodDef {
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
	discriminator?: string;
	keyType?: unknown;
	valueType?: unknown;
	element?: unknown;
	shape?: Record<string, unknown>;
	/** 对象里没声明的键按什么收;strict 对象这一格是 `never`。 */
	catchall?: unknown;
	/** 挂在这一层上的检查(`.min()` / `.max()` / `.refine()` …),每一条自己也有 `_zod.def`。 */
	checks?: readonly unknown[];
}

export function defOf(schema: unknown): ZodDef | undefined {
	return (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;
}

function optinOf(schema: unknown): string | undefined {
	return (schema as { _zod?: { optin?: string } } | undefined)?._zod?.optin;
}

/** 剥完包装之后,对表要的那几样。 */
export interface Unwrapped {
	/** 剥完包装的那一层;认不出(不是 zod 4 造的、包得太深)就没有。 */
	def?: ZodDef;
	/**
	 * 缺了这一格时 zod 补的值:`.default()` 补的,或者 `.catch()` 补的。读值推迟到对表那一刻 ——
	 * 两种都可以交一个函数,函数是拓展写的,抛了要点名到那一格。
	 */
	fill?: { from: "default" | "catch"; read: () => unknown };
	/** 缺了这一格 zod 收不收 —— 收不下的就是必填。 */
	optional: boolean;
	/**
	 * 一路剥下来每一层的 `.meta()` 合在一起,外层的盖过里层的。包装层(`.optional()` / `.default()` …)
	 * 各是一个新实例、不带里面那层的 meta,所以 meta 写在哪一层都读得到。
	 */
	meta?: Readonly<Record<string, unknown>>;
}

/** 这一层自己的 `.meta()`:调的是规则对象自己的方法,读的是造它的那份 zod 的登记表。 */
function ownMetaOf(schema: unknown): Record<string, unknown> | undefined {
	const read = (schema as { meta?: unknown } | undefined)?.meta;
	if (typeof read !== "function") return undefined;
	const meta: unknown = read.call(schema);
	return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined;
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
export function unwrap(schema: unknown, depth = 0, underOptional = false): Unwrapped {
	const got = unwrapLayer(schema, depth, underOptional);
	const own = ownMetaOf(schema);
	return own ? { ...got, meta: { ...got.meta, ...own } } : got;
}

function unwrapLayer(schema: unknown, depth: number, underOptional: boolean): Unwrapped {
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

/**
 * 一组取值在 zod 里的几种写法:`z.enum`、`z.literal`(可以带几个值)、每一支都是这两种之一的
 * `z.union`。认不出是一组取值就回 `undefined`。
 *
 * union 只要有一支不是取值(比如混了一格 `z.string()`),面板就选不全它收的值 —— 不认。
 */
export function enumValuesOf(def: ZodDef): unknown[] | undefined {
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
export interface Bound {
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
export function numberBoundsOf(def: ZodDef): { min?: Bound; max?: Bound } {
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
