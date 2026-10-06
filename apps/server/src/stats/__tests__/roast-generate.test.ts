/**
 * 服务端自主生成锐评 —— 不经 HTTP 直接调的那条路。
 *
 * 定时推送没有前端也没有人在场,所有失败都得**带着码和一句人话**:路由直接把它当错误体回
 * (状态码从码推),调度器直接把话私聊给主人。所以这里守的不是「会不会挂」,而是「挂了以后
 * 说得清是哪一种挂法」——「这周的周报没发」后面必须跟得上原因,否则主人对着沉默
 * 猜,正是他刚让女仆修掉的那种体验。
 *
 * 取数是注入的:`/overview` 那个 handler 背着 TTL 缓存和跨 UP 遮罩,这里不碰它。
 */

import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { GlobalDefaults } from "@bilibili-notify/internal";
import {
	EMPTY_AI_PROVIDER_PROFILE,
	FAILURE_CODES,
	makeDefaultGlobalConfig,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RoastGenDeps } from "../roast-generate";
import { generateBoardRoast, generateSoloRoast } from "../roast-generate";

// 显式标注参数,否则 vi.fn 推出空参元组,.mock.calls[0][3] 会触发 TS2493。
const comment = vi.fn(
	async (
		_content: string,
		_scene?: string,
		_imgs?: string[],
		_override?: Record<string, unknown>,
	) => "{}",
);
const setWebSearchSource = vi.fn();

vi.mock("@bilibili-notify/ai", () => ({
	// class 而不是箭头函数 —— 生成服务是 `new CommentaryGenerator(...)`。
	CommentaryGenerator: class {
		comment = comment;
		setWebSearchSource = setWebSearchSource;
	},
	webSearchExecutorFromSettings: () => null,
}));

/** B 站订阅的 id:夹具按 uid 写(好读),订阅 id 取 `sub-<uid>`。 */
const biliId = (uid: string) => `sub-${uid}`;

/** overview 的一行,字段齐全即可,数值不影响分类。行以订阅 id 为键、带着身份(ADR-0020 决策 18)。 */
function row(uid: string) {
	return {
		subscriptionId: biliId(uid),
		identity: { sourceKey: "bilibili", externalId: uid },
		net7d: 1,
		netWindow: 2,
		videoPosts: 3,
		posts: 7,
		liveSessions: 5,
		liveHours: 6,
		lastActivityAt: "2026-08-01T00:00:00.000Z",
	};
}

/** 一条拓展订阅的夹具。`profileName` 是拓展报来的资料里的名字(主人起的别名已退役,ADR-0021 决策 16)。 */
interface ExtFixture {
	id: string;
	extensionId: string;
	externalId: string;
	profileName?: string;
}

/** 拓展订阅在 overview 里的那一行:身份的来源键是拓展 id。 */
function extRow(e: ExtFixture) {
	return {
		...row("x"),
		subscriptionId: e.id,
		identity: { sourceKey: e.extensionId, externalId: e.externalId },
	};
}

/** 装着的拓展清单里的平台名(引擎现取);没装的拓展取不到。 */
const PLATFORM_LABELS: Record<string, string> = { douyin: "抖音" };

/** 测试替身:只填生成路径真正读到的那几个字段,其余靠一次 unknown 断言收口。 */
function makeDeps(uids: string[], aiEnabled = true, exts: ExtFixture[] = []): RoastGenDeps {
	const globals = makeDefaultGlobalConfig();
	globals.defaults.ai = {
		...globals.defaults.ai,
		enabled: aiEnabled,
		provider: "custom",
		// 拿空 profile 打底 —— toGeneratorConfig 会读 vision 等一整套字段,
		// 只填三个键的话它在取 `p.vision.baseUrl` 时就炸了。
		providers: {
			custom: {
				...EMPTY_AI_PROVIDER_PROFILE,
				apiKey: "k",
				baseUrl: "https://example.invalid/v1",
				model: "m",
			},
		},
	} as GlobalDefaults["ai"];
	const profiles = new Map(
		exts.flatMap((e) => (e.profileName ? [[e.id, { name: e.profileName }] as const] : [])),
	);
	return {
		runtime: {
			engines: {
				api: {},
				extensionPlatformLabel: (id: string) => PLATFORM_LABELS[id],
			},
			serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
			subRuntimeStore: { get: (id: string) => ({ cachedProfile: profiles.get(id) }) },
		},
		store: {
			getGlobals: () => globals,
			getSubscriptions: () => [
				...uids.map((uid) => ({
					id: biliId(uid),
					identity: { sourceKey: "bilibili", externalId: uid },
					overrides: {},
				})),
				...exts.map(({ extensionId, externalId, ...e }) => ({
					overrides: {},
					identity: { sourceKey: extensionId, externalId },
					...e,
				})),
			],
		},
	} as unknown as RoastGenDeps;
}

