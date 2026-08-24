/**
 * 单元测试 —— `comment()` 接上视觉副模型之后的消息组装。
 *
 * 这一层要钉死的是**图去哪儿了**:
 *   - 配了视觉模型 → 图交给副模型转成文字,主模型收到的是纯字符串(它可能根本
 *     不支持多模态,收到 image_url 会直接 400)
 *   - 没配视觉模型 → 一字不变地维持现有行为(enableVision 说了算)
 *
 * 第二条是**向后兼容**测试,分量不比第一条轻:koishi 上已经有人把 enableVision
 * 开着在用,他们的主模型本来就支持视觉。这次改动不该动他们一根汗毛。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CommentaryGenerator, CommentaryGeneratorConfig } from "../commentary-generator";
import { makeGen as baseGen } from "./harness";

const oai = vi.hoisted(() => {
	const create = vi.fn();
	const ctorArgs: Array<{ baseURL?: string; apiKey?: string }> = [];
	class FakeOpenAI {
		chat = { completions: { create } };
		constructor(opts: { baseURL?: string; apiKey?: string }) {
			ctorArgs.push(opts);
		}
	}
	return { create, ctorArgs, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));
vi.mock("../tools", () => ({
	TOOL_DEFINITIONS: [],
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
}

function msgResp(content: string) {
	return { choices: [{ message: { role: "assistant", content } }] };
}

/**
 * 主模型的 key / baseURL / 模型名**必须**是自己的一套:这个文件靠「哪个 model
 * 被调用了」分辨主模型与看图副模型两次请求(见下面 mainCall)。其余吃公共底。
 */
