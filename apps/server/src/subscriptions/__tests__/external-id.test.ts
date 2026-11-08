import { EXTERNAL_ID_MAX } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
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

describe("externalIdRefusal:回给面板的整句话", () => {
	it("格式不对:整条失败的话与 issues 里的话,点名来源的 label", () => {
		expect(externalIdRefusal(DIGITS, "abc")).toMatchObject({
			message: "某站的外部 id 格式不对，没法新建订阅",
			issues: [{ message: "这个 id 不是某站认的写法" }],
		});
	});
});

it.each([
	[
		"en",
		"The external ID format for Custom 源 is invalid; a subscription cannot be created.",
		"This ID does not match the format declared by Custom 源.",
	],
	[
		"ja",
		"Custom 源の外部IDの形式が正しくないため、購読を作成できません。",
		"このIDはCustom 源が指定する形式に合っていません。",
	],
	["zh-TW", "Custom 源的外部 ID 格式不正確，無法建立訂閱。", "此 ID 不符合 Custom 源 要求的格式。"],
] as const)(
	"localizes declared identity validation in %s while keeping source labels and issue paths",
	(locale, message, issue) => {
		const previous = i18n.state();
		const spec = { ...DIGITS, label: "Custom 源" };
		try {
			i18n.set({ locale, voice: "plain" });
			expect(externalIdRefusal(spec, "invalid-id")).toEqual({
				ok: false,
				code: "invalid",
				message,
				issues: [{ path: ["identity", "externalId"], message: issue }],
			});
			expect(externalIdRefusal(spec, "123")).toBeUndefined();
		} finally {
			i18n.set(previous);
		}
	},
);
