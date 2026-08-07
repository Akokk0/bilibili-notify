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

const comment = vi.fn(async () => "{}");

vi.mock("@bilibili-notify/ai", () => ({
	// class 而不是箭头函数 —— 生成服务是 `new CommentaryGenerator(...)`。
	CommentaryGenerator: class {
		comment = comment;
	},
}));

/** overview 的一行,字段齐全即可,数值不影响分类。 */
function row(uid: string) {
	return {
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

/** 测试替身:只填生成路径真正读到的那几个字段,其余靠一次 unknown 断言收口。 */
function makeDeps(uids: string[], aiEnabled = true): RoastGenDeps {
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
	return {
		runtime: {
			engines: { api: {} },
			serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
			subRuntimeStore: { get: () => undefined },
		},
		store: {
			getGlobals: () => globals,
			getSubscriptions: () => uids.map((uid, i) => ({ id: `sub-${i}`, uid, overrides: {} })),
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
	it("uid 不在订阅列表里 → not-subscribed(不拿空数据去烧 token)", async () => {
		const fetchOverview = vi.fn(overviewOf(["1"]));
		const r = await generateSoloRoast(makeDeps(["1"]), {
			uid: "999",
			days: 7,
			tz: 0,
			fetchOverview,
		});
		expect(r).toMatchObject({ ok: false, kind: "not-subscribed" });
		expect(fetchOverview).not.toHaveBeenCalled();
	});

	it("订阅着但窗口内没数据 → no-data", async () => {
		const r = await generateSoloRoast(makeDeps(["1"]), {
			uid: "1",
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
			uid: "1",
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