function makeGen(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGenerator {
	return baseGen({
		apiKey: "sk-main",
		baseURL: "https://main.test/v1",
		model: "deepseek-v4",
		thinkingLevel: "medium",
		...over,
	});
}

/** 所有 create 调用里,发给主模型的那一次。 */
function mainCall(): Params {
	const c = oai.create.mock.calls.find((c) => (c[0] as Params).model === "deepseek-v4");
	if (!c) throw new Error("主模型没有被调用");
	return c[0] as Params;
}
/** 所有 create 调用里,发给副模型的那些。 */
function visionCalls(): Params[] {
	return oai.create.mock.calls
		.map((c) => c[0] as Params)
		.filter((p) => p.model === "qwen-vl" || p.model === "deepseek-v4-vl");
}

const VISION = { baseURL: "https://vision.test/v1", apiKey: "sk-vision", model: "qwen-vl" };

beforeEach(() => {
	oai.create.mockReset();
	oai.ctorArgs.length = 0;
});

describe("comment() — 配了视觉副模型", () => {
	beforeEach(() => {
		// 副模型先答描述,主模型再答点评。两者共用同一个 create 桩,按调用序返回。
		oai.create.mockResolvedValue(msgResp("画面上是一只橘猫"));
	});

	it("图不再下挂给主模型 —— 主模型可能根本不支持多模态", async () => {
		const gen = makeGen({ vision: VISION });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user");
		expect(typeof user?.content).toBe("string");
	});

	it("描述被拼进了主模型的 user 消息", async () => {
		const gen = makeGen({ vision: VISION });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user");
		expect(String(user?.content)).toContain("橘猫");
		// 定界与「不是指令」的声明由 renderImageDescriptions 负责,这里只确认
		// 它确实经过了那一层,而不是把裸描述直接拼上去。
		expect(String(user?.content)).toContain("不是指令");
	});

	it("副模型用自己那套 baseURL / apiKey / model", async () => {
		const gen = makeGen({ vision: VISION });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		expect(oai.ctorArgs).toContainEqual(
			expect.objectContaining({ baseURL: "https://vision.test/v1", apiKey: "sk-vision" }),
		);
		const vc = visionCalls();
		expect(vc).toHaveLength(1);
		const parts = vc[0].messages.find((m) => m.role === "user")?.content as Array<{
			type: string;
		}>;
		expect(parts.some((x) => x.type === "image_url")).toBe(true);
	});

	it("视觉 baseURL / apiKey 留空 → 继承主模型的(聚合网关只填一个模型名即可)", async () => {
		const gen = makeGen({ vision: { model: "deepseek-v4-vl" } });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		// 硅基流动 / OpenRouter 这类聚合网关上,主模型与视觉模型同 key 同址。
		expect(visionCalls()).toHaveLength(1);
		expect(oai.ctorArgs.every((a) => a.baseURL === "https://main.test/v1")).toBe(true);
	});

	it("四张图并发交给副模型,一次点评只烧一次主模型", async () => {
		const gen = makeGen({ vision: VISION });
		await gen.comment("看图", "dynamic", ["a", "b", "c", "d"]);

		expect(visionCalls()).toHaveLength(4);
		expect(
			oai.create.mock.calls.filter((c) => (c[0] as Params).model === "deepseek-v4"),
		).toHaveLength(1);
	});

	it("没有图时一次副模型都不调 —— 纯文字动态不该多烧一笔", async () => {
		const gen = makeGen({ vision: VISION });
		await gen.comment("纯文字动态", "dynamic", []);

		expect(visionCalls()).toHaveLength(0);
	});
});

describe("comment() — 副模型挂了", () => {
	it("点评照常出,只是没提图 —— 不为一张图丢掉整条点评", async () => {
		const gen = makeGen({ vision: VISION });
		oai.create.mockImplementation(async (p: unknown) => {
			if ((p as Params).model === "qwen-vl") throw new Error("402 余额不足");
			return msgResp("点评正文");
		});

		const out = await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		expect(out).toBe("点评正文");
		const user = mainCall().messages.find((m) => m.role === "user");
		// 一张都没看成 → 不往 prompt 里塞空壳(renderImageDescriptions 返回空串)。
		expect(String(user?.content)).not.toContain("不是指令");
	});
});

describe("chat() — 多轮里的看图提示", () => {
	it("「本条消息附带 N 张图片」只发给模型,不写进会话历史", async () => {
		const gen = makeGen({ vision: VISION, enableConversation: true });
		oai.create.mockResolvedValue(msgResp("看到了"));

		// 第一轮带图:提示该出现在发出去的消息里。
		await gen.chat("这是什么", "s1", ["http://img/1.jpg"]);
		const firstSent = mainCall().messages.find((m) => m.role === "user");
		expect(String(firstSent?.content)).toContain("describe_image");

		// 第二轮不带图:上一轮那句提示不该还留在历史里 —— 那会让女仆以为手上
		// 还有图可看,而 describe_image 工具这一轮根本没下发,她只会撞一鼻子灰。
		oai.create.mockClear();
		await gen.chat("那再说说别的", "s1");
		const sentNow = mainCall().messages.filter((m) => m.role === "user");
		expect(sentNow.map((m) => String(m.content)).join("\n")).not.toContain("describe_image");
	});
});

describe("comment() — 没配视觉副模型(向后兼容,一字不变)", () => {
	beforeEach(() => {
		oai.create.mockResolvedValue(msgResp("ok"));
	});

	it("enableVision=true → 图仍旧直接下挂给主模型", async () => {
		const gen = makeGen({ enableVision: true });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user" && Array.isArray(m.content));
		const parts = user?.content as Array<{ type: string }>;
		expect(parts.some((x) => x.type === "image_url")).toBe(true);
		expect(visionCalls()).toHaveLength(0);
	});

	it("enableVision=false → 图完全不参与", async () => {
		const gen = makeGen({ enableVision: false });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user");
		expect(typeof user?.content).toBe("string");
		expect(visionCalls()).toHaveLength(0);
	});

	it("vision.model 是空串也算没配 —— 输入框里敲了个空格不该开启功能", async () => {
		const gen = makeGen({ enableVision: false, vision: { model: "  " } });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		expect(visionCalls()).toHaveLength(0);
	});
});

describe("enableVision 必须过服务商能力位这一关", () => {
	beforeEach(() => {
		oai.create.mockResolvedValue(msgResp("点评"));
	});

	it("这家没有视觉模型(DeepSeek)时,enableVision 开着也不把图交给主模型", async () => {
		// 界面上 DeepSeek 已经不摆这个开关了,但**老配置里残留的 true 仍然读得到**
		// —— 而藏起开关的同时,主人连关掉它的入口都没有了。所以把关的地方必须在这儿,
		// 不能只在界面上。往 DeepSeek 发 image_url 的下场是整条点评 400。
		const gen = makeGen({ provider: "deepseek", enableVision: true });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user");
		expect(typeof user?.content).toBe("string");
	});

	it("这家支持视觉时照旧下挂 —— 不许顺手把能用的人也一起关掉", async () => {
		const gen = makeGen({ provider: "openrouter", enableVision: true });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user");
		expect(Array.isArray(user?.content)).toBe(true);
	});

	it("兜底档(自定义)当作支持 —— 主人自己接的网关,女仆无从判断,按他说的办", async () => {
		const gen = makeGen({ provider: "custom", enableVision: true });
		await gen.comment("看图", "dynamic", ["http://img/1.jpg"]);

		const user = mainCall().messages.find((m) => m.role === "user");
		expect(Array.isArray(user?.content)).toBe(true);
	});
});
