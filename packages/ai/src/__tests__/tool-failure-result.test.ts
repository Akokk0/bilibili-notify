/**
 * 核心自带的工具按**结果形状**返回 —— 失败是 `fail(码, 话)`,不是一句「获取…失败: …」的字符串。
 *
 * 为什么要紧:从前 `executeTool` 一律返回字符串,接口出错也只是返回一句话,于是调用它的
 * 生成器把它记成成功,面板上工具那一格是勾。两层各钉一条:
 *   - `executeTool` 的公开口:每把工具在接口回错时返回的是失败(码与 `upstreamCode` 写死),
 *     成功时给模型看的文字与改形状之前逐字相同;
 *   - 生成器的公开口(`chatStatelessStream`):失败的工具调用在痕迹里记成失败并带上那句话,
 *     同一句话照旧作为工具输出喂回给模型,对话照常继续。
 *
 * 这里**不** mock `../tools` —— 要的就是真 `executeTool` 与真生成器连在一起的行为;模型是假的。
 */

import { ok } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommentaryGenerator, type ToolTraceEvent } from "../commentary-generator";
import { type BiliReader, type CreatorReader, executeTool } from "../tools";
import { aiConfig, fakeServiceCtx, readerStubs, streamOf, textChunk } from "./harness";

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

/** 读口替身:B 站只收纯数字的外部 id(照描述符声明的格式)。 */
const SUBS: CreatorReader = {
	subscriptions: () => [
		{ creator: "bilibili:111", name: "小绫", platform: "B 站", post: true, live: true },
	],
	externalIdFits: (sourceKey, externalId) =>
		sourceKey === "bilibili" ? /^\d+$/.test(externalId) : true,
	...readerStubs,
};

/** 只给被测那把工具要用的方法;别的方法没人该碰,碰了就炸。 */
function apiOf(over: Partial<Record<keyof BiliReader, unknown>>): BiliReader {
	const stub = (name: string) =>
		vi.fn(async () => {
			throw new Error(`不该调用 ${name}`);
		});
	return {
		fetchUserUpstat: stub("fetchUserUpstat"),
		fetchUserNavnum: stub("fetchUserNavnum"),
		fetchUserVideos: stub("fetchUserVideos"),
		...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, vi.fn(async () => v)] as const)),
	} as unknown as BiliReader;
}

const run = (name: string, args: Record<string, string>, api: BiliReader, reader = SUBS) =>
	executeTool(name, args, api, reader);

describe("executeTool —— 接口回了错 → 失败(码 unavailable,B 站的码放 upstreamCode)", () => {
	it("get_user_stats(两个接口各错一次,upstreamCode 取出错的那个)", async () => {
		const upstatBad = await run(
			"get_user_stats",
			{ uid: "111" },
			apiOf({
				fetchUserUpstat: { code: -403, message: "权限不足" },
				fetchUserNavnum: { code: 0, data: { video: 5, upos: 3 } },
			}),
		);
		expect(upstatBad).toEqual({
			ok: false,
			code: "unavailable",
			message: "获取数据失败: 权限不足",
			upstreamCode: -403,
		});
		const navnumBad = await run(
			"get_user_stats",
			{ uid: "111" },
			apiOf({
				fetchUserUpstat: { code: 0, data: { archive: { view: 1 }, likes: 1 } },
				fetchUserNavnum: { code: -404, message: "啥也没有" },
			}),
		);
		expect(navnumBad).toEqual({
			ok: false,
			code: "unavailable",
			message: "获取数据失败: 啥也没有",
			upstreamCode: -404,
		});
	});

	it("get_user_videos", async () => {
		const out = await run(
			"get_user_videos",
			{ uid: "111" },
			apiOf({ fetchUserVideos: { code: -500, message: "服务异常" } }),
		);
		expect(out).toEqual({
			ok: false,
			code: "unavailable",
			message: "获取视频失败: 服务异常",
			upstreamCode: -500,
		});
	});
});

