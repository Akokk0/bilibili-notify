/**
 * 守卫 13 前半的判定函数:给一个 zod schema,遍历出所有「用某套词表做键」的位置。
 *
 * 认法(词表 = 一组键,如 `FeatureKey` 的 8 个):
 * - `z.object`:形状键**包含**词表的全部键(允许多出别的键,如特性开关还多一个 `extras`)。两套词表有包含关系时
 *   (`CardKind` ⊂ `CardSkinKind`),同一个对象只报最大的那套;
 * - `z.record` / `z.partialRecord`:键 schema 是枚举、取值集合**等于**词表。值接着往下走,路径加 `*`;
 * - `z.enum`:取值集合**等于**词表,算「当值用」(如历史行里「这条推送是哪个特性」那一格)。
 *
 * 穿透:`optional` / `nullable` / `default` / `prefault` / `nonoptional` / `catch` / `readonly` / `promise` /
 * `success`、`pipe`(`transform` / `preprocess` 也是 `pipe`,两头都走)、`lazy`(自引用只走一圈)、数组元素、
 * `union` 的各支(含 `discriminatedUnion`)。`refine` 不改节点形状,不用特判。
 *
 * 路径:对象键用 `.` 连,数组元素 `[]`,record 的值 `*`;根自己命中就是空串。
 *
 * **不认识的节点类型直接抛**(`tuple` / `intersection` / `map` / `set` ……):静默跳过就是让守卫在那一枝上失明,
 * 而 schema 里新长一种节点时类型、测试、构建全绿。要用就在这里补一个分支和一条样例。已知不看的:对象的 `catchall`。
 *
 * 看的是 zod 4 的内部结构(`_zod.def`),升 zod 大版本时先看样例有没有红。
 */

import type { z } from "zod";

/** 一套词表:名字 + 全部键。 */
export interface Vocabulary<Name extends string = string> {
	name: Name;
	keys: readonly string[];
}

/** 一处命中:schema 里 `path` 这个位置用了 `vocabulary` 这套词表。 */
export interface KeyedRecord<Name extends string = string> {
	path: string;
	vocabulary: Name;
}

/** zod 4 节点里这个函数要读的那一小块。只写用到的,别和 `z.core` 的联合类型纠缠。 */
interface ZodNodeLike {
	_zod: { def: ZodDefLike; innerType?: ZodNodeLike };
}
interface ZodDefLike {
	type: string;
	[key: string]: unknown;
}

const WRAPPER_TYPES = new Set([
	"optional",
	"nullable",
	"default",
	"prefault",
	"nonoptional",
	"catch",
	"readonly",
	"promise",
	"success",
]);

/** 没有子节点、也不可能用词表做键的节点。 */
const LEAF_TYPES = new Set([
	"string",
	"number",
	"boolean",
	"bigint",
	"symbol",
	"date",
	"file",
	"null",
	"undefined",
	"void",
	"nan",
	"any",
	"unknown",
	"never",
	"literal",
	"custom",
	"template_literal",
	"transform",
]);

const child = (path: string, segment: string) => (path === "" ? segment : `${path}.${segment}`);

/** 枚举节点的取值;不是枚举回 `undefined`。 */
function enumValues(node: unknown): Set<unknown> | undefined {
	const def = (node as ZodNodeLike)._zod.def;
	if (def.type !== "enum") return undefined;
	return new Set(Object.values(def.entries as Record<string, unknown>));
}

const sameValues = (values: ReadonlySet<unknown>, keys: readonly string[]) => {
	const wanted = new Set(keys);
	return values.size === wanted.size && keys.every((key) => values.has(key));
};

const isSubset = (small: readonly string[], big: readonly string[]) =>
	small.length < big.length && small.every((key) => big.includes(key));

export function findKeyedRecords<Name extends string>(
	schema: z.ZodType,
	vocabularies: readonly Vocabulary<Name>[],
): KeyedRecord<Name>[] {
	const hits = new Map<string, KeyedRecord<Name>>();
	const ancestors = new Set<ZodNodeLike>();

	const report = (path: string, vocabulary: Name) =>
		hits.set(`${path}\0${vocabulary}`, { path, vocabulary });

	function visit(node: ZodNodeLike, path: string): void {
		if (ancestors.has(node)) return;
		ancestors.add(node);
		const { def } = node._zod;

		if (def.type === "object") {
			const shape = def.shape as Record<string, ZodNodeLike>;
			const matched = vocabularies.filter((v) => v.keys.every((key) => Object.hasOwn(shape, key)));
			for (const v of matched) {
				if (!matched.some((other) => isSubset(v.keys, other.keys))) report(path, v.name);
			}
			for (const [key, value] of Object.entries(shape)) visit(value, child(path, key));
		} else if (def.type === "record") {
			const values = enumValues(def.keyType);
			for (const v of vocabularies) if (values && sameValues(values, v.keys)) report(path, v.name);
			visit(def.valueType as ZodNodeLike, child(path, "*"));
		} else if (def.type === "enum") {
			const values = enumValues(node) as Set<unknown>;
			for (const v of vocabularies) if (sameValues(values, v.keys)) report(path, v.name);
		} else if (def.type === "array") {
			visit(def.element as ZodNodeLike, `${path}[]`);
		} else if (def.type === "union") {
			for (const option of def.options as ZodNodeLike[]) visit(option, path);
		} else if (def.type === "pipe") {
			visit(def.in as ZodNodeLike, path);
			visit(def.out as ZodNodeLike, path);
		} else if (def.type === "lazy") {
			visit(node._zod.innerType as ZodNodeLike, path);
		} else if (WRAPPER_TYPES.has(def.type)) {
			visit(def.innerType as ZodNodeLike, path);
		} else if (!LEAF_TYPES.has(def.type)) {
			throw new Error(
				`未识别的 zod 节点 "${def.type}"(路径 ${path || "<根>"}):判定函数看不进去,会在这一枝上失明。` +
					"到 keyed-record-finder.ts 补一个分支和一条样例。",
			);
		}

		ancestors.delete(node);
	}

	visit(schema as unknown as ZodNodeLike, "");
	return [...hits.values()];
}
