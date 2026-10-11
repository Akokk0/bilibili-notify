/**
 * 集成段设置(`config/settings/<集成键>.json`)的逐格解析。纯函数,不碰盘。
 *
 * 规矩与核心设置同一条(docs/agents/conventions/settings-validation.md 第 4 条):一格坏了只那一格退默认、
 * 别的格照盘上的值。格的划分是段 schema 的每个顶层键一格,不再往下切 —— 更深的那一格整个退默认。
 * 落盘前把坏格盖回原文用核心那一个 `withRawSettings`,这里不另写。
 */

import type { ZodObject, ZodType } from "zod";
import { type InvalidSettingEntry, parseCell } from "./core-settings.js";

/**
 * 盘上读进来的一份集成设置 → 规范形态的 `settings`,加上被隔离的格。`raw` 必须是普通对象
 * (顶层不是对象、文件不是 JSON 是「整段读不懂」,由调用方在这之前分流)。
 *
 * 前提:`schema.parse({})` 过得了 —— 配置仓登记时核。退默认取的就是它同一个键上的值;
 * 没有默认的可选格,键不放进结果。盘上多出来的键被 schema 剥掉,不算坏。
 * 入参不改写,返回值与入参不共享引用。
 */
export function parseIntegrationCells(
	schema: ZodObject<Record<string, ZodType>>,
	raw: Record<string, unknown>,
): { settings: unknown; invalid: InvalidSettingEntry[] } {
	const source = structuredClone(raw);
	const defaults = schema.parse({}) as Record<string, unknown>;
	const invalid: InvalidSettingEntry[] = [];
	const assembled: Record<string, unknown> = {};

	for (const [key, cell] of Object.entries(schema.shape)) {
		const r = parseCell(cell, source, key, [key], defaults[key], invalid);
		if (r && r.value !== undefined) assembled[key] = r.value;
	}

	// 拼好的整份理应过得了;抛了就是这个函数自己的 bug,不接。
	return { settings: schema.parse(assembled), invalid };
}
