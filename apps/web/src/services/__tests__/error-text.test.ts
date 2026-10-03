/**
 * 失败要给人看的字:`message` 一句话,有逐条原因就接在后面(ADR-0026)。
 * 皮肤包 / 清单没通过检查时,概括在 `message`、逐条在 `issues` —— 只读 `message` 会丢线索。
 */

import { describe, expect, it } from "vite-plus/test";
import { ApiError, apiErrorOf } from "../api";
import { errorTextOf, issueTextsOf } from "../error-text";

describe("errorTextOf", () => {
	it("一句话的失败 → 就是 message", () => {
		expect(errorTextOf(new Error("皮肤不存在"))).toBe("皮肤不存在");
	});

	it("带逐条原因 → message 后面接「：甲；乙」,一条也不丢", () => {
		const err = apiErrorOf(
			400,
			{
				code: "invalid",
				message: "这个皮肤包没通过检查（共 2 条）",
				issues: [{ message: "name 缺失" }, { message: "cards 不是对象" }],
			},
			"POST /api/cards/skins → 400",
		);
		expect(errorTextOf(err)).toBe("这个皮肤包没通过检查（共 2 条）：name 缺失；cards 不是对象");
	});

	it("逐条原因带路径 → 路径接在话前面", () => {
		const err = apiErrorOf(
			400,
			{
				code: "invalid",
				message: "请求体不是一条技能的形状",
				issues: [{ path: ["body"], message: "不能为空" }],
			},
			"x",
		);
		expect(errorTextOf(err)).toBe("请求体不是一条技能的形状：body：不能为空");
	});

	it("issues 是空数组 / 不是数组 → 只有 message", () => {
		expect(errorTextOf(Object.assign(new Error("坏了"), { issues: [] }))).toBe("坏了");
		expect(errorTextOf(Object.assign(new Error("坏了"), { issues: "乱写" }))).toBe("坏了");
	});

	it("不是 Error → 转成字符串,不抛", () => {
		expect(errorTextOf("断了")).toBe("断了");
		expect(errorTextOf(undefined)).toBe("undefined");
	});

	it("按形状读:测试里换掉的假 ApiError 也认得", () => {
		class FakeApiError extends Error {
			issues = [{ message: "第一条" }];
		}
		expect(errorTextOf(new FakeApiError("概括"))).toBe("概括：第一条");
	});
});

describe("issueTextsOf", () => {
	it("只回逐条原因的话,没有就是空数组", () => {
		expect(issueTextsOf(new ApiError(400, undefined, "x"))).toEqual([]);
		expect(issueTextsOf(null)).toEqual([]);
		expect(issueTextsOf({ issues: [{ message: "甲" }, { message: "" }, {}] })).toEqual(["甲"]);
	});
});
