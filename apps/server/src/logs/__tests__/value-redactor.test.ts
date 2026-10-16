/**
 * 按值打码的登记册:各集成登记自己手上的密钥值,日志出口按值遮。
 *
 * 值都是一眼看得出是假的(`FAKE-…`),不是任何真实凭据。
 */

import { describe, expect, it } from "vite-plus/test";
import { createValueRedactor, MIN_REDACTED_LENGTH, stringLeaves } from "../value-redactor.js";

describe("createValueRedactor", () => {
	it("登记过的值在字符串里被遮成 ***;没登记的原样", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["FAKE-TOKEN-AAAA"]);
		expect(redactor.scrub("token=FAKE-TOKEN-AAAA 与 FAKE-TOKEN-BBBB")).toBe(
			"token=*** 与 FAKE-TOKEN-BBBB",
		);
	});

	it("同一个值出现几次都遮;跨集成、跨桶的值都遮", () => {
		const redactor = createValueRedactor();
		redactor.replace("a", "secrets", ["FAKE-VALUE-ONE"]);
		redactor.replace("a", "cookies", ["FAKE-VALUE-TWO"]);
		redactor.replace("b", "secrets", ["FAKE-VALUE-THREE"]);
		expect(redactor.scrub("FAKE-VALUE-ONE FAKE-VALUE-ONE FAKE-VALUE-TWO FAKE-VALUE-THREE")).toBe(
			"*** *** *** ***",
		);
	});

	it(`少于 ${MIN_REDACTED_LENGTH} 个字符的值不遮,正好 ${MIN_REDACTED_LENGTH} 个的遮`, () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["1234567", "12345678", ""]);
		expect(redactor.scrub("a1234567b 12345678 c")).toBe("a1234567b *** c");
	});

	it("一个值是另一个值的一部分:先遮长的,不会剩半截", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["FAKE-PREFIX-12", "FAKE-PREFIX-12-LONGER"]);
		expect(redactor.scrub("x FAKE-PREFIX-12-LONGER y")).toBe("x *** y");
	});

	it("两个值首尾重叠(互不包含):命中区间合并,整段遮成一个 ***,不剩半截", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["FAKE-AAAA-1111", "1111-BBBB-FAKE"]);
		expect(redactor.scrub("x FAKE-AAAA-1111-BBBB-FAKE y")).toBe("x *** y");
		// 反过来登记的顺序也一样。
		const reversed = createValueRedactor();
		reversed.replace("demo", "secrets", ["1111-BBBB-FAKE", "FAKE-AAAA-1111"]);
		expect(reversed.scrub("x FAKE-AAAA-1111-BBBB-FAKE y")).toBe("x *** y");
	});

	it("三个值连环重叠与同一个值自己重叠:都合并成一段", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", [
			"AAAAAAAA-1",
			"1-BBBBBBBB-2",
			"2-CCCCCCCC",
			"repeatrepeat",
		]);
		expect(redactor.scrub("AAAAAAAA-1-BBBBBBBB-2-CCCCCCCC")).toBe("***");
		expect(redactor.scrub("repeatrepeatrepeat")).toBe("***");
	});

	it("首尾相接但不重叠的两个值:各遮各的", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["FAKE-AAAA-1111", "ZZZZ-BBBB-YYYY"]);
		expect(redactor.scrub("FAKE-AAAA-1111ZZZZ-BBBB-YYYY")).toBe("******");
	});

	it("登记很多个短值也不丢:每个都遮(没有条数上限)", () => {
		const redactor = createValueRedactor();
		const many = Array.from({ length: 2000 }, (_, i) => `FAKE-MANY-${String(i).padStart(6, "0")}`);
		redactor.replace("demo", "secrets", many);
		expect(redactor.scrub("a FAKE-MANY-001999 b FAKE-MANY-000000 c")).toBe("a *** b *** c");
	});

	it("has:整个文本恰好是登记的值才算;子串、太短的不算", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["123456789", "short"]);
		expect(redactor.has("123456789")).toBe(true);
		expect(redactor.has("12345678")).toBe(false);
		expect(redactor.has("1234567890")).toBe(false);
		expect(redactor.has("short")).toBe(false);
	});

	it("整桶换:旧值不再遮,新值遮;别的桶不受影响", () => {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", ["FAKE-OLD-VALUE"]);
		redactor.replace("demo", "cookies", ["FAKE-COOKIE-VAL"]);
		redactor.replace("demo", "secrets", ["FAKE-NEW-VALUE"]);
		expect(redactor.scrub("FAKE-OLD-VALUE FAKE-NEW-VALUE FAKE-COOKIE-VAL")).toBe(
			"FAKE-OLD-VALUE *** ***",
		);
	});

	it("clear 带桶名只清那一桶;不带桶名清这个集成名下的全部,别的集成不动", () => {
		const redactor = createValueRedactor();
		redactor.replace("a", "secrets", ["FAKE-A-SECRETS"]);
		redactor.replace("a", "cookies", ["FAKE-A-COOKIES"]);
		redactor.replace("b", "secrets", ["FAKE-B-SECRETS"]);
		redactor.clear("a", "cookies");
		expect(redactor.scrub("FAKE-A-SECRETS FAKE-A-COOKIES FAKE-B-SECRETS")).toBe(
			"*** FAKE-A-COOKIES ***",
		);
		redactor.clear("a");
		expect(redactor.scrub("FAKE-A-SECRETS FAKE-B-SECRETS")).toBe("FAKE-A-SECRETS ***");
	});

	it("什么都没登记:原样返回", () => {
		expect(createValueRedactor().scrub("abc FAKE-NOTHING-HERE")).toBe("abc FAKE-NOTHING-HERE");
	});

	it("值里有正则元字符也只当字面量", () => {
		const redactor = createValueRedactor();
		const meta = "FAKE.*+?^$(){}|[]\\";
		redactor.replace("demo", "secrets", [meta]);
		expect(redactor.scrub(`a ${meta} b FAKEXYZ`)).toBe("a *** b FAKEXYZ");
	});
});

describe("stringLeaves", () => {
	it("递归走 JSON,收每一段字符串;键名、数字、布尔、null 不收", () => {
		expect(
			stringLeaves({
				a: "one",
				"key-name": 5,
				nested: { list: ["two", { deep: "three" }, true, null] },
			}),
		).toEqual(["one", "two", "three"]);
	});

	it("顶层就是字符串也收", () => {
		expect(stringLeaves("top")).toEqual(["top"]);
	});
});
