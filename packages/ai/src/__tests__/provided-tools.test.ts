import { ok } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AiTool } from "../tools";
import { makeGen, streamOf, textChunk } from "./harness";

const oai = vi.hoisted(() => {
	const create = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create } };
	}
	return { create, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

const HIST = [{ role: "user" as const, content: "看看提供方那边" }];

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

function callChunk(args: object, id = "call_provided", name = "provided_lookup") {
	return {
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
				},
			},
		],
	};
}

function makeExecute() {
	return vi.fn(async (_args: Record<string, string>, _onProgress?: (chars: number) => void) =>
		ok({ text: "提供方查到了" }),
	);
}

type ExecuteMock = ReturnType<typeof makeExecute>;

function makeTool(
	over: Partial<Omit<AiTool, "execute">> & { execute?: ExecuteMock } = {},
): AiTool & { execute: ExecuteMock } {
	return {
		label: "查提供方资料",
		definition: {
			type: "function",
			function: {
				name: "provided_lookup",
				description: "查提供方登记的只读资料",
				parameters: {
					type: "object",
					properties: { topic: { type: "string" } },
					required: ["topic"],
				},
			},
		},
		execute: makeExecute(),
		...over,
	};
}

function makeNamedTool(name: string, label = `查 ${name}`): AiTool & { execute: ExecuteMock } {
	const tool = makeTool({ label });
	tool.definition = {
		...tool.definition,
		function: { ...tool.definition.function, name },
	};
	return tool;
}

function toolCallResponse(name: string, args: object, id = "call_provided") {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{ id, type: "function", function: { name, arguments: JSON.stringify(args) } },
					],
				},
			},
		],
	};
}

function textResponse(content: string) {
	return { choices: [{ message: { role: "assistant", content } }] };
}

beforeEach(() => {
	oai.create.mockReset();
});

describe("CommentaryGenerator × 提供方只读工具", () => {
	it("流式请求挂上提供方工具，调用结果回灌，痕迹取工具自己的 label", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ topic: "更新" })]))
			.mockResolvedValueOnce(streamOf([textChunk("查到啦")]));
		const tool = makeTool();
		const gen = makeGen();
		const events: Array<{ phase: string; label?: string; ok?: boolean }> = [];

		gen.setProvidedTools(() => [tool]);
		const reply = await gen.chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (event) => events.push(event),
		});

		expect(reply).toBe("查到啦");
		expect(toolNames(0)).toContain("provided_lookup");
		expect(tool.execute).toHaveBeenCalledWith({ topic: "更新" }, expect.any(Function));
		expect(createParams(1).messages.find((message) => message.role === "tool")?.content).toBe(
			"提供方查到了",
		);
		expect(events.find((event) => event.phase === "start")?.label).toBe("查提供方资料");
		expect(events.find((event) => event.phase === "end")?.ok).toBe(true);
	});

	it("读口给空数组 → 请求不挂，模型叫到它时按未知工具失败", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ topic: "更新" })]))
			.mockResolvedValueOnce(streamOf([textChunk("换个办法")]));
		const tool = makeTool();
		const gen = makeGen();
		const events: Array<{ phase: string; ok?: boolean }> = [];

		gen.setProvidedTools(() => []);
		const reply = await gen.chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (event) => events.push(event),
		});

		expect(reply).toBe("换个办法");
		expect(toolNames(0)).not.toContain("provided_lookup");
		expect(tool.execute).not.toHaveBeenCalled();
		expect(createParams(1).messages.find((message) => message.role === "tool")?.content).toContain(
			"未知工具: provided_lookup",
		);
		expect(events.find((event) => event.phase === "end")?.ok).toBe(false);
	});

	it("builtinTools:false → 提供方工具也不挂", async () => {
		oai.create.mockResolvedValueOnce(streamOf([textChunk("专职回答")]));
		const gen = makeGen();

		gen.setProvidedTools(() => [makeTool()]);
		await gen.chatStatelessStream(HIST, { onDelta: () => {}, builtinTools: false });

		expect(toolNames(0)).not.toContain("provided_lookup");
	});

	it("注入工具与提供方工具同名 → 定义只挂一份，执行与 label 都归注入的", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ topic: "更新" })]))
			.mockResolvedValueOnce(streamOf([textChunk("注入版回答")]));
		const provided = makeTool();
		const injected = makeTool({
			label: "注入版查资料",
			execute: vi.fn(async () => ok({ text: "注入版结果" })),
		});
		const gen = makeGen();
		const events: Array<{ phase: string; label?: string }> = [];

		gen.setProvidedTools(() => [provided]);
		await gen.chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (event) => events.push(event),
			extraTools: [injected],
		});

		expect(toolNames(0).filter((name) => name === "provided_lookup")).toHaveLength(1);
		expect(provided.execute).not.toHaveBeenCalled();
		expect(injected.execute).toHaveBeenCalledOnce();
		expect(createParams(1).messages.find((message) => message.role === "tool")?.content).toBe(
			"注入版结果",
		);
		expect(events.find((event) => event.phase === "start")?.label).toBe("注入版查资料");
	});

	it("提供方工具也能收窄下一轮的工具面", async () => {
		oai.create
			.mockResolvedValueOnce(
				streamOf([callChunk({ topic: "更新" }, "call_provided", "provided_reader")]),
			)
			.mockResolvedValueOnce(streamOf([textChunk("只留读取这一把")]));
		const reader = makeNamedTool("provided_reader");
		reader.execute.mockResolvedValueOnce(
			ok({ text: "读到了", restrictTools: ["provided_reader"] }),
		);
		const sibling = makeNamedTool("provided_sibling");
		const gen = makeGen();

		gen.setProvidedTools(() => [reader, sibling]);
		await gen.chatStatelessStream(HIST, { onDelta: () => {} });

		expect(toolNames(1)).toContain("provided_reader");
		expect(toolNames(1)).not.toContain("provided_sibling");
	});

	it("提供方工具交回的图走现有看图分流", async () => {
		const shot = "data:image/jpeg;base64,U0hPVA==";
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ topic: "更新" })]))
			.mockResolvedValueOnce(streamOf([textChunk("看过截图了")]));
		const tool = makeTool({
			execute: vi.fn(async () => ok({ text: "提供方截了一张图", images: [shot] })),
		});
		const gen = makeGen({ enableVision: true });

		gen.setProvidedTools(() => [tool]);
		await gen.chatStatelessStream(HIST, { onDelta: () => {} });

		const imageMessage = createParams(1).messages.find(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some(
					(part) => (part as { image_url?: { url: string } }).image_url?.url === shot,
				),
		);
		expect(imageMessage).toBeDefined();
	});
});

