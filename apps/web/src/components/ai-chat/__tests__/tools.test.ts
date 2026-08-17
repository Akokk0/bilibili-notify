/**
 * 单元测试 —— 工具名 → 界面上那一行中文。
 *
 * 后端把工具名原样发上来(`list_subscriptions`),直接显示等于给主人看代码。
 * 这一层的两条底线:① 认识的工具翻成人话并带上关键入参,② **不认识**的工具
 * 也得显示点什么 —— 后端加了新工具而这儿还没配的时候,一片空白比一个英文
 * 标识符难查得多。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { toolLabel } from "../tools";

describe("toolLabel", () => {
	it("认识的工具翻成中文", () => {
		expect(toolLabel("list_subscriptions", {})).toBe("查看订阅列表");
	});

	it("带上关键入参 —— 「搜了什么」比「搜过」有用得多", () => {
		expect(toolLabel("search_user", { keyword: "咩栗" })).toBe("搜索 UP 主「咩栗」");
	});

	it("该带的入参缺席时只显示动作,不留一对空括号", () => {
		expect(toolLabel("search_user", {})).toBe("搜索 UP 主");
		expect(toolLabel("search_user", { keyword: "   " })).toBe("搜索 UP 主");
	});

	it("有备选入参时按顺序挑第一个有值的 —— 订阅时昵称比 UID 好认", () => {
		expect(toolLabel("subscribe_user", { uid: "123", name: "咩栗" })).toBe("添加订阅「咩栗」");
		expect(toolLabel("subscribe_user", { uid: "123" })).toBe("添加订阅「123」");
	});

	it("做皮肤那几十秒里写清「在做什么样的」—— 光转圈跟卡住没区别", () => {
		expect(toolLabel("create_skin", { brief: "赛博朋克暗色" })).toBe("制作皮肤「赛博朋克暗色」");
	});

	it("不认识的工具显示原名,不是空白", () => {
		expect(toolLabel("brand_new_tool", {})).toBe("brand_new_tool");
	});

	it("入参太长时截断 —— 一条小条不能被一段话撑爆", () => {
		const label = toolLabel("search_user", { keyword: "啊".repeat(80) });
		expect(label.length).toBeLessThan(40);
		expect(label).toContain("…");
	});
});

/**
 * 后端每加一个工具,这儿都得跟着配一句中文,否则界面上冒出来的是
 * `get_something_new` 这样的英文标识符 —— 构建全绿,只有主人看得到。
 */
describe("工具名覆盖", () => {
	it("packages/ai 里定义的每个工具都配了中文名", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = await readFile(join(here, "../../../../../../packages/ai/src/tools.ts"), "utf8");
		// TOOL_DEFINITIONS 里每个 `function: { name: "…" }`。缩进正好三层 tab,
		// 这是嵌套参数里那些 name 字段(第五层)之外的唯一一批。
		const defined = [...src.matchAll(/^\t{3}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
		expect(defined.length).toBeGreaterThan(5); // 正则没匹配上时别假绿

		const missing = defined.filter((n) => toolLabel(n, {}) === n);
		expect(missing).toEqual([]);
	});
});
