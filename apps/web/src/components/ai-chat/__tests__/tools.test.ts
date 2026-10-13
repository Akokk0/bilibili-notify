/**
 * 单元测试 —— 工具痕迹 → 小条上那一行字。
 *
 * 标签与入参文字由服务端随痕迹下发(`label` / `argText`,工具自己带的),面板不再有一张
 * 「工具名 → 中文」的表。这一层只管**怎么拼**:「标签「入参」」、入参超长时截短(`…`)、
 * 以及两条底线 ——
 *   ① 没带标签的痕迹(认不出的工具)显示**原名**而不是空白;
 *   ② 没有入参时只有标签,不留一对空括号。
 *
 * 下面几行字面量期望,是改写之前面板那张写死的表对同样入参显示的字(逐字),用来钉「这一步
 * 界面上看到的字没有变」。
 */

import { describe, expect, it } from "vite-plus/test";
import { describeTool } from "../tools";

describe("describeTool", () => {
	it("给了标签就照显示;入参补在后面", () => {
		expect(
			describeTool({ name: "get_user_info", label: "查看 UP 主资料", argText: "咩栗" }),
		).toEqual({
			label: "查看 UP 主资料「咩栗」",
			argText: "咩栗",
			clipped: false,
		});
		expect(
			describeTool({ name: "get_user_stats", label: "查看数据概览", argText: "12345" }).label,
		).toBe("查看数据概览「12345」");
		expect(describeTool({ name: "web_search", label: "联网搜索", argText: "b站 新闻" }).label).toBe(
			"联网搜索「b站 新闻」",
		);
		expect(describeTool({ name: "write_card", label: "写卡片", argText: "直播卡" }).label).toBe(
			"写卡片「直播卡」",
		);
		expect(
			describeTool({ name: "load_skill", label: "使用技能", argText: "weekly-report" }).label,
		).toBe("使用技能「weekly-report」");
	});

	it("做皮肤的长 brief:完整入参原样留着,小条上截短并标明被截了", () => {
		const argText = "赛博朋克 暗色 霓虹，要有很长很长很长很长很长很长很长的一段描述";
		expect(describeTool({ name: "create_skin", label: "制作皮肤", argText })).toEqual({
			label: "制作皮肤「赛博朋克 暗色 霓虹，要有很…」",
			argText,
			clipped: true,
		});
	});

	it("截短的边界:恰好 14 个字不截,15 个字截到 14 个加「…」", () => {
		const at14 = describeTool({
			name: "search_user",
			label: "搜索 UP 主",
			argText: "啊".repeat(14),
		});
		expect(at14.label).toBe(`搜索 UP 主「${"啊".repeat(14)}」`);
		expect(at14.clipped).toBe(false);
		const at15 = describeTool({
			name: "search_user",
			label: "搜索 UP 主",
			argText: "啊".repeat(15),
		});
		expect(at15.label).toBe(`搜索 UP 主「${"啊".repeat(14)}…」`);
		expect(at15.clipped).toBe(true);
	});

	it("没有入参只有标签,不留一对空括号", () => {
		expect(describeTool({ name: "list_subscriptions", label: "查看订阅列表" })).toEqual({
			label: "查看订阅列表",
			argText: null,
			clipped: false,
		});
	});

	it("没带标签(认不出的工具 / 老痕迹)显示原名,不是空白", () => {
		expect(describeTool({ name: "brand_new_tool" })).toEqual({
			label: "brand_new_tool",
			argText: null,
			clipped: false,
		});
	});
});
