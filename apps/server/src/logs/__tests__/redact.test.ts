/**
 * 安全守护 — `scrubSecrets` / `redactLogCall`(日志调用入口的凭证脱敏)。
 *
 * 不变量:stdout + 落盘归档 + WS 帧都经此单一 scrub。两遍:先按登记的值(`value-redactor.ts`,B 站的 cookie
 * 与续期令牌靠它),再按固定形状 —— 固定形状只剩 AI 服务商密钥两类:sk-xxx / Bearer xxx。
 * 核心不再认识任何一家平台的 cookie 名字(SESSDATA / bili_jct / refresh_token 不再按名字遮)。
 * 非密文不动;嵌套 args 也要 scrub;循环引用不抛。
 * 复发点:去掉某条 REPLACER 或 scrub 只作用 msg 不作用 args;把按名字的正则加回来。
 */

import { describe, expect, it } from "vite-plus/test";
import { redactLogCall, scrubSecrets } from "../redact.js";
import { createValueRedactor } from "../value-redactor.js";

describe("scrubSecrets — 固定形状(AI 服务商密钥)", () => {
	it("核心里不再写死 B 站 cookie 的名字:没登记的 SESSDATA= / bili_jct= / refresh_token= 原样,靠按值登记来遮", () => {
		const text =
			'Cookie: SESSDATA=abc%2Cdef; bili_jct=9f8e7d; refresh_token=tok_123; {"refresh_token":"eyJ-payload"}';
		expect(scrubSecrets(text)).toBe(text);
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
		const red = redactLogCall("登录 Bearer leak_in_msg_01", [
			"sk-LEAKLEAKLEAK01",
			{ header: "Bearer leak_in_arg_01", n: 7 },
		]);
		expect(red.msg).toContain("Bearer ***");
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
			new TypeError("outer", { cause: new Error("in Bearer cause_leak_01") }),
			{
				code: "E_X",
			},
		);
		const [arg] = redactLogCall("x", [err]).args as [Record<string, unknown>];
		expect(arg.name).toBe("TypeError");
		expect(arg.message).toBe("outer");
		expect(String(arg.stack)).toContain("TypeError: outer");
		expect(arg.code).toBe("E_X");
		expect(JSON.stringify(arg.cause)).toContain("Bearer ***");
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
		const red = redactLogCall("Bearer leak_in_msg_01", [hostile, "a"]);
		expect(red.msg).toBe("Bearer ***");
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
