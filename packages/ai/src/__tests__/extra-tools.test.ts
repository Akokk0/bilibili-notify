/**
 * 调用方**注入**的额外工具 —— 独立端专属能力(如「做一套皮肤」)挂进聊天的口子。
 *
 * 为什么不是往 `tools.ts` 的 TOOL_DEFINITIONS 里加一条:那张表三端共用,而且是
 * **只读**的(见 read-only-tools-gate.test.ts)。koishi 的 `bili.chat` 没有权限门,
 * 群里任何人都能调 —— 写能力挂在那张表上,等于任意一条群消息都能改主人的东西。
 *
 * 所以口子开在**调用点**而不是工具表:generator 只负责把注入的定义挂上、把调用
 * 转发给注入者的执行器,不认识它的语义;谁有权限门,谁自己往里塞。这条路目前只有
 * dashboard 的 `chatStatelessStream`(cookie session 后面,只有主人本人)。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommentaryGenerator, type CommentaryGeneratorConfig } from "../commentary-generator";
import type { ExtraTool } from "../tools";

const oai = vi.hoisted(() => {
	const create = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create } };
	}
	return { create, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

function makeConfig(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGeneratorConfig {
	return {
		apiKey: "sk-test",
		baseURL: "https://api.test/v1",
		model: "gpt-test",
		persona: { preset: "assistant" },
		dynamicPrompt: "DYN",
		liveSummaryPrompt: "LIVE",
		enableConversation: true,
		maxHistory: 5,
		provider: "custom",
		enableThinking: false,
		thinkingLevel: "high",
		enableVision: false,
		...over,
	};
}

function makeGen(): CommentaryGenerator {
	const ctx: ServiceContext = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	return new CommentaryGenerator({ serviceCtx: ctx, api: {} as BilibiliAPI, config: makeConfig() });
}

function makeTool(
	over: Partial<ExtraTool> = {},
): ExtraTool & { execute: ReturnType<typeof vi.fn> } {
	return {
		definition: {
			type: "function",
			function: {
				name: "make_thing",
				description: "造一个东西",
				parameters: {
					type: "object",
					properties: { brief: { type: "string" } },
					required: ["brief"],
				},
			},
		},
		execute: vi.fn(async () => "造好了:一个东西"),
		...over,
	} as ExtraTool & { execute: ReturnType<typeof vi.fn> };
}

function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c;
		},
	};
}
const textChunk = (text: string) => ({ choices: [{ delta: { content: text } }] });
const callChunk = (args: object, id = "call_1", name = "make_thing") => ({
	choices: [
		{
			delta: {
				tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
			},
		},
	],
});

interface CreateParams {
	tools?: Array<{ function: { name: string } }>;
	messages: Array<{ role: string; content: unknown }>;
}
function createParams(n: number): CreateParams {
	const call = oai.create.mock.calls[n];
	if (!call) throw new Error(`create 未被调用第 ${n} 次`);
	return call[0] as CreateParams;
}
function toolNames(n: number): string[] {
	return (createParams(n).tools ?? []).map((t) => t.function.name);
}

const HIST = [{ role: "user" as const, content: "给我造个东西" }];

beforeEach(() => {
	oai.create.mockReset();
});

describe("chatStatelessStream × 注入工具", () => {
	it("传了 extraTools → 工具表在原有只读工具之上多出它", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, { onDelta: () => {}, extraTools: [makeTool()] });

		expect(toolNames(0)).toContain("make_thing");
		// 注入是**加装**:B 站只读工具照旧在。
		expect(toolNames(0)).toContain("list_subscriptions");
	});

	it("不传 extraTools → 工具表里没有它(钉住「默认没有写能力」)", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, { onDelta: () => {} });

		expect(toolNames(0)).not.toContain("make_thing");
	});

	it("模型调它 → 执行器收到入参,结果回灌给模型,正文照常出", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "暗色赛博" })]))
			.mockResolvedValueOnce(streamOf([textChunk("做好啦")]));
		const tool = makeTool();
		const reply = await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [tool],
		});

		expect(reply).toBe("做好啦");
		expect(tool.execute).toHaveBeenCalledWith({ brief: "暗色赛博" });
		const toolMsg = createParams(1).messages.find((m) => m.role === "tool");
		expect(String(toolMsg?.content)).toContain("造好了:一个东西");
	});

	it("onToolEvent:start 带入参,end 带成败 —— 界面上那个转圈靠它", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "暗色赛博" })]))
			.mockResolvedValueOnce(streamOf([textChunk("做好啦")]));
		const events: unknown[] = [];
		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (ev) => events.push(ev),
			extraTools: [makeTool()],
		});

		expect(events[0]).toMatchObject({
			phase: "start",
			name: "make_thing",
			args: { brief: "暗色赛博" },
		});
		expect(events[1]).toMatchObject({ phase: "end", ok: true });
	});

	it("执行器抛错 → end ok:false,生成不炸,失败当资料回给模型", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "暗色赛博" })]))
			.mockResolvedValueOnce(streamOf([textChunk("没做成也回一句")]));
		const tool = makeTool();
		tool.execute.mockRejectedValueOnce(new Error("模型把 JSON 写坏了"));
		const events: Array<{ phase: string; ok?: boolean }> = [];
		const reply = await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (ev) => events.push(ev),
			extraTools: [tool],
		});

		expect(reply).toBe("没做成也回一句");
		expect(events[1]).toMatchObject({ phase: "end", ok: false });
		const toolMsg = createParams(1).messages.find((m) => m.role === "tool");
		expect(String(toolMsg?.content)).toContain("模型把 JSON 写坏了");
	});

	it("注入工具与只读工具共存:模型调只读的那个照旧走内置执行器", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({}, "call_1", "list_subscriptions")]))
			.mockResolvedValueOnce(streamOf([textChunk("查完了")]));
		const tool = makeTool();
		const gen = makeGen();
		gen.setSubscriptionsSource(() => ({ "1": { uid: "1", uname: "咩栗", dynamic: true } }));
		await gen.chatStatelessStream(HIST, { onDelta: () => {}, extraTools: [tool] });

		expect(tool.execute).not.toHaveBeenCalled();
		const toolMsg = createParams(1).messages.find((m) => m.role === "tool");
		expect(String(toolMsg?.content)).toContain("咩栗");
	});
});

/**
 * 专职模式 —— 调用方自带 system、并且**不要**内置那套 B 站只读工具。
 *
 * 它服务的是「一个窗口只干一件事」的形态(皮肤工坊):人格不带、B 站数据的口子
 * 不开,模型手上只剩注入的那一把工具。少一样东西在上下文里,就少一条能把它带跑
 * 的路。
 */
describe("chatStatelessStream × 专职模式", () => {
	it("给了 systemPrompt → system 消息就是它,人格一个字都不掺", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			systemPrompt: "你只做皮肤。",
		});

		const sys = createParams(0).messages.find((m) => m.role === "system");
		expect(sys?.content).toBe("你只做皮肤。");
	});

	it("builtinTools:false → 工具表只剩注入的那把", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			builtinTools: false,
			extraTools: [makeTool()],
		});

		expect(toolNames(0)).toEqual(["make_thing"]);
	});

	it("工具表空了就**不发** tools 字段 —— 空数组有网关会当参数错拒掉", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, { onDelta: () => {}, builtinTools: false });

		expect(createParams(0).tools).toBeUndefined();
	});

	it("不给这两项 → 照旧人格 + 全套只读工具(钉住默认没变)", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, { onDelta: () => {} });

		const sys = createParams(0).messages.find((m) => m.role === "system");
		expect(String(sys?.content).length).toBeGreaterThan(50);
		expect(toolNames(0)).toContain("list_subscriptions");
	});
});
