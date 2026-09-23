/**
 * config 的**两份声明**要在加载期对得上(ADR-0012 决策 19 / 33)。
 *
 * 两份不是冗余:**字段表给人填**(标签、控件、提示),**zod 给机器校验**(类型、必填、
 * 跨字段规则)。合成一份要么把字段表逼成一门 DSL,要么让校验退化成只剩类型检查。
 *
 * 代价是「两份会漂」,而这道对表就是那笔账的兜底 —— 漂了当场拒绝加载,并说清是哪一格。
 * 没有它的话,症状是「面板上填了保存不了」或者「有个必填项面板上根本没有」。
 */

import type { ExtensionField, ExtensionScalarField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { type ZodType, z } from "zod";
import { assertConfigFieldsMatchSchema } from "../config-fields.js";

const SCHEMA = z.object({
	token: z.string(),
	bridgeKind: z.enum(["koishi", "astrbot"]),
	label: z.string().optional(),
});

function fields(...over: ExtensionField[]): ExtensionField[] {
	return over.length > 0
		? over
		: [
				{ type: "string", key: "token", label: "长期 token", secret: true, required: true },
				{
					type: "enum",
					key: "bridgeKind",
					label: "哪一种桥",
					required: true,
					options: [
						{ value: "koishi", label: "koishi" },
						{ value: "astrbot", label: "AstrBot" },
					],
				},
			];
}

const check = (f: ExtensionField[], schema: z.ZodType = SCHEMA) =>
	assertConfigFieldsMatchSchema("bridge", schema, f);

describe("字段表 × zod 对表", () => {
	it("对得上就放行 —— 可选键没有对应那一栏也没关系", () => {
		expect(() => check(fields())).not.toThrow();
	});

	it("字段表里有一格 zod 不认识 → 拒,并说出是哪个 key", () => {
		expect(() => check([...fields(), { type: "string", key: "typoo", label: "手滑" }])).toThrow(
			/typoo/,
		);
	});

	/**
	 * 🔴 zod 的 shape 是个普通对象:`key in shape` 会顺着原型链把 `toString` 判成「是 schema 的键」。
	 * v2 清单校验那头已经拒这种 key,但 v1 的字段表写在代码里、不过清单校验,只剩这一道。
	 */
	it("字段表里的 key 是 Object.prototype 上的名字、zod 里没有 → 拒(v1 只对键,也照拒)", () => {
		const schema = z.object({ a: z.string().optional() });
		const field: ExtensionField = { type: "string", key: "toString", label: "?" };
		expect(() => assertConfigFieldsMatchSchema("demo", schema, [field])).toThrow(
			/"toString" 不是 config schema 的键/,
		);
		expect(() => assertConfigFieldsMatchSchema("demo", schema, [field], { v1: true })).toThrow(
			/"toString" 不是 config schema 的键/,
		);
	});

	it("zod 的必填键没人填 → 拒,并说出是哪个键", () => {
		expect(() => check([fields()[0] as ExtensionField])).toThrow(/bridgeKind/);
	});

	/**
	 * 连接是**挑**出来的(`listBots`,ADR-0012 决策 45)时,config 由拓展自己交、没有一栏是人填的
	 * —— 必填键不在字段表里是正常的,不是漂了。字段表里有格、zod 不认识仍然要拒。
	 */
	it("config 是挑出来的(有 listBots)→ 必填键不在字段表里也放行;字段表里多出来的格照拒", () => {
		expect(() =>
			assertConfigFieldsMatchSchema("bridge", SCHEMA, [], { picked: true }),
		).not.toThrow();
		expect(() =>
			assertConfigFieldsMatchSchema(
				"bridge",
				SCHEMA,
				[{ type: "string", key: "nope", label: "?" }],
				{
					picked: true,
				},
			),
		).toThrow(/nope/);
	});

	it("同一个 key 摆了两栏 → 拒。哪一栏说了算是个没人想回答的问题", () => {
		expect(() => check([...fields(), { type: "string", key: "token", label: "又一个" }])).toThrow(
			/token/,
		);
	});

	it("config 的 schema 不是个对象 → 拒。**第一版 config 必须是扁平的一层键值**", () => {
		// `set` 由前端统一生成成 `config[key] = v`,前提就是它是扁平的。
		expect(() => check([], z.string())).toThrow(/对象/);
	});

	/**
	 * 🔴 **判据按形状问,不认 zod 的类身份。**
	 *
	 * 拓展会被打成自包含的 `index.mjs`,它那份 zod 是**另一个实例** —— `instanceof ZodObject`
	 * 当场为假,而报出来的会是「schema 必须是一个对象」,把人指向完全错误的方向。这里拿一个
	 * **不是本进程 zod 造的**、只是形状对得上的 schema 当替身:它必须照常通过。
	 */
	it("拓展自带的另一份 zod 造出来的 schema 照样认得 —— 不看类身份,看形状", () => {
		// zod 4 的每个 schema 都挂着 `_zod.def`(不管哪个实例),对类型就是读它;缺了收不收读
		// `_zod.optin`。替身上不挂 `safeParse` —— 对表不跑校验(异步 refine 一跑就抛)。
		const foreign = {
			shape: {
				token: { _zod: { def: { type: "string" } } },
				note: { _zod: { def: { type: "string" }, optin: "optional" } },
			},
		} as unknown as ZodType;
		expect(() =>
			assertConfigFieldsMatchSchema("bridge", foreign, [
				{ type: "string", key: "token", label: "token", required: true },
			]),
		).not.toThrow();
		// 必填那条判据也得照样生效(`note` 的 optin 是 optional,缺了也收,所以不必有栏)。
		expect(() => assertConfigFieldsMatchSchema("bridge", foreign, [])).toThrow(/token/);
	});
});

/**
 * 对表不只对键,**连类型与默认值一起对**(ADR-0019 决策 17):设置项按数据类型分、与 zod 一一
 * 对应,所以两份声明在这几格上也漂不开。漂了的症状都很难查 —— 面板画成开关、zod 要的是数字,
 * 存不进去;面板上显示默认 30、实际用的是 60。
 */
describe("对表:类型与默认值", () => {
	const one = (field: ExtensionField, member: ZodType) =>
		assertConfigFieldsMatchSchema("demo", z.object({ [field.key]: member }), [field]);

	it.each<[string, ExtensionField, ZodType]>([
		["string", { type: "string", key: "a", label: "A", required: true }, z.string().min(1)],
		[
			"number(整数、上下限两边一样)",
			{ type: "number", key: "a", label: "A", required: true, min: 1 },
			z.int().min(1),
		],
		["boolean", { type: "boolean", key: "a", label: "A", required: true }, z.boolean()],
		[
			"enum",
			{
				type: "enum",
				key: "a",
				label: "A",
				required: true,
				options: [
					{ value: "x", label: "X" },
					{ value: "y", label: "Y" },
				],
			},
			z.enum(["y", "x"]),
		],
		["可选", { type: "string", key: "a", label: "A" }, z.string().optional()],
		["可空", { type: "string", key: "a", label: "A", required: true }, z.string().nullable()],
		[
			"带转换(按输入那一侧对)",
			{ type: "string", key: "a", label: "A", required: true },
			z.string().transform(Number),
		],
	])("%s —— 对得上", (_label, field, member) => {
		expect(() => one(field, member)).not.toThrow();
	});

	it("类型对不上 —— 拒,并说出是哪一格、两边各是什么", () => {
		expect(() => one({ type: "boolean", key: "interval", label: "间隔" }, z.number())).toThrow(
			/"interval".*boolean.*number/,
		);
		expect(() => one({ type: "string", key: "a", label: "A" }, z.enum(["x"]))).toThrow(/"a"/);
	});

	it("enum 的选项与 zod 的取值对不上 —— 拒(面板能选出 zod 不收的值)", () => {
		expect(() =>
			one(
				{
					type: "enum",
					key: "kind",
					label: "种类",
					required: true,
					options: [{ value: "koishi", label: "koishi" }],
				},
				z.enum(["koishi", "astrbot"]),
			),
		).toThrow(/"kind"/);
	});

	it("默认值两边一样 —— 放行", () => {
		expect(() =>
			one({ type: "number", key: "a", label: "A", default: 60 }, z.number().default(60)),
		).not.toThrow();
	});

	it.each<[string, ExtensionField, ZodType]>([
		["两边不一样", { type: "number", key: "a", label: "A", default: 30 }, z.number().default(60)],
		["只有设置项写了", { type: "boolean", key: "a", label: "A", default: true }, z.boolean()],
		["只有 zod 写了", { type: "string", key: "a", label: "A" }, z.string().default("x")],
	])("默认值%s —— 拒(面板显示的会和实际用的不一样)", (_label, field, member) => {
		expect(() => one(field, member)).toThrow(/"a".*默认/);
	});

	describe("list", () => {
		const LINK = z.object({
			id: z.string().min(1),
			name: z.string().min(1),
			token: z.string(),
			note: z.string().optional(),
		});
		const list = (fields: ExtensionScalarField[]): ExtensionField => ({
			type: "list",
			key: "links",
			label: "接入",
			title: "name",
			required: true,
			fields,
		});
		const NAME: ExtensionScalarField = {
			type: "string",
			key: "name",
			label: "名字",
			required: true,
		};
		const TOKEN: ExtensionScalarField = {
			type: "string",
			key: "token",
			label: "Token",
			secret: true,
			required: true,
		};

		it("对象数组、每一项逐格对上 —— 放行(列表自己的默认空数组不算默认值漂移)", () => {
			expect(() => one(list([NAME, TOKEN]), z.array(LINK).default([]))).not.toThrow();
		});

		it("项里有一格类型对不上 —— 拒,并说出是哪个列表里的哪一格", () => {
			expect(() =>
				one(list([NAME, { type: "number", key: "token", label: "Token" }]), z.array(LINK)),
			).toThrow(/"links\.token"/);
		});

		it("项里有一格 zod 不认识 —— 拒", () => {
			expect(() =>
				one(list([NAME, TOKEN, { type: "string", key: "typoo", label: "?" }]), z.array(LINK)),
			).toThrow(/"links\.typoo"/);
		});

		it("项里的必填键没人填 —— 拒", () => {
			expect(() => one(list([NAME]), z.array(LINK))).toThrow(/"links\.token"/);
		});

		/** 项的 id 由 BN 生成、藏起来(ADR-0019 决策 29):清单里不声明它,zod 里却必须有。 */
		it("项的 id 免声明;zod 的项里没有 id —— 拒(BN 生成的 id 会被它当场剥掉)", () => {
			expect(() => one(list([NAME, TOKEN]), z.array(LINK))).not.toThrow();
			const noId = z.object({ name: z.string().min(1), token: z.string() });
			expect(() => one(list([NAME, TOKEN]), z.array(noId))).toThrow(/"links\.id"/);
		});

		it("zod 那边不是对象数组 —— 拒", () => {
			expect(() => one(list([NAME]), z.array(z.string()))).toThrow(/"links"/);
			expect(() => one(list([NAME]), z.string())).toThrow(/"links"/);
		});
	});

	it("认不出类型的 schema(不是 zod 4 造的)—— 拒,而不是悄悄跳过这一格", () => {
		const opaque = {
			shape: { a: { safeParse: () => ({ success: true }) } },
		} as unknown as ZodType;
		expect(() =>
			assertConfigFieldsMatchSchema("demo", opaque, [{ type: "string", key: "a", label: "A" }]),
		).toThrow(/"a".*zod 4/);
	});
});

/**
 * 对表也对**必填**:zod 那格收不下 `undefined`,清单却既没写 `required: true` 也没给 `default`
 * —— BN 按清单派生的保存校验就会放过缺了这一格的设置,而拓展自己的 zod 解不开,**整份**设置
 * 按没设过算(桥就是全部接入一起失效)。所以拒绝加载,并说清哪一格、怎么改。
 */
describe("对表:必填", () => {
	const one = (field: ExtensionField, member: ZodType) =>
		assertConfigFieldsMatchSchema("demo", z.object({ [field.key]: member }), [field]);

	it.each<[string, ExtensionField, ZodType]>([
		["string", { type: "string", key: "a", label: "A" }, z.string()],
		["number", { type: "number", key: "a", label: "A" }, z.number()],
		["boolean", { type: "boolean", key: "a", label: "A" }, z.boolean()],
		[
			"enum",
			{ type: "enum", key: "a", label: "A", options: [{ value: "x", label: "X" }] },
			z.enum(["x"]),
		],
	])("zod 必填、清单没写 required 也没给 default(%s)—— 拒,点名那一格并说怎么改", (_l, f, m) => {
		expect(() => one(f, m)).toThrow(/"a".*必填.*"required": true.*default/);
	});

	it("列表项里的一格也算 —— 点名到列表里那一格", () => {
		const item = z.object({ id: z.string(), token: z.string() });
		const list: ExtensionField = {
			type: "list",
			key: "links",
			label: "接入",
			title: "token",
			required: true,
			fields: [{ type: "string", key: "token", label: "Token" }],
		};
		expect(() => one(list, z.array(item))).toThrow(/"links\.token".*必填/);
	});

	it("列表本身 zod 必填(没有 .default([]))、清单没写 required —— 拒,提示给 zod 一个默认值", () => {
		const item = z.object({ id: z.string(), name: z.string().optional() });
		const list: ExtensionField = {
			type: "list",
			key: "links",
			label: "接入",
			title: "name",
			fields: [{ type: "string", key: "name", label: "名字" }],
		};
		expect(() => one(list, z.array(item))).toThrow(/"links".*必填.*\.default\(\[\]\)/);
		expect(() => one(list, z.array(item).default([]))).not.toThrow();
	});

	it.each<[string, ExtensionField, ZodType]>([
		[
			"清单写了 required: true",
			{ type: "string", key: "a", label: "A", required: true },
			z.string(),
		],
		[
			"两边都给了默认值",
			{ type: "string", key: "a", label: "A", default: "" },
			z.string().default(""),
		],
		["zod 那格本来就可选", { type: "string", key: "a", label: "A" }, z.string().optional()],
	])("%s —— 放行", (_label, field, member) => {
		expect(() => one(field, member)).not.toThrow();
	});
});

/**
 * 审查找出来的两头(ADR-0019 决策 43):一头是**合法的写法被判成对不上**、拓展加载不了;另一头是
 * **漂了对不出来** —— 面板放行的值拓展一读就整份失败,或者面板显示的默认值是假话。
 */
describe("对表:误判 —— 这些写法是合法的,得认得", () => {
	const one = (field: ExtensionField, member: ZodType) =>
		assertConfigFieldsMatchSchema("demo", z.object({ [field.key]: member }), [field]);

	/**
	 * `z.preprocess(fn, inner)` 在 zod 4 里是一根 pipe:`in` 是那个 fn(一格 transform),`out` 才是
	 * 真类型。与 `.transform()` 正好反过来(`in` 是真类型、`out` 是转换),所以两种得分开认。
	 */
	it("z.preprocess 按里面那个真类型对 —— 对得上放行,对不上照拒", () => {
		const toNumber = (v: unknown) => (typeof v === "string" ? Number(v) : v);
		expect(() =>
			one(
				{ type: "number", key: "a", label: "A", required: true },
				z.preprocess(toNumber, z.number()),
			),
		).not.toThrow();
		expect(() =>
			one(
				{ type: "string", key: "a", label: "A", required: true },
				z.preprocess(toNumber, z.number()),
			),
		).toThrow(/"a".*string.*number/);
	});

	/** 一组字符串取值,zod 里除了 `z.enum` 还常写成字面量的 union —— 两种说的是同一件事。 */
	describe("enum 用字面量写", () => {
		const XY: ExtensionField = {
			type: "enum",
			key: "a",
			label: "A",
			required: true,
			options: [
				{ value: "x", label: "X" },
				{ value: "y", label: "Y" },
			],
		};
		const X_ONLY: ExtensionField = { ...XY, options: [{ value: "x", label: "X" }] };

		it.each<[string, ExtensionField, ZodType]>([
			["字面量的 union", XY, z.union([z.literal("y"), z.literal("x")])],
			["一个字面量带几个值", XY, z.literal(["x", "y"])],
			["单个字面量", X_ONLY, z.literal("x")],
			["union 里混着 z.enum", XY, z.union([z.enum(["x"]), z.literal("y")])],
		])("%s —— 对得上", (_label, field, member) => {
			expect(() => one(field, member)).not.toThrow();
		});

		it("取值对不上 —— 照拒,说出两边各是什么", () => {
			expect(() => one(XY, z.union([z.literal("x"), z.literal("z")]))).toThrow(
				/"a" 的选项 \[x, y\].*\[x, z\]/,
			);
		});

		/** 两条都挑「别的都对得上」的例子 —— 只剩被测的那一条规矩能让它拒。 */
		it("union 里有一支不是字面量 —— 拒(面板选不全它收的值)", () => {
			expect(() => one(XY, z.union([z.literal("x"), z.literal("y"), z.string()]))).toThrow(
				/"a".*enum.*union/,
			);
		});

		it('字面量不是字符串 —— 拒(面板存的永远是字符串,选项写 "1" 也存不成数字 1)', () => {
			const field: ExtensionField = {
				...XY,
				options: [
					{ value: "x", label: "X" },
					{ value: "1", label: "一" },
				],
			};
			expect(() => one(field, z.union([z.literal("x"), z.literal(1)]))).toThrow(/"a".*字符串/);
		});
	});

	/** `z.lazy` 只是晚一步拿到里面那份 schema(递归结构、互相引用时用),剥开再对。 */
	it("z.lazy 剥开再对 —— 类型、默认值、列表的项都照常对", () => {
		expect(() =>
			one(
				{ type: "string", key: "a", label: "A", required: true },
				z.lazy(() => z.string()),
			),
		).not.toThrow();
		expect(() =>
			one(
				{ type: "number", key: "a", label: "A", default: 3 },
				z.lazy(() => z.number().default(3)),
			),
		).not.toThrow();
		const item = z.object({ id: z.string(), name: z.string() });
		expect(() =>
			one(
				{
					type: "list",
					key: "a",
					label: "A",
					title: "name",
					required: true,
					fields: [{ type: "string", key: "name", label: "名字", required: true }],
				},
				z.array(z.lazy(() => item)),
			),
		).not.toThrow();
		expect(() =>
			one(
				{ type: "string", key: "a", label: "A", required: true },
				z.lazy(() => z.number()),
			),
		).toThrow(/"a".*string.*number/);
	});

	/**
	 * 🔴 判「必填」不能靠 `safeParse(undefined)`:带异步 refine 的 schema 一被同步解析就抛(「同步解析
	 * 撞上 Promise」),整条对表跟着崩,拓展加载不了。refine 本来就与「缺了这一格收不收」无关。
	 */
	describe("异步 refine", () => {
		const ok = async () => true;

		it.each<[string, ExtensionField, ZodType]>([
			[
				"带默认值",
				{ type: "string", key: "a", label: "A", default: "" },
				z.string().default("").refine(ok),
			],
			["可选", { type: "string", key: "a", label: "A" }, z.string().optional().refine(ok)],
		])("%s的一格带异步 refine —— 照常对,不崩", (_label, field, member) => {
			expect(() => one(field, member)).not.toThrow();
		});

		it("字段表里没有的那一格带异步 refine —— 照常判它是不是必填,不崩", () => {
			const schema = z.object({ a: z.string(), note: z.string().optional().refine(ok) });
			expect(() =>
				assertConfigFieldsMatchSchema("demo", schema, [
					{ type: "string", key: "a", label: "A", required: true },
				]),
			).not.toThrow();
			const strict = z.object({ a: z.string(), note: z.string().refine(ok) });
			expect(() =>
				assertConfigFieldsMatchSchema("demo", strict, [
					{ type: "string", key: "a", label: "A", required: true },
				]),
			).toThrow(/必填键 "note"/);
		});

		it("必填照样判得出来 —— 带异步 refine 的必填格,清单没写 required 照拒", () => {
			expect(() => one({ type: "string", key: "a", label: "A" }, z.string().refine(ok))).toThrow(
				/"a".*必填/,
			);
		});
	});

	/**
	 * 不跑校验判必填,读的是 zod 自己算的「缺了收不收」;preprocess 那根 pipe 的入口是个 transform,
	 * 那一格说「收」—— 可缺了的值过完 fn 还是 undefined,里面那个真类型照样不收。
	 */
	it("z.preprocess 的必填照里面那个真类型判 —— 真类型必填、清单没写 required,拒", () => {
		const toNumber = (v: unknown) => (typeof v === "string" ? Number(v) : v);
		expect(() =>
			one({ type: "number", key: "a", label: "A" }, z.preprocess(toNumber, z.number())),
		).toThrow(/"a".*必填/);
		expect(() =>
			one({ type: "number", key: "a", label: "A" }, z.preprocess(toNumber, z.number().optional())),
		).not.toThrow();
	});
});

describe("对表:漏判 —— 漂了今天对不出来", () => {
	const one = (field: ExtensionField, member: ZodType) =>
		assertConfigFieldsMatchSchema("demo", z.object({ [field.key]: member }), [field]);

	/**
	 * 面板照设置项的 `min` / `max` 拦,拓展照自己的 zod 收:zod 那边多一道下限,面板放行的值拓展一读
	 * 就整份失败;反过来是面板拦下了拓展本来收的值。设置项的上下限**含端点**(`.min()` / `.max()`)。
	 */
	describe("数值上下限", () => {
		const num = (
			over: Partial<Extract<ExtensionField, { type: "number" }>> = {},
		): ExtensionField => ({
			type: "number",
			key: "a",
			label: "A",
			required: true,
			...over,
		});

		it.each<[string, ExtensionField, ZodType]>([
			["两边都没有", num(), z.number()],
			["整数本身不算上下限", num(), z.int()],
			["min / max 两边一样", num({ min: 1, max: 10 }), z.number().min(1).max(10)],
			["gte / lte 就是 min / max", num({ min: 0, max: 10 }), z.int().gte(0).lte(10)],
			// 最紧的那道摆在中间:「取第一道」「取最后一道」都会读成别的数。
			["叠了几道的取最紧的那道", num({ min: 3 }), z.number().min(1).min(3).min(2)],
		])("%s —— 放行", (_label, field, member) => {
			expect(() => one(field, member)).not.toThrow();
		});

		it.each<[string, ExtensionField, ZodType, RegExp]>([
			["zod 有下限、设置项没写", num(), z.number().min(1), /"a" 的下限/],
			["设置项写了上限、zod 没有", num({ max: 10 }), z.number(), /"a" 的上限/],
			["下限的数不一样", num({ min: 1 }), z.number().min(0), /"a" 的下限/],
			["下限开闭不同(.positive() 是 > 0)", num({ min: 0 }), z.number().positive(), /"a" 的下限/],
			["上限开闭不同", num({ max: 10 }), z.number().lt(10), /"a" 的上限/],
		])("%s —— 拒,点名那一格", (_label, field, member, message) => {
			expect(() => one(field, member)).toThrow(message);
		});
	});

	/**
	 * `.catch(v)`:缺了这一格(收不下 undefined)时它补 v —— 与 `.default(v)` 是同一件事,默认值照同一套
	 * 规矩对。但它只在里面那层**拒了** undefined 时才出手,所以不是每个 `.catch` 都补值。
	 */
	describe(".catch 当默认值对", () => {
		const field = (fill: number | undefined): ExtensionField => ({
			type: "number",
			key: "a",
			label: "A",
			...(fill === undefined ? {} : { default: fill }),
		});

		it.each<[string, ZodType, number | undefined]>([
			["catch 补值", z.number().catch(5), 5],
			["函数形式的 catch", z.number().catch(() => 5), 5],
			["套在 nullable 里照样补", z.number().catch(5).nullable(), 5],
			["default 在里面:default 先补,catch 不出手", z.number().default(3).catch(5), 3],
			["default 在外面:缺了先补 default", z.number().catch(5).default(3), 3],
			["里面已经收 undefined:catch 不出手", z.number().optional().catch(5), undefined],
			[
				"套在 optional 里:缺了就是缺了,catch 补的被 optional 丢掉",
				z.number().catch(5).optional(),
				undefined,
			],
		])("%s", (_label, member, fill) => {
			// 先钉 zod 自己怎么补 —— 哪天升级 zod 改了这条,这里先红,对表那头跟着改。
			expect(z.object({ a: member }).parse({}).a).toBe(fill);
			expect(() => one(field(fill), member)).not.toThrow();
		});

		it("catch 补了值、设置项没写默认值 —— 拒,并说出是 .catch 补的", () => {
			expect(() => one(field(undefined), z.number().catch(5))).toThrow(/"a".*默认值 5.*\.catch/);
		});

		it("两边的默认值不一样 —— 拒", () => {
			expect(() => one(field(3), z.number().catch(5))).toThrow(/"a" 的默认值两边不一样.*3.*5/);
		});

		it(".catch 的函数算不出补什么 —— 拒并点名那一格,不是整条对表崩成一句看不懂的错", () => {
			const member = z.number().catch(() => {
				throw new Error("boom");
			});
			expect(() => one(field(undefined), member)).toThrow(/"a" 的 \.catch\(\).*boom/);
		});
	});

	/**
	 * 🔴 strict 对象碰上存量:清单改过、旧版留下一个旧键,strict 就整份解不开 —— 设置读不了,拓展起不来
	 * (ADR-0019 决策 36)。对表时就拒,并说清怎么改。
	 */
	describe("strict 对象", () => {
		const A: ExtensionField = { type: "string", key: "a", label: "A", required: true };
		const list = (item: ZodType) =>
			assertConfigFieldsMatchSchema("demo", z.object({ links: z.array(item).default([]) }), [
				{
					type: "list",
					key: "links",
					label: "接入",
					title: "name",
					fields: [{ type: "string", key: "name", label: "名字", required: true }],
				},
			]);

		it.each<[string, ZodType]>([
			["z.strictObject", z.strictObject({ a: z.string() })],
			[".strict()", z.object({ a: z.string() }).strict()],
		])("顶层是 %s —— 拒,说清为什么、怎么改", (_label, schema) => {
			expect(() => assertConfigFieldsMatchSchema("demo", schema, [A])).toThrow(
				/strict.*旧键.*z\.object.*passthrough/,
			);
		});

		it("列表的项是 strict —— 拒,点名那个列表", () => {
			expect(() => list(z.strictObject({ id: z.string(), name: z.string() }))).toThrow(
				/"links".*strict/,
			);
		});

		it("连接配置(挑出来的)也一样 —— 存在连接里的那份照样会多旧键", () => {
			expect(() =>
				assertConfigFieldsMatchSchema("demo", z.strictObject({ link: z.string() }), [], {
					picked: true,
				}),
			).toThrow(/strict/);
		});

		it.each<[string, ZodType]>([
			["普通 z.object(多的键丢掉)", z.object({ a: z.string() })],
			["z.looseObject", z.looseObject({ a: z.string() })],
			[".passthrough()", z.object({ a: z.string() }).passthrough()],
		])("%s —— 放行", (_label, schema) => {
			expect(() => assertConfigFieldsMatchSchema("demo", schema, [A])).not.toThrow();
			expect(() => list(z.object({ id: z.string(), name: z.string() }))).not.toThrow();
		});

		/** v1 格式已冻结:加规矩等于让已经发出去的 v1 包加载不了。 */
		it("v1 不查(只对键)", () => {
			expect(() =>
				assertConfigFieldsMatchSchema("demo", z.strictObject({ a: z.string() }), [A], { v1: true }),
			).not.toThrow();
		});
	});
});
