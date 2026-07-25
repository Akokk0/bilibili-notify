/**
 * 单元测试 — 斜杠技能的匹配与解析。
 *
 * 这两个纯函数决定了输入框的两件事:菜单什么时候弹、Enter 之后到底发出去什么。
 * 都不好靠肉眼在页面上验(菜单一闪而过),所以钉在这里。
 */

import { describe, expect, it } from "vite-plus/test";
import { AI_SKILLS, matchSkills, resolveOutgoing } from "../skills";

describe("matchSkills — 菜单什么时候弹", () => {
	it("普通文字不弹菜单", () => {
		expect(matchSkills("本周谁最勤奋")).toEqual([]);
	});

	it("只打一个 / → 列出全部技能", () => {
		expect(matchSkills("/")).toHaveLength(AI_SKILLS.length);
	});

	it("按前缀过滤", () => {
		const got = matchSkills("/锐");
		expect(got.map((s) => s.cmd)).toEqual(["/锐评"]);
	});

	it("前缀对不上 → 空,不弹一个没内容的框", () => {
		expect(matchSkills("/不存在的技能")).toEqual([]);
	});

	it("命令后已经在写正文 → 收起菜单,别挡着输入", () => {
		// 悬在输入框上方的菜单会盖住主人正在敲的那行字。
		expect(matchSkills("/锐评 ")).toEqual([]);
		expect(matchSkills("/锐评 只看这三个人")).toEqual([]);
	});

	it("斜杠不在开头就不算命令 —— 日期、路径里都有斜杠", () => {
		expect(matchSkills("帮我看看 2026/07 的数据")).toEqual([]);
	});
});

describe("resolveOutgoing — 到底发出去什么", () => {
	it("整条就是技能命令 → 换成预置提问", () => {
		const skill = AI_SKILLS[0];
		expect(skill).toBeTruthy();
		expect(resolveOutgoing(skill?.cmd ?? "")).toBe(skill?.prompt);
	});

	it("命令后面还跟了追加要求 → 原样发,不吞掉那句追加", () => {
		// 换成预置话术的话,「只看这三个人」会凭空消失,而女仆答得一本正经。
		expect(resolveOutgoing("/锐评 只看这三个人")).toBe("/锐评 只看这三个人");
	});

	it("普通问题原样发", () => {
		expect(resolveOutgoing("本周谁最勤奋")).toBe("本周谁最勤奋");
	});

	it("首尾空白被裁掉", () => {
		expect(resolveOutgoing("  在吗  ")).toBe("在吗");
	});

	it("技能命令带首尾空白也认得出来", () => {
		const skill = AI_SKILLS[0];
		expect(resolveOutgoing(`  ${skill?.cmd}  `)).toBe(skill?.prompt);
	});
});

describe("AI_SKILLS — 数据本身", () => {
	it("每条命令都以 / 开头 —— matchSkills 的匹配全靠这个约定", () => {
		for (const s of AI_SKILLS) expect(s.cmd.startsWith("/")).toBe(true);
	});

	it("命令不重复,否则菜单里会出现两条一样的", () => {
		expect(new Set(AI_SKILLS.map((s) => s.cmd)).size).toBe(AI_SKILLS.length);
	});
});
