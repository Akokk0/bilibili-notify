/**
 * 单元测试 —— system prompt 里那条「只用纯文本」的**作用域**。
 *
 * 它原本无条件拼在 `CORE_IDENTITY` 里,而 `CORE_IDENTITY` 是 dashboard 聊天、QQ 聊天、
 * 动态点评、直播总结**共用**的第一段。dashboard 现在要渲染 Markdown,那条约束在
 * 那儿变成了反作用;而推送渠道(QQ / Telegram / webhook)不渲染 Markdown,一旦模型
 * 真开始吐 `**加粗**`,那边收到的就是字面的星号。
 *
 * 所以按调用方分叉。这份测试的重心不在「dashboard 能不能用 md」,而在
 * **推送侧一个字都不许变** —— 那才是会砸到主人的群里的一侧。
 */

import { describe, expect, it } from "vite-plus/test";
import { buildSystemPrompt } from "../persona-presets";

/** 那条约束的特征串。改文案时这里跟着改,别改成宽泛的「纯文本」。 */
const PLAIN_TEXT_RULE = "只用纯文本";

describe("buildSystemPrompt — allowMarkdown", () => {
	it("默认带着「只用纯文本」—— 缺省必须落在保守那一侧", () => {
		// 缺省值的方向是要紧的:漏传参数的调用方会得到**推送**该有的行为,
		// 而不是把 Markdown 泄进 QQ。
		expect(buildSystemPrompt({ preset: "assistant" })).toContain(PLAIN_TEXT_RULE);
	});

	it("allowMarkdown 时那条约束整个消失", () => {
		expect(buildSystemPrompt({ preset: "assistant", allowMarkdown: true })).not.toContain(
			PLAIN_TEXT_RULE,
		);
	});

	it("allowMarkdown 只摘掉那一条,人格与工具铁律一个字不动", () => {
		// 两边都带 withTools —— 工具铁律现在按调用方分档(挂了工具才发,见
		// persona-prompt-tools.test.ts),这一条要验的是**在同一档里**
		// allowMarkdown 只摘纯文本那一行,所以两边的档位必须对齐才比得出来。
		const opts = { preset: "assistant" as const, withTools: true };
		const plain = buildSystemPrompt(opts);
		const md = buildSystemPrompt({ ...opts, allowMarkdown: true });
		// 「必须调用工具才能声称操作成功」那条铁律绝不能被顺手带走。
		expect(md).toContain("必须调用对应工具");
		expect(md).toContain("严禁在未调用工具的情况下声称操作已完成");
		// 两者之差**只有**那一行。
		const removed = plain
			.split("\n")
			.filter((l) => !md.split("\n").includes(l))
			.map((l) => l.trim());
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain(PLAIN_TEXT_RULE);
	});

	it("不带工具那一档也一样 —— allowMarkdown 同样只摘那一行", () => {
		const plain = buildSystemPrompt({ preset: "assistant" });
		const md = buildSystemPrompt({ preset: "assistant", allowMarkdown: true });
		const removed = plain.split("\n").filter((l) => !md.split("\n").includes(l));
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain(PLAIN_TEXT_RULE);
		// 「你没有工具」那条在两边都在,不会被 allowMarkdown 带走。
		expect(md).toContain("没有任何可调用的工具");
	});

	it("那条约束留在**原来的位置** —— 推送侧的提示词顺序不许变", () => {
		// 摘除做法很容易顺手写成「拼在整段末尾」,那样推送侧看到的顺序就变了。
		// 收件人是主人的群,「行为不变」得是字面意义上的不变。
		const plain = buildSystemPrompt({ preset: "assistant" });
		const lines = plain.split("\n");
		const ruleAt = lines.findIndex((l) => l.includes(PLAIN_TEXT_RULE));
		const dutyAt = lines.findIndex((l) => l.includes("这是你最重要的职责"));
		const toolLawAt = lines.findIndex((l) => l.includes("【重要规则】"));
		expect(dutyAt).toBeGreaterThanOrEqual(0);
		expect(toolLawAt).toBeGreaterThanOrEqual(0);
		expect(ruleAt).toBeGreaterThan(dutyAt);
		expect(ruleAt).toBeLessThan(toolLawAt);
	});

	it("custom 预设下同样管用 —— 自定义人格也吃这段共用开头", () => {
		const opts = { preset: "custom" as const, customBase: "你是一只猫。" };
		expect(buildSystemPrompt(opts)).toContain(PLAIN_TEXT_RULE);
		expect(buildSystemPrompt({ ...opts, allowMarkdown: true })).not.toContain(PLAIN_TEXT_RULE);
		// 自定义人格本身不受影响。
		expect(buildSystemPrompt({ ...opts, allowMarkdown: true })).toContain("你是一只猫。");
	});
});
