/**
 * 回归测试 —— **工具铁律的作用域**。
 *
 * 用户报障:动态锐评推出来的第一句是「不过我得先确认一下,我这边是不是有订阅
 * 「XXX」这个 UP 主呢…让我先看看订阅情况,稍等一下哦!」—— 然后就没有然后了。
 *
 * 根因不在人格(报障者用的是内置元气少女改的,那份预设里一个字都没提订阅)。
 * `CORE_IDENTITY` 里那段【重要规则】—— 「涉及订阅、查询订阅等操作时,必须调用
 * 对应工具」—— 是**无条件**拼给所有场景的,而动态锐评走 `comment()`,那条路
 * `callAPI` 的 toolOptions 传的是 `undefined`,**一个工具都没挂**。
 *
 * 于是模型被告知「查订阅必须调工具」,手上却没有工具,只好用自然语言演一遍「我去
 * 查一下」然后卡住。工具铁律只该发给真正挂了工具的那两条路(群聊女仆 / dashboard
 * 聊天),其余场景要明确告诉它:这一次没有工具,直接回应。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CommentaryGenerator } from "../commentary-generator";
import { buildSystemPrompt } from "../persona-presets";
import { makeGen as baseGen } from "./harness";

const oai = vi.hoisted(() => {
	const create = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create } };
	}
	return { create, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));
vi.mock("../tools", () => ({
	TOOL_DEFINITIONS: [{ type: "function", function: { name: "fake_tool", parameters: {} } }],
	executeTool: vi.fn(async () => "tool-result"),
}));

/** 工具铁律的特征串。改文案时这里跟着改,别放宽成「工具」两个字。 */
const TOOL_LAW = "必须调用对应工具";
/** 无工具那一档的特征串。它现在只讲**本次任务范围**,刻意不提「工具」二字。 */
const NO_TOOL_RULE = "就眼前给到的内容直接作答";
/** 「改订阅这件事我做不到」的特征串 —— 工具表是只读的,不许承诺写。 */
const NO_WRITE_RULE = "你没有这个能力";

describe("buildSystemPrompt — 工具铁律的作用域", () => {
	it("默认不带工具铁律 —— 缺省必须落在「没有工具」那一侧", () => {
		// 方向和 allowMarkdown 一致:漏传的调用方拿到的是**没有工具**这个更安全的默认。
		// 反过来(默认带铁律)就是这次的 bug:锐评那条路谁也没想起来要关掉它。
		expect(buildSystemPrompt({ preset: "assistant" })).not.toContain(TOOL_LAW);
	});

	it("默认那一档只讲本次任务范围", () => {
		// 光把铁律摘掉不够:模型仍然知道自己「负责帮用户关注 UP 主」,照样会自作主张说
		// 要去看订阅列表。但堵这条路不必**提到工具** —— 说「你没有工具」反而是主动把这
		// 个概念塞进上下文,而这条路的请求里压根没挂 tools。正面说清这次要干什么即可。
		const p = buildSystemPrompt({ preset: "assistant" });
		expect(p).toContain(NO_TOOL_RULE);
	});

	it("默认那一档**一个「工具」字都不提** —— 别把不存在的东西请进上下文", () => {
		expect(buildSystemPrompt({ preset: "assistant" })).not.toMatch(/工具/);
	});

	it("withTools 时铁律回来,防编造那条也在", () => {
		const p = buildSystemPrompt({ preset: "assistant", withTools: true });
		expect(p).toContain(TOOL_LAW);
		expect(p).toContain("严禁在未调用工具的情况下编造或猜测结果");
		expect(p).not.toContain(NO_TOOL_RULE);
	});

	/**
	 * 工具表是**只读**的(见 `tools.ts` 的 `executeTool` 文档与
	 * `read-only-tools-gate.test.ts`):增删改订阅的工具是刻意下架的,因为群聊上下文里
	 * 塞满外部可控内容而 `bili.chat` 没有权限门。
	 *
	 * 所以铁律不能再指着不存在的写工具说「必须调用」,更不能说「不存在权限不足的问题」
	 * —— 那是在鼓励模型表现得像它能配置订阅,轻则空转,重则回一句「已经帮你取消了」而
	 * 什么也没发生。
	 */
	it("withTools 那一档不许承诺能改订阅 —— 工具表是只读的", () => {
		const p = buildSystemPrompt({ preset: "assistant", withTools: true });
		expect(p).toContain(NO_WRITE_RULE);
		expect(p).not.toContain("权限不足");
	});

	it("两档只差这一段 —— 人格、职责、纯文本约束都不许被顺手带走", () => {
		const noTools = buildSystemPrompt({ preset: "assistant" }).split("\n");
		const withTools = buildSystemPrompt({ preset: "assistant", withTools: true }).split("\n");
		// 除了各自那一条规则,其余每一行都该在对面找得到。
		const onlyNo = noTools.filter((l) => !withTools.includes(l));
		const onlyWith = withTools.filter((l) => !noTools.includes(l));
		expect(onlyNo.every((l) => l.includes(NO_TOOL_RULE))).toBe(true);
		expect(onlyWith.every((l) => l.includes(TOOL_LAW) || l.includes(NO_WRITE_RULE))).toBe(true);
	});

	it("custom 人格照样吃这两档 —— 报障者正是拿内置改的", () => {
		const opts = { preset: "custom" as const, customBase: "你是一个超级元气的助手!" };
		expect(buildSystemPrompt(opts)).not.toContain(TOOL_LAW);
		expect(buildSystemPrompt({ ...opts, withTools: true })).toContain(TOOL_LAW);
		// 人格本身两档都在。
		expect(buildSystemPrompt(opts)).toContain("你是一个超级元气的助手!");
	});
});

