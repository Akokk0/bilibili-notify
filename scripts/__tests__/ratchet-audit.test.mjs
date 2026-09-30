import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";

/** 按文件记账的棘轮对账:出网点名表、结果不手写等守卫共用。 */

describe("对照白名单与棘轮表", () => {
	const hit = (line) => ({ line, text: `fetch(u${line})` });
	const tables = {
		allowlist: { "lib/client.ts": "请求客户端" },
		ratchet: { "src/old.ts": 2 },
		what: "出站原语",
	};

	it("白名单里的文件放行,多少处都行", () => {
		expect(
			auditRatchet({ "lib/client.ts": [hit(1), hit(2), hit(3)] }, { ...tables, ratchet: {} }),
		).toEqual([]);
	});

	it("表外的文件出现命中:每一处报 file:line、那一行与命中叫什么", () => {
		expect(
			auditRatchet({ "src/old.ts": [hit(1), hit(2)], "src/new.ts": [hit(7), hit(9)] }, tables),
		).toEqual([
			"src/new.ts:7: fetch(u7) —— 出站原语,文件不在白名单也不在棘轮表里",
			"src/new.ts:9: fetch(u9) —— 出站原语,文件不在白名单也不在棘轮表里",
		]);
	});

	it("棘轮表里的文件超过上限就红,并点名每一处", () => {
		const problems = auditRatchet({ "src/old.ts": [hit(1), hit(2), hit(3)] }, tables);
		expect(problems[0]).toBe("src/old.ts: 出站原语 3 处,超过棘轮上限 2 —— 只许少不许多");
		expect(problems.join("\n")).toContain("src/old.ts:3: fetch(u3)");
	});

	it("上限高于实数也红:棘轮只许往下走,提示调低到几", () => {
		expect(auditRatchet({ "src/old.ts": [hit(1)] }, tables)).toEqual([
			"src/old.ts: 实数 1,上限还写着 2 —— 把上限调低到 1",
		]);
		// 清零了:整行删掉。
		expect(auditRatchet({}, tables)).toEqual([
			"src/old.ts: 实数 0,上限还写着 2 —— 把这一行从棘轮表里删掉",
		]);
	});

	it("实数等于上限就过", () => {
		expect(auditRatchet({ "src/old.ts": [hit(1), hit(2)] }, tables)).toEqual([]);
	});

	it("同一个文件不许既在白名单又在棘轮表:两张表打架", () => {
		const problems = auditRatchet(
			{},
			{ allowlist: { "src/both.ts": "x" }, ratchet: { "src/both.ts": 1 }, what: "出站原语" },
		);
		expect(problems.join("\n")).toContain("src/both.ts");
		expect(problems.join("\n")).toContain("白名单");
		expect(problems.join("\n")).toContain("棘轮表");
	});
});
