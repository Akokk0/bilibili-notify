/// <reference types="node" />
/**
 * Field 字典 conformance —— 扫 `apps/web/src/pages/` 全 .tsx,对每个
 * `<Field code="X">` / `<FieldRow code="X">` 字面量 code,断言它在 FIELD_LABELS
 * 字典里有 entry。背景:Field 组件已删除 label/hint 字面量 props,UI 文案 100%
 * 走字典 lookup;新增 Field 用法忘补字典 → 用户看到的就是 raw code(只在 dev
 * console.warn),需要静态护栏。
 *
 * 跳过:动态 code(`code={...}` 模板字符串 / 表达式)。本仓库仅 PerUpEditor
 * `code={`templates.${templateField}`}` 一处,templateField 限定在
 * specialDanmaku / specialUserEnter,两个 key 都在字典里;再加字段时 PR review
 * 兜底。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { FIELD_LABELS } from "../config/field-labels.js";
import { listSources } from "./walk.js";

/**
 * **连测试文件一起扫**(`skipTests: false`)—— 这不是疏忽:页面测试里也写
 * `<Field code="...">`,引用了一个字典里没有的字段码同样是错,只是它错在测试里。
 */
const listTsx = (dir: string) => listSources(dir, { skipTestDirs: false });

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(TEST_DIR, "..", "pages");

/**
 * 匹配 `<Field` 或 `<FieldRow` 开标签内的字面量 `code="..."` 属性。multi-line
 * 友好(s 标志),跨行/多空白都容忍。返回 `{ file, code }[]` 便于失败时定位。
 */
function extractCodes(file: string): { file: string; code: string }[] {
	const src = readFileSync(file, "utf8");
	const out: { file: string; code: string }[] = [];
	const re = /<(?:Field|FieldRow)\b[^>]*?\bcode="([^"]+)"/gs;
	let m: RegExpExecArray | null = re.exec(src);
	while (m !== null) {
		out.push({ file, code: m[1] });
		m = re.exec(src);
	}
	return out;
}

describe("Field 字典 conformance", () => {
	const tsxFiles = listTsx(PAGES_DIR);
	const allUsages = tsxFiles.flatMap(extractCodes);

	it("扫描到至少 80 个 <Field code=...> 字面量用法(防 regex 静默丢)", () => {
		expect(allUsages.length).toBeGreaterThanOrEqual(80);
	});

	it("所有字面量 code 在 FIELD_LABELS 里都有 entry", () => {
		const missing: { file: string; code: string }[] = [];
		for (const { file, code } of allUsages) {
			if (!(code in FIELD_LABELS)) {
				missing.push({ file, code });
			}
		}
		expect(
			missing,
			`字典 apps/web/src/config/field-labels.ts 缺少以下 code 的 entry:\n${missing
				.map((x) => `  ${x.code}  (${x.file.replace(PAGES_DIR, "pages")})`)
				.join("\n")}`,
		).toEqual([]);
	});
});
