/**
 * 回归守护 — P1 / ②2:用户正则安全闸门(单一权威)。
 *
 * 关键不变量:嵌套量词 `(a+)+` **与** 交替重叠 `(a|a)*c` / `(.|.)*c` 两类
 * 灾难性回溯都必须被判危(②2:旧 looksCatastrophic 只挡前者,35 字符即冻
 * cron 单线程整引擎)。同时不得误伤常见且安全的不相交交替 `(https?|ftp)+`。
 *
 * 复发点:任何人把交替重叠分支去掉、或让 schema/filter 各自再分叉一份启发式。
 */

import { describe, expect, it } from "vite-plus/test";
import { checkUserRegex, isCatastrophicRegexSource } from "./regex-safety";

describe("isCatastrophicRegexSource — 两类指数构造都判危 (②2)", () => {
	it("嵌套量词类:(a+)+ / (.*)*  / (?:\\w+)* / (a+){2,}", () => {
		expect(isCatastrophicRegexSource("(a+)+")).toBe(true);
		expect(isCatastrophicRegexSource("(.*)*")).toBe(true);
		expect(isCatastrophicRegexSource("(?:\\w+)*")).toBe(true);
		expect(isCatastrophicRegexSource("(a+){2,}")).toBe(true);
	});

	it("交替重叠类(②2 漏网):(a|a)*c / (.|.)*c / (\\w|\\w)+ / (.|x)*", () => {
		expect(isCatastrophicRegexSource("(a|a)*c")).toBe(true);
		expect(isCatastrophicRegexSource("(.|.)*c")).toBe(true);
		expect(isCatastrophicRegexSource("(\\w|\\w)+")).toBe(true);
		expect(isCatastrophicRegexSource("(.|x)*")).toBe(true);
	});

	/**
	 * 有界量词也能引爆 —— 旧规则只认组内字面 `+` / `*`,于是 `(a{0,30}){0,30}`
	 * 一路放行。实测 34 字符的输入就让 node 跑满 30 秒(2026-08-25 复现)。
	 *
	 * 判据是**组内那一层长度可不可变**,不是「有没有用 {}」:
	 * 长度固定(`{4}`)时每一步怎么切都只有一种走法,没有回溯可言;
	 * 一旦可变(`{0,30}` / `{2,}`),同一段文本就有多种切法,外层再套量词即爆炸。
	 */
	it("有界但可变的嵌套量词:(a{0,30}){0,30} / (\\d{2,4})+ / (a{1,}){3}", () => {
		expect(isCatastrophicRegexSource("(a{0,30}){0,30}$")).toBe(true);
		expect(isCatastrophicRegexSource("(\\d{2,4})+")).toBe(true);
		expect(isCatastrophicRegexSource("(a{1,}){3}")).toBe(true);
	});

	it("组内长度固定的不误伤:(\\d{4})+ / (ab{2}){3}", () => {
		// 每个组必须恰好吃掉那么多字符,没有第二种切法 —— 线性,别拦。
		// 判危一旦宽到「见 {} 就拦」,主人写的 `(\d{4})+` 这类日期/编号模式全保存不了。
		expect(isCatastrophicRegexSource("(\\d{4})+")).toBe(false);
		expect(isCatastrophicRegexSource("(ab{2}){3}")).toBe(false);
	});

	it("安全的不相交交替不误伤:(https?|ftp)+ / (ab|cd)* / 普通模式", () => {
		expect(isCatastrophicRegexSource("(https?|ftp)+")).toBe(false);
		expect(isCatastrophicRegexSource("(ab|cd)*")).toBe(false);
		expect(isCatastrophicRegexSource("^\\d{4}-\\d{2}-\\d{2}$")).toBe(false);
		expect(isCatastrophicRegexSource("foo|bar")).toBe(false);
	});
});

describe("checkUserRegex — 长度/回溯/编译三关", () => {
	it("超长拒绝", () => {
		const r = checkUserRegex("a".repeat(201));
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("过长");
	});

	it("疑似 ReDoS 拒绝(交替重叠)", () => {
		expect(checkUserRegex("(a|a)*c").ok).toBe(false);
	});

	it("非法正则拒绝(括号不配平)", () => {
		const r = checkUserRegex("(abc");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("非法");
	});

	it("合法安全正则通过", () => {
		expect(checkUserRegex("^bilibili-\\d+$").ok).toBe(true);
	});
});
