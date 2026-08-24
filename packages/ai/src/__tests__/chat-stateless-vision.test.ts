/**
 * `chatStatelessStream()` 的看图装备 —— 独立端 dashboard 聊天专走这一条。
 *
 * 与 `comment()` / `chat()` 那两条分开测,是因为它是**唯一的流式路径**:正文经
 * `streamOnce` 分片吐出,请求体多带一个 `stream: true`。图与工具表是在 `callAPI`
 * 里拼的,两条路共用 —— 但「共用」这件事没人钉过,而独立端刚放开图片上传。
 *
 * 钉的还是那一个问题:**图去哪儿了**。
 *   - 配了副模型 → 挂上 describe_image,并明说「有图、你看不见、去调工具」,
 *     图本身不下挂(主模型可能根本不支持多模态)
 *   - 没配副模型但主模型自己看得见 → 图以 image_url 直接下挂
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CommentaryGenerator, CommentaryGeneratorConfig } from "../commentary-generator";
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
	TOOL_DEFINITIONS: [{ type: "function", function: { name: "get_subs", parameters: {} } }],
	DESCRIBE_IMAGE_TOOL: {
		type: "function",
		function: { name: "describe_image", parameters: {} },
	},
	executeTool: vi.fn(async () => "tool-result"),
}));

interface ChatMsg {
	role: string;
	content: unknown;
}
interface Params {
	model: string;
	messages: ChatMsg[];
	tools?: Array<{ function: { name: string } }>;
	stream?: boolean;
}

const IMG = "data:image/png;base64,AAAA";
const VISION = { baseURL: "https://vision.test/v1", apiKey: "sk-vision", model: "qwen-vl" };

/** 流式那一支要的是 async iterable,不是一个整包响应。 */
async function* streamOf(text: string) {
	yield { choices: [{ delta: { role: "assistant" } }] };
	yield { choices: [{ delta: { content: text } }] };
}

/**
 * 主模型的 key / baseURL / 模型名**必须**是自己的一套:这个文件靠「哪个 model
 * 被调用了」来分辨主模型与看图副模型两次请求(见下面 mainCall)。其余吃公共底。
 */
function makeGen(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGenerator {
	return baseGen({
		apiKey: "sk-main",
		baseURL: "https://main.test/v1",
		model: "deepseek-v4",
		enableConversation: false,
		maxHistory: 6,
		thinkingLevel: "medium",
		...over,
	});
}

/** 发给主模型的那一次请求(副模型那几次 model 不同)。 */
function mainCall(): Params {
	const c = oai.create.mock.calls.find((c) => (c[0] as Params).model === "deepseek-v4");
	if (!c) throw new Error("主模型没有被调用");
	return c[0] as Params;
}
/**
 * 主模型收到的最后一条 **user** 消息 —— 图与提示都该落在这儿。
 *
 * 必须按 role 挑,不能取数组末尾:`callAPI` 的工具循环会**就地**往同一个数组里
 * push 助手回复,断言时末尾早已是模型说的那句话(于是「content 是字符串」这类
 * 断言会一路假绿)。
 */
function lastUserMsg(): ChatMsg {
	const users = mainCall().messages.filter((m) => m.role === "user");
	if (users.length === 0) throw new Error("主模型没收到任何 user 消息");
	return users[users.length - 1];
}

beforeEach(() => {
	oai.create.mockReset();
	oai.create.mockImplementation(async (p: Params) =>
		p.stream
			? streamOf("好的")
			: { choices: [{ message: { role: "assistant", content: "好的" } }] },
	);
});

async function ask(gen: CommentaryGenerator, imageUrls?: string[]) {
	return gen.chatStatelessStream([{ role: "user", content: "这张图是什么" }], {
		onDelta: () => {},
		imageUrls,
	});
}

describe("独立端聊天发图 — 配了视觉副模型", () => {
	it("describe_image 挂进了工具表 —— 不挂的话模型压根没有看图的手段", async () => {
		await ask(makeGen({ vision: VISION }), [IMG]);
		expect((mainCall().tools ?? []).map((t) => t.function.name)).toContain("describe_image");
	});

	it("明说「有图、你看不见、去调工具」—— 不说它根本不知道有东西可看", async () => {
		await ask(makeGen({ vision: VISION }), [IMG]);
		expect(String(lastUserMsg().content)).toContain("describe_image");
	});

	it("图本身不下挂给主模型 —— 它可能根本不支持多模态,收到 image_url 直接 400", async () => {
		await ask(makeGen({ vision: VISION }), [IMG]);
		expect(typeof lastUserMsg().content).toBe("string");
	});

	it("没带图时既不挂看图工具也不多那句话 —— 否则下一轮模型会去查根本不存在的图", async () => {
		await ask(makeGen({ vision: VISION }));
		expect((mainCall().tools ?? []).map((t) => t.function.name)).not.toContain("describe_image");
		expect(String(lastUserMsg().content)).not.toContain("describe_image");
	});
});

describe("独立端聊天发图 — 主模型自己看得见", () => {
	it("图以 image_url 下挂在最后一条 user 消息上", async () => {
		await ask(makeGen({ enableVision: true }), [IMG]);
		const content = lastUserMsg().content;
		expect(Array.isArray(content)).toBe(true);
		expect(content).toContainEqual({ type: "image_url", image_url: { url: IMG } });
	});

	it("正文照样在,不该被图挤掉", async () => {
		await ask(makeGen({ enableVision: true }), [IMG]);
		expect(lastUserMsg().content).toContainEqual({ type: "text", text: "这张图是什么" });
	});

	it("这家没有视觉模型(DeepSeek)时,开着开关也不下挂 —— 发过去就是 400", async () => {
		await ask(makeGen({ enableVision: true, provider: "deepseek" }), [IMG]);
		expect(typeof lastUserMsg().content).toBe("string");
	});

	it("两条路都没开 → 图彻底不参与(服务端另有守卫拦在前面)", async () => {
		await ask(makeGen(), [IMG]);
		expect(typeof lastUserMsg().content).toBe("string");
	});
});
