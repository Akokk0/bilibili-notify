/**
 * 女仆查订阅的那几把工具 × 拓展订阅(ADR-0019 决策 64)。
 *
 * 视图按订阅 `id` 为键,两种条目:B 站的带 `uid`;别的平台的(拓展订阅)没有 `uid`,带平台名与
 * 外部 id。钉住的是:
 * - B 站那几行照旧(`list_subscriptions` 的写法、`get_live_status` 照样按 UID 问 B 站)。
 * - 拓展条目写明平台与外部 id,并说清它不是 B 站 UID;`get_live_status` 不拿外部 id 去问 B 站。
 * - 按 UID 查的那几把工具收到一个拓展条目的外部 id 时,不去 B 站查 —— 外部 id 恰好是一串数字
 *   时,B 站那边会查出另一个人来,女仆会把他当成这位主播讲(决策 73 说的「静默认错人」)。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import { describe, expect, it, vi } from "vite-plus/test";
import { executeTool, type Subscriptions } from "../tools";

const VIEW: Subscriptions = {
	"sub-bili": { uid: "1", uname: "晨风", dynamic: true, live: true },
	"sub-ext": { platform: "抖音", externalId: "20001", uname: "抖音甲", dynamic: true, live: true },
};

function apiStub() {
	return {
		getLiveRoomInfoByUids: vi.fn(async () => ({
			code: 0,
			data: { "1": { live_status: 1, title: "晚间杂谈" } },
		})),
		getUserCardInfo: vi.fn(async () => ({ code: 0, data: { card: { name: "别人", fans: 1 } } })),
		getUserSpaceDynamic: vi.fn(async () => ({ code: 0, data: { items: [] } })),
		getUserUpstat: vi.fn(async () => ({ code: 0, data: {} })),
		getUserNavnum: vi.fn(async () => ({ code: 0, data: {} })),
		getUserVideos: vi.fn(async () => ({ code: 0, data: { list: { vlist: [] } } })),
	};
}

function run(name: string, args: Record<string, string>, api = apiStub()) {
	return executeTool(name, args, api as unknown as BilibiliAPI, () => VIEW);
}

describe("list_subscriptions", () => {
	it("B 站那行照旧;拓展那行写平台名与外部 id,说明不是 B 站 UID", async () => {
		const out = await run("list_subscriptions", {});
		const [bili, ext] = out.split("\n");
		expect(bili).toBe("晨风（UID: 1）动态:✓ 直播:✓");
		expect(ext).toContain("抖音甲");
		expect(ext).toContain("抖音 · 外部 id 20001");
		expect(ext).toContain("不是 B 站 UID");
		expect(ext).not.toContain("UID: ");
		expect(ext).toContain("动态:✓ 直播:✓");
	});
});

describe("get_live_status", () => {
	it("只拿 B 站订阅的 UID 去问 B 站;拓展那条说查不到,不冒充一个状态", async () => {
		const api = apiStub();
		const out = await run("get_live_status", {}, api);
		expect(api.getLiveRoomInfoByUids).toHaveBeenCalledWith(["1"]);
		expect(out).toContain("晨风：直播中「晚间杂谈」");
		expect(out).toContain("抖音甲");
		expect(out).toContain("查不到");
		expect(out).not.toMatch(/抖音甲：(未开播|直播中|轮播中|未知)/);
	});

	it("开了直播的只有拓展订阅 → 根本不问 B 站", async () => {
		const api = apiStub();
		const view: Subscriptions = { "sub-ext": VIEW["sub-ext"] as Subscriptions[string] };
		const out = await executeTool("get_live_status", {}, api as unknown as BilibiliAPI, () => view);
		expect(api.getLiveRoomInfoByUids).not.toHaveBeenCalled();
		expect(out).toContain("查不到");
	});
});

describe("按 UID 查的工具", () => {
	const UID_TOOLS: [string, keyof ReturnType<typeof apiStub>][] = [
		["get_user_info", "getUserCardInfo"],
		["get_user_dynamics", "getUserSpaceDynamic"],
		["get_user_stats", "getUserUpstat"],
		["get_user_videos", "getUserVideos"],
	];

	it.each(UID_TOOLS)(
		"%s 收到拓展条目的外部 id → 不去 B 站查,说明它是哪个平台的",
		async (tool, method) => {
			const api = apiStub();
			const out = await run(tool, { uid: "20001" }, api);
			expect(api[method]).not.toHaveBeenCalled();
			expect(out).toContain("抖音");
			expect(out).toContain("不是 B 站 UID");
		},
	);

	it.each(UID_TOOLS)("%s 收到 B 站 UID → 照旧去 B 站查", async (tool, method) => {
		const api = apiStub();
		await run(tool, { uid: "1" }, api);
		expect(api[method]).toHaveBeenCalledWith("1");
	});

	it("没订阅的 B 站用户(搜出来的 UID)照旧查得了", async () => {
		const api = apiStub();
		await run("get_user_info", { uid: "999" }, api);
		expect(api.getUserCardInfo).toHaveBeenCalledWith("999");
	});

	it("外部 id 与某位 B 站订阅的 UID 撞号 → 照查 B 站那位(按 UID 问得到的只有他)", async () => {
		const api = apiStub();
		const view: Subscriptions = {
			...VIEW,
			"sub-ext-2": { platform: "抖音", externalId: "1", uname: "抖音乙" },
		};
		await executeTool("get_user_info", { uid: "1" }, api as unknown as BilibiliAPI, () => view);
		expect(api.getUserCardInfo).toHaveBeenCalledWith("1");
	});
});
