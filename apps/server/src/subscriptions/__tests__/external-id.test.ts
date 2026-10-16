import { EXTERNAL_ID_MAX } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { externalIdRefusal } from "../external-id.js";

const DIGITS = { label: "某站", externalIdRegex: "^\\d+$" };

describe("externalIdRefusal:按来源声明的格式核外部 id", () => {
	it("声明了格式:合格式的放行", () => {
		expect(externalIdRefusal(DIGITS, "123")).toBeUndefined();
		expect(externalIdRefusal(DIGITS, "0")).toBeUndefined();
	});

	it.each([
		["字母", "abc"],
		["数字夹字母", "12a"],
		["空串", ""],
		["带空格", " 123"],
		["带换行", "123\n"],
		["数字类型(不是字符串)", 123],
		["缺省", undefined],
	])("声明了格式:%s → invalid,issues 指到 identity.externalId", (_label, value) => {
		const failure = externalIdRefusal(DIGITS, value);
		expect(failure).toMatchObject({
			ok: false,
			code: "invalid",
			issues: [{ path: ["identity", "externalId"], message: expect.any(String) }],
		});
		// 话里点的是来源自己的名字,核心不替它说哪个平台的 id 长什么样。
		expect(failure?.message).toContain("某站");
	});

	it("整串匹配:声明里没写 ^ 与 $ 也一样按整串核;自带的照常能用", () => {
		expect(externalIdRefusal({ label: "甲", externalIdRegex: "\\d+" }, "123")).toBeUndefined();
		expect(externalIdRefusal({ label: "甲", externalIdRegex: "\\d+" }, "123a")).toBeDefined();
		expect(externalIdRefusal({ label: "甲", externalIdRegex: "\\d+" }, "a123")).toBeDefined();
		expect(externalIdRefusal({ label: "甲", externalIdRegex: "^\\d+$" }, "123")).toBeUndefined();
	});

	it("整串匹配:带 | 的声明不会只匹配到一半", () => {
		const spec = { label: "甲", externalIdRegex: "a|b" };
		expect(externalIdRefusal(spec, "a")).toBeUndefined();
		expect(externalIdRefusal(spec, "b")).toBeUndefined();
		expect(externalIdRefusal(spec, "ab")).toBeDefined();
		expect(externalIdRefusal(spec, "xa")).toBeDefined();
	});

	it("被核的值超过 256 字:拒,不去跑正则", () => {
		expect(externalIdRefusal(DIGITS, "1".repeat(EXTERNAL_ID_MAX))).toBeUndefined();
		expect(externalIdRefusal(DIGITS, "1".repeat(EXTERNAL_ID_MAX + 1))).toMatchObject({
			code: "invalid",
		});
	});

	it("没声明格式(或来源认不出):不替来源做主,放行", () => {
		expect(externalIdRefusal({ label: "甲" }, "abc")).toBeUndefined();
		expect(externalIdRefusal(undefined, "abc")).toBeUndefined();
	});
});
