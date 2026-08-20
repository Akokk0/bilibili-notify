/**
 * 聊天里的 `load_skill` —— 女仆自己挑一条技能来用的那条路(ADR-0001 决策 7)。
 *
 * 它与 `create_skin` 同一条注入路(dashboard 的 ExtraTool),**绝不进
 * `TOOL_DEFINITIONS`** —— 那张表三端共享,而 koishi 的 `bili.chat` 没有权限门。
 *
 * 这一层要钉的三件事:
 * ① 目录里只出现**允许模型自选**的那些(`disable-model-invocation` 的退出);
 * ② 读到的技能若声明了 `allowed-tools`,收窄意图要一并带出来;
 * ③ 读不到就**说读不到**,别让女仆拿着一句空气去干活。
 */

import { AI_TOOL_LOAD_SKILL } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { createSkillChatTool } from "../chat-tool.js";
import type { MaidSkillEntry } from "../store.js";

function entry(over: Partial<MaidSkillEntry> = {}): MaidSkillEntry {
	return {
		name: "weekly-report",
		description: "评选本周鸽王",
		disableModelInvocation: false,
		body: "先列订阅,再逐个查数据。",
		builtin: true,
		...over,
	};
}

/** 工具定义里那份目录(描述 + 参数枚举)。 */
function catalogOf(tool: NonNullable<ReturnType<typeof createSkillChatTool>>) {
	const fn = tool.definition.function;
	const props = fn.parameters?.properties as { name?: { enum?: string[] } } | undefined;
	return { description: fn.description ?? "", names: props?.name?.enum ?? [] };
}

describe("目录", () => {
	it("列出每一条的名字与 description —— 模型只靠这一句决定要不要用它", () => {
		const tool = createSkillChatTool([
			entry(),
			entry({ name: "up-pk", description: "两个 UP 拉开对比" }),
		]);
		expect(tool).not.toBeNull();
		if (!tool) return;
		const { description, names } = catalogOf(tool);
		expect(names).toEqual(["weekly-report", "up-pk"]);
		expect(description).toContain("weekly-report");
		expect(description).toContain("评选本周鸽王");
		expect(description).toContain("两个 UP 拉开对比");
	});

	it("disable-model-invocation 的不进目录 —— 那是「只许主人打斜杠」的意思", () => {
		const tool = createSkillChatTool([
			entry(),
			entry({ name: "manual-only", disableModelInvocation: true }),
		]);
		expect(tool).not.toBeNull();
		if (!tool) return;
		const { description, names } = catalogOf(tool);
		expect(names).toEqual(["weekly-report"]);
		expect(description).not.toContain("manual-only");
	});

	it("一条可自选的都没有 → 根本不挂这把工具", () => {
		// 挂一把空目录的工具,只会让模型调它、拿到一句「没有」,白烧一轮。
		expect(createSkillChatTool([])).toBeNull();
		expect(createSkillChatTool([entry({ disableModelInvocation: true })])).toBeNull();
	});
});

describe("读取", () => {
	it("读到 → 正文原样回灌,并点明这是哪条技能", async () => {
		const tool = createSkillChatTool([entry()]);
		if (!tool) throw new Error("工具没建出来");
		const out = await tool.execute({ name: "weekly-report" });
		const text = typeof out === "string" ? out : out.text;
		expect(text).toContain("先列订阅,再逐个查数据。");
		expect(text).toContain("weekly-report");
	});

	it("声明了 allowed-tools → 收窄意图带上它自己", async () => {
		// 带上自己是刻意的:收窄永远只会更窄(交集),所以留着这把工具不会扩大
		// 任何东西 —— 但挑错了技能时,女仆还有一次改口的机会。
		const tool = createSkillChatTool([
			entry({ allowedTools: ["list_subscriptions", "get_user_stats"] }),
		]);
		if (!tool) throw new Error("工具没建出来");
		const out = await tool.execute({ name: "weekly-report" });
		if (typeof out === "string") throw new Error("该带收窄意图的");
		expect(out.restrictTools).toEqual(["list_subscriptions", "get_user_stats", AI_TOOL_LOAD_SKILL]);
	});

	it("没声明 allowed-tools → 不收窄", async () => {
		// 「不收窄」有两种等价的表达:回一个纯字符串,或回富形状但不带
		// restrictTools。断言的是**语义**,别把实现挑的那一种写死。
		const tool = createSkillChatTool([entry()]);
		if (!tool) throw new Error("工具没建出来");
		const out = await tool.execute({ name: "weekly-report" });
		expect(typeof out === "string" || out.restrictTools === undefined).toBe(true);
	});

	it("读一条不存在的 / 不许自选的 → 说清读不到,而不是抛", async () => {
		// 抛出去会被 execToolCall 记成一次工具失败,界面上是一个叉,但女仆不知道
		// 该改口读哪一条。把话说在返回值里,她才能自己纠正。
		const tool = createSkillChatTool([
			entry(),
			entry({ name: "manual-only", disableModelInvocation: true }),
		]);
		if (!tool) throw new Error("工具没建出来");
		for (const name of ["nope", "manual-only", ""]) {
			const out = await tool.execute({ name });
			const text = typeof out === "string" ? out : out.text;
			expect(text).toContain("没有");
			// 顺带把还有哪些可用告诉她。
			expect(text).toContain("weekly-report");
		}
	});
});
