/**
 * 中立的三把读订阅人的工具:`get_creator_profile` / `get_creator_posts` / `get_creator_stats`。
 * 参数一律叫 `creator`(来源键:外部 id,ADR-0030 决策 1);数据由读口给,这里钉的是入参核对、排版和失败原样喂回。
 */

import { fail, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AiPostView, AiProfileView, AiStatsView, BiliReader, CreatorReader } from "../tools";
import { executeTool, TOOL_DEFINITIONS } from "../tools";
import { sayOf } from "./harness";

function readerWith(over: Partial<CreatorReader>): CreatorReader {
	return {
		subscriptions: () => [],
		externalIdFits: () => true,
		searchCreators: async () => ok({ candidates: [] }),
		profile: async () => fail("not_found", "没订阅"),
		recentPosts: async () => fail("not_found", "没订阅"),
		stats: async () => fail("not_found", "没订阅"),
		...over,
	};
}

const run = (name: string, args: Record<string, string>, reader: CreatorReader | null) =>
	executeTool(name, args, {} as BiliReader, reader);

const STATS: AiStatsView = {
	days: 30,
	followers: 12_345,
	netWindow: 120,
	posts: 9,
	videoPosts: 4,
	liveSessions: 3,
	liveHours: 7.5,
	lastActivityAt: "2026-10-01T08:00:00.000Z",
};

describe("三把工具共有的入参核对", () => {
	it.each(["get_creator_profile", "get_creator_posts", "get_creator_stats"])(
		"%s:creator 缺、切不出来(没有冒号)→ invalid,不去问读口",
		async (name) => {
			const spy = vi.fn();
			const reader = readerWith({ profile: spy, recentPosts: spy, stats: spy });
			const bad: Record<string, string>[] = [
				{},
				{ creator: "" },
				{ creator: "12345" },
				{ creator: "bilibili:" },
			];
			for (const args of bad) {
				expect(await run(name, args, reader)).toMatchObject({ ok: false, code: "invalid" });
			}
			expect(spy).not.toHaveBeenCalled();
		},
	);

	it.each(["get_creator_profile", "get_creator_posts", "get_creator_stats"])(
		"%s:没接读口 → unavailable",
		async (name) => {
			expect(await run(name, { creator: "bilibili:1" }, null)).toMatchObject({
				ok: false,
				code: "unavailable",
			});
		},
	);

	it.each([
		["get_creator_profile", "profile"],
		["get_creator_posts", "recentPosts"],
		["get_creator_stats", "stats"],
	] as const)("%s:读口回的失败(没订阅、总开关关着……)码、话原样喂回", async (name, method) => {
		const reader = readerWith({
			[method]: async () => fail("not_configured", "数据统计没开"),
		});
		expect(await run(name, { creator: "bilibili:1" }, reader)).toEqual({
			ok: false,
			code: "not_configured",
			message: "数据统计没开",
		});
	});

	it("工具表:新三把在,get_user_info / get_user_dynamics 没了;参数叫 creator,不叫 uid", () => {
		const names = TOOL_DEFINITIONS.map((t) => t.function.name);
		expect(names).toEqual(
			expect.arrayContaining(["get_creator_profile", "get_creator_posts", "get_creator_stats"]),
		);
		expect(names).not.toContain("get_user_info");
		expect(names).not.toContain("get_user_dynamics");
		for (const name of ["get_creator_profile", "get_creator_posts", "get_creator_stats"]) {
			const def = TOOL_DEFINITIONS.find((t) => t.function.name === name);
			const params = def?.function.parameters as { properties: object; required?: string[] };
			expect(Object.keys(params.properties)).toContain("creator");
			expect(Object.keys(params.properties)).not.toContain("uid");
			expect(params.required).toContain("creator");
		}
	});
});

describe("get_creator_profile", () => {
	it("creator 原样递给读口;只交名字、粉丝数、简介(没有等级、没有视频数)", async () => {
		const view: AiProfileView = { name: "咩栗", followers: 4567, bio: "你好呀" };
		const profile = vi.fn(async () => ok({ profile: view }));
		const out = await run(
			"get_creator_profile",
			{ creator: "acme:alice" },
			readerWith({ profile }),
		);
		expect(profile).toHaveBeenCalledWith("acme:alice");
		expect(out).toEqual({ ok: true, text: "名称: 咩栗, 粉丝数: 4567, 简介: 你好呀" });
	});

	it("缓存里没有的格不写,简介截到 200 字", async () => {
		const out = await run(
			"get_creator_profile",
			{ creator: "acme:alice" },
			readerWith({ profile: async () => ok({ profile: { name: "咩栗", bio: "长".repeat(300) } }) }),
		);
		expect(sayOf(out)).toBe(`名称: 咩栗, 简介: ${"长".repeat(200)}…`);
	});
});

