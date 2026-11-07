/**
 * 原 `packages/ai` 按 UID 查的两把工具搬到这里,改为按 B 站订阅的 `creator` 查。
 *
 * 报告 #P2:`get_user_stats` 此前只校验 upstat.code,不校验 navnum.code。navnum
 * 接口报错时 navnum.data 为空 → 视频/动态数静默落 "?",把"接口错误"伪装成
 * "数据为空"误导 LLM。修复后 navnum.code !== 0 显式返回失败。
 */
import type { AiTool } from "@bilibili-notify/internal";
import { fail, ok, type Result } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { i18n } from "../../i18n/index.js";
import { skillToolNames } from "../../maid-skills/reader.js";
import { createBiliAiToolProvider } from "../ai-tools.js";
import { makeApi, makeServiceContext } from "../api/__tests__/support/make-api.js";
import type { Api } from "../api/index.js";
import { t } from "../i18n.js";

afterEach(() => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	vi.useRealTimers();
});

function toolOf(tools: readonly AiTool[], name: "get_up_totals" | "get_up_videos"): AiTool {
	const tool = tools.find((candidate) => candidate.definition.function.name === name);
	if (!tool) throw new Error(`缺少工具 ${name}`);
	return tool;
}

function fakeApi(
	over: {
		upstat?: Result<{ data: unknown }>;
		navnum?: Result<{ data: unknown }>;
		videos?: Result<{ data: unknown }>;
	} = {},
) {
	return {
		fetchUserUpstat: vi.fn(async () => over.upstat ?? ok({ data: {} })),
		fetchUserNavnum: vi.fn(async () => over.navnum ?? ok({ data: {} })),
		fetchUserVideos: vi.fn(async () => over.videos ?? ok({ data: { list: { vlist: [] } } })),
	};
}

async function actualApi() {
	const world = await makeApi({ serviceCtx: makeServiceContext().serviceCtx });
	let reply: unknown = { code: 0, message: "0", data: {} };
	vi.spyOn(world.http, "fetch").mockImplementation(((target: string | URL) =>
		Promise.resolve({
			ok: true,
			url: String(target),
			status: 200,
			headers: new Headers(),
			isSuccess: true,
			text: () => JSON.stringify(reply),
		})) as never);
	(
		world.api as unknown as {
			updateBiliTicket(): Promise<void>;
			wbiKeys: { imgKey: string; subKey: string };
		}
	).updateBiliTicket = async () => {
		(
			world.api as unknown as {
				wbiKeys: { imgKey: string; subKey: string };
			}
		).wbiKeys = { imgKey: "a".repeat(32), subKey: "b".repeat(32) };
	};
	return {
		api: world.api,
		answer(body: unknown) {
			reply = body;
		},
	};
}

