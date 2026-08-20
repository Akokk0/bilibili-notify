/**
 * 斜杠命令的解析 —— 输入框里打 `/` 之后发生的全部事情。
 *
 * 与从前那版最要紧的分别:技能不再是前端写死的常量,而是**从服务端拉来的**一份
 * 清单;而且 `/技能 补充内容` 这种写法**技能照样生效**。旧版要求整条输入恰好等于
 * 命令,于是主人打 `/锐评 只看这三个人` 时技能一个字都不进 —— 他以为在用技能,
 * 其实在跟模型说一句它不认识的暗号(ADR-0001 背景第 1 条)。
 */

import type { MaidSkillDTO } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { matchSkills, resolveOutgoing } from "../skills";

const skill = (name: string, over: Partial<MaidSkillDTO> = {}): MaidSkillDTO => ({
	name,
	description: `${name} 干什么`,
	disableModelInvocation: false,
	body: "步骤",
	builtin: true,
	...over,
});

const SKILLS = [skill("weekly-report"), skill("unsub-cleanup"), skill("up-pk")];

describe("matchSkills —— 菜单什么时候弹", () => {
	it("不以 / 开头 → 不弹", () => {
		expect(matchSkills("本周谁最勤奋", SKILLS)).toEqual([]);
	});

	it("只打了一个 / → 全列出来(主人记不住 kebab 名,这就是他的目录)", () => {
		expect(matchSkills("/", SKILLS)).toHaveLength(SKILLS.length);
	});

	it("打了前缀 → 只留对得上的", () => {
		expect(matchSkills("/up", SKILLS).map((s) => s.name)).toEqual(["up-pk"]);
		expect(matchSkills("/un", SKILLS).map((s) => s.name)).toEqual(["unsub-cleanup"]);
	});

	it("前缀谁都对不上 → 不弹", () => {
		expect(matchSkills("/zzz", SKILLS)).toEqual([]);
	});

	it("打完命令又敲了空格 → 收起来,让位给正文", () => {
		expect(matchSkills("/weekly-report ", SKILLS)).toEqual([]);
		expect(matchSkills("/weekly-report 只看这三个人", SKILLS)).toEqual([]);
	});

	it("句中的斜杠不算 —— 「2026/07 的数据」不该弹菜单", () => {
		expect(matchSkills("帮我看看 2026/07 的数据", SKILLS)).toEqual([]);
	});

	it("清单是空的 → 不弹(还没配技能的部署)", () => {
		expect(matchSkills("/", [])).toEqual([]);
	});
});

describe("resolveOutgoing —— 到底发出去什么", () => {
	it("光秃秃一条命令 → 点名这条技能,原话照发", () => {
		// 「后面那串字」是空的,那就把命令本身当这一问 —— 服务端要求消息非空,
		// 而气泡里显示主人真打的那几个字,配上旁边那枚痕迹胶囊刚好说得通。
		expect(resolveOutgoing("/weekly-report", SKILLS)).toEqual({
			skill: "weekly-report",
			text: "/weekly-report",
		});
	});

	it("命令 + 补充内容 → 技能照样生效,后面那串字当主人这一问", () => {
		// 这一条就是旧版那个坑的解药。
		expect(resolveOutgoing("/weekly-report 只看这三个人", SKILLS)).toEqual({
			skill: "weekly-report",
			text: "只看这三个人",
		});
	});

	it("认不得的命令 → 当普通消息原样发,不点名任何技能", () => {
		// 服务端会拒掉一个不存在的技能名,所以这里必须**不**点名 —— 否则主人打错
		// 一个字就收到 400,而他要的只是把这句话说出去。
		expect(resolveOutgoing("/nope 在吗", SKILLS)).toEqual({ text: "/nope 在吗" });
	});

	it("普通消息原样发,首尾空白剥掉", () => {
		expect(resolveOutgoing("  在吗  ", SKILLS)).toEqual({ text: "在吗" });
	});

	it("命令前后有空白照样认得", () => {
		expect(resolveOutgoing("  /up-pk 甲 vs 乙  ", SKILLS)).toEqual({
			skill: "up-pk",
			text: "甲 vs 乙",
		});
	});

	it("退出了模型自选的技能,斜杠照样打得动 —— 那是它唯一的路", () => {
		const manual = [skill("manual-only", { disableModelInvocation: true })];
		expect(resolveOutgoing("/manual-only", manual)).toEqual({
			skill: "manual-only",
			text: "/manual-only",
		});
		// 菜单里也得有它,不然主人根本不知道该打什么。
		expect(matchSkills("/", manual)).toHaveLength(1);
	});
});