describe("CommentaryGenerator × 提供方工具的热读口", () => {
	it("每次顶层请求现取 getter，后一轮看得到刚变成的新工具", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([textChunk("第一轮")]))
			.mockResolvedValueOnce(streamOf([textChunk("第二轮")]));
		let available = [makeNamedTool("provided_first")];
		const gen = makeGen();

		gen.setProvidedTools(() => available);
		await gen.chatStatelessStream(HIST, { onDelta: () => {} });
		available = [makeNamedTool("provided_second")];
		await gen.chatStatelessStream(HIST, { onDelta: () => {} });

		expect(toolNames(0)).toContain("provided_first");
		expect(toolNames(0)).not.toContain("provided_second");
		expect(toolNames(1)).toContain("provided_second");
		expect(toolNames(1)).not.toContain("provided_first");
	});
});

describe("CommentaryGenerator × 提供方工具的多条出口", () => {
	it("chat() 挂上提供方工具，并能执行、把结果回灌给模型", async () => {
		oai.create
			.mockResolvedValueOnce(toolCallResponse("provided_lookup", { topic: "更新" }))
			.mockResolvedValueOnce(textResponse("试推送查到了"));
		const tool = makeTool();
		const gen = makeGen();

		gen.setProvidedTools(() => [tool]);
		const reply = await gen.chat("查一下");

		expect(reply).toBe("试推送查到了");
		expect(toolNames(0)).toContain("provided_lookup");
		expect(tool.execute).toHaveBeenCalledOnce();
		expect(createParams(1).messages.find((message) => message.role === "tool")?.content).toBe(
			"提供方查到了",
		);
	});

	it("chat() 的工具交回图时仍只取文字", async () => {
		const shot = "data:image/jpeg;base64,U0hPVA==";
		oai.create
			.mockResolvedValueOnce(toolCallResponse("provided_lookup", { topic: "更新" }))
			.mockResolvedValueOnce(textResponse("图片收到"));
		const tool = makeTool({
			execute: vi.fn(async () => ok({ text: "提供方截了一张图", images: [shot] })),
		});
		const gen = makeGen({ enableVision: true });

		gen.setProvidedTools(() => [tool]);
		await gen.chat("查一下");

		const imageParts = createParams(1).messages.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter(
						(part) => (part as { image_url?: { url: string } }).image_url?.url === shot,
					)
				: [],
		);
		expect(imageParts).toHaveLength(0);
	});

	it("comment() 的推送路径照旧不挂提供方工具", async () => {
		oai.create.mockResolvedValueOnce(textResponse("一条点评"));
		const gen = makeGen();

		gen.setProvidedTools(() => [makeTool()]);
		await gen.comment("动态正文", "dynamic");

		expect(toolNames(0)).not.toContain("provided_lookup");
	});
});
