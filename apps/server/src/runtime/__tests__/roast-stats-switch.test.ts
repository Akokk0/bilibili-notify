/**
 * **关着数据统计时不生成锐评**(ADR-0027 决策 9;㉙a)。
 *
 * 锐评只读统计,数据停更还去评旧数据没有意义。手动的(榜单、单人)回一个明确的失败 ——
 * 形状与错误码照「女仆 AI 关着」那一支(`not_configured`),话是「数据统计已关闭,开启后才能锐评」;
 * 定时的到点不生成,走它现有的「生成失败私聊主人原话」那条路告诉主人同一句。三条路都**不调模型**。
 *
 * 这里不 mock 生成函数(调度器那份测试 mock 了它):调度器 → 真的 `generateBoardRoast` / `generateSoloRoast`。
 */

import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import { EMPTY_AI_PROVIDER_PROFILE, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { generateBoardRoast, generateSoloRoast } from "../../stats/roast-generate.js";
import { createRoastScheduler } from "../roast-scheduler.js";

const comment = vi.fn(async () => "{}");

vi.mock("@bilibili-notify/ai", async (importOriginal) => ({
	// 叫法常量与渲染函数走真的(锐评提示词要用),只顶掉生成器。
	...(await importOriginal<typeof import("@bilibili-notify/ai")>()),
	CommentaryGenerator: class {
		comment = comment;
		setWebSearchSource = vi.fn();
	},
	webSearchExecutorFromSettings: () => null,
}));

const STATS_OFF_MESSAGE = "数据统计已关闭,开启后才能锐评";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeGlobals(statsEnabled: boolean) {
	const globals = makeDefaultGlobalConfig();
	globals.stats.enabled = statsEnabled;
	globals.ai = {
		...globals.ai,
		enabled: true,
		provider: "custom",
		providers: {
			custom: {
				...EMPTY_AI_PROVIDER_PROFILE,
				apiKey: "k",
				baseUrl: "https://example.invalid/v1",
				model: "m",
			},
		},
	} as never;
	globals.roastSchedule = {
		...globals.roastSchedule,
		enabled: true,
		targets: ["t1"],
		notifyOnError: true,
	};
	return globals;
}

const SUBS = ["1", "2"].map((uid) => ({
	id: `sub-${uid}`,
	identity: { sourceKey: "bilibili", externalId: uid },
	overrides: {},
	roastSchedule: {
		enabled: true,
		cron: "0 9 * * 2",
		days: 7,
		targets: ["t1"],
		approval: false,
		notifyOnError: true,
	},
}));

const row = (uid: string) => ({
	subscriptionId: `sub-${uid}`,
	identity: { sourceKey: "bilibili", externalId: uid },
	net7d: 1,
	netWindow: 2,
	videoPosts: 3,
	posts: 7,
	liveSessions: 5,
	liveHours: 6,
	lastActivityAt: "2026-08-01T00:00:00.000Z",
});
const fetchOverview = vi.fn(
	async () => ({ days: 7, rows: ["1", "2"].map(row) }) as unknown as StatsOverviewResponse,
);

function makeDeps(statsEnabled: boolean) {
	const globals = makeGlobals(statsEnabled);
	return {
		globals,
		deps: {
			runtime: {
				pipeline: { api: {}, imageRenderer: null, push: {} },
				serviceCtx: { logger, setTimeout: () => ({ dispose() {} }), track: vi.fn() },
				subscriptionStateStore: { get: () => undefined },
				// 「平台」一列读来源登记表的 label。
				sourceRegistry: {
					get: (key: string) =>
						key === "bilibili" ? { descriptor: { label: "B 站" } } : undefined,
				},
			},
			store: {
				getGlobals: () => globals,
				getSubscriptions: () => SUBS,
				getTargets: () => [{ id: "t1", enabled: true, connectionId: "a1" }],
				getConnections: () => [{ id: "a1", enabled: true }],
			},
		} as never,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("锐评 × 数据统计总开关", () => {
	it("对照:统计开着时榜单锐评会去调模型(这条不调就说明下面的「没调」是空绿)", async () => {
		const { deps } = makeDeps(true);
		await generateBoardRoast(deps, { days: 7, tz: 0, fetchOverview });
		expect(comment).toHaveBeenCalledTimes(1);
	});

	it("手动榜单:关着 → not_configured + 那句话,不调模型、不去取数", async () => {
		const { deps } = makeDeps(false);
		const r = await generateBoardRoast(deps, { days: 7, tz: 0, fetchOverview });
		expect(r).toMatchObject({ ok: false, code: "not_configured", message: STATS_OFF_MESSAGE });
		expect(comment).not.toHaveBeenCalled();
		expect(fetchOverview).not.toHaveBeenCalled();
	});

	it("手动单人:关着 → 同一个码、同一句话,不调模型", async () => {
		const { deps } = makeDeps(false);
		const r = await generateSoloRoast(deps, {
			subscriptionId: "sub-1",
			days: 7,
			tz: 0,
			fetchOverview,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured", message: STATS_OFF_MESSAGE });
		expect(comment).not.toHaveBeenCalled();
	});

	it("热更新:同一份依赖,关着时拒、打开后下一次就能生成", async () => {
		const { deps, globals } = makeDeps(false);
		expect(await generateBoardRoast(deps, { days: 7, tz: 0, fetchOverview })).toMatchObject({
			ok: false,
		});
		globals.stats.enabled = true;
		await generateBoardRoast(deps, { days: 7, tz: 0, fetchOverview });
		expect(comment).toHaveBeenCalledTimes(1);
	});

	describe("定时(调度器 → 真的生成函数)", () => {
		function makeScheduler(statsEnabled: boolean) {
			const { deps } = makeDeps(statsEnabled);
			const tellMaster = vi.fn(async (_text: string) => {});
			const sched = createRoastScheduler({
				deps,
				drafts: {} as never,
				logger: logger as never,
				fetchOverview,
				tellMaster,
				tellMasterPayload: vi.fn(async () => {}),
			});
			return { sched, tellMaster };
		}

		it("榜单到点:关着不生成,私聊主人同一句话", async () => {
			const { sched, tellMaster } = makeScheduler(false);
			const outcome = await sched.runBoardOnce();
			expect(outcome).toMatchObject({
				kind: "gen-failed",
				code: "not_configured",
				message: STATS_OFF_MESSAGE,
			});
			expect(comment).not.toHaveBeenCalled();
			expect(tellMaster).toHaveBeenCalledTimes(1);
			expect(String(tellMaster.mock.calls[0]?.[0])).toContain(STATS_OFF_MESSAGE);
		});

		it("单人到点:关着不生成,私聊主人同一句话", async () => {
			const { sched, tellMaster } = makeScheduler(false);
			const outcome = await sched.runSoloOnce("sub-1");
			expect(outcome).toMatchObject({ kind: "gen-failed", message: STATS_OFF_MESSAGE });
			expect(comment).not.toHaveBeenCalled();
			expect(String(tellMaster.mock.calls[0]?.[0])).toContain(STATS_OFF_MESSAGE);
		});

		it("定时锐评的设置不动:关着统计不会把 roastSchedule 关掉", () => {
			const { globals } = makeDeps(false);
			expect(globals.roastSchedule.enabled).toBe(true);
		});
	});
});
