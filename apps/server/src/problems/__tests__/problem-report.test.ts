/**
 * 问题上报的入口解析 —— 集成层、来源层、适配器层共用的一份规矩。收 `unknown`:第三方交来的东西
 * 形状再怪,也只交回一份干净副本或一句点名哪一格的原因,不抛。
 */

import { describe, expect, it } from "vite-plus/test";
import { parseProblemReport, parseProblemResolve, problemCodePreview } from "../problem-report.js";

/** 失败那一句原因;成功就返回 undefined(成功那一支才带得动 `message`)。 */
const issueOf = (parsed: { ok: true } | { ok: false; message: string }) =>
	parsed.ok ? undefined : parsed.message;

describe("parseProblemReport", () => {
	it("形状都对:交回只含已知格的干净副本", () => {
		expect(
			parseProblemReport({
				externalId: "1",
				code: "monitor_stopped",
				message: "停了",
				recoveryMessage: "好了",
				notify: true,
			}),
		).toEqual({
			ok: true,
			externalId: "1",
			code: "monitor_stopped",
			message: "停了",
			recoveryMessage: "好了",
			notify: true,
		});
	});

	it("不认识的格不跟着交出去(第三方硬塞的 writtenBy 之类)", () => {
		expect(
			parseProblemReport({ code: "auth_lost", message: "登录失效", writtenBy: "冒充的" }),
		).toEqual({ ok: true, code: "auth_lost", message: "登录失效" });
	});

	it.each([
		["Auth-Lost", "code"],
		["", "code"],
		["1abc", "code"],
		["a__b", "code"],
	])("code 写成 %j:点名 code", (code, word) => {
		expect(issueOf(parseProblemReport({ code, message: "x" }))).toContain(word);
	});

	it("缺 message(报的一边必填):点名 message", () => {
		expect(issueOf(parseProblemReport({ code: "x_down" }))).toContain("message");
	});

	it("message 是数字:回原因而不抛", () => {
		expect(() => parseProblemReport({ code: "x_down", message: 123 })).not.toThrow();
		expect(issueOf(parseProblemReport({ code: "x_down", message: 123 }))).toContain("message");
	});

	it("空对象:点名 code", () => {
		expect(issueOf(parseProblemReport({}))).toContain("code");
	});

	it("整个上报不是对象(null / 数组 / 字符串):同样回原因而不抛", () => {
		for (const report of [null, [], "x", undefined]) {
			expect(() => parseProblemReport(report)).not.toThrow();
			expect(issueOf(parseProblemReport(report))).toContain("不是对象");
		}
	});

	it("notify 不是布尔:点名 notify", () => {
		expect(
			issueOf(parseProblemReport({ code: "x_down", message: "x", notify: "false" })),
		).toContain("notify");
	});

	it("message 交函数:点名 message,不把它当取字函数收下", () => {
		expect(issueOf(parseProblemReport({ code: "x_down", message: () => "x" }))).toContain(
			"message",
		);
	});

	it("message 是空白:点名 message", () => {
		expect(issueOf(parseProblemReport({ code: "auth_lost", message: "   " }))).toContain("message");
	});

	it("recoveryMessage 是空白 / 不是字符串:点名 recoveryMessage", () => {
		expect(
			issueOf(parseProblemReport({ code: "auth_lost", message: "x", recoveryMessage: " " })),
		).toContain("recoveryMessage");
		expect(
			issueOf(parseProblemReport({ code: "auth_lost", message: "x", recoveryMessage: 1 })),
		).toContain("recoveryMessage");
	});

	it("externalId 给了空串 / 不是字符串:点名 externalId", () => {
		expect(
			issueOf(parseProblemReport({ externalId: "", code: "auth_lost", message: "x" })),
		).toContain("externalId");
		expect(
			issueOf(parseProblemReport({ externalId: 1, code: "auth_lost", message: "x" })),
		).toContain("externalId");
	});

	it("connectionId 给了就得是非空字符串(适配器层那一格)", () => {
		expect(
			issueOf(parseProblemReport({ connectionId: 1, code: "auth_lost", message: "x" })),
		).toContain("connectionId");
		expect(
			issueOf(parseProblemReport({ connectionId: "", code: "auth_lost", message: "x" })),
		).toContain("connectionId");
		expect(
			parseProblemReport({ connectionId: "c1", code: "auth_lost", message: "x" }),
		).toMatchObject({ ok: true, connectionId: "c1" });
	});
});

describe("parseProblemResolve", () => {
	it("清的一边不带 message / recoveryMessage:照样过", () => {
		expect(parseProblemResolve({ code: "auth_lost" })).toEqual({ ok: true, code: "auth_lost" });
	});

	it("清的一边不看 message:给了个怪的也不影响清", () => {
		expect(parseProblemResolve({ code: "auth_lost", message: 123 })).toEqual({
			ok: true,
			code: "auth_lost",
		});
	});

	it("code / notify / externalId / connectionId 的规矩与报的一边同一份", () => {
		expect(issueOf(parseProblemResolve({ code: "Bad Code" }))).toContain("code");
		expect(issueOf(parseProblemResolve({ code: "auth_lost", notify: "false" }))).toContain(
			"notify",
		);
		expect(issueOf(parseProblemResolve({ code: "auth_lost", externalId: "" }))).toContain(
			"externalId",
		);
		expect(issueOf(parseProblemResolve({ code: "auth_lost", connectionId: 1 }))).toContain(
			"connectionId",
		);
	});
});

describe("problemCodePreview", () => {
	it("字符串照念;不是字符串的只说类型", () => {
		expect(problemCodePreview({ code: "auth_lost" })).toBe("auth_lost");
		expect(problemCodePreview({ code: 1 })).toBe("(number)");
		expect(problemCodePreview({})).toBe("(undefined)");
		expect(problemCodePreview(null)).toBe("(undefined)");
	});

	it("太长的截一段", () => {
		const long = "a".repeat(100);
		expect(problemCodePreview({ code: long })).toBe(`${"a".repeat(64)}…`);
	});
});
