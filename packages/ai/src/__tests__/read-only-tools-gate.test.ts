/**
 * 单元测试 —— AI 工具表**只读**这条硬约束的闸。
 *
 * 为什么这条约束值得一个专门的测试文件盯着:
 *
 * 群聊 AI 曾经握有 `subscribe_user` / `unsubscribe_user` / `update_subscription`
 * 三个能真正改订阅的工具,而喂进它上下文的东西 —— 群友的每一句话、B 站动态正文、
 * 图片里的文字 —— 全都是外部可控的。koishi 的 `bili.chat` 还没有任何权限门,群里
 * 任何人都能调。也就是说:**任意一条群消息都可能改掉主人的订阅表**。
 *
 * 而这个能力本来就没真正работать过 —— koishi 每次加载都 `store.replaceAll()`
 * 从配置重建订阅,回写配置的通道只有监听器、没有任何发射方,所以 AI 加的订阅
 * 撑不过下一次插件重载。用一个重载即丢的功能换一个注入面,不划算。
 *
 * 因此三个写工具被整体下架。这条测试是那道闸:写能力一旦被"顺手补回来",
 * 这里立刻红。删这个文件比让它变绿更难 —— 那正是它存在的意义。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import { describe, expect, it } from "vite-plus/test";
import { executeTool, TOOL_DEFINITIONS } from "../tools";

/** 曾经存在、现已下架的三个写工具。名字写死,不从源码反推。 */
const WRITE_TOOLS = ["subscribe_user", "unsubscribe_user", "update_subscription"];

describe("AI 工具表 — 只读约束", () => {
	it("TOOL_DEFINITIONS 不含任何会改订阅的工具", () => {
		const names = TOOL_DEFINITIONS.map((t) => t.function.name);
		for (const w of WRITE_TOOLS) {
			expect(names).not.toContain(w);
		}
	});

	it("工具表非空 —— 别把只读工具也一起误删了", () => {
		// 少了只读工具,女仆会一口咬定「当前没有订阅」,而主人明明订了十几个。
		// 那种答案比不会答更糟,因为它听起来像个事实。
		const names = TOOL_DEFINITIONS.map((t) => t.function.name);
		expect(names).toContain("list_subscriptions");
		expect(names).toContain("get_live_status");
	});

	it("即便模型硬编造出写工具名,executeTool 也无分支可走", async () => {
		// 工具定义不下发只挡住了「模型知道有这个工具」;万一它凭记忆瞎猜一个名字,
		// 执行层也必须没有对应实现,而不是靠上游少传一个依赖来兜。
		const api = {} as BilibiliAPI;
		for (const w of WRITE_TOOLS) {
			const out = await executeTool(w, { uid: "123", name: "谁" }, api, () => ({
				"123": { uid: "123", uname: "谁", dynamic: true, live: true },
			}));
			expect(out).toContain("未知工具");
		}
	});
});