const overviewOf = (uids: string[]) => async () =>
	({ rows: uids.map(row) }) as unknown as StatsOverviewResponse;
const overviewFails = async () => null;

describe("generateBoardRoast — 失败得说得清是哪一种(码 + 话)", () => {
	it("引擎没起来 → unavailable(等一会儿就好)", async () => {
		const deps = makeDeps(["1", "2"]);
		(deps.runtime as { engines: unknown }).engines = null;
		const r = await generateBoardRoast(deps, {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({ ok: false, code: "unavailable", message: "服务尚未就绪,请稍后重试" });
	});

	it("AI 没启用 → not_configured(要主人去开,等是等不好的;不白烧一次取数)", async () => {
		const fetchOverview = vi.fn(overviewOf(["1", "2"]));
		const r = await generateBoardRoast(makeDeps(["1", "2"], false), {
			days: 7,
			tz: 0,
			fetchOverview,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured", message: "智能女仆尚未启用" });
		expect(fetchOverview).not.toHaveBeenCalled();
	});

	it("取数失败 → unavailable", async () => {
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewFails,
		});
		expect(r).toMatchObject({
			ok: false,
			code: "unavailable",
			message: "统计数据读取失败,请稍后重试",
		});
	});

	it("只订阅 1 位 → not_configured(评鸽王要有对照组,先去订阅够 2 位)", async () => {
		const r = await generateBoardRoast(makeDeps(["1"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1"]),
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(!r.ok && r.message).toContain("2 位");
	});

	it("AI 抛错 → unavailable,且原文带着(主人要据此判断是限流还是没配对)", async () => {
		comment.mockRejectedValueOnce(new Error("429 rate limited"));
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(!r.ok && r.message).toContain("429");
	});

	it("AI 抛出来的错没有话可说 → 给一句兜底,不回空 message(错误体的 message 不许为空)", async () => {
		comment.mockRejectedValueOnce(new Error(""));
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(!r.ok && r.message.trim()).not.toBe("");
	});

	it("回复解析不出来 → unavailable(不把半截结构渲染成一张像模像样的卡)", async () => {
		comment.mockResolvedValueOnce("模型今天想聊点别的");
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({
			ok: false,
			code: "unavailable",
			message: "女仆的回复解析失败,请重试",
		});
	});
});

describe("generateSoloRoast — 单人特有的两道闸", () => {
	it("订阅 id 对不上任何订阅 → not_found(不拿空数据去烧 token)", async () => {
		const fetchOverview = vi.fn(overviewOf(["1"]));
		const r = await generateSoloRoast(makeDeps(["1"]), {
			// 恰好是某位 B 站 UP 的 uid 也不算:路由参数是订阅 id,不再认 uid。
			subscriptionId: "1",
			days: 7,
			tz: 0,
			fetchOverview,
		});
		expect(r).toMatchObject({ ok: false, code: "not_found", message: "该 UP 主不在订阅列表里" });
		expect(fetchOverview).not.toHaveBeenCalled();
	});

	it("订阅着但窗口内没数据 → not_found", async () => {
		const r = await generateSoloRoast(makeDeps(["1"]), {
			subscriptionId: biliId("1"),
			days: 7,
			// 订阅里有他,overview 里没有他(比如刚订阅、还没采到）。
			fetchOverview: overviewOf([]),
			tz: 0,
		});
		expect(r).toMatchObject({ ok: false, code: "not_found", message: "该 UP 主暂无统计数据" });
	});

	it("单人没有「至少 2 位」那道闸 —— 只订阅 1 位照样评得出来", async () => {
		comment.mockResolvedValueOnce(
			JSON.stringify({
				verdict: "还行",
				score: 60,
				highlights: [{ label: "更新", comment: "挺勤快" }],
			}),
		);
		const r = await generateSoloRoast(makeDeps(["1"]), {
			subscriptionId: biliId("1"),
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1"]),
		});
		expect(r.ok).toBe(true);
	});
});

describe("失败一律是标准码表里的码,话不空 —— 路由的错误体与调度器的私聊共用这一份", () => {
	/** 把每一种失败都逼出来一次:靠输入造,不靠手写失败对象(手写的话就测不到产生失败的那一处)。 */
	async function everyFailure() {
		const asOffline = (deps: RoastGenDeps) => {
			(deps.runtime as { engines: unknown }).engines = null;
			return deps;
		};
		const args = { days: 7, tz: 0 };
		comment.mockRejectedValueOnce(new Error("boom"));
		const aiError = await generateBoardRoast(makeDeps(["1", "2"]), {
			...args,
			fetchOverview: overviewOf(["1", "2"]),
		});
		comment.mockResolvedValueOnce("不是 JSON");
		const parseFailed = await generateBoardRoast(makeDeps(["1", "2"]), {
			...args,
			fetchOverview: overviewOf(["1", "2"]),
		});
		return [
			await generateBoardRoast(asOffline(makeDeps(["1", "2"])), {
				...args,
				fetchOverview: overviewOf(["1", "2"]),
			}),
			await generateBoardRoast(makeDeps(["1", "2"], false), {
				...args,
				fetchOverview: overviewOf(["1", "2"]),
			}),
			await generateBoardRoast(makeDeps(["1", "2"]), { ...args, fetchOverview: overviewFails }),
			await generateBoardRoast(makeDeps(["1"]), { ...args, fetchOverview: overviewOf(["1"]) }),
			await generateSoloRoast(makeDeps(["1"]), {
				...args,
				subscriptionId: "nope",
				fetchOverview: overviewOf(["1"]),
			}),
			await generateSoloRoast(makeDeps(["1"]), {
				...args,
				subscriptionId: biliId("1"),
				fetchOverview: overviewOf([]),
			}),
			aiError,
			parseFailed,
		];
	}

	it("八种失败都是 { ok: false, code, message }:码在码表里,话不空、不含 undefined", async () => {
		const all = await everyFailure();
		expect(all).toHaveLength(8);
		for (const f of all) {
			expect(f.ok).toBe(false);
			if (f.ok) continue;
			expect(Object.hasOwn(FAILURE_CODES, f.code), `${f.code} 不在码表里`).toBe(true);
			expect(f.message.trim(), `${f.code} 没有话`).not.toBe("");
			expect(f.message).not.toContain("undefined");
			// 失败对象不再带旧的 `kind` 分类,也不带 `err` / `why`:码与话是唯一的原因。
			expect(Object.keys(f).sort()).toEqual(["code", "message", "ok"]);
		}
	});

	it("「没配 / 没开」归 not_configured,「稍后再试」归 unavailable,「查无此人」归 not_found", async () => {
		const codes = (await everyFailure()).map((f) => (f.ok ? "ok" : f.code));
		expect(codes).toEqual([
			"unavailable", // 引擎没起
			"not_configured", // 智能女仆没开
			"unavailable", // 取数失败
			"not_configured", // 订阅不够 2 位
			"not_found", // 订阅 id 对不上
			"not_found", // 窗口内没数据
			"unavailable", // 模型出错
			"unavailable", // 回复读不懂
		]);
	});
});

describe("联网搜索 override(engines.roast)", () => {
	// 下面读的是这一条自己打出去的调用:两个替身是模块级的,别指望跑测的默认替我们清。
	beforeEach(() => {
		comment.mockClear();
		setWebSearchSource.mockClear();
	});

	it("engines.roast 开着 → comment 的 override 带 webSearch:true,且生成器接了搜索源", async () => {
		const deps = makeDeps(["1", "2"]);
		deps.store.getGlobals().defaults.ai.search.engines.roast = true;
		await generateBoardRoast(deps, {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(setWebSearchSource).toHaveBeenCalled();
		expect(comment).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			undefined,
			expect.objectContaining({ webSearch: true }),
		);
	});

	it("默认全关 → override 不带 webSearch(现状不变)", async () => {
		const deps = makeDeps(["1", "2"]);
		await generateBoardRoast(deps, { days: 7, tz: 0, fetchOverview: overviewOf(["1", "2"]) });
		const override = comment.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
		expect(override?.webSearch).toBeUndefined();
	});

	it("单人锐评同样吃 engines.roast,per-UP 覆盖不丢", async () => {
		const deps = makeDeps(["1"]);
		deps.store.getGlobals().defaults.ai.search.engines.roast = true;
		await generateSoloRoast(deps, {
			subscriptionId: biliId("1"),
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1"]),
		});
		expect(comment).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			undefined,
			expect.objectContaining({ webSearch: true }),
		);
	});
});

describe("两支混着比(ADR-0020 决策 12 / 3 / 18)", () => {
	const DY: ExtFixture = {
		id: "ext-dy",
		extensionId: "douyin",
		externalId: "sec-1",
		profileName: "抖音乙",
	};
	const promptOfLastCall = () => String(comment.mock.calls.at(-1)?.[0]);
	const tableOf = (prompt: string) =>
		JSON.parse(prompt.split("\n")[1] ?? "[]") as Array<Record<string, unknown>>;

	it("一位 B 站 + 一位拓展 → 同一张榜:两行都进提示词(平台一列写「B 站」与清单里的平台名),下标按订阅 id 回指", async () => {
		comment.mockResolvedValueOnce(
			JSON.stringify({
				pigeon: { i: 1, reason: "鸽" },
				diligent: { i: 0, reason: "勤" },
				roast: [{ i: 1, comment: "咕" }],
				scores: [
					{ i: 0, score: 90 },
					{ i: 1, score: 10 },
				],
				pushText: "i=1 是鸽王",
			}),
		);
		const r = await generateBoardRoast(makeDeps(["1"], true, [DY]), {
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [row("1"), extRow(DY)] }) as unknown as StatsOverviewResponse,
		});
		expect(r.ok).toBe(true);
		const table = tableOf(promptOfLastCall());
		expect(table.map((t) => [t.名称, t.平台])).toEqual([
			["UID 1", "B 站"],
			["抖音乙", "抖音"],
		]);
		expect(r.ok && r.result.pigeon.subscriptionId).toBe("ext-dy");
		expect(r.ok && r.result.diligent.subscriptionId).toBe(biliId("1"));
		expect(r.ok && r.result.scores.map((x) => x.subscriptionId)).toEqual([biliId("1"), "ext-dy"]);
		// pushText 里的下标换回的是拓展那位的名字。
		expect(r.ok && r.result.pushText).toBe("抖音乙 是鸽王");
	});

	it("两位都是拓展订阅也评得出来 —— 「至少 2 位」数的是两支加起来的人头", async () => {
		comment.mockResolvedValueOnce(
			JSON.stringify({ pigeon: { i: 0, reason: "鸽" }, diligent: { i: 1, reason: "勤" } }),
		);
		const B: ExtFixture = { id: "ext-b", extensionId: "douyin", externalId: "sec-2" };
		const r = await generateBoardRoast(makeDeps([], true, [DY, B]), {
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [extRow(DY), extRow(B)] }) as unknown as StatsOverviewResponse,
		});
		expect(r.ok).toBe(true);
	});

	it("一共只有 1 位(拓展那位)→ 订阅不够 2 位(not_configured)", async () => {
		const calls = comment.mock.calls.length;
		const r = await generateBoardRoast(makeDeps([], true, [DY]), {
			days: 7,
			tz: 0,
			fetchOverview: async () => ({ rows: [extRow(DY)] }) as unknown as StatsOverviewResponse,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(comment.mock.calls.length).toBe(calls);
	});

	it("拓展行的名字链:资料里的名字 → 外部 id(别名已退役,ADR-0021 决策 16);平台名取不到(拓展卸了)写拓展 id", async () => {
		comment.mockResolvedValueOnce(
			JSON.stringify({ pigeon: { i: 0, reason: "鸽" }, diligent: { i: 1, reason: "勤" } }),
		);
		const named: ExtFixture = {
			id: "ext-a",
			extensionId: "douyin",
			externalId: "sec-a",
			profileName: "资料甲",
		};
		const bare: ExtFixture = { id: "ext-z", extensionId: "gone", externalId: "sec-z" };
		await generateBoardRoast(makeDeps([], true, [named, bare]), {
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [extRow(named), extRow(bare)] }) as unknown as StatsOverviewResponse,
		});
		expect(tableOf(promptOfLastCall()).map((t) => [t.名称, t.平台])).toEqual([
			["资料甲", "抖音"],
			["sec-z", "gone"],
		]);
	});

	it("单人锐评按订阅 id 评拓展订阅:数据是它那一行,结果带回它的订阅 id", async () => {
		comment.mockResolvedValueOnce(
			JSON.stringify({ verdict: "还行", score: 60, highlights: [], pushText: "" }),
		);
		const r = await generateSoloRoast(makeDeps(["1"], true, [DY]), {
			subscriptionId: "ext-dy",
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [row("1"), extRow(DY)] }) as unknown as StatsOverviewResponse,
		});
		expect(r.ok && r.result.subscriptionId).toBe("ext-dy");
		const data = JSON.parse(promptOfLastCall().split("\n")[1] ?? "{}") as Record<string, unknown>;
		expect(data.名称).toBe("抖音乙");
		expect(data.平台).toBe("抖音");
	});

	it("拓展订阅外部 id 恰好等于某位 B 站 UP 的 uid 也不串:按订阅 id 找的是它自己那一行", async () => {
		comment.mockResolvedValueOnce(JSON.stringify({ verdict: "还行", score: 60 }));
		const twin: ExtFixture = {
			id: "ext-twin",
			extensionId: "douyin",
			externalId: "1",
			profileName: "抖音同号",
		};
		await generateSoloRoast(makeDeps(["1"], true, [twin]), {
			subscriptionId: "ext-twin",
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [row("1"), extRow(twin)] }) as unknown as StatsOverviewResponse,
		});
		const data = JSON.parse(promptOfLastCall().split("\n")[1] ?? "{}") as Record<string, unknown>;
		expect(data.名称).toBe("抖音同号");
	});
});

