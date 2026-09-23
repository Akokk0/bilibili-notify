/**
 * 契约形状的守卫 —— 形状一动,契约小号就得有人回答一句(ADR-0019 决策 59、后果「契约小号要记得加」)。
 *
 * 拓展能用的东西变多(事件表加一格、多一种积木、清单多一格)时,契约小号
 * (`EXTENSION_API_RANGE.revision`)要加一。漏了的话,老 BN 会照装要新东西的拓展,再把它报的东西
 * 整条拒掉 —— 而类型、测试、构建全绿。这里把拓展交给 BN 的那几份 zod 转成 JSON Schema 算摘要,
 * 与小号**成对**钉住:形状一动就红,逼人当场回答「对应的 BN 发版了没有」。
 *
 * - 摘要取自**运行时的 schema 对象**,不读源文件:注释、格式、报错文案、`.describe()` 怎么改都不红;
 *   对象的键序与 `required` / `enum` / `anyOf` / `oneOf` 这几个集合的次序也先排好再算 —— 挪一挪
 *   字段、换一换并集成员的次序不算形状变了。
 * - 转换按**输入侧**(`io: "input"`):钉的是拓展**交得进来**什么。表达不了的类型(`z.custom` 这类)
 *   让它照默认的 `unrepresentable: "throw"` 当场炸 —— 换成 `"any"` 那一格就成了 `{}`,守卫从此对它
 *   失明;真要登记这种,替**那一份** schema 写一份形状(见 {@link BYTE_SHAPES})。⚠️ 走不了
 *   `toJSONSchema` 的 `override` 参数:它在处理器之后才跑,custom 的处理器在那之前就 throw 了。
 * - ⚠️ **`refine` / `superRefine` 里的规矩进不了 JSON Schema**,这条看不见 —— 放宽那些(老 BN 会拒、
 *   新 BN 收)同样要抬小号,改的时候自己想一遍。同一个盲区:上报里图的格式与单张字节上限在 `z.custom`
 *   的判定函数里(替它写的形状只说「这是字节、哪一种」),整条上报的图总量上限在走格子那一段里
 *   (`checkSubscriptionReport`),都看不见;张数上限是 `maxItems`、字数与数值的上下限都在形状里,看得见。
 * - 拓展一侧的 TS 类型由 `apps/server/src/extensions/*-shape-pin.ts` 与这几份 zod 双向钉着,所以钉住
 *   zod 就间接钉住了类型。ctx 多一个方法是纯 TS、没有 zod,不在这里。
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { EXTENSION_API_RANGE, ExtensionManifestV2Schema } from "./extension-manifest";
import { SubscriptionCandidatesSchema } from "./extension-subscription";
import { ExtensionViewSchema } from "./extension-view";
import {
	SubscriptionLiveEndSchema,
	SubscriptionLiveStartSchema,
	SubscriptionLiveStatusSchema,
	SubscriptionPostSchema,
	SubscriptionProfileSchema,
	SubscriptionReportAvatarSchema,
	SubscriptionReportPictureSchema,
} from "./subscription-report";

interface ContractRow {
	/** 报错时点名用,也是摘要表的键 —— 不许重名。 */
	name: string;
	schema: z.ZodType;
	/** {@link contractDigest} 的结果。新加一行时先填空串,红了照报错里 Received 那一侧填。 */
	digest: string;
}

/**
 * 被钉的契约 —— **以后加一个 schema 就是往这里加一行**。
 *
 * 只登记拓展**交给 BN**、或 BN 照着它画 / 收的那几份:清单、解析门候选、视图、五种上报。
 */
const CONTRACT: readonly ContractRow[] = [
	{ name: "清单 v2", schema: ExtensionManifestV2Schema, digest: "45bca9ed5ee47dd8" },
	{ name: "解析门候选", schema: SubscriptionCandidatesSchema, digest: "69bdc90eeb29a4b2" },
	{ name: "视图", schema: ExtensionViewSchema, digest: "7333cbc5ca440d8e" },
	{ name: "上报:作品", schema: SubscriptionPostSchema, digest: "21db7ebd2e6b36b3" },
	{ name: "上报:开播", schema: SubscriptionLiveStartSchema, digest: "83ea3e17a459f360" },
	{ name: "上报:下播", schema: SubscriptionLiveEndSchema, digest: "f7e48c7ee78de47e" },
	{ name: "上报:直播状态", schema: SubscriptionLiveStatusSchema, digest: "ded2ea235332d960" },
	{ name: "上报:资料更新", schema: SubscriptionProfileSchema, digest: "a522bed1fa10e01b" },
];

/**
 * 表达不了、但登记过的那几份 schema → 替它写的形状。**按 schema 对象认**,不按类型认:别处再冒出一个
 * `z.custom`,它不在这张表里,照旧 throw。
 *
 * 上报的图是 `z.custom<Uint8Array>`(字节)。形状只说「这是字节」与「哪一种」—— 作品图 / 封面与头像收的
 * 格式不一样,把头像那一格换成作品图那一份(就多收了 gif)也得红。格式与大小本身在判定函数里,看不见。
 *
 * ⚠️ 登记在这里的 schema 不能带 `_zod.parent`(接了 `.refine()` 就有):zod 4.4 碰上「钩子 + parent 链」
 * 会在 `flattenRef` 里炸掉,所以上报那两份字节格是一个 custom、不接 refine。
 */
