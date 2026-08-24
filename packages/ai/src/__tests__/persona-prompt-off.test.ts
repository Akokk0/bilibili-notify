/**
 * 「无人格」这道杠杆 —— dashboard 聊天里主人开局能选的那一档。
 *
 * 由来:女仆人格是这个项目的气质,但主人也有「就正经问点事」的时候。那一档要的
 * 是**只去掉性格**,不是换一条别的路 —— 职责说明、Markdown 约定、工具铁律一条都
 * 不能少,否则模型会连「查订阅得调工具」都忘了(工具铁律缺席的老 bug 见
 * persona-prompt-tools.test.ts)。
 *
 * 缺省必须是**有人格**:漏传的调用方(推送、koishi 群聊、点评、总结)拿到的行为
 * 一字不变,这是三端共享这个包的前提。
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

const PERSONA = {
	preset: "maid" as const,
	name: "伦伦酱",
	addressUser: "主人",
	addressSelf: "小的",
	traits: "黏人,爱撒娇",
	catchphrase: "喵~",
};

describe("buildSystemPrompt 的 withPersona", () => {
	it("缺省 = 有人格 —— 三端共享,漏传的调用方行为必须一字不变", () => {
		const withFlag = buildSystemPrompt({ ...PERSONA, withPersona: true });
		expect(buildSystemPrompt(PERSONA)).toBe(withFlag);
	});

	it("关掉之后,名字 / 自称 / 性格 / 口头禅一个都不留", () => {
		const off = buildSystemPrompt({ ...PERSONA, withPersona: false });
		for (const trace of ["伦伦酱", "小的", "黏人", "爱撒娇", "喵~"]) {
			expect(off).not.toContain(trace);
		}
	});

	it("去掉的只有性格 —— 职责与工具铁律照旧", () => {
		const off = buildSystemPrompt({ ...PERSONA, withPersona: false, withTools: true });
		expect(off).toContain("关注 B 站 UP 主");
		expect(off).toContain("必须调用对应工具");
	});

	it("Markdown 约定照旧跟着 allowMarkdown 走,不受人格开关影响", () => {
		const plain = buildSystemPrompt({ ...PERSONA, withPersona: false });
		const md = buildSystemPrompt({ ...PERSONA, withPersona: false, allowMarkdown: true });
		expect(plain).toContain("只用纯文本");
		expect(md).not.toContain("只用纯文本");
	});

	it("不留那句「你有自己的性格」的引子 —— 后面已经没有下文了", () => {
		const off = buildSystemPrompt({ ...PERSONA, withPersona: false });
		expect(off).not.toContain("你有自己的性格");
	});
});

// ---------------------------------------------------------------------------
// 接线:dashboard 聊天那条路真的把开关传下去了吗
// ---------------------------------------------------------------------------

/**
 * 这个文件测的是「关掉人格之后还剩什么」,所以人设**必须**是自家那条 custom;
 * 场景提示词留空,免得断言把场景那两段也算进来。其余吃公共底。
 */
function makeGen(): CommentaryGenerator {
	return baseGen({
		persona: { preset: "custom", customBase: "你是一个超级元气的助手!" },
		dynamicPrompt: "",
		liveSummaryPrompt: "",
		enableConversation: false,
	});
}

function sentSystemPrompt(): string {
	const params = oai.create.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
	return params.messages[0].content;
}

beforeEach(() => {
	oai.create.mockReset();
	oai.create.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "好" } }] });
});

describe("chatStatelessStream 的 persona 开关", () => {
	const history = [{ role: "user" as const, content: "咩栗最近在播吗" }];

	it("不传 = 有人格 —— 这条路的老行为不许变", async () => {
		await makeGen().chatStatelessStream(history, { onDelta: () => {} });
		expect(sentSystemPrompt()).toContain("你是一个超级元气的助手!");
	});

	it("传 false → 人格那段不下发,工具铁律照旧", async () => {
		await makeGen().chatStatelessStream(history, { onDelta: () => {}, persona: false });
		const sys = sentSystemPrompt();
		expect(sys).not.toContain("你是一个超级元气的助手!");
		expect(sys).toContain("必须调用对应工具");
	});

	it("systemPrompt 整段顶掉时,人格开关无从谈起 —— 皮肤工坊那条路本来就没有人格", async () => {
		await makeGen().chatStatelessStream(history, {
			onDelta: () => {},
			systemPrompt: "专职提示词",
			persona: true,
		});
		expect(sentSystemPrompt()).toBe("专职提示词");
	});
});