describe("overview 行 → 提示词:「投稿」取 videoPosts、「动态」取 posts − videoPosts", () => {
	beforeEach(() => {
		comment.mockClear();
	});
	// 参数是面板上的两个数(投稿 / 动态);行上存的是 videoPosts 与全部作品数 posts。
	const rowWith = (uid: string, videoPosts: number | null, plainPosts: number | null) => ({
		...row(uid),
		videoPosts,
		posts: videoPosts === null || plainPosts === null ? null : videoPosts + plainPosts,
	});
	const dataLine = () => String(comment.mock.calls.at(-1)?.[0]).split("\n")[1] ?? "";

	// 验红:把 roast-generate.ts 的 toRoastInput 里 videoPosts / posts 两行对调取值,本组全红。
	it("榜单:每一行的 投稿 / 动态 各取各的格,null 写「无记录」", async () => {
		await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({
					rows: [rowWith("1", 3, 5), rowWith("2", null, null)],
				}) as unknown as StatsOverviewResponse,
		});
		const table = JSON.parse(dataLine()) as Array<Record<string, unknown>>;
		expect(table.map((t) => [t.投稿, t.动态])).toEqual([
			[3, 5],
			["无记录", "无记录"],
		]);
	});

	it("单人:同样两格", async () => {
		await generateSoloRoast(makeDeps(["1"]), {
			subscriptionId: biliId("1"),
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [rowWith("1", 3, 5)] }) as unknown as StatsOverviewResponse,
		});
		const data = JSON.parse(dataLine()) as Record<string, unknown>;
		expect([data.投稿, data.动态]).toEqual([3, 5]);
	});
});
