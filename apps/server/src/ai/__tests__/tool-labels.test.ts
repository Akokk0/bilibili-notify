/**
 * 聊天里挂得出的**全部**工具,每把都有给人看的标签 —— 「新加工具忘了配标签」的闸。
 *
 * 面板从前自己抄一张「工具名 → 中文」的表,漏配就是界面上一个英文标识符。标签现在跟着工具
 * 走、随痕迹下发,这条测试列出核心的(含联网搜索、看图)与三家注入的(读技能、做皮肤、
 * 卡片工坊 8 把),逐把核对标签,**期望写成字面量对照表**(不从面板 import),文字与面板
 * 原来那张表逐字相同。
 */

import {
	coreToolLabelOf,
	describeToolCall,
	TOOL_DEFINITIONS,
	WEB_SEARCH_TOOL_NAME,
} from "@bilibili-notify/ai";
import { describe, expect, it } from "vite-plus/test";
import { createCardWorkshopTools } from "../../card-skins/chat-tools.js";
import { createSkillChatTool } from "../../maid-skills/chat-tool.js";
import { createSkinChatTools } from "../../skins/chat-tool.js";

const EXPECTED_LABELS: Record<string, string> = {
	// 核心自带
	list_subscriptions: "查看订阅列表",
	get_live_status: "查看直播状态",
	get_user_dynamics: "查看最近动态",
	get_user_info: "查看 UP 主资料",
	get_user_stats: "查看数据概览",
	get_user_videos: "查看最近视频",
	search_user: "搜索 UP 主",
	web_search: "联网搜索",
	describe_image: "查看图片",
	// 注入的三家
	load_skill: "使用技能",
	create_skin: "制作皮肤",
	list_skins: "查看卡片皮肤库",
	read_card: "看卡片",
	read_block: "看卡片的块",
	look_card: "看一眼效果",
	write_card: "写卡片",
	set_block: "改卡片的块",
	remove_block: "删卡片的块",
	set_skin_meta: "给卡片皮肤起名",
};

/** 注入的三家各造一套(只为拿定义与标签,不执行,所以依赖给空壳)。 */
function injectedTools() {
	const skill = createSkillChatTool([
		{
			name: "weekly-report",
			description: "周报",
			disableModelInvocation: false,
			body: "正文",
			builtin: true,
		},
	]);
	const skins = createSkinChatTools({ skinStore: {} as never, generator: () => null });
	const cards = createCardWorkshopTools({
		store: {} as never,
		ledger: { owned: [], forks: {} },
		record: async () => {},
		activeId: () => "default",
	}).tools;
	return [...(skill ? [skill] : []), ...skins, ...cards];
}

describe("聊天里挂得出的全部工具都有标签", () => {
	it("核心的(含联网搜索、看图):标签表查得到,文字逐字对得上", () => {
		const names = [
			...TOOL_DEFINITIONS.map((t) => t.function.name),
			WEB_SEARCH_TOOL_NAME,
			"describe_image",
		];
		expect(names.length).toBe(9);
		for (const name of names) {
			expect(coreToolLabelOf(name)?.label, name).toBe(EXPECTED_LABELS[name]);
		}
	});

	it("注入的三家:每把都带非空的 label,文字逐字对得上", () => {
		const tools = injectedTools();
		expect(tools.map((t) => t.definition.function.name).sort()).toEqual(
			[
				"load_skill",
				"create_skin",
				"list_skins",
				"read_card",
				"read_block",
				"look_card",
				"write_card",
				"set_block",
				"remove_block",
				"set_skin_meta",
			].sort(),
		);
		for (const tool of tools) {
			const name = tool.definition.function.name;
			expect(tool.label.trim(), name).not.toBe("");
			expect(tool.label, name).toBe(EXPECTED_LABELS[name]);
		}
	});

	it("入参那一格与面板原来的写法一致(卡种翻成中文、昵称优先、只读 brief / name)", () => {
		const byName = new Map(injectedTools().map((t) => [t.definition.function.name, t]));
		const argText = (name: string, args: Record<string, string>) =>
			describeToolCall(byName.get(name), args).argText;
		expect(argText("read_card", { kind: "live" })).toBe("直播卡");
		expect(argText("write_card", { kind: "live" })).toBe("直播卡");
		expect(argText("look_card", { kind: "nope" })).toBe("nope");
		expect(argText("read_block", { block: "cover" })).toBe("cover");
		expect(argText("create_skin", { brief: "赛博  暗色" })).toBe("赛博 暗色");
		expect(argText("load_skill", { name: "weekly-report" })).toBe("weekly-report");
		expect(argText("set_skin_meta", { name: "樱花粉" })).toBe("樱花粉");
		expect(argText("list_skins", {})).toBeUndefined();
	});
});