// ---------------------------------------------------------------------------
// 接线:哪条路真的拿得到工具
// ---------------------------------------------------------------------------

/**
 * 报障者用的是内置「元气少女」改的 —— 人设库条目下发到引擎时 preset 恒为
 * "custom"、内容进 customBase(见 apps/server/src/runtime/ai-config.ts)。
 * 场景提示词取两个好认的哨兵串,断言靠它们分辨这一段有没有拼进去。
 */
function makeGen(): CommentaryGenerator {
	return baseGen({
		persona: { preset: "custom", customBase: "你是一个超级元气的助手，充满活力！" },
		dynamicPrompt: "DYN_SCENE_PROMPT",
		liveSummaryPrompt: "LIVE_SCENE_PROMPT",
		enableConversation: false,
	});
}

/** 读第 n 次 create() 实际发出去的 system prompt。 */
function sentSystemPrompt(n = 0): string {
	const params = oai.create.mock.calls[n]?.[0] as { messages: Array<{ content: string }> };
	return params.messages[0].content;
}

beforeEach(() => {
	oai.create.mockReset();
	oai.create.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "好耶" } }] });
});

describe("哪条路发工具铁律", () => {
	it("动态锐评不发 —— 它的 callAPI 压根没挂工具", async () => {
		await makeGen().comment("UP 主发了新动态", "dynamic");
		const sys = sentSystemPrompt();
		expect(sys).not.toContain(TOOL_LAW);
		expect(sys).toContain(NO_TOOL_RULE);
		// 场景提示词仍然要在,别把孩子一起倒掉。
		expect(sys).toContain("DYN_SCENE_PROMPT");
	});

	it("直播总结同样不发", async () => {
		await makeGen().comment("这场直播聊了很多", "liveSummary");
		expect(sentSystemPrompt()).not.toContain(TOOL_LAW);
	});

	it("群聊女仆要发 —— 那条路是真的挂了工具的", async () => {
		await makeGen().chat("session-1", "帮我订阅一下这个 UP");
		expect(sentSystemPrompt()).toContain(TOOL_LAW);
		expect(sentSystemPrompt()).not.toContain(NO_TOOL_RULE);
	});
});
