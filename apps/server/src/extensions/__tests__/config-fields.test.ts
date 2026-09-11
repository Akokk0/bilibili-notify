/**
 * config 的**两份声明**要在加载期对得上(ADR-0012 决策 19 / 33)。
 *
 * 两份不是冗余:**字段表给人填**(标签、控件、提示),**zod 给机器校验**(类型、必填、
 * 跨字段规则)。合成一份要么把字段表逼成一门 DSL,要么让校验退化成只剩类型检查。
 *
 * 代价是「两份会漂」,而这道对表就是那笔账的兜底 —— 漂了当场拒绝加载,并说清是哪一格。
 * 没有它的话,症状是「面板上填了保存不了」或者「有个必填项面板上根本没有」。
 */

import type { ExtensionConfigField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { type ZodType, z } from "zod";
import { assertConfigFieldsMatchSchema } from "../config-fields.js";

const SCHEMA = z.object({
	token: z.string(),
	bridgeKind: z.enum(["koishi", "astrbot"]),
	label: z.string().optional(),
});

function fields(...over: ExtensionConfigField[]): ExtensionConfigField[] {
	return over.length > 0
		? over
		: [
				{ kind: "text", code: "token", label: "长期 token", secret: true },
				{
					kind: "select",
					code: "bridgeKind",
					label: "哪一种桥",
					options: [
						{ value: "koishi", label: "koishi" },
						{ value: "astrbot", label: "AstrBot" },
					],
				},
			];
}

const check = (f: ExtensionConfigField[], schema: z.ZodType = SCHEMA) =>
	assertConfigFieldsMatchSchema("bridge", schema, f);

describe("字段表 × zod 对表", () => {
	it("对得上就放行 —— 可选键没有对应那一栏也没关系", () => {
		expect(() => check(fields())).not.toThrow();
	});

	it("字段表里有一格 zod 不认识 → 拒,并说出是哪个 code", () => {
		expect(() => check([...fields(), { kind: "text", code: "typoo", label: "手滑" }])).toThrow(
			/typoo/,
		);
	});

	it("zod 的必填键没人填 → 拒,并说出是哪个键", () => {
		expect(() => check([fields()[0] as ExtensionConfigField])).toThrow(/bridgeKind/);
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
				[{ kind: "text", code: "nope", label: "?" }],
				{
					picked: true,
				},
			),
		).toThrow(/nope/);
	});

	it("同一个 code 摆了两栏 → 拒。哪一栏说了算是个没人想回答的问题", () => {
		expect(() => check([...fields(), { kind: "text", code: "token", label: "又一个" }])).toThrow(
			/token/,
		);
	});

	it("config 的 schema 不是个对象 → 拒。**第一版 config 必须是扁平的一层键值**", () => {
		// `set` 由前端统一生成成 `config[code] = v`,前提就是它是扁平的。
		expect(() => check([], z.string())).toThrow(/对象/);
	});

	/**
	 * 🔴 **判据按形状问,不认 zod 的类身份。**
	 *
	 * 拓展会被打成自包含的 `index.mjs`,它那份 zod 是**另一个实例** —— `instanceof ZodObject`
	 * 当场为假,而报出来的会是「schema 必须是一个对象」,把人指向完全错误的方向。这里拿一个
	 * **不是本进程 zod 造的**、只是形状对得上的 schema 当替身:它必须照常通过。
	 */
	it("拓展自带的另一份 zod 造出来的 schema 照样认得 —— 不看类身份,看有没有 shape", () => {
		const foreign = {
			shape: {
				token: { safeParse: (v: unknown) => ({ success: v !== undefined }) },
				note: { safeParse: () => ({ success: true }) },
			},
		} as unknown as ZodType;
		expect(() =>
			assertConfigFieldsMatchSchema("bridge", foreign, [
				{ kind: "text", code: "token", label: "token" },
			]),
		).not.toThrow();
		// 必填那条判据也得照样生效(`note` 收得下 undefined,所以不必有栏)。
		expect(() => assertConfigFieldsMatchSchema("bridge", foreign, [])).toThrow(/token/);
	});
});