describe("B 站 AI 工具提供方", () => {
	it("提供 B 站版周报，登记后使用来源前缀的技能名", () => {
		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi() as unknown as Api,
		});
		const weekly = provider.skills?.[0];

		expect(provider.skills).toHaveLength(1);
		expect(weekly).toMatchObject({
			name: "weekly-report",
			description: expect.stringContaining("B 站版"),
			allowedTools: [
				"list_subscriptions",
				"bilibili__get_up_totals",
				"bilibili__get_up_videos",
				"get_creator_posts",
				"get_creator_profile",
			],
		});
		const coreTools = new Set(skillToolNames(createAiToolProviderRegistry()));
		const ownTools = new Set(["bilibili__get_up_totals", "bilibili__get_up_videos"]);
		for (const name of weekly?.allowedTools ?? []) {
			expect(coreTools.has(name) || ownTools.has(name), name).toBe(true);
		}

		const registry = createAiToolProviderRegistry();
		registry.register("bilibili", provider);
		expect(registry.skills().map((skill) => skill.name)).toEqual(["bilibili-weekly-report"]);
	});

	it("登记两把本名工具,累计数据与最近视频的成功文字逐字同今天", async () => {
		const createdAt = Math.floor(Date.parse("2026-10-20T04:00:00Z") / 1000);
		const api = fakeApi({
			upstat: ok({ data: { archive: { view: 12345 }, likes: 678 } }),
			navnum: ok({ data: { video: 42, upos: 99 } }),
			videos: ok({
				data: { list: { vlist: [{ title: "新曲", play: 10, created: createdAt }] } },
			}),
		});
		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: api as unknown as Api,
		});
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-23T04:00:00Z") });

		expect(provider.readOnly.map((tool) => tool.definition.function.name)).toEqual([
			"get_up_totals",
			"get_up_videos",
		]);
		await expect(
			toolOf(provider.readOnly, "get_up_totals").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({
			ok: true,
			text: "总播放量: 12345, 总获赞: 678, 视频数: 42, 动态数: 99",
		});
		await expect(
			toolOf(provider.readOnly, "get_up_videos").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({
			ok: true,
			text: "1. [2026/10/20 · 3 天前] 新曲（播放: 10）",
		});
		expect(api.fetchUserUpstat).toHaveBeenCalledWith("123");
		expect(api.fetchUserNavnum).toHaveBeenCalledWith("123");
		expect(api.fetchUserVideos).toHaveBeenCalledWith("123");
	});

	it("两个累计接口各自失败都原样带标准码、原码与原话;视频空列表仍是成功", async () => {
		const navnum = fail("unknown", "啥也没有", { upstreamCode: -404 });
		const failing = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi({
				upstat: ok({ data: { archive: { view: 100 }, likes: 9 } }),
				navnum,
			}) as unknown as Api,
		});
		await expect(
			toolOf(failing.readOnly, "get_up_totals").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({
			ok: false,
			code: "unknown",
			message: "获取数据失败: 啥也没有",
			upstreamCode: -404,
		});

		const upstat = fail("unauthorized", "登录过期", { upstreamCode: -101 });
		const failingUpstat = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi({
				upstat,
				navnum: ok({ data: { video: 1, upos: 2 } }),
			}) as unknown as Api,
		});
		await expect(
			toolOf(failingUpstat.readOnly, "get_up_totals").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({
			ok: false,
			code: "unauthorized",
			message: "获取数据失败: 登录过期",
			upstreamCode: -101,
		});

		const failingVideos = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi({
				videos: fail("unknown", "服务异常", { upstreamCode: -500 }),
			}) as unknown as Api,
		});
		await expect(
			toolOf(failingVideos.readOnly, "get_up_videos").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({
			ok: false,
			code: "unknown",
			message: "获取视频失败: 服务异常",
			upstreamCode: -500,
		});

		const empty = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi({
				videos: ok({ data: { list: { vlist: [] } } }),
			}) as unknown as Api,
		});
		await expect(
			toolOf(empty.readOnly, "get_up_videos").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({ ok: true, text: "暂无投稿视频" });
	});

	it("-412 / -101 / 表外码按请求层的翻译表回标准码,话保留获取失败前缀", async () => {
		const cases = [
			[-412, "rate_limited"],
			[-101, "unauthorized"],
			[-403, "unknown"],
		] as const;
		for (const [upstreamCode, code] of cases) {
			const world = await actualApi();
			world.answer({ code: upstreamCode, message: "B 站原话" });
			const provider = createBiliAiToolProvider({
				context: { timezone: () => "Asia/Shanghai" },
				api: world.api,
			});

			await expect(
				toolOf(provider.readOnly, "get_up_totals").execute({ creator: "bilibili:123" }),
			).resolves.toEqual({
				ok: false,
				code,
				message: "获取数据失败: B 站原话",
				upstreamCode,
			});
		}
	});

	it("视频接口持续 -352 回 rate_limited,不把风控当未知失败", async () => {
		const world = await actualApi();
		world.answer({ code: -352, message: "风控持续" });
		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: world.api,
		});

		const out = await toolOf(provider.readOnly, "get_up_videos").execute({
			creator: "bilibili:123",
		});
		expect(out).toMatchObject({
			ok: false,
			code: "rate_limited",
			upstreamCode: -352,
		});
		if (!out.ok) expect(out.message).toMatch(/^获取视频失败:/);
	});

	it("只收 B 站订阅的 creator;别家来源、坏外部 id、缺省都不去问 B 站", async () => {
		const api = fakeApi();
		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: api as unknown as Api,
		});

		for (const [toolName, creator] of [
			["get_up_totals", "acme.inprocess:123"],
			["get_up_totals", "bilibili:abc"],
			["get_up_totals", undefined],
			["get_up_videos", "acme.inprocess:123"],
			["get_up_videos", "bilibili:abc"],
			["get_up_videos", undefined],
		] as const) {
			const out = await toolOf(provider.readOnly, toolName).execute(
				creator === undefined ? {} : { creator },
			);
			expect(out).toEqual({
				ok: false,
				code: "invalid",
				message: `「${creator ?? ""}」不是 B 站订阅的 creator（要写成 bilibili:纯数字 UID）；这两把工具只查 B 站订阅。`,
			});
		}
		expect(api.fetchUserUpstat).not.toHaveBeenCalled();
		expect(api.fetchUserNavnum).not.toHaveBeenCalled();
		expect(api.fetchUserVideos).not.toHaveBeenCalled();
	});

	it("label 是 getter,现取字典那一格;labelArg 从 creator 里取外部 id", () => {
		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi() as unknown as Api,
		});
		const totals = toolOf(provider.readOnly, "get_up_totals");
		const videos = toolOf(provider.readOnly, "get_up_videos");

		expect(totals.label).toBe(t("bilibili.aiTools.upTotals"));
		expect(videos.label).toBe(t("bilibili.aiTools.upVideos"));
		expect(totals.label).toBe("查看数据概览");
		expect(videos.label).toBe("查看最近视频");
		expect(totals.labelArg?.format?.("bilibili:123")).toBe("123");
		expect(videos.labelArg?.format?.("bilibili:456")).toBe("456");
		expect(totals.labelArg?.format?.("malformed")).toBe("malformed");
	});

	it("时间戳缺失写「未知时间」,不拼出 Invalid Date / NaN", async () => {
		// 发布时间带「距今多久」:模型手上没有当前时间,只给裸日期只能靠猜。
		const provider = createBiliAiToolProvider({
			context: { timezone: () => "Asia/Shanghai" },
			api: fakeApi({
				videos: ok({ data: { list: { vlist: [{ title: "旧作", play: 1 }] } } }),
			}) as unknown as Api,
		});

		await expect(
			toolOf(provider.readOnly, "get_up_videos").execute({ creator: "bilibili:123" }),
		).resolves.toEqual({
			ok: true,
			text: "1. [未知时间] 旧作（播放: 1）",
		});
	});
});

