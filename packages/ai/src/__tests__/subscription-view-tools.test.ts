/**
 * 女仆查订阅的那几把工具 × 订阅视图。
 *
 * 视图每条订阅是同一种形状 `{ creator, name, platform, post, live, liveNow }`,`creator` 是
 * 「来源键:外部 id」(ADR-0030 决策 1),B 站和别的来源不再分两种条目。钉住的是:
 * - `list_subscriptions` 每行写名字、平台名与 `creator`,不再有「UID:」。
 * - `get_live_status` 两支都从视图里的在播状态答,不问 B 站。
 * - 还按 UID 查的那几把工具(过渡)收到的 uid 不合 B 站声明的外部 id 格式时不去 B 站查 ——
 *   别家的外部 id 恰好是一串数字时,B 站那边会查出另一个人来(ADR-0021 决策 14 的 10-15 🔗)。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { AiSubscriptionView, BiliReader, CreatorReader, LiveNowView } from "../tools";
import { executeTool } from "../tools";
import { sayOf } from "./harness";

const BILI: AiSubscriptionView = {
	creator: "bilibili:1",
	name: "晨风",
	platform: "B 站",
	post: true,
	live: true,
};
const EXT: AiSubscriptionView = {
	creator: "douyin:20001",
	name: "抖音甲",
	platform: "抖音",
	post: true,
	live: true,
};

/** 读口替身:B 站只收纯数字的外部 id(照描述符声明的格式),别的来源不替它做主。 */
function readerOf(items: AiSubscriptionView[]): CreatorReader {
	return {
		subscriptions: () => items,
		externalIdFits: (sourceKey, externalId) =>
			sourceKey === "bilibili" ? /^\d+$/.test(externalId) : true,
	};
}

function apiStub() {
	return {
		fetchUserCard: vi.fn(async () => ({ code: 0, data: { card: { name: "别人", fans: 1 } } })),
		fetchUserSpaceDynamic: vi.fn(async () => ({ code: 0, data: { items: [] } })),
		fetchUserUpstat: vi.fn(async () => ({ code: 0, data: {} })),
		fetchUserNavnum: vi.fn(async () => ({ code: 0, data: {} })),
		fetchUserVideos: vi.fn(async () => ({ code: 0, data: { list: { vlist: [] } } })),
		// 在播不再问 B 站:谁调了它谁红。
		fetchLiveRoomInfoByUids: vi.fn(),
	};
}

function run(name: string, args: Record<string, string>, api = apiStub(), items = [BILI, EXT]) {
	return executeTool(name, args, api as unknown as BiliReader, readerOf(items));
}

describe("list_subscriptions", () => {
	it("每行写名字、平台名与 creator(来源键:外部 id),B 站和别的来源同一种写法,不再有「UID:」", async () => {
		const out = await run("list_subscriptions", {});
		expect(out.ok).toBe(true);
		const [bili, ext] = sayOf(out).split("\n");
		expect(bili).toBe("晨风（B 站 · creator: bilibili:1）动态:✓ 直播:✓");
		expect(ext).toBe("抖音甲（抖音 · creator: douyin:20001）动态:✓ 直播:✓");
		expect(sayOf(out)).not.toContain("UID");
	});

	it("没有订阅 / 没接读口 → 当前没有订阅", async () => {
		expect(sayOf(await run("list_subscriptions", {}, apiStub(), []))).toBe("当前没有订阅");
		const noReader = await executeTool(
			"list_subscriptions",
			{},
			apiStub() as unknown as BiliReader,
			null,
		);
		expect(sayOf(noReader)).toBe("当前没有订阅");
	});
});

