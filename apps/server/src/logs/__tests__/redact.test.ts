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
