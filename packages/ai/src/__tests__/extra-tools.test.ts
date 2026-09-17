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

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtraTool } from "../tools";
import { makeGen, streamOf, textChunk } from "./harness";

const oai = vi.hoisted(() => {
	const create = vi.fn();
	class FakeOpenAI {
		chat = { completions: { create } };
	}
	return { create, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

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
		// 第二个参数是进度口子(见下面那条)—— 接不接由工具自己决定。
		expect(tool.execute).toHaveBeenCalledWith({ brief: "暗色赛博" }, expect.any(Function));
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

	it("注入工具报进度 → 多出 progress 那几拍,与 start/end 同一个 id", async () => {
		// 一趟皮肤生成要几分钟,而工具轮**不产生正文** —— 中间一个事件都没有的话,
		// 界面上跟「卡死了」长得一模一样。进度是这段静默里唯一的活口。
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "暗色赛博" })]))
			.mockResolvedValueOnce(streamOf([textChunk("做好啦")]));
		const tool = makeTool({
			execute: vi.fn(async (_args: Record<string, string>, onProgress?: (n: number) => void) => {
				onProgress?.(120);
				onProgress?.(860);
				return "造好了:一个东西";
			}),
		});
		const events: Array<{ phase: string; id: string; chars?: number }> = [];
		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (ev) => events.push(ev as never),
			extraTools: [tool],
		});

		expect(events.map((e) => e.phase)).toEqual(["start", "progress", "progress", "end"]);
		// 界面按 id 认人:一轮里可以同时开好几个工具,进度得落到对的那一条上。
		expect(new Set(events.map((e) => e.id)).size).toBe(1);
		expect(events.filter((e) => e.phase === "progress").map((e) => e.chars)).toEqual([120, 860]);
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

/**
 * 卡片皮肤工坊要的三样(ADR-0015 决策 13 / 19 / 23 的 🔗)。
 *
 * - 写一张卡的入参是**嵌套的**(`blocks` 是对象数组)。归一只该把数字 / 布尔变成字符串,
 *   对象压成 `String(v)` 就是一串 `[object Object]`,工具连 JSON 都拿不回来。
 * - 从零做一整套至少 8 把工具调用,而默认的轮数闸正好是 8 —— 工坊得能单独放宽。
 * - `look_card` 截了图要交回给模型看,而 tool 消息只收文字。
 */
describe("chatStatelessStream × 卡片工坊的管道", () => {
	it("入参里的对象 / 数组 → 交给工具的是 JSON 原文,不是 [object Object]", async () => {
		const blocks = [{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1 } }];
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "x", blocks, width: 400, on: true })]))
			.mockResolvedValueOnce(streamOf([textChunk("好")]));
		const tool = makeTool();
		await makeGen().chatStatelessStream(HIST, { onDelta: () => {}, extraTools: [tool] });

		const args = tool.execute.mock.calls[0]?.[0] as Record<string, string>;
		expect(JSON.parse(args.blocks ?? "")).toEqual(blocks);
		// 标量照旧归一成字符串(老工具靠这个比对 uid)。
		expect(args.width).toBe("400");
		expect(args.on).toBe("true");
	});

	/** 连着 `n` 轮都只调工具,第 n+1 轮才开口。 */
	function toolRounds(n: number): void {
		for (let i = 0; i < n; i++) {
			oai.create.mockResolvedValueOnce(streamOf([callChunk({ brief: `第${i}轮` }, `call_${i}`)]));
		}
		oai.create.mockResolvedValueOnce(streamOf([textChunk("一整套做完啦")]));
	}

	it("默认闸仍是 8 轮:第 9 轮才开口的话,回的是上限提示", async () => {
		toolRounds(8);
		const reply = await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [makeTool()],
		});
		expect(reply).toContain("上限");
	});

	it("maxToolRounds 放宽 → 工具轮多于 8 也收得到正文", async () => {
		toolRounds(9);
		const reply = await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [makeTool()],
			maxToolRounds: 24,
		});
		expect(reply).toBe("一整套做完啦");
	});

	const SHOT = "data:image/jpeg;base64,U0hPVA==";
	const lookTool = () =>
		makeTool({ execute: vi.fn(async () => ({ text: "这是直播卡的截图", images: [SHOT] })) });

	/** 主模型那几次请求里,带着这张截图的 user 消息(副模型那趟本来就带图,不算)。 */
	function imageMessages(): Array<{ role: string; content: unknown }> {
		const all = oai.create.mock.calls
			.filter((c) => (c[0] as { model: string }).model !== "qwen-vl")
			.flatMap((c) => (c[0] as CreateParams).messages ?? []);
		return all.filter(
			(m) =>
				m.role === "user" &&
				Array.isArray(m.content) &&
				(m.content as Array<{ image_url?: { url: string } }>).some(
					(p) => p.image_url?.url === SHOT,
				),
		);
	}

	it("工具交回图 + 主模型看得见 → 工具结果之后补一条带图的 user 消息", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "看看" })]))
			.mockResolvedValueOnce(streamOf([textChunk("看过了")]));
		await makeGen({ enableVision: true }).chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [lookTool()],
		});

		const msgs = createParams(1).messages;
		const toolAt = msgs.findIndex((m) => m.role === "tool");
		const imageAt = msgs.findIndex((m) => imageMessages().includes(m));
		expect(String(msgs[toolAt]?.content)).toContain("这是直播卡的截图");
		expect(imageAt).toBeGreaterThan(toolAt);
	});

	it("主模型看不见、配了看图副模型 → 截图转成文字并进工具结果,图不下挂", async () => {
		// 按模型分派:副模型那一趟插在主模型两趟之间,排队式的 Once 会被它抢走一个。
		const main = [streamOf([callChunk({ brief: "看看" })]), streamOf([textChunk("看过了")])];
		oai.create.mockImplementation(async (p: { model: string }) =>
			p.model === "qwen-vl"
				? { choices: [{ message: { role: "assistant", content: "粉色玻璃卡,标题压住了封面" } }] }
				: main.shift(),
		);
		await makeGen({ vision: { model: "qwen-vl", baseURL: "", apiKey: "" } }).chatStatelessStream(
			HIST,
			{ onDelta: () => {}, extraTools: [lookTool()] },
		);

		const mainCalls = oai.create.mock.calls.filter(
			(c) => (c[0] as { model: string }).model !== "qwen-vl",
		);
		const last = mainCalls.at(-1)?.[0] as CreateParams;
		const toolMsg = last.messages.find((m) => m.role === "tool");
		expect(String(toolMsg?.content)).toContain("这是直播卡的截图");
		expect(String(toolMsg?.content)).toContain("标题压住了封面");
		expect(imageMessages()).toHaveLength(0);
	});

	it("两样都没有 → 工具结果里说一句看不见,不报错、不下挂图", async () => {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk({ brief: "看看" })]))
			.mockResolvedValueOnce(streamOf([textChunk("看不见也回一句")]));
		const events: Array<{ phase: string; ok?: boolean }> = [];
		const reply = await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			onToolEvent: (ev) => events.push(ev),
			extraTools: [lookTool()],
		});

		expect(reply).toBe("看不见也回一句");
		expect(events.find((e) => e.phase === "end")?.ok).toBe(true);
		const toolMsg = createParams(1).messages.find((m) => m.role === "tool");
		expect(String(toolMsg?.content)).toMatch(/看不见/);
		expect(imageMessages()).toHaveLength(0);
	});
});
