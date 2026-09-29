/**
 * 失败那一句话怎么写:一串检查意见变成 `message` + `issues`,「还有谁在用」并进 `message`(ADR-0026 决策 6)。
 */

import { describe, expect, it } from "vite-plus/test";
import { describeUsers, failureOfChecks, listUsers } from "../failure-text.js";

describe("failureOfChecks", () => {
	it("只有一句 → 就是 message,不带 issues(话已经说全了)", () => {
		const f = failureOfChecks("invalid", "皮肤包", ["缺少 card-skin.json"]);
		expect(f).toEqual({ ok: false, code: "invalid", message: "缺少 card-skin.json" });
		expect(f).not.toHaveProperty("issues");
	});

	it("不止一句 → message 概括(说明是谁没通过、共几条),逐条意见进 issues", () => {
		const f = failureOfChecks("invalid", "皮肤包", ["name 缺失", "cards.live.width 不是数字"]);
		expect(f).toEqual({
			ok: false,
			code: "invalid",
			message: "皮肤包没通过检查（共 2 条）",
			issues: [{ message: "name 缺失" }, { message: "cards.live.width 不是数字" }],
		});
	});

	it("listSingle:只有一句也摆成概括 + 逐条(那句话离了上下文说不清是谁的)", () => {
		const f = failureOfChecks("invalid", "女仆改出来的皮肤", ["输出不是合法 JSON"], {
			listSingle: true,
		});
		expect(f).toEqual({
			ok: false,
			code: "invalid",
			message: "女仆改出来的皮肤没通过检查（共 1 条）",
			issues: [{ message: "输出不是合法 JSON" }],
		});
	});

	it("码由调用方给:同一份意见也能是 conflict", () => {
		expect(failureOfChecks("conflict", "皮肤", ["还被用着"]).code).toBe("conflict");
	});

	it("一句意见都没有(不该发生)→ 仍是句人话,message 不许是空的", () => {
		const f = failureOfChecks("invalid", "皮肤包", []);
		expect(f.message).toBe("皮肤包没通过检查");
		expect(f).not.toHaveProperty("issues");
	});
});

describe("listUsers / describeUsers", () => {
	it("不多于三个:全列", () => {
		expect(listUsers(["全局默认", "UP 1"])).toBe("全局默认、UP 1");
		expect(describeUsers(["全局默认", "UP 1", "UP 2"])).toBe("还有 3 处在用：全局默认、UP 1、UP 2");
	});

	it("多了:列前三个,再接「等 N 处」", () => {
		const users = ["甲", "乙", "丙", "丁", "戊"];
		expect(listUsers(users)).toBe("甲、乙、丙 等 5 处");
		expect(describeUsers(users)).toBe("还有 5 处在用：甲、乙、丙 等 5 处");
	});
});