describe("get_creator_posts", () => {
	const posts: AiPostView[] = [
		{ publishedAt: "2026-10-01T08:00:00.000Z", title: "第一条", summary: "摘要甲" },
		{ publishedAt: "2026-09-30T08:00:00.000Z", summary: "只有摘要" },
		{ publishedAt: "2026-09-29T08:00:00.000Z" },
	];

	it("creator 原样递给读口,要最近 5 条;每条:时间(日期 · 多久前)+ 标题 + 摘要", async () => {
		const recentPosts = vi.fn(async () => ok({ posts }));
		const out = await run(
			"get_creator_posts",
			{ creator: "acme:alice" },
			readerWith({ recentPosts }),
		);
		expect(recentPosts).toHaveBeenCalledWith("acme:alice", 5);
		const lines = sayOf(out).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^1\. \[2026\/10\/1 · \d+ 天前\] 第一条 摘要甲$/);
		expect(lines[1]).toMatch(/^2\. \[2026\/9\/30 · \d+ 天前\] 只有摘要$/);
		expect(lines[2]).toMatch(/^3\. \[2026\/9\/29 · \d+ 天前\] （无文字内容）$/);
	});

	it("一天之内的按小时报", async () => {
		const out = await run(
			"get_creator_posts",
			{ creator: "acme:alice" },
			readerWith({
				recentPosts: async () =>
					ok({
						posts: [
							{
								publishedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
								summary: "今晚八点开播",
							},
						],
					}),
			}),
		);
		expect(sayOf(out)).toContain("5 小时前");
		expect(sayOf(out)).toContain("今晚八点开播");
	});

	it("摘要超过 200 字截断", async () => {
		const out = await run(
			"get_creator_posts",
			{ creator: "acme:alice" },
			readerWith({
				recentPosts: async () =>
					ok({ posts: [{ publishedAt: "2026-10-01T08:00:00.000Z", summary: "长".repeat(300) }] }),
			}),
		);
		expect(sayOf(out)).toContain(`${"长".repeat(200)}…`);
		expect(sayOf(out)).not.toContain("长".repeat(201));
	});

	// 验红:空的时候改回「暂无动态」,这条红。
	it("一条都没有 → 成功,但话说清是 BN 没记到,不说「暂无动态」(没记到不等于没发过)", async () => {
		const out = await run(
			"get_creator_posts",
			{ creator: "acme:alice" },
			readerWith({ recentPosts: async () => ok({ posts: [] }) }),
		);
		expect(out.ok).toBe(true);
		expect(sayOf(out)).toContain("BN 没记到");
		expect(sayOf(out)).not.toContain("暂无动态");
	});
});

describe("get_creator_stats", () => {
	it("days 缺省 30;creator 与 days 递给读口;排版写出各项,没有的格写「没记录」", async () => {
		const stats = vi.fn(async () => ok({ stats: STATS }));
		const out = await run("get_creator_stats", { creator: "acme:alice" }, readerWith({ stats }));
		expect(stats).toHaveBeenCalledWith("acme:alice", 30);
		const text = sayOf(out);
		expect(text).toContain("近 30 天");
		expect(text).toContain("当前粉丝: 12345");
		expect(text).toContain("涨粉: +120");
		expect(text).toContain("作品: 9");
		expect(text).toContain("视频作品: 4");
		expect(text).toContain("直播场次: 3");
		expect(text).toContain("直播时长: 7.5 小时");
		expect(text).toContain("最后活动: 2026/10/1");

		const empty = await run(
			"get_creator_stats",
			{ creator: "acme:alice" },
			readerWith({
				stats: async () =>
					ok({
						stats: {
							days: 30,
							followers: null,
							netWindow: null,
							posts: null,
							videoPosts: null,
							liveSessions: null,
							liveHours: null,
							lastActivityAt: null,
						},
					}),
			}),
		);
		expect(sayOf(empty)).toContain("作品: 没记录");
		expect(sayOf(empty)).toContain("涨粉: 没记录");
		expect(sayOf(empty)).toContain("最后活动: 没记录");
	});

	it.each([
		["0", 1],
		["-5", 1],
		["500", 90],
		["12.7", 12],
		["abc", 30],
		["", 30],
	])("days=%s → 钳到 %i(1 到 90,不是数字回缺省)", async (raw, expected) => {
		const stats = vi.fn(async () => ok({ stats: STATS }));
		await run("get_creator_stats", { creator: "acme:alice", days: raw }, readerWith({ stats }));
		expect(stats).toHaveBeenCalledWith("acme:alice", expected);
	});
});
