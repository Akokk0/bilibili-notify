/**
 * 核心设置(`config/settings/core.json`)的逐格解析与落盘前放回原文。纯函数,不碰盘。
 *
 * 一格坏了只那一格退默认、别的格照盘上的值(规矩见 docs/agents/conventions/settings-validation.md 第 4 条):
 * 整份一次过的话,一个字写坏就开不了机,进不了面板去改。格的划分是每个顶层键一格,`defaults` 与 `ai`
 * 再细一层;更深的(`ai.providers` 里一家坏了)不再切,那一格整个退默认。
 */

import {
	type GlobalConfig,
	GlobalConfigSchema,
	type Issue,
	issuesFromZod,
	makeDefaultGlobalConfig,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { ConfigValidationError } from "./validation-error.js";

/** 被隔离的一格。 */
export interface InvalidSettingEntry {
	/** `["history"]`、`["ai", "providers"]`。 */
	path: string[];
	issues: Issue[];
	/** 盘上原文那一格的 JSON 值;`missing` 时是 `undefined`。 */
	raw: unknown;
	/** 盘上根本没有这个键(必填格缺了);放回时是删键。 */
	missing: boolean;
}

type Cells = Record<string, ZodType>;
type Json = Record<string, unknown>;

const TOP_CELLS: Cells = GlobalConfigSchema.shape;
/** 要再细一层的两格:顶层键 → 它的子格表。 */
const SUB_CELLS: Record<string, Cells> = {
	defaults: GlobalConfigSchema.shape.defaults.shape,
	ai: GlobalConfigSchema.shape.ai.shape,
};

function isPlainObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析一格。盘上有这个键:过了取解析值,不过记一条。盘上没有:吃 `undefined` 能过(带 `.default` 或可选)的
 * 不算坏、也不往拼好的对象里放,留给最后那遍整份解析去补;不能过的(必填格缺了)记一条 `missing`。
 * 返回 `undefined` 表示这一格不往拼好的对象里放键(缺了且不算坏)。
 */
function parseCell(
	schema: ZodType,
	source: Json,
	key: string,
	path: string[],
	fallback: unknown,
	invalid: InvalidSettingEntry[],
): { value: unknown } | undefined {
	const present = Object.hasOwn(source, key);
	const parsed = schema.safeParse(source[key]);
	if (parsed.success) return present ? { value: parsed.data } : undefined;
	invalid.push({
		path,
		issues: issuesFromZod(parsed.error),
		raw: present ? source[key] : undefined,
		missing: !present,
	});
	return { value: fallback };
}

/**
 * 盘上读进来的核心设置 → 规范形态的 `settings`,加上被隔离的格。顶层不是普通对象是信封坏(全部格一起退默认
 * 比挡开机更隐蔽:目标清空、AI 关掉、拓展全关),照整份校验不过的老办法抛。
 *
 * 退默认取 `makeDefaultGlobalConfig()` 同一路径上的值而不是 schema 的 `.default`:两边只有 `templatesSeen`
 * 不一致(schema 默认空表,出厂值是填满的账本),取出厂值才不会在退默认后凭空冒出一排「默认文案有更新」。
 */
export function parseCoreSettings(raw: unknown): {
	settings: GlobalConfig;
	invalid: InvalidSettingEntry[];
} {
	if (!isPlainObject(raw)) {
		const parsed = GlobalConfigSchema.safeParse(raw);
		if (parsed.success) throw new Error("core settings: a non-object passed the schema");
		throw ConfigValidationError.fromZod("globals", parsed.error, { subject: "settings/core.json" });
	}

	// 入参不许被改写、返回值也不与入参共享引用:先深拷一份,后面都在副本上取。
	const source = structuredClone(raw) as Json;
	const fallback = makeDefaultGlobalConfig() as unknown as Json;
	const invalid: InvalidSettingEntry[] = [];
	const assembled: Json = {};

	for (const [key, schema] of Object.entries(TOP_CELLS)) {
		const subCells = SUB_CELLS[key];
		const cell = source[key];
		if (subCells && isPlainObject(cell)) {
			const sub: Json = {};
			for (const [subKey, subSchema] of Object.entries(subCells)) {
				const r = parseCell(
					subSchema,
					cell,
					subKey,
					[key, subKey],
					(fallback[key] as Json)[subKey],
					invalid,
				);
				if (r) sub[subKey] = r.value;
			}
			assembled[key] = sub;
			continue;
		}
		const r = parseCell(schema, source, key, [key], fallback[key], invalid);
		if (r) assembled[key] = r.value;
	}

	// 拼好的整份理应过得了;抛了就是这个函数自己的 bug,不接。
	return { settings: GlobalConfigSchema.parse(assembled), invalid };
}

/**
 * 落盘前把仍被隔离的格盖回盘上原文(`missing` 的删键),让「盘上原文不动」在整份重写时也成立。
 * 在密钥抠除之后调,不是之前:抠除只认合法的内存值,遇到原文那种不合形状的会把它改成别的样子。
 *
 * 两级路径的父格不是普通对象时(盘上与条目对不上号,理应不会发生)跳过那一条、不抛:落盘口宁可少放回一格,
 * 也不该因此写不了盘。入参不改写,放回的原文是副本。
 */
export function withRawSettings(disk: unknown, entries: readonly InvalidSettingEntry[]): unknown {
	const out = structuredClone(disk);
	if (!isPlainObject(out)) return out;
	for (const entry of entries) {
		const key = entry.path[entry.path.length - 1];
		if (key === undefined) continue;
		let parent: Json = out;
		for (const step of entry.path.slice(0, -1)) {
			const next = parent[step];
			if (!isPlainObject(next)) {
				parent = {};
				break;
			}
			parent = next;
		}
		if (entry.missing) delete parent[key];
		else parent[key] = structuredClone(entry.raw);
	}
	return out;
}
