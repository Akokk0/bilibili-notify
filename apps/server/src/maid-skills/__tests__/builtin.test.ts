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

import { TOOL_DEFINITIONS, WEB_SEARCH_TOOL_NAME } from "@bilibili-notify/ai";
import { MAID_SKILL_LIMITS } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_SKILLS } from "../builtin.js";
import { formatSkillFile, isValidSkillName, parseSkillFile } from "../parse.js";

const REAL_TOOLS = new Set([...TOOL_DEFINITIONS.map((t) => t.function.name), WEB_SEARCH_TOOL_NAME]);

describe("内置技能表", () => {
	it("不是空的 —— 空了的话 load_skill 根本不会挂上", () => {
		expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
	});

	it("名字合法且互不重名", () => {
		const names = BUILTIN_SKILLS.map((s) => s.name);
		for (const name of names) expect(isValidSkillName(name)).toBe(true);
		expect(new Set(names).size).toBe(names.length);
	});

	it("每一条都写得出、读得回 —— 与主人自己写的一条走同一道闸", () => {
		for (const skill of BUILTIN_SKILLS) {
			const res = parseSkillFile(formatSkillFile(skill));
			expect(res.ok, `${skill.name}: ${res.ok ? "" : res.reason}`).toBe(true);
			if (res.ok) expect(res.skill).toEqual(skill);
		}
	});

	it("description 在上限之内 —— 这一句每轮对话都带着", () => {
		for (const s of BUILTIN_SKILLS) {
			expect(s.description.length, s.name).toBeLessThanOrEqual(MAID_SKILL_LIMITS.descChars);
		}
	});

	it("allowed-tools 里每个名字都真有那把工具", () => {
		// 这一条是「写不出工具链的点子不该进这张表」那句纪律的机械化版本。
		for (const s of BUILTIN_SKILLS) {
			for (const tool of s.allowedTools ?? []) {
				expect(REAL_TOOLS.has(tool), `${s.name} 声明了不存在的工具 ${tool}`).toBe(true);
			}
		}
	});

	it("正文里提到的工具名也得真有 —— 步骤里点名一把不存在的,女仆只会编一个", () => {
		// 正文写的是「调 `get_user_stats`」这种。名字打错了模型看不出来,它会
		// 一本正经地按那个名字去调,换回一句「未知工具」,然后自己找补。
		const mentioned = /`([a-z_]{4,})`/g;
		for (const s of BUILTIN_SKILLS) {
			for (const [, name] of s.body.matchAll(mentioned)) {
				if (!name?.includes("_")) continue;
				expect(REAL_TOOLS.has(name), `${s.name} 正文提到了不存在的工具 ${name}`).toBe(true);
			}
		}
	});
});
