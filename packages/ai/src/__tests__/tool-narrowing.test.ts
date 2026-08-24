/**
 * 注入工具**收窄工具面** —— 一条技能声明了 `allowed-tools` 之后,从下一轮起
 * 模型手上只剩那几把(ADR-0001 决策 11 / 12)。
 *
 * 两条铁律:
 *
 * ① **只减不加。** 收窄是对现有工具表做交集,`restrictTools` 里写一个本来不在
 *    表上的名字,不会凭空长出一把工具来。这是整条链路的安全前提:技能正文是
 *    **用户可写的数据**(「从网上抄一份贴进来」),用户可写的数据永远不能扩大
 *    能力面。
 * ② **两种 API 风味都要真收窄。** chat 风味的工具表在 `makeParams` 里每轮现取,
 *    responses 风味原先是**循环外算一次**的 —— 那条路上收窄会静默失效:构建全绿、
 *    测试全绿,只有真机上用 responses 协议的主人会发现技能压根没约束住工具。
 *
 * 收窄**只活一轮对话**:`toolOptions` 每次请求现造,下一条用户消息拿回完整工具面。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtraTool } from "../tools";
import { makeGen, streamOf, textChunk } from "./harness";

const oai = vi.hoisted(() => {
	const chatCreate = vi.fn();
	const responsesCreate = vi.fn(async (_params: Record<string, unknown>): Promise<unknown> => {
		throw new Error("unmocked responses.create");
	});
	class FakeOpenAI {
		chat = { completions: { create: chatCreate } };
		responses = { create: responsesCreate };
	}
	return { chatCreate, responsesCreate, FakeOpenAI };
});
vi.mock("openai", () => ({ default: oai.FakeOpenAI }));

/** 「读一条技能」那把工具的替身。给了 restrictTools 就在返回值里捎上收窄意图。 */
function makeLoader(restrictTools?: readonly string[]): ExtraTool {
	return {
		definition: {
			type: "function",
			function: {
				name: "load_skill",
				description: "读一条技能",
				parameters: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
		},
		execute: async () => (restrictTools ? { text: "技能正文", restrictTools } : "技能正文"),
	};
}

// --- chat 风味 ---
const callChunk = (name: string, args: object) => ({
	choices: [
		{
			delta: {
				tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }],
			},
		},
	],
});
function chatToolNames(n: number): string[] {
	const p = oai.chatCreate.mock.calls[n]?.[0] as { tools?: Array<{ function: { name: string } }> };
	if (!p) throw new Error(`chat.create 未被调用第 ${n} 次`);
	return (p.tools ?? []).map((t) => t.function.name);
}

// --- responses 风味 ---
const completed = (items: unknown[]) => ({
	type: "response.completed",
	response: { output: items },
});
const msgItem = (text: string) => ({
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text }],
});
const fnCallItem = (name: string, args: object) => ({
	type: "function_call",
	call_id: "c1",
	name,
	arguments: JSON.stringify(args),
});
function responsesToolNames(n: number): string[] {
	const p = oai.responsesCreate.mock.calls[n]?.[0] as { tools?: Array<{ name: string }> };
	if (!p) throw new Error(`responses.create 未被调用第 ${n} 次`);
	return (p.tools ?? []).map((t) => t.name);
}

const HIST = [{ role: "user" as const, content: "/weekly-report" }];

beforeEach(() => {
	oai.chatCreate.mockReset();
	oai.responsesCreate.mockReset();
});

