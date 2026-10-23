/**
 * 核心工具按结果形状返回,生成器把失败如实记进痕迹并原话喂回模型。
 *
 * 这里不 mock `../tools`:要的是真 `executeTool` 与真生成器连在一起的行为,
 * 模型仍是假的。
 */

import { fail, ok } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommentaryGenerator, type ToolTraceEvent } from "../commentary-generator";
import { type AiTool, type CreatorReader, executeTool } from "../tools";
import { aiConfig, fakeServiceCtx, readerStubs, streamOf, testNouns, textChunk } from "./harness";

const oai = vi.hoisted(() => {
	const create = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create } };
	}
	return { create, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

beforeEach(() => {
	oai.create.mockReset();
});

const SUBS: CreatorReader = {
	subscriptions: () => [
		{ creator: "acme:111", name: "小绫", platform: "示例", post: true, live: true },
	],
	...readerStubs,
};

const run = (name: string, args: Record<string, string>, reader: CreatorReader | null = SUBS) =>
	executeTool(name, args, reader);

describe("executeTool —— 不是接口的错,但调用本身就不成立 → 失败", () => {
	it("未知工具 → not_found", async () => {
		expect(await run("subscribe_user", { creator: "acme:1" })).toEqual({
			ok: false,
			code: "not_found",
			message: "未知工具: subscribe_user",
		});
	});

	it("describe_image:没有图 → unavailable;序号不对 → invalid;副模型抛错 → unavailable", async () => {
		expect(await run("describe_image", { index: "1" })).toEqual({
			ok: false,
			code: "unavailable",
			message: "看图功能当前不可用（没有配置视觉模型，或本条消息没有图片）",
		});
		const ctx = { images: ["data:image/png;base64,AA"], describe: vi.fn(async () => "一只猫") };
		expect(await executeTool("describe_image", { index: "2" }, null, ctx)).toEqual({
			ok: false,
			code: "invalid",
			message: "图片序号不对：本条消息只有 1 张图，请给 1 到 1 之间的整数序号（不是图片地址）",
		});
		const broken = {
			images: ["data:image/png;base64,AA"],
			describe: vi.fn(async () => {
				throw new Error("副模型挂了");
			}),
		};
		expect(await executeTool("describe_image", { index: "1" }, null, broken)).toEqual({
			ok: false,
			code: "unavailable",
			message: "看图失败: 副模型挂了",
		});
	});
});

describe("executeTool —— 成功与「查了、没有」仍是成功", () => {
	it("list_subscriptions:有订阅、没订阅都是成功", async () => {
		expect(await run("list_subscriptions", {})).toEqual({
			ok: true,
			text: "小绫（示例 · creator: acme:111）动态:✓ 直播:✓",
		});
		expect(await executeTool("list_subscriptions", {}, null)).toEqual({
			ok: true,
			text: "当前没有订阅",
		});
	});

	it("搜人失败原样喂回;查了没有是成功", async () => {
		const failing = {
			...SUBS,
			searchCreators: async () => fail("rate_limited", "被风控了", { upstreamCode: -352 }),
		};
		expect(await run("search_creators", { source: "acme", query: "x" }, failing)).toEqual({
			ok: false,
			code: "rate_limited",
			message: "被风控了",
			upstreamCode: -352,
		});
		const empty = { ...SUBS, searchCreators: async () => ok({ candidates: [] }) };
		expect(await run("search_creators", { source: "acme", query: "x" }, empty)).toEqual({
			ok: true,
			text: "没有找到相关用户",
		});
	});
});

describe("CommentaryGenerator.chatStatelessStream —— 工具失败在痕迹里记成失败", () => {
	const toolChunk = (name: string, args: object) => ({
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }],
				},
			},
		],
	});

	function makeGen(reader: CreatorReader | null = SUBS): CommentaryGenerator {
		const generator = new CommentaryGenerator({
			serviceCtx: fakeServiceCtx(),
			config: aiConfig(),
			nouns: testNouns,
		});
		if (reader) generator.setCreatorReader(reader);
		return generator;
	}

	async function drive(gen: CommentaryGenerator, name: string, args: object) {
		oai.create
			.mockResolvedValueOnce(streamOf([toolChunk(name, args)]))
			.mockResolvedValueOnce(streamOf([textChunk("好的主人")]));
		const seen: ToolTraceEvent[] = [];
		const answer = await gen.chatStatelessStream([{ role: "user", content: "帮我查" }], {
			onDelta: () => {},
			onToolEvent: (event) => seen.push(event),
		});
		return { seen, answer };
	}

	function toolMessageFedBack(): string {
		const params = oai.create.mock.calls[1]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		const message = params.messages.find((candidate) => candidate.role === "tool");
		if (!message) throw new Error("第二次请求里没有工具消息");
		return message.content;
	}

	it("读口回错 → end 是失败并带那句话;同一句话喂回给模型;对话继续", async () => {
		const gen = makeGen({
			...SUBS,
			searchCreators: async () => fail("rate_limited", "请求被拦截", { upstreamCode: -412 }),
		});

		const { seen, answer } = await drive(gen, "search_creators", {
			source: "acme",
			query: "小绫",
		});

		expect(seen.find((event) => event.phase === "end")).toMatchObject({
			ok: false,
			message: "请求被拦截",
		});
		expect(toolMessageFedBack()).toBe("请求被拦截");
		expect(answer).toBe("好的主人");
	});

	it("「查了、没有」仍记成功(没订阅)", async () => {
		const { seen } = await drive(makeGen(null), "list_subscriptions", {});
		expect(seen.find((event) => event.phase === "end")).toMatchObject({ ok: true });
		expect(toolMessageFedBack()).toBe("当前没有订阅");
	});

	it("提供方工具抛错仍记失败,话是「工具执行失败: …」", async () => {
		const broken: AiTool = {
			definition: {
				type: "function",
				function: { name: "broken_tool", description: "x", parameters: { type: "object" } },
			},
			label: "坏工具",
			execute: async () => {
				throw new Error("连不上");
			},
		};

		const gen = makeGen();
		gen.setProvidedTools(() => [broken]);

		const { seen, answer } = await drive(gen, "broken_tool", {});

		expect(seen.find((event) => event.phase === "end")).toMatchObject({
			ok: false,
			message: "工具执行失败: 连不上",
		});
		expect(toolMessageFedBack()).toBe("工具执行失败: 连不上");
		expect(answer).toBe("好的主人");
	});
});
