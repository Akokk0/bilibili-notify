/**
 * 安全守护 — `scrubSecrets` / `redactLogCall`(日志调用入口的凭证脱敏)。
 *
 * 不变量:stdout + 落盘归档 + WS 帧都经此单一 scrub,以下五类明文绝不出现在输出里:
 *   SESSDATA / bili_jct / refresh_token / sk-xxx / Bearer xxx。
 * 非密文不动;嵌套 args 也要 scrub;循环引用不抛。
 * 复发点:去掉某条 REPLACER 或 scrub 只作用 msg 不作用 args。
 */

import { describe, expect, it } from "vite-plus/test";
import { redactLogCall, scrubSecrets } from "../redact.js";
import { createValueRedactor } from "../value-redactor.js";

describe("scrubSecrets — 五类凭证形态", () => {
	it("SESSDATA / bili_jct / refresh_token cookie 对被打码", () => {
		const s = scrubSecrets(
			"Cookie: SESSDATA=abc%2Cdef; bili_jct=9f8e7d; refresh_token=tok_123; foo=bar",
		);
		expect(s).not.toContain("abc%2Cdef");
		expect(s).not.toContain("9f8e7d");
		expect(s).not.toContain("tok_123");
		expect(s).toContain("SESSDATA=***");
		expect(s).toContain("bili_jct=***");
		expect(s).toContain("refresh_token=***");
		expect(s).toContain("foo=bar"); // 非密文保留
	});

	it("refresh_token 的 JSON 形也打码", () => {
		const s = scrubSecrets('{"refresh_token":"eyJ-secret-payload","other":1}');
		expect(s).not.toContain("eyJ-secret-payload");
		expect(s).toContain('"other":1');
	});

	it("sk- apiKey 与 Bearer token 打码,前缀保留可诊断", () => {
		const s = scrubSecrets("auth sk-ABCDEF0123456789 / Authorization: Bearer aB.cD_eF-12345678");
		expect(s).not.toContain("sk-ABCDEF0123456789");
		expect(s).not.toContain("aB.cD_eF-12345678");
		expect(s).toContain("sk-***");
		expect(s).toContain("Bearer ***");
	});

	it("无密文字符串原样返回", () => {
		expect(scrubSecrets("uid=12345 推送成功 dynamic")).toBe("uid=12345 推送成功 dynamic");
	});
});

describe("redactLogCall — msg + 嵌套 args 都 scrub", () => {
	it("msg 与 args(含嵌套对象)里的密文都被打码", () => {
		const red = redactLogCall("登录 SESSDATA=leak_in_msg", [
			"sk-LEAKLEAKLEAK01",
			{ cookie: "bili_jct=leak_in_arg", n: 7 },
		]);
		expect(red.msg).toContain("SESSDATA=***");
		expect(red.msg).not.toContain("leak_in_msg");
		expect(JSON.stringify(red.args)).not.toContain("sk-LEAKLEAKLEAK01");
		expect(JSON.stringify(red.args)).not.toContain("leak_in_arg");
		expect(JSON.stringify(red.args)).toContain('"n":7'); // 非密文字段保留
	});

	it("循环引用的 arg 不抛(收敛为 [circular])", () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		expect(() => redactLogCall("x", [cyclic])).not.toThrow();
		expect(JSON.stringify(redactLogCall("x", [cyclic]).args)).toContain("[circular]");
	});

	it("Error 交出普通对象:name / message / stack 打码,cause 递归,自带属性保留", () => {
		const err = Object.assign(
			new TypeError("outer", { cause: new Error("in SESSDATA=cause_leak") }),
			{
				code: "E_X",
			},
		);
		const [arg] = redactLogCall("x", [err]).args as [Record<string, unknown>];
		expect(arg.name).toBe("TypeError");
		expect(arg.message).toBe("outer");
		expect(String(arg.stack)).toContain("TypeError: outer");
		expect(arg.code).toBe("E_X");
		expect(JSON.stringify(arg.cause)).toContain("SESSDATA=***");
		expect(JSON.stringify(arg)).not.toContain("cause_leak");
	});

	it("按值那一遍抛错:失败就关 —— msg 也换成占位,参数换成占位,不往外抛,登记的值不会原样出去", () => {
		const exploding = {
			scrub(): string {
				throw new Error("scrub exploded");
			},
			has: () => false,
		};
		const red = redactLogCall("msg FAKE-REGISTERED-1", ["FAKE-REGISTERED-1", { a: 1 }], exploding);
		expect(red.msg).toBe("[redaction-failed]");
		expect(red.args).toEqual(["[redaction-failed]", "[redaction-failed]"]);
	});

	it("打码过程抛错:msg 照样打码,参数换成占位,不往外抛", () => {
		const hostile = {
			get boom(): string {
				throw new Error("x");
			},
		};
		const red = redactLogCall("SESSDATA=leak_in_msg", [hostile, "a"]);
		expect(red.msg).toBe("SESSDATA=***");
		expect(red.args).toEqual(["[redaction-failed]", "[redaction-failed]"]);
	});
});

/** 按值打码(登记册)那一遍:先按值、再按固定形状,两遍都过。值都是假值。 */
describe("redactLogCall — 按值打码", () => {
	function registered(...values: string[]) {
		const redactor = createValueRedactor();
		redactor.replace("demo", "secrets", values);
		return redactor;
	}

	it("先按值再按固定形状:登记值遮完,固定形状照样跑", () => {
		const red = redactLogCall(
			"SESSDATA=FAKE-REGISTERED-1; other=sk-ABCDEF0123456789",
			[],
			registered("FAKE-REGISTERED-1"),
		);
		expect(red.msg).toBe("SESSDATA=***; other=sk-***");
	});

	it("Error.name 也遮(自定义错误把令牌放进了 name)", () => {
		const err = new Error("boom");
		Object.defineProperty(err, "name", { value: "FAKE-REGISTERED-1", enumerable: false });
		const [arg] = redactLogCall("x", [err], registered("FAKE-REGISTERED-1")).args as [
			Record<string, unknown>,
		];
		expect(arg.name).toBe("***");
	});

	it("数字 / bigint 形态的参数:十进制串恰好等于登记的值,整格换成 ***(嵌套里也是)", () => {
		const red = redactLogCall(
			"x",
			[123456789, 123456789n, { mid: 123456789, list: [123456789] }],
			registered("123456789"),
		);
		expect(red.args).toEqual(["***", "***", { mid: "***", list: ["***"] }]);
	});

	it("数字只比整值:子串、更长、不同的数字原样;登记值太短不遮", () => {
		const red = redactLogCall("x", [12345678, 1234567890, 123456, 42], registered("123456789"));
		expect(red.args).toEqual([12345678, 1234567890, 123456, 42]);
		expect(redactLogCall("x", [4242], registered("4242")).args).toEqual([4242]);
	});

	it("msg 里的数字不是参数:只按字符串遮", () => {
		expect(redactLogCall("uid=123456789", [], registered("123456789")).msg).toBe("uid=***");
	});

	it("不给登记册:数字原样,行为与改前一致", () => {
		expect(redactLogCall("x", [123456789]).args).toEqual([123456789]);
	});
});
