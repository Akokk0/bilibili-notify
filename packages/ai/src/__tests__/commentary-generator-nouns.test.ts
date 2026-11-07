import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommentaryGenerator } from "../commentary-generator";
import type { PromptNouns } from "../prompt-nouns";
import { aiConfig, fakeServiceCtx } from "./harness";

const BILI_NOUNS: PromptNouns = {
	creatorNoun: "UP主",
	postNoun: "动态",
	sources: "B 站",
};

const oai = vi.hoisted(() => {
	const create = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create } };
	}
	return { create, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

function makeGen(nouns: (sourceKeys?: readonly string[]) => PromptNouns) {
	return new CommentaryGenerator({
		serviceCtx: fakeServiceCtx(),
		config: aiConfig(),
		nouns,
	});
}

beforeEach(() => {
	oai.create.mockReset();
	oai.create.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "好" } }] });
});

describe("CommentaryGenerator —— 提示词叫法的范围与落点", () => {
	it("comment() 把这次涉及的来源键交给叫法读口", async () => {
		const seen: Array<readonly string[] | undefined> = [];
		const gen = makeGen((keys) => {
			seen.push(keys);
			return BILI_NOUNS;
		});

		await gen.comment("内容", "post", undefined, undefined, ["bilibili", "acme"]);

		expect(seen).toEqual([["bilibili", "acme"]]);
	});

	it("聊天不给来源键，按全局范围取叫法", async () => {
		const seen: Array<readonly string[] | undefined> = [];
		const gen = makeGen((keys) => {
			seen.push(keys);
			return BILI_NOUNS;
		});

		await gen.chat("你好");

		expect(seen).toEqual([undefined]);
	});

	it("发出去的核心工具说明用同一份叫法渲染", async () => {
		const gen = makeGen(() => BILI_NOUNS);
		await gen.chat("你好");

		const params = oai.create.mock.calls[0]?.[0] as {
			tools: Array<{ function: { name: string; description: string } }>;
		};
		const listSubscriptions = params.tools.find(
			(tool) => tool.function.name === "list_subscriptions",
		);
		expect(listSubscriptions?.function.description).toContain("所有UP主");
		expect(listSubscriptions?.function.description).not.toContain("UP 主");
	});

	it("动态场景补充按这次来源填叫法，未知花括号原样保留", async () => {
		const scene = "主人订阅的{creatorNoun}刚刚更新了{postNoun}，保留{未知}。";
		const gen = new CommentaryGenerator({
			serviceCtx: fakeServiceCtx(),
			config: aiConfig({ dynamicPrompt: scene }),
			nouns: () => BILI_NOUNS,
		});

		await gen.comment("内容", "post", undefined, undefined, ["bilibili"]);

		const params = oai.create.mock.calls[0]?.[0] as {
			messages: Array<{ content: string }>;
		};
		const systemPrompt = params.messages[0]?.content;
		expect(systemPrompt).toContain("主人订阅的UP主刚刚更新了动态，保留{未知}。");
		expect(systemPrompt).not.toContain("{creatorNoun}");
	});

	it("per-UP 覆盖的动态场景补充也用同一份叫法", async () => {
		const gen = makeGen(() => BILI_NOUNS);

		await gen.comment(
			"内容",
			"post",
			undefined,
			{
				dynamicPrompt: "把{creatorNoun}的新{postNoun}讲清楚。",
			},
			["bilibili"],
		);

		const params = oai.create.mock.calls[0]?.[0] as {
			messages: Array<{ content: string }>;
		};
		expect(params.messages[0]?.content).toContain("把UP主的新动态讲清楚。");
	});
});
