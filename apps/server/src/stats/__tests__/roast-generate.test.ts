/**
 * 服务端自主生成锐评 —— 不经 HTTP 直接调的那条路。
 *
 * 定时推送没有前端也没有人在场,所有失败都得**能被分类**:路由要把它转成状态码,
 * 调度器要把它转成私聊里的一句人话。所以这里守的不是「会不会挂」,而是「挂了以后
 * 说得清是哪一种挂法」——「这周的周报没发」后面必须跟得上原因,否则主人对着沉默
 * 猜,正是他刚让女仆修掉的那种体验。
 *
 * 取数是注入的:`/overview` 那个 handler 背着 TTL 缓存和跨 UP 遮罩,这里不碰它。
 */

import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { GlobalDefaults } from "@bilibili-notify/internal";
import { EMPTY_AI_PROVIDER_PROFILE, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { RoastGenDeps, RoastGenError } from "../roast-generate";
import {
	generateBoardRoast,
	generateSoloRoast,
	roastGenErrorStatus,
	roastGenErrorText,
} from "../roast-generate";

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
		uid,
		net7d: 1,
		netWindow: 2,
		archives: 3,
		dynamics: 4,
		liveSessions: 5,
		liveHours: 6,
		lastActivityAt: "2026-08-01T00:00:00.000Z",
	};
}

/** 一条拓展订阅的夹具。`profileName` 是拓展报来的资料里的名字,`name` 是主人起的别名。 */
interface ExtFixture {
	id: string;
	extensionId: string;
	externalId: string;
	name?: string;
	profileName?: string;
}

/** 拓展订阅在 overview 里的那一行:不带 uid,带拓展 id + 外部 id。 */
function extRow(e: ExtFixture) {
	const { uid: _uid, ...rest } = row("x");
	return {
		...rest,
		subscriptionId: e.id,
		extensionId: e.extensionId,
		externalId: e.externalId,
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
				...uids.map((uid) => ({ kind: "bilibili", id: biliId(uid), uid, overrides: {} })),
				...exts.map((e) => ({ kind: "extension", overrides: {}, ...e })),
			],
		},
	} as unknown as RoastGenDeps;
}

const overviewOf = (uids: string[]) => async () =>
	({ rows: uids.map(row) }) as unknown as StatsOverviewResponse;
const overviewFails = async () => null;

