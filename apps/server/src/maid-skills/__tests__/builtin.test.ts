/**
 * 内置技能这张表本身。
 *
 * 它是**手写的数据**,而它的两处错法都不会在别处报出来:
 *
 * ① **`allowed-tools` 里写了个不存在的工具名。** 收窄是交集,所以那一把只是
 *    静默消失 —— 整条链路全绿,只有真机上「说好要查数据却没查」。老 `/体检`
 *    栽的就是这个坑的极端版(整条技能一把工具都没有)。
 * ② **写出了一份自己都读不回来的 SKILL.md。** 内置不落盘,所以永远不过解析器
 *    那道闸 —— 直到主人照着它新建一条,才发现同样的写法存不进去。
 */

import { renderPromptNouns } from "@bilibili-notify/ai";
import { MAID_SKILL_LIMITS } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { BUILTIN_SKILLS } from "../builtin.js";
import { formatSkillFile, isValidSkillName, parseSkillFile } from "../parse.js";
import { skillToolNames } from "../reader.js";

const CORE_TOOLS = new Set(skillToolNames(createAiToolProviderRegistry()));

function withoutAliases(
	skill: (typeof BUILTIN_SKILLS)[number],
): Omit<(typeof BUILTIN_SKILLS)[number], "aliases"> {
	const copy = { ...skill };
	delete copy.aliases;
	return copy;
}

describe("内置技能表", () => {
	it("不是空的 —— 空了的话 load_skill 根本不会挂上", () => {
		expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
	});

	it("名字合法且互不重名", () => {
		const names = BUILTIN_SKILLS.map((s) => s.name);
		for (const name of names) expect(isValidSkillName(name)).toBe(true);
		expect(new Set(names).size).toBe(names.length);
	});

	it("别名都是合法正名，且不与任何内置正名或别的别名重复", () => {
		const names = new Set(BUILTIN_SKILLS.map((s) => s.name));
		const aliases = new Set<string>();
		for (const skill of BUILTIN_SKILLS) {
			for (const alias of skill.aliases ?? []) {
				expect(isValidSkillName(alias), alias).toBe(true);
				expect(names.has(alias), alias).toBe(false);
				expect(aliases.has(alias), alias).toBe(false);
				aliases.add(alias);
			}
		}
	});

	it("每一条都写得出、读得回 —— 与主人自己写的一条走同一道闸", () => {
		for (const skill of BUILTIN_SKILLS) {
			const res = parseSkillFile(formatSkillFile(skill));
			expect(res.ok, `${skill.name}: ${res.ok ? "" : res.message}`).toBe(true);
			// 别名只住内置条目；写成主人的 SKILL.md 时不应落进 frontmatter。
			if (res.ok) expect(res.skill).toEqual(withoutAliases(skill));
		}
	});

	it("description 在上限之内 —— 这一句每轮对话都带着", () => {
		for (const s of BUILTIN_SKILLS) {
			expect(s.description.length, s.name).toBeLessThanOrEqual(MAID_SKILL_LIMITS.descChars);
		}
	});

	it("allowed-tools 只列核心中立工具，不依赖任何提供方", () => {
		for (const s of BUILTIN_SKILLS) {
			for (const tool of s.allowedTools ?? []) {
				expect(CORE_TOOLS.has(tool), `${s.name} 声明了非核心工具 ${tool}`).toBe(true);
				expect(tool, `${s.name} 的 allowed-tools 不许写提供方全名`).not.toContain("__");
			}
		}
	});

	it("正文里提到的每个工具都在核心中立工具与本条 allowed-tools 里", () => {
		// 正文写的是「调 `get_creator_stats`」这种。名字打错了模型看不出来,它会
		// 一本正经地按那个名字去调,换回一句「未知工具」,然后自己找补。
		const mentioned = /`([a-z_]{4,})`/g;
		for (const s of BUILTIN_SKILLS) {
			for (const [, name] of s.body.matchAll(mentioned)) {
				if (!name?.includes("_")) continue;
				expect(CORE_TOOLS.has(name), `${s.name} 正文提到了非核心工具 ${name}`).toBe(true);
				expect(s.allowedTools, `${s.name} 正文点名了 ${name},allowed-tools 里却没有`).toContain(
					name,
				);
			}
		}
	});

	it("渲染前的 description 与正文不含平台叫法", () => {
		for (const s of BUILTIN_SKILLS) {
			expect(s.description, `${s.name} 的 description`).not.toMatch(
				/UP|B\s*站|UID|(?<![A-Za-z0-9_])bilibili(?![A-Za-z0-9_])/i,
			);
			expect(s.body, `${s.name} 的正文`).not.toMatch(
				/UP|B\s*站|UID|(?<![A-Za-z0-9_])bilibili(?![A-Za-z0-9_])/i,
			);
		}
	});

	it("按 B 站叫法渲染后使用 UP主", () => {
		const nouns = { creatorNoun: "UP主", postNoun: "动态", sources: "B 站" };
		for (const skill of BUILTIN_SKILLS) {
			expect(renderPromptNouns(`${skill.description}\n${skill.body}`, nouns), skill.name).toMatch(
				/UP主|\{sources\}/,
			);
		}
	});
});
