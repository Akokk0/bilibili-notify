/**
 * 回归守护 — P1(① 全新):wordcloud 内联 `<script>` 的 JSON 注入。
 *
 * 关键不变量:弹幕词(`words`,完全攻击者可控)经 safeJsonForScript 后,
 * `</script>` / `<!--` / `<script` 一律被中和(无裸 `<`),不得 breakout
 * 出 `<script>` 块在 puppeteer 页内执行;且产物仍是合法 JSON(JSON.parse
 * 回原值,词云功能不回归)。
 *
 * 复发点:有人把 safeJsonForScript 改回裸 JSON.stringify。
 */

import { describe, expect, it } from "vite-plus/test";
import { safeJsonForScript } from "../templates/wordcloud";

describe("safeJsonForScript — <script> breakout 防护 (P1)", () => {
	it("弹幕含 </script> → 输出无裸 `<`,无法闭合脚本块", () => {
		const out = safeJsonForScript([["</script><img src=x onerror=alert(1)>", 9]]);
		expect(out).not.toContain("<");
		expect(out).not.toContain("</script>");
		expect(out).toContain("\\u003c");
	});

	it("中和 <!-- 与 <script", () => {
		const out = safeJsonForScript(["<!--", "<script>evil()</script>"]);
		expect(out).not.toContain("<");
	});

	it("U+2028 / U+2029 被转义(老式 JS 行终止符)", () => {
		const out = safeJsonForScript([`a\u2028b\u2029c`]);
		expect(out).not.toContain("\u2028");
		expect(out).not.toContain("\u2029");
		expect(out).toContain("\\u2028");
		expect(out).toContain("\\u2029");
	});

	it("产物仍是合法 JSON,parse 回原值(功能不回归)", () => {
		const original = [
			["普通弹幕", 12],
			["</script>注入", 3],
			["emoji 😀换行", 1],
		];
		expect(JSON.parse(safeJsonForScript(original))).toEqual(original);
	});
});