it("视频请求pending期间改共同ctx时区,返回后现取日期且经过时长不变", async () => {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T00:30:00Z") });
	let timezone = "Asia/Shanghai";
	let finish!: (result: ReturnType<typeof ok<{ data: unknown }>>) => void;
	const api = fakeApi();
	api.fetchUserVideos.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const provider = createBiliAiToolProvider({
		api: api as unknown as Api,
		context: { timezone: () => timezone },
	});
	const videos = toolOf(provider.readOnly, "get_up_videos");
	const pending = videos.execute({ creator: "bilibili:123" });
	timezone = "UTC";
	finish(
		ok({
			data: {
				list: {
					vlist: [{ created: Date.parse("2026-10-20T23:30:00Z") / 1000, title: "test", play: 10 }],
				},
			},
		}),
	);
	await expect(pending).resolves.toEqual({
		ok: true,
		text: "1. [2026/10/20 · 1 天前] test（播放: 10）",
	});
	timezone = "Asia/Shanghai";
	const again = videos.execute({ creator: "bilibili:123" });
	finish(
		ok({
			data: {
				list: {
					vlist: [{ created: Date.parse("2026-10-20T23:30:00Z") / 1000, title: "test", play: 10 }],
				},
			},
		}),
	);
	await expect(again).resolves.toEqual({
		ok: true,
		text: "1. [2026/10/21 · 1 天前] test（播放: 10）",
	});
});