describe("executeTool —— 不是接口的错,但调用本身就不成立 → 失败", () => {
	it("未知工具 → not_found", async () => {
		expect(await run("subscribe_user", { uid: "1" }, apiOf({}))).toEqual({
			ok: false,
			code: "not_found",
			message: "未知工具: subscribe_user",
		});
	});

	it("按 UID 查的工具收到的 uid 不合 B 站声明的外部 id 格式 → invalid,不去问 B 站", async () => {
		const api = apiOf({});
		const out = await run("get_user_videos", { uid: "sec-uid-1" }, api);
		expect(out).toEqual({
			ok: false,
			code: "invalid",
			message:
				"「sec-uid-1」不是 B 站 UID 的格式 —— 这把工具只查 B 站用户，uid 只传订阅列表里 B 站 creator 冒号后面的那一段",
		});
		expect(api.fetchUserVideos).not.toHaveBeenCalled();
	});

	it("describe_image:没有图 → unavailable;序号不对 → invalid;副模型抛错 → unavailable", async () => {
		const api = apiOf({});
		expect(await run("describe_image", { index: "1" }, api)).toEqual({
			ok: false,
			code: "unavailable",
			message: "看图功能当前不可用（没有配置视觉模型，或本条消息没有图片）",
		});
		const ctx = { images: ["data:image/png;base64,AA"], describe: vi.fn(async () => "一只猫") };
		expect(await executeTool("describe_image", { index: "2" }, api, null, ctx)).toEqual({
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
		expect(await executeTool("describe_image", { index: "1" }, api, null, broken)).toEqual({
			ok: false,
			code: "unavailable",
			message: "看图失败: 副模型挂了",
		});
	});
});

describe("executeTool —— 成功与「查了、没有」仍是成功,给模型看的文字逐字不变", () => {
	it("get_user_stats 成功", async () => {
		const out = await run(
			"get_user_stats",
			{ uid: "111" },
			apiOf({
				fetchUserUpstat: { code: 0, data: { archive: { view: 12345 }, likes: 678 } },
				fetchUserNavnum: { code: 0, data: { video: 42, upos: 99 } },
			}),
		);
		expect(out).toEqual({
			ok: true,
			text: "总播放量: 12345, 总获赞: 678, 视频数: 42, 动态数: 99",
		});
	});

	it("list_subscriptions:有订阅、没订阅都是成功", async () => {
		expect(await run("list_subscriptions", {}, apiOf({}))).toEqual({
			ok: true,
			text: "小绫（B 站 · creator: bilibili:111）动态:✓ 直播:✓",
		});
		expect(await executeTool("list_subscriptions", {}, apiOf({}), null)).toEqual({
			ok: true,
			text: "当前没有订阅",
		});
	});

	it("查了、没有:暂无投稿视频 / 没有找到相关用户 → 成功", async () => {
		expect(
			await run(
				"get_user_videos",
				{ uid: "111" },
				apiOf({ fetchUserVideos: { code: 0, data: { list: { vlist: [] } } } }),
			),
		).toEqual({ ok: true, text: "暂无投稿视频" });
		expect(
			await run("search_creators", { source: "bilibili", query: "没这个人" }, apiOf({}), {
				...SUBS,
				searchCreators: async () => ok({ candidates: [] }),
			}),
		).toEqual({ ok: true, text: "没有找到相关用户" });
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

	function makeGen(api: BiliReader): CommentaryGenerator {
		return new CommentaryGenerator({
			serviceCtx: fakeServiceCtx(),
			api,
			config: aiConfig(),
		});
	}

	async function drive(gen: CommentaryGenerator, name: string, args: object) {
		oai.create
			.mockResolvedValueOnce(streamOf([toolChunk(name, args)]))
			.mockResolvedValueOnce(streamOf([textChunk("好的主人")]));
		const seen: ToolTraceEvent[] = [];
		const answer = await gen.chatStatelessStream([{ role: "user", content: "帮我查" }], {
			onDelta: () => {},
			onToolEvent: (e) => seen.push(e),
		});
		return { seen, answer };
	}

	/** 第二次请求里回给模型的那条工具消息。 */
	function toolMessageFedBack(): string {
		const params = oai.create.mock.calls[1]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		const msg = params.messages.find((m) => m.role === "tool");
		if (!msg) throw new Error("第二次请求里没有工具消息");
		return msg.content;
	}

	it("接口回错 → end 是失败并带那句话;同一句话喂回给模型;对话继续到有回答", async () => {
		const gen = makeGen(apiOf({ fetchUserVideos: { code: -412, message: "请求被拦截" } }));

		const { seen, answer } = await drive(gen, "get_user_videos", { uid: "111" });

		expect(seen.find((e) => e.phase === "end")).toMatchObject({
			ok: false,
			message: "获取视频失败: 请求被拦截",
		});
		expect(toolMessageFedBack()).toBe("获取视频失败: 请求被拦截");
		expect(answer).toBe("好的主人");
	});

	it("「查了、没有」仍记成功(没订阅)", async () => {
		const gen = makeGen(apiOf({}));

		const { seen } = await drive(gen, "list_subscriptions", {});

		expect(seen.find((e) => e.phase === "end")).toMatchObject({ ok: true });
		expect(toolMessageFedBack()).toBe("当前没有订阅");
	});

	it("工具抛错仍记失败(原有路径保留),话是「工具执行失败: …」", async () => {
		const gen = makeGen(
			// 这台 api 的 fetchUserVideos 直接抛 —— 抛错只留给 bug,宿主在边界接住。
			{
				...apiOf({}),
				fetchUserVideos: async () => {
					throw new Error("连不上");
				},
			} as BiliReader,
		);

		const { seen, answer } = await drive(gen, "get_user_videos", { uid: "111" });

		expect(seen.find((e) => e.phase === "end")).toMatchObject({
			ok: false,
			message: "工具执行失败: 连不上",
		});
		expect(toolMessageFedBack()).toBe("工具执行失败: 连不上");
		expect(answer).toBe("好的主人");
	});
});