describe("get_live_status", () => {
	const STARTED = Date.UTC(2026, 8, 24, 4, 0, 0);
	const BILI_LIVE: LiveNowView = { state: "live", title: "晚间杂谈", startedAt: STARTED };
	const items = (
		extLive: LiveNowView | undefined,
		biliLive: LiveNowView | undefined = BILI_LIVE,
	) => [
		{ ...BILI, liveNow: biliLive },
		{ ...EXT, liveNow: extLive },
	];
	const status = (list: AiSubscriptionView[], api = apiStub()) =>
		executeTool("get_live_status", {}, api as unknown as BiliReader, readerOf(list));

	it("B 站订阅也从 BN 手里的在播状态答,全程不问 B 站;拓展那条同样:标题、开播时刻、累计观看", async () => {
		const api = apiStub();
		const out = await status(
			items({ state: "live", title: "晚饭直播", startedAt: STARTED, totalViewers: 23_456 }),
			api,
		);
		expect(api.fetchLiveRoomInfoByUids).not.toHaveBeenCalled();
		expect(out.ok).toBe(true);
		expect(sayOf(out)).toContain("晨风：直播中「晚间杂谈」");
		expect(sayOf(out)).toContain(
			`开播于 ${new Date(STARTED).toLocaleString("zh-CN", { hour12: false })}`,
		);
		const line = sayOf(out)
			.split("\n")
			.find((l) => l.startsWith("抖音甲"));
		expect(line).toMatch(/^抖音甲：直播中「晚饭直播」/);
		expect(line).toContain(
			`开播于 ${new Date(STARTED).toLocaleString("zh-CN", { hour12: false })}`,
		);
		expect(line).toContain("累计观看 23456");
	});

	it("拓展报了不在播 → 未开播;没报的格不写", async () => {
		expect(sayOf(await status(items({ state: "idle" })))).toContain("抖音甲：未开播");
		const live = await status(items({ state: "live" }));
		expect(sayOf(live)).toContain("抖音甲：直播中");
		expect(sayOf(live)).not.toMatch(/抖音甲：直播中.*(开播于|累计观看|「)/);
	});

	it("拓展没在跑(BN 手里没有它的在播状态)→ 说查不到,不冒充一个状态", async () => {
		for (const liveNow of [{ state: "unknown" } as const, undefined]) {
			const out = await status(items(liveNow));
			// 「查不到」是拓展没在跑时的如实回答,不是工具失败
			expect(out.ok).toBe(true);
			expect(sayOf(out)).toContain("抖音甲：查不到");
			expect(sayOf(out)).not.toMatch(/抖音甲：(未开播|直播中|轮播中|未知)/);
		}
	});

	it("B 站订阅不在播表里 → 未开播;没接上在播来源 → 查不到,都不问 B 站", async () => {
		const api = apiStub();
		expect(sayOf(await status([{ ...BILI, liveNow: { state: "idle" } }], api))).toContain(
			"晨风：未开播",
		);
		expect(sayOf(await status([BILI], api))).toContain("晨风：查不到");
		expect(api.fetchLiveRoomInfoByUids).not.toHaveBeenCalled();
	});

	it("只开了直播推送的才在结果里", async () => {
		const out = await status([
			{ ...BILI, live: false },
			{ ...EXT, liveNow: { state: "idle" } },
		]);
		expect(sayOf(out)).toBe("抖音甲：未开播");
	});
});

describe("按 UID 查的工具(过渡)", () => {
	const UID_TOOLS: [string, keyof ReturnType<typeof apiStub>][] = [
		["get_user_info", "fetchUserCard"],
		["get_user_dynamics", "fetchUserSpaceDynamic"],
		["get_user_stats", "fetchUserUpstat"],
		["get_user_videos", "fetchUserVideos"],
	];

	it.each(UID_TOOLS)(
		"%s 收到的 uid 不合 B 站声明的外部 id 格式(别家的外部 id 或整串 creator)→ 不去 B 站查,invalid,话里说只传冒号后面那一段",
		async (tool, method) => {
			for (const uid of ["alice-ext", "bilibili:1", ""]) {
				const api = apiStub();
				const out = await run(tool, { uid }, api);
				expect(api[method]).not.toHaveBeenCalled();
				expect(out).toMatchObject({ ok: false, code: "invalid" });
				expect(sayOf(out)).toContain("冒号后面");
			}
		},
	);

	it.each(UID_TOOLS)(
		"%s 收到合格式的 uid → 照旧去 B 站查(订没订阅都一样)",
		async (tool, method) => {
			const api = apiStub();
			await run(tool, { uid: "999" }, api);
			expect(api[method]).toHaveBeenCalledWith("999");
		},
	);

	it("没接读口(核不了格式)→ 照旧去查,不替来源做主", async () => {
		const api = apiStub();
		await executeTool("get_user_info", { uid: "abc" }, api as unknown as BiliReader, null);
		expect(api.fetchUserCard).toHaveBeenCalledWith("abc");
	});
});
