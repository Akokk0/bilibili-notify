/**
 * SKILL.md 的解析与回写。
 *
 * 这份文件**同时是主人手写的**(ADR 决策 3:真文件、可手放),所以解析器面对的
 * 不是我们自己序列化出来的东西 —— 缺字段、写错类型、frontmatter 都没有,全是
 * 日常。判据只有一条:**读不懂就说清楚哪儿读不懂**,别默默吞掉半份。
 */

import { describe, expect, it } from "vite-plus/test";
import { formatSkillFile, isValidSkillName, parseSkillFile } from "../parse.js";

describe("isValidSkillName", () => {
	it("kebab-case ASCII 收下 —— 它同时是目录名与斜杠命令", () => {
		for (const ok of ["weekly-report", "up-pk", "a", "a1", "find-up-2"]) {
			expect(isValidSkillName(ok)).toBe(true);
		}
	});

	it("拒掉一切能走出目录的形状 —— 名字要拼进磁盘路径", () => {
		// 白名单不含 `.` `/` `\`,所以 `..` 在构造上就不可能出现。这是这条规则
		// 存在的**全部理由**:皮肤库那次审计(2026-08-19)就是少了这道闸,被
		// `DELETE /%2e%2e%2fconversations` 删掉整个会话目录。
		for (const bad of ["..", "../etc", "a/b", "a\\b", "a.b", ".hidden", "a b"]) {
			expect(isValidSkillName(bad)).toBe(false);
		}
	});

	it("拒掉大写与中文 —— 主人拍板走 Claude Code 标准", () => {
		// macOS 的文件系统大小写不敏感、还会把名字归一化成 NFD;两条都只在
		// ASCII 小写这一档上没有意外。
		for (const bad of ["Weekly-Report", "周报", "café"]) {
			expect(isValidSkillName(bad)).toBe(false);
		}
	});

	it("拒掉连字符贴边或连打 —— 目录名不该长成 `-a--b-`", () => {
		for (const bad of ["-a", "a-", "a--b", "-", ""]) {
			expect(isValidSkillName(bad)).toBe(false);
		}
	});

	it("超长拒收", () => {
		expect(isValidSkillName("a".repeat(32))).toBe(true);
		expect(isValidSkillName("a".repeat(33))).toBe(false);
	});
});

describe("parseSkillFile", () => {
	it("标准形状:frontmatter + 正文", () => {
		const res = parseSkillFile(
			[
				"---",
				"name: weekly-report",
				"description: 评选本周鸽王与勤奋 UP",
				"---",
				"",
				"先列订阅,再逐个查数据。",
			].join("\n"),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.skill.name).toBe("weekly-report");
		expect(res.skill.description).toBe("评选本周鸽王与勤奋 UP");
		expect(res.skill.body).toBe("先列订阅,再逐个查数据。");
		// 两个可选字段的缺省:工具不限、参与模型自选。
		expect(res.skill.allowedTools).toBeUndefined();
		expect(res.skill.disableModelInvocation).toBe(false);
	});

	it("allowed-tools 收逗号串,也收 YAML 列表 —— 手写的人两种都会写", () => {
		const withCommas = parseSkillFile(
			[
				"---",
				"name: a",
				"description: d",
				"allowed-tools: list_subscriptions, get_user_stats",
				"---",
				"正文",
			].join("\n"),
		);
		const withList = parseSkillFile(
			[
				"---",
				"name: a",
				"description: d",
				"allowed-tools:",
				"  - list_subscriptions",
				"  - get_user_stats",
				"---",
				"正文",
			].join("\n"),
		);
		for (const res of [withCommas, withList]) {
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.skill.allowedTools).toEqual(["list_subscriptions", "get_user_stats"]);
		}
	});

	it("disable-model-invocation: true → 退出模型自选", () => {
		const res = parseSkillFile(
			["---", "name: a", "description: d", "disable-model-invocation: true", "---", "正文"].join(
				"\n",
			),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.skill.disableModelInvocation).toBe(true);
	});

	it("没有 frontmatter → 拒收,并说清缺的是什么", () => {
		const res = parseSkillFile("就一段正文,什么都没声明");
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toContain("frontmatter");
	});

	it("name 不合法 / 缺失 → 拒收", () => {
		for (const fm of ["name: 周报", "name: ../evil", "description: 只有它"]) {
			const res = parseSkillFile(["---", fm, "description: d", "---", "正文"].join("\n"));
			expect(res.ok).toBe(false);
		}
	});

	it("description 缺失或超 200 字 → 拒收", () => {
		// 常驻成本就压在这一句上(ADR 决策 13):可自选的 skill 每轮都带着它的
		// description,不封顶就等于让一条 skill 悄悄吃掉整个上下文预算。
		const long = "字".repeat(201);
		expect(parseSkillFile(["---", "name: a", "---", "正文"].join("\n")).ok).toBe(false);
		expect(
			parseSkillFile(["---", "name: a", `description: ${long}`, "---", "正文"].join("\n")).ok,
		).toBe(false);
		expect(
			parseSkillFile(
				["---", "name: a", `description: ${"字".repeat(200)}`, "---", "正文"].join("\n"),
			).ok,
		).toBe(true);
	});

	it("正文为空 → 拒收:一条什么都不说的 skill 等于没有", () => {
		const res = parseSkillFile(["---", "name: a", "description: d", "---", "   ", ""].join("\n"));
		expect(res.ok).toBe(false);
	});

	it("YAML 本身坏掉 → 拒收而不是抛", () => {
		const res = parseSkillFile(["---", "name: [unclosed", "---", "正文"].join("\n"));
		expect(res.ok).toBe(false);
	});
});

describe("formatSkillFile", () => {
	it("往返:写出去再读回来,一个字段都不差", () => {
		const skill = {
			name: "up-pk",
			description: "两个 UP 主拉开对比",
			allowedTools: ["get_user_info", "get_user_stats"],
			disableModelInvocation: true,
			body: "先各查一遍,再列表格。\n\n结论写一句。",
		};
		const res = parseSkillFile(formatSkillFile(skill));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.skill).toEqual(skill);
	});

	it("正文里带 `---` 也能安全往返 —— 主人写 Markdown 分割线是常事", () => {
		// 分隔符找的是**第一段** frontmatter 的收尾,正文里再出现多少条都不影响。
		const skill = {
			name: "a",
			description: "d",
			disableModelInvocation: false,
			body: "上半段\n\n---\n\n下半段",
		};
		const res = parseSkillFile(formatSkillFile(skill));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.skill.body).toBe("上半段\n\n---\n\n下半段");
	});
});