const BYTE_SHAPES: ReadonlyMap<z.ZodType, Record<string, unknown>> = new Map([
	[SubscriptionReportPictureSchema, { "x-bn-bytes": "Uint8Array", "x-bn-image": "picture" }],
	[SubscriptionReportAvatarSchema, { "x-bn-bytes": "Uint8Array", "x-bn-image": "avatar" }],
]);

/** 上面那些摘要是在哪个契约小号上记的。 */
const PINNED_REVISION = 0;

const HOW_TO_FIX = [
	"契约形状变了(或契约小号变了,而这里记的还是旧的)。",
	"- 对应的 BN 已经发版 → 小号加一(packages/internal 的 EXTENSION_API_RANGE.revision),并更新这里的摘要与 PINNED_REVISION;",
	"- 还没发版 → 只更新摘要。",
	"只动了小号、形状没变 → 把 PINNED_REVISION 改成现在的小号。升级 zod 之后红了、schema 一格没动 → 只更新摘要。",
	"新摘要照下面 Received 那一侧填。",
].join("\n");

/** 这几个关键字的值是**集合**,次序不算数。 */
const SET_KEYWORDS = new Set(["required", "enum", "anyOf", "oneOf"]);

/** 键排好序、集合排好序 —— 两份形状一样的 JSON Schema 在这之后逐字相同。 */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const inner = canonical((value as Record<string, unknown>)[key]);
		out[key] =
			SET_KEYWORDS.has(key) && Array.isArray(inner)
				? inner
						.map((item) => [JSON.stringify(item), item] as const)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([, item]) => item)
				: inner;
	}
	return out;
}

/**
 * 转 JSON Schema 的这一趟里,给 {@link BYTE_SHAPES} 那几份挂上 zod 的单 schema 钩子
 * (`_zod.toJSONSchema`,「override `toJSONSchema` logic」)—— `process()` 先问它、问到了就不走处理器,
 * custom 那一抛就不会发生。转完摘掉,别的地方看见的还是原样的 schema。
 */
function withByteShapes<T>(run: () => T): T {
	const previous = [...BYTE_SHAPES.keys()].map(
		(schema) => [schema, schema._zod.toJSONSchema] as const,
	);
	for (const [schema, shape] of BYTE_SHAPES) schema._zod.toJSONSchema = () => ({ ...shape });
	try {
		return run();
	} finally {
		for (const [schema, hook] of previous) schema._zod.toJSONSchema = hook;
	}
}

/** 一份 schema 的形状摘要(sha256 前 16 位,只用来判「变没变」)。 */
function contractDigest(schema: z.ZodType): string {
	const json = withByteShapes(() =>
		z.toJSONSchema(schema, {
			io: "input",
			// 空的元数据表:`.describe()` / `.meta()` 是文档,不是形状。
			metadata: z.registry(),
			unrepresentable: "throw",
		}),
	);
	return createHash("sha256")
		.update(JSON.stringify(canonical(json)))
		.digest("hex")
		.slice(0, 16);
}

describe("契约形状与契约小号一起变", () => {
	it("每份被钉的 schema 摘要不变,小号也还是记摘要时那一号", () => {
		const names = CONTRACT.map((row) => row.name);
		expect(new Set(names).size, "清单里有重名的行").toBe(names.length);
		const actual = {
			revision: EXTENSION_API_RANGE.revision,
			digests: Object.fromEntries(CONTRACT.map((row) => [row.name, contractDigest(row.schema)])),
		};
		const pinned = {
			revision: PINNED_REVISION,
			digests: Object.fromEntries(CONTRACT.map((row) => [row.name, row.digest])),
		};
		expect(actual, HOW_TO_FIX).toEqual(pinned);
	});
});

/** 摘要只认形状:该红的红,不该红的不红。 */
describe("contractDigest", () => {
	const base = z.strictObject({
		id: z.string().min(1).max(64),
		kind: z.enum(["a", "b"]),
		fans: z.number().int().optional(),
	});

	it("键序、集合次序、报错文案、describe 不同 → 摘要一样", () => {
		const shuffled = z.strictObject({
			fans: z.number().int().optional().describe("粉丝数"),
			kind: z.enum(["b", "a"]),
			id: z.string().min(1, "不能空").max(64, "太长了"),
		});
		expect(contractDigest(shuffled)).toBe(contractDigest(base));
		expect(contractDigest(z.union([z.string(), z.number()]))).toBe(
			contractDigest(z.union([z.number(), z.string()])),
		);
	});

	it.each([
		["放宽一格上限", base.extend({ id: z.string().min(1).max(65) })],
		["多一格选填", base.extend({ avatar: z.string().optional() })],
		["选填变必填", base.extend({ fans: z.number().int() })],
		["枚举多一个值", base.extend({ kind: z.enum(["a", "b", "c"]) })],
		["严格变宽松", z.object(base.shape)],
	])("%s → 摘要变了", (_label, changed) => {
		expect(contractDigest(changed)).not.toBe(contractDigest(base));
	});

	it("没登记的 z.custom 照旧当场炸 —— 替字节格写的形状只挂在登记过的那两份上", () => {
		expect(() =>
			contractDigest(z.strictObject({ bytes: z.custom<Uint8Array>(() => true) })),
		).toThrow(/Custom types/);
	});

	it("作品图与头像两种字节格分得开:头像那一格换成作品图那一份,摘要变了", () => {
		expect(contractDigest(z.strictObject({ avatar: SubscriptionReportPictureSchema }))).not.toBe(
			contractDigest(z.strictObject({ avatar: SubscriptionReportAvatarSchema })),
		);
	});
});
