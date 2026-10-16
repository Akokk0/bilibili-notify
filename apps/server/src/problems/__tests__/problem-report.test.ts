/**
 * 问题上报的入口校验 —— 集成层、来源层共用的一份规矩:`code` 是 snake、文案不许空白、`externalId` 不许空串。
 */

import { describe, expect, it } from "vite-plus/test";
import { problemReportIssue } from "../problem-report.js";

describe("problemReportIssue", () => {
	it("形状都对:没有问题", () => {
		expect(problemReportIssue({ code: "auth_lost", message: "登录失效" })).toBeUndefined();
		expect(
			problemReportIssue({
				externalId: "1",
				code: "monitor_stopped",
				message: "停了",
				recoveryMessage: "好了",
			}),
		).toBeUndefined();
	});

	it("清的一边不带 message,也不带 recoveryMessage:照样过", () => {
		expect(problemReportIssue({ code: "auth_lost" })).toBeUndefined();
	});

	it.each([
		["Auth-Lost", "code"],
		["", "code"],
		["1abc", "code"],
		["a__b", "code"],
	])("code 写成 %j:点名 code", (code, word) => {
		expect(problemReportIssue({ code, message: "x" })).toContain(word);
	});

	it("message 是空白:点名 message", () => {
		expect(problemReportIssue({ code: "auth_lost", message: "   " })).toContain("message");
	});

	it("recoveryMessage 是空白:点名 recoveryMessage", () => {
		expect(problemReportIssue({ code: "auth_lost", message: "x", recoveryMessage: " " })).toContain(
			"recoveryMessage",
		);
	});

	it("externalId 给了空串:点名 externalId", () => {
		expect(problemReportIssue({ externalId: "", code: "auth_lost", message: "x" })).toContain(
			"externalId",
		);
	});
});