describe("chat 风味", () => {
	it("工具返回 restrictTools → 下一轮的工具表只剩交集", async () => {
		oai.chatCreate
			.mockResolvedValueOnce(streamOf([callChunk("load_skill", { name: "weekly-report" })]))
			.mockResolvedValueOnce(streamOf([textChunk("这就去查")]));

		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [makeLoader(["list_subscriptions", "get_user_stats", "load_skill"])],
		});

		// 第一轮:完整工具面。
		expect(chatToolNames(0)).toContain("get_user_videos");
		expect(chatToolNames(0)).toContain("load_skill");
		// 第二轮:只剩技能声明的那几把。
		expect(chatToolNames(1).sort()).toEqual(["get_user_stats", "list_subscriptions", "load_skill"]);
	});

	it("只减不加:restrictTools 里写个本来没有的名字,不会凭空长出来", async () => {
		// 技能正文是**用户可写的数据**。这条测试是那句「用户可写的数据永远不能
		// 扩大工具面」的在场证明 —— 收窄只做交集,不做并集。
		oai.chatCreate
			.mockResolvedValueOnce(streamOf([callChunk("load_skill", { name: "evil" })]))
			.mockResolvedValueOnce(streamOf([textChunk("好")]));

		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [makeLoader(["list_subscriptions", "delete_everything", "create_skin"])],
		});

		expect(chatToolNames(1)).toEqual(["list_subscriptions"]);
	});

	it("工具返回纯字符串 → 工具表原样不动", async () => {
		oai.chatCreate
			.mockResolvedValueOnce(streamOf([callChunk("load_skill", { name: "a" })]))
			.mockResolvedValueOnce(streamOf([textChunk("好")]));

		await makeGen().chatStatelessStream(HIST, { onDelta: () => {}, extraTools: [makeLoader()] });

		expect(chatToolNames(1)).toEqual(chatToolNames(0));
	});

	it("收窄只活一轮 —— 下一条用户消息拿回完整工具面", async () => {
		const gen = makeGen();
		const tools = [makeLoader(["list_subscriptions", "load_skill"])];
		oai.chatCreate
			.mockResolvedValueOnce(streamOf([callChunk("load_skill", { name: "a" })]))
			.mockResolvedValueOnce(streamOf([textChunk("好")]))
			.mockResolvedValueOnce(streamOf([textChunk("再说")]));

		await gen.chatStatelessStream(HIST, { onDelta: () => {}, extraTools: tools });
		await gen.chatStatelessStream(HIST, { onDelta: () => {}, extraTools: tools });

		expect(chatToolNames(1)).toEqual(["list_subscriptions", "load_skill"]);
		expect(chatToolNames(2)).toEqual(chatToolNames(0));
	});
});

describe("开局就带着技能(斜杠命令那条路)", () => {
	it("systemSuffix 追加在人格之后,人格照旧在场", async () => {
		// ADR 决策 14:技能正文是**追加**,不是顶掉。顶掉的话主人打一条斜杠命令,
		// 女仆就突然不是女仆了 —— 而他要的只是「按这套步骤做事」。
		oai.chatCreate.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			systemSuffix: "## 周报\n先列订阅,再逐个查数据。",
		});
		const p = oai.chatCreate.mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		const system = p.messages.find((m) => m.role === "system")?.content ?? "";
		expect(system).toContain("先列订阅,再逐个查数据。");
		// 人格那段还在(缺省人格里必有的「工具」纪律)。
		expect(system.indexOf("先列订阅")).toBeGreaterThan(0);
		expect(system.length).toBeGreaterThan("## 周报\n先列订阅,再逐个查数据。".length + 50);
	});

	it("restrictTools 让**第一轮**就已经是窄的 —— 主人已经点名了,不必白烧一轮让模型自己去调", async () => {
		oai.chatCreate.mockResolvedValueOnce(streamOf([textChunk("好")]));
		await makeGen().chatStatelessStream(HIST, {
			onDelta: () => {},
			restrictTools: ["list_subscriptions", "get_user_stats", "不存在的工具"],
		});
		// 同样是交集:多写的那个名字长不出工具来。
		expect(chatToolNames(0).sort()).toEqual(["get_user_stats", "list_subscriptions"]);
	});
});

describe("responses 风味", () => {
	it("同样真收窄 —— 那边的工具表原先是循环外算一次的", async () => {
		// 这条测试的全部价值就在这句话上:两条取轮路径各写各的,收窄在 responses
		// 那边会**静默**失效 —— 构建绿、chat 的测试也绿,只有真机上用 responses
		// 协议的主人会发现技能压根没约束住工具。
		oai.responsesCreate
			.mockResolvedValueOnce(
				streamOf([completed([fnCallItem("load_skill", { name: "weekly-report" })])]),
			)
			.mockResolvedValueOnce(streamOf([completed([msgItem("这就去查")])]));

		await makeGen({ apiFlavor: "responses" }).chatStatelessStream(HIST, {
			onDelta: () => {},
			extraTools: [makeLoader(["list_subscriptions", "get_user_stats", "load_skill"])],
		});

		expect(responsesToolNames(0)).toContain("get_user_videos");
		expect(responsesToolNames(1).sort()).toEqual([
			"get_user_stats",
			"list_subscriptions",
			"load_skill",
		]);
	});
});