describe("generateBoardRoast — 失败得说得清是哪一种", () => {
	it("引擎没起来 → not-ready", async () => {
		const deps = makeDeps(["1", "2"]);
		(deps.runtime as { engines: unknown }).engines = null;
		const r = await generateBoardRoast(deps, {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({ ok: false, kind: "not-ready" });
	});

	it("AI 没启用 → ai-disabled(不白烧一次取数)", async () => {
		const fetchOverview = vi.fn(overviewOf(["1", "2"]));
		const r = await generateBoardRoast(makeDeps(["1", "2"], false), {
			days: 7,
			tz: 0,
			fetchOverview,
		});
		expect(r).toMatchObject({ ok: false, kind: "ai-disabled" });
		expect(fetchOverview).not.toHaveBeenCalled();
	});

	it("取数失败 → overview-failed", async () => {
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewFails,
		});
		expect(r).toMatchObject({ ok: false, kind: "overview-failed" });
	});

	it("只订阅 1 位 → too-few-ups(评鸽王要有对照组)", async () => {
		const r = await generateBoardRoast(makeDeps(["1"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1"]),
		});
		expect(r).toMatchObject({ ok: false, kind: "too-few-ups" });
	});

	it("AI 抛错 → ai-error,且原文带着(主人要据此判断是限流还是没配对)", async () => {
		comment.mockRejectedValueOnce(new Error("429 rate limited"));
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({ ok: false, kind: "ai-error" });
		expect(r.ok === false && r.kind === "ai-error" && r.message).toContain("429");
	});

	it("回复解析不出来 → parse-failed(不把半截结构渲染成一张像模像样的卡)", async () => {
		comment.mockResolvedValueOnce("模型今天想聊点别的");
		const r = await generateBoardRoast(makeDeps(["1", "2"]), {
			days: 7,
			tz: 0,
			fetchOverview: overviewOf(["1", "2"]),
		});
		expect(r).toMatchObject({ ok: false, kind: "parse-failed" });
	});
});

describe("generateSoloRoast — 单人特有的两道闸", () => {
	it("订阅 id 对不上任何订阅 → not-subscribed(不拿空数据去烧 token)", async () => {
		const fetchOverview = vi.fn(overviewOf(["1"]));
		const r = await generateSoloRoast(makeDeps(["1"]), {
			// 恰好是某位 B 站 UP 的 uid 也不算:路由参数是订阅 id,不再认 uid。
			subscriptionId: "1",
			days: 7,
			tz: 0,
			fetchOverview,
		});
		expect(r).toMatchObject({ ok: false, kind: "not-subscribed" });
		expect(fetchOverview).not.toHaveBeenCalled();
	});

	it("订阅着但窗口内没数据 → no-data", async () => {
		const r = await generateSoloRoast(makeDeps(["1"]), {
			subscriptionId: biliId("1"),
			days: 7,
			// 订阅里有他,overview 里没有他(比如刚订阅、还没采到）。
			fetchOverview: overviewOf([]),
			tz: 0,
		});
		expect(r).toMatchObject({ ok: false, kind: "no-data" });
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

describe("失败分类 → 人话与状态码", () => {
	const ALL: RoastGenError[] = [
		{ kind: "not-ready" },
		{ kind: "ai-disabled" },
		{ kind: "overview-failed" },
		{ kind: "too-few-ups" },
		{ kind: "not-subscribed" },
		{ kind: "no-data" },
		{ kind: "ai-error", message: "boom" },
		{ kind: "parse-failed" },
	];

	it("每一种都有话可说 —— 私聊里不能出现空字符串或 undefined", () => {
		for (const e of ALL) {
			const text = roastGenErrorText(e);
			expect(text, `${e.kind} 没有文案`).toBeTruthy();
			expect(text).not.toContain("undefined");
		}
	});

	it("每一种都映射到一个真实状态码", () => {
		for (const e of ALL) {
			expect([400, 404, 500, 502, 503], `${e.kind} 的状态码不对`).toContain(roastGenErrorStatus(e));
		}
	});

	it("ai-error 把模型原文透出去,而不是笼统一句「生成失败」", () => {
		expect(roastGenErrorText({ kind: "ai-error", message: "429 rate limited" })).toContain("429");
	});
});

describe("联网搜索 override(engines.roast)", () => {
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

	it("一共只有 1 位(拓展那位)→ too-few-ups", async () => {
		const calls = comment.mock.calls.length;
		const r = await generateBoardRoast(makeDeps([], true, [DY]), {
			days: 7,
			tz: 0,
			fetchOverview: async () => ({ rows: [extRow(DY)] }) as unknown as StatsOverviewResponse,
		});
		expect(r).toMatchObject({ ok: false, kind: "too-few-ups" });
		expect(comment.mock.calls.length).toBe(calls);
	});

	it("拓展行的名字链:资料里的名字 → 主人起的别名 → 外部 id;平台名取不到(拓展卸了)写拓展 id", async () => {
		comment.mockResolvedValueOnce(
			JSON.stringify({ pigeon: { i: 0, reason: "鸽" }, diligent: { i: 1, reason: "勤" } }),
		);
		const aliased: ExtFixture = {
			id: "ext-a",
			extensionId: "douyin",
			externalId: "sec-a",
			name: "别名甲",
		};
		const bare: ExtFixture = { id: "ext-z", extensionId: "gone", externalId: "sec-z" };
		await generateBoardRoast(makeDeps([], true, [aliased, bare]), {
			days: 7,
			tz: 0,
			fetchOverview: async () =>
				({ rows: [extRow(aliased), extRow(bare)] }) as unknown as StatsOverviewResponse,
		});
		expect(tableOf(promptOfLastCall()).map((t) => [t.名称, t.平台])).toEqual([
			["别名甲", "抖音"],
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
