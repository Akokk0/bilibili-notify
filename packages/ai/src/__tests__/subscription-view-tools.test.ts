/**
 * 女仆查订阅的那几把工具 × 订阅视图。
 *
 * 视图每条订阅是同一种形状 `{ creator, name, platform, post, live, liveNow }`,`creator` 是
 * 「来源键:外部 id」(ADR-0030 决策 1),B 站和别的来源不再分两种条目。钉住的是:
 * - `list_subscriptions` 每行写名字、平台名与 `creator`,不再有「UID:」。
 * - `get_live_status` 两支都从视图里的在播状态答,不问 B 站。
 */

import { describe, expect, it } from "vite-plus/test";
import type { AiSubscriptionView, CreatorReader, LiveNowView } from "../tools";
import { executeTool } from "../tools";
import { readerStubs, sayOf } from "./harness";

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

function readerOf(items: AiSubscriptionView[]): CreatorReader {
	return {
		subscriptions: () => items,
		...readerStubs,
	};
}

function run(name: string, args: Record<string, string>, items = [BILI, EXT]) {
	return executeTool(name, args, readerOf(items));
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
		expect(sayOf(await run("list_subscriptions", {}, []))).toBe("当前没有订阅");
		const noReader = await executeTool("list_subscriptions", {}, null);
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
	const status = (list: AiSubscriptionView[]) => executeTool("get_live_status", {}, readerOf(list));

	it("B 站订阅也从 BN 手里的在播状态答,全程不问 B 站;拓展那条同样:标题、开播时刻、累计观看", async () => {
		const out = await status(
			items({ state: "live", title: "晚饭直播", startedAt: STARTED, totalViewers: 23_456 }),
		);
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
		expect(sayOf(await status([{ ...BILI, liveNow: { state: "idle" } }]))).toContain(
			"晨风：未开播",
		);
		expect(sayOf(await status([BILI]))).toContain("晨风：查不到");
	});

	it("只开了直播推送的才在结果里", async () => {
		const out = await status([
			{ ...BILI, live: false },
			{ ...EXT, liveNow: { state: "idle" } },
		]);
		expect(sayOf(out)).toBe("抖音甲：未开播");
	});
});
