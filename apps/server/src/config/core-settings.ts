/**
 * 核心设置(`config/settings/core.json`)的逐格解析与落盘前放回原文。纯函数,不碰盘。
 *
 * 一格坏了只那一格退默认、别的格照盘上的值(规矩见 docs/agents/conventions/settings-validation.md 第 4 条):
 * 整份一次过的话,一个字写坏就开不了机,进不了面板去改。格的划分是每个顶层键一格,`defaults` 与 `ai`
 * 再细一层,`ai.providers` 再按每一家细一层(一家坏了只那一家在内存里不在、别家照常;表本身不是对象才整格退默认);
 * 更深的不再切。
 */

import {
	type GlobalSettings,
	GlobalSettingsSchema,
	type Issue,
	issuesFromZod,
	makeDefaultGlobalSettings,
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

const TOP_CELLS: Cells = GlobalSettingsSchema.shape;
/** 要再细一层的两格:顶层键 → 它的子格表。 */
const SUB_CELLS: Record<string, Cells> = {
	defaults: GlobalSettingsSchema.shape.defaults.shape,
	ai: GlobalSettingsSchema.shape.ai.shape,
};

/**
 * 实例表(`ai.providers`)的键规则与值规则,取自 `GlobalSettingsSchema` 本身:值的规矩只有一个出处,表哪天换了
 * 规则这里跟着变。`.unwrap()` 剥掉 `.default({})`,得到 record,再取它的 `keyType` / `valueType`。
 */
const PROVIDERS_TABLE = GlobalSettingsSchema.shape.ai.shape.providers.unwrap();
const PROVIDER_KEY_SCHEMA: ZodType = PROVIDERS_TABLE.keyType;
const PROVIDER_VALUE_SCHEMA: ZodType = PROVIDERS_TABLE.valueType;

function isPlainObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 这条被隔离的格是不是**某一家 AI 实例**的(路径恰好是 `["ai", "providers", "<id>"]`),是就回那个 id。
 * 配置仓(比值与拒收)、密钥袋(只留这一家名下的键)、问题条目的话三处都问它,不各自去数路径长度。
 * 两段的 `["ai", "providers"]` 是整张表坏了,不是单家。
 */
export function instanceIdOfEntry(path: readonly string[]): string | undefined {
	if (path.length !== 3 || path[0] !== "ai" || path[1] !== "providers") return undefined;
	return path[2];
}

/**
 * 解析实例表(盘上已确认是普通对象)的每一家:自己的键过不了键规则、或值过不了值规则的记一条
 * `["ai", "providers", id]`(原文是那一家的值),内存里**没有这个键**(表是稀疏的,键在 = 主人添加过);
 * 过了的放进结果。
 *
 * 取键与拼装都只认自己的键:盘上可能有一家自己的键叫 `__proto__`(`JSON.parse` 造得出来),
 * `out[id] = …` 遇到它是换原型而不是加键,所以用 `Object.fromEntries`;zod 的 record 在把键交给键规则之前
 * 就静默跳过 `__proto__`,所以这里不靠整表 `safeParse`,每家自己过一遍键与值。
 */
function parseProviderTable(
	table: Json,
	path: string[],
	invalid: InvalidSettingEntry[],
): Record<string, unknown> {
	const good: Array<[string, unknown]> = [];
	for (const [id, raw] of Object.entries(table)) {
		const key = PROVIDER_KEY_SCHEMA.safeParse(id);
		const value = key.success ? PROVIDER_VALUE_SCHEMA.safeParse(raw) : undefined;
		if (value?.success) {
			good.push([id, value.data]);
			continue;
		}
		const error = key.success ? value?.error : key.error;
		invalid.push({
			path: [...path, id],
			issues: error ? issuesFromZod(error) : [],
			raw,
			missing: false,
		});
	}
	return Object.fromEntries(good);
}

/**
 * 解析一格。盘上有这个键:过了取解析值,不过记一条。盘上没有:吃 `undefined` 能过(带 `.default` 或可选)的
 * 不算坏、也不往拼好的对象里放,留给最后那遍整份解析去补;不能过的(必填格缺了)记一条 `missing`。
 * 返回 `undefined` 表示这一格不往拼好的对象里放键(缺了且不算坏)。
 */
export function parseCell(
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
 * 退默认取 `makeDefaultGlobalSettings()` 同一路径上的值而不是 schema 的 `.default`:出厂值才是"新装的样子"。
 * 账本 `templatesSeen` 曾是两边唯一不一致的一格(出厂值填满账本);现在新装账本也是空的(只在主人改某条时才记),
 * 两边已经一致,这条理由不再靠它撑着,取出厂值的写法留着是为了日后哪一格再分叉时不必回头改这里。
 */
export function parseCoreSettings(raw: unknown): {
	settings: GlobalSettings;
	invalid: InvalidSettingEntry[];
} {
	if (!isPlainObject(raw)) {
		const parsed = GlobalSettingsSchema.safeParse(raw);
		if (parsed.success) throw new Error("core settings: a non-object passed the schema");
		throw ConfigValidationError.fromZod("globals", parsed.error, { subject: "settings/core.json" });
	}

	// 入参不许被改写、返回值也不与入参共享引用:先深拷一份,后面都在副本上取。
	const source = structuredClone(raw) as Json;
	const fallback = makeDefaultGlobalSettings() as unknown as Json;
	const invalid: InvalidSettingEntry[] = [];
	const assembled: Json = {};

	for (const [key, schema] of Object.entries(TOP_CELLS)) {
		const subCells = SUB_CELLS[key];
		const cell = source[key];
		if (subCells && isPlainObject(cell)) {
			const sub: Json = {};
			for (const [subKey, subSchema] of Object.entries(subCells)) {
				// 实例表再细一层:每一家自己一格。表本身不是普通对象、或键不在,仍走整格的老路。
				const table = cell[subKey];
				if (key === "ai" && subKey === "providers" && isPlainObject(table)) {
					sub[subKey] = parseProviderTable(table, [key, subKey], invalid);
					continue;
				}
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
	return { settings: GlobalSettingsSchema.parse(assembled), invalid };
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
		// 不写 `parent[key] = …`:键叫 `__proto__` 时那是换原型而不是放回一个自己的键,那一家会静默消失。
		else {
			Object.defineProperty(parent, key, {
				value: structuredClone(entry.raw),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return out;
}
