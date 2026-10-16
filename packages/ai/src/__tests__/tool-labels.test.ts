/**
 * 工具自带「给人看的标签」,痕迹的 start 事件带着它。
 *
 * 为什么放在服务端这一头:面板从前自己抄了一张「工具名 → 中文」的表,加一把工具就得两头
 * 各配一句,漏了界面上就是一个英文标识符。现在标签跟着工具定义走,一次调用的痕迹自带
 * 「那一行要用的字」:`label`(名字)与 `argText`(小条上补的那一格入参,翻好、规整过的完整文字)。
 *
 * 钉两层:
 *   - 纯函数 `describeToolCall`(按顺序取第一个有值的入参、值的翻译、空白规整、没有就不带);
 *   - 经生成器驱动一次工具调用,`start` 事件带着这两格(核心的一把、注入的一把各一条)。
 */

import { ok } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommentaryGenerator, type ToolTraceEvent } from "../commentary-generator";
import { type AiTool, coreToolLabelOf, describeToolCall } from "../tools";
import { aiConfig, fakeServiceCtx, streamOf, textChunk } from "./harness";

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

describe("describeToolCall", () => {
	it("按 labelArg.keys 的顺序取第一个有值的入参(昵称优先,只有 UID 时退回 UID)", () => {
		const spec = { label: "查看 UP 主资料", labelArg: { keys: ["name", "uid"] } };
		expect(describeToolCall(spec, { name: "咩栗", uid: "1" })).toEqual({
			label: "查看 UP 主资料",
			argText: "咩栗",
		});
		expect(describeToolCall(spec, { name: "  ", uid: "12345" })).toEqual({
			label: "查看 UP 主资料",
			argText: "12345",
		});
	});

	it("值经 labelArg.format 翻成给人看的样子(卡种 live → 直播卡)", () => {
		const spec = {
			label: "看卡片",
			labelArg: {
				keys: ["kind"],
				format: (v: string) => (v === "live" ? "直播卡" : v),
			},
		};
		expect(describeToolCall(spec, { kind: "live" })).toEqual({
			label: "看卡片",
			argText: "直播卡",
		});
	});

	it("空白规整:trim,连续空白(含换行)压成一个空格,不截短", () => {
		const out = describeToolCall(
			{ label: "制作皮肤", labelArg: { keys: ["brief"] } },
			{ brief: " 赛博朋克\n\n  暗色   霓虹，要有很长很长很长很长很长很长很长的一段描述 " },
		);
		expect(out.argText).toBe("赛博朋克 暗色 霓虹，要有很长很长很长很长很长很长很长的一段描述");
	});

	it("入参里挑不出值 / 没有 labelArg → 只有 label,不带 argText 这一格", () => {
		expect(describeToolCall({ label: "查看订阅列表" }, { x: "1" })).toEqual({
			label: "查看订阅列表",
		});
		expect(describeToolCall({ label: "搜索 UP 主", labelArg: { keys: ["keyword"] } }, {})).toEqual({
			label: "搜索 UP 主",
		});
	});

	it("认不出的工具(没有标签)→ 什么都不带,面板回落显示原名", () => {
		expect(describeToolCall(undefined, { uid: "1" })).toEqual({});
	});
});

describe("核心工具的入参格 = 文案表里单独写的格 + 工具定义里 required 的格", () => {
	const argTextOf = (name: string, args: Record<string, string>) =>
		describeToolCall(coreToolLabelOf(name), args).argText;

	it("单独写的格(昵称)优先于必填格(UID)", () => {
		expect(argTextOf("get_user_info", { name: "咩栗", uid: "12345" })).toBe("咩栗");
	});

	it("只有必填格时显示它(没给昵称 → UID)", () => {
		expect(argTextOf("get_user_stats", { uid: "12345" })).toBe("12345");
		expect(argTextOf("search_user", { keyword: "咩栗" })).toBe("咩栗");
		expect(argTextOf("web_search", { query: "b站 新闻" })).toBe("b站 新闻");
		expect(argTextOf("describe_image", { index: "2" })).toBe("2");
	});

	it("两样都没有 → 只有标签,不带 argText", () => {
		expect(describeToolCall(coreToolLabelOf("list_subscriptions"), { x: "1" })).toEqual({
			label: "查看订阅列表",
		});
		expect(describeToolCall(coreToolLabelOf("get_user_info"), {})).toEqual({
			label: "查看 UP 主资料",
		});
	});
});

describe("coreToolLabelOf", () => {
	it("核心自带的几把查得到,表外的名字查不到", () => {
		expect(coreToolLabelOf("get_user_info")).toMatchObject({ label: "查看 UP 主资料" });
		expect(coreToolLabelOf("no_such_tool")).toBeUndefined();
	});
});

describe("工具环发 start 时带着标签", () => {
	const callChunk = (name: string, args: object) => ({
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }],
				},
			},
		],
	});

	function makeGen(): CommentaryGenerator {
		return new CommentaryGenerator({
			serviceCtx: fakeServiceCtx(),
			api: {
				fetchUserCard: async () => ({ code: 0, data: { card: { name: "咩栗", fans: 1 } } }),
			} as never,
			config: aiConfig(),
		});
	}

	async function drive(extra: AiTool[], name: string, args: object) {
		oai.create
			.mockResolvedValueOnce(streamOf([callChunk(name, args)]))
			.mockResolvedValueOnce(streamOf([textChunk("好")]));
		const seen: ToolTraceEvent[] = [];
		await makeGen().chatStatelessStream([{ role: "user", content: "查" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e),
			...(extra.length ? { extraTools: extra } : {}),
		});
		return seen.find((e) => e.phase === "start");
	}

	it("核心的一把:label 取自核心标签表,argText 是翻好的入参", async () => {
		const start = await drive([], "get_user_info", { uid: "12345", name: "咩栗" });
		expect(start).toMatchObject({
			name: "get_user_info",
			label: "查看 UP 主资料",
			argText: "咩栗",
		});
	});

	it("注入的一把:label / argText 取自它自己的 label、labelArg", async () => {
		const tool: AiTool = {
			definition: {
				type: "function",
				function: { name: "make_thing", description: "造", parameters: { type: "object" } },
			},
			label: "造个东西",
			labelArg: { keys: ["brief"] },
			execute: async () => ok({ text: "造好了" }),
		};
		const start = await drive([tool], "make_thing", { brief: "暗色  赛博" });
		expect(start).toMatchObject({ name: "make_thing", label: "造个东西", argText: "暗色 赛博" });
	});

	it("表外的工具(模型编的名字)→ start 不带 label", async () => {
		const start = await drive([], "ghost_tool", {});
		expect(start).toBeDefined();
		expect(start).not.toHaveProperty("label");
		expect(start).not.toHaveProperty("argText");
	});
});
