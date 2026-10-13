/**
 * `/status` —— 手机上问一句「现在还好吗」。
 *
 * 这条消息只回答**一个**问题:系统正常吗。所以四项都是「不正常时才有救的东西」——
 * 登录掉了 / 不抓了 / 推不出去 / 卡住了。方案里专门钉过:别往里加订阅数、今日推送数
 * 之类,这是在手机上看的,长了就没人读。
 *
 * 取数与渲染分开:probe 给一份纯数据,渲染是纯函数。真去接 authSystem / adapter 的话
 * 这些断言就得先起半个服务端。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthState, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { recordingCtx } from "../../__tests__/support/command-ctx.js";
import type { SourceLoginView, SourceView } from "../../subscriptions/registry.js";
import {
	createStatusCommand,
	readLogins,
	readSourceHealth,
	type StatusReport,
} from "../status-command.js";

const NOW = 1_786_500_000_000;
const MIN = 60_000;

const HEALTHY: StatusReport = {
	logins: [
		{ label: "B 站", state: { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" } },
	],
	sources: [{ label: "B 站", summary: "上次抓取 2 分钟前" }],
	renderQueue: 0,
	connections: [{ name: "NapCat", ok: true }],
	mutedUntil: 0,
};

function setup(report: Partial<StatusReport> = {}) {
	const replies: string[] = [];
	const spec = createStatusCommand({
		probe: () => ({ ...HEALTHY, ...report }),
		now: () => NOW,
	});
	return { spec, replies, run: () => spec.run({} as never, recordingCtx(replies)) };
}

describe("status 指令", () => {
	it("主名英文,中文走别名", () => {
		const { spec } = setup();
		expect(spec.name).toBe("status");
		expect(spec.aliases).toContain("状态");
	});

	it("不收参数", () => {
		const { spec } = setup();
		expect(spec.signature).toBeUndefined();
	});

	// 登录一行、每个来源各一行、推送通道、渲染排队。连接全连着时**不点名** —— 名字只在断了的时候有用,
	// 平时列一串只是噪音(下面单独有一条验断掉时会点名)。
	it("四项都在:来源那一行是「<label>：<summary>」", async () => {
		const { replies, run } = setup();
		await run();
		const text = replies[0] ?? "";
		expect(text).toContain("B 站登录：已登录");
		expect(text).toContain("B 站：上次抓取 2 分钟前");
		expect(text).toContain("推送通道：");
		expect(text).toContain("渲染排队：");
	});

	// 验红:`renderStatus` 里把 sources 倒着排(或不按数组次序),这条红。
	it("每个在册来源一行,次序就是数组的次序,冒号前是名字", async () => {
		const { replies, run } = setup({
			sources: [
				{ label: "甲", summary: "好" },
				{ label: "乙", summary: "也好" },
			],
		});
		await run();
		const lines = (replies[0] ?? "").split("\n");
		expect(lines.slice(0, 3)).toEqual(["B 站登录：已登录", "甲：好", "乙：也好"]);
	});

	it("没有任何来源交了一行 → 登录之后直接是推送通道,不留空行", async () => {
		const { replies, run } = setup({ sources: [] });
		await run();
		expect((replies[0] ?? "").split("\n").slice(0, 2)).toEqual([
			"B 站登录：已登录",
			"推送通道：1 个都连着",
		]);
	});

	// 验红:`renderStatus` 只渲染第一个登录行(或写死「B 站」),这条红。
	it("两个带登录的来源各出一行,带各自的名字与状态,次序是给定的次序,排在来源自己的行之前", async () => {
		const { replies, run } = setup({
			logins: [
				{ label: "B 站", state: { status: "logged-in", loggedInAt: "t" } },
				{ label: "对拍源", state: { status: "expired", message: "对拍源的登录过期了" } },
			],
		});
		await run();
		expect((replies[0] ?? "").split("\n").slice(0, 4)).toEqual([
			"B 站登录：已登录",
			"对拍源登录：对拍源的登录过期了",
			"B 站：上次抓取 2 分钟前",
			"推送通道：1 个都连着",
		]);
	});

	it("没有带登录的来源 → 没有「登录」这一行", async () => {
		const { replies, run } = setup({ logins: [] });
		await run();
		expect(replies[0]).not.toContain("登录");
		expect((replies[0] ?? "").split("\n")[0]).toBe("B 站：上次抓取 2 分钟前");
	});

	// 「X 登录：」那一行由核心按 `AuthState` 拼:每种状态各出什么字都钉死,`confirming` 没带 message 时兜底写「正在确认」。
	it.each([
		[{ status: "logged-in", loggedInAt: "t" }, "已登录"],
		[{ status: "logged-out" }, "没登录"],
		[
			{ status: "awaiting-scan", qr: { dataUrl: "data:image/png;base64,AA", expiresAt: "t" } },
			"等待扫码",
		],
		[{ status: "confirming", message: "已扫码，请在手机上确认" }, "已扫码，请在手机上确认"],
		[{ status: "confirming" }, "正在确认"],
		[
			{ status: "expired", message: "账号登录已失效，请重新扫码登录" },
			"账号登录已失效，请重新扫码登录",
		],
		[
			{ status: "error", message: "二维码已超时（3分钟），请重新登录" },
			"二维码已超时（3分钟），请重新登录",
		],
	] as const)("登录一行：%j → %s", async (state, text) => {
		const { replies, run } = setup({ logins: [{ label: "B 站", state }] });
		await run();
		expect(replies[0]).toContain(`B 站登录：${text}`);
	});

	// 「怎么没动静」的第一嫌疑就是它。不说的话主人会顺着查登录、查网络,
	// 而真相是他自己三小时前敲了静音。
	it("正在静音 → 必须说出来", async () => {
		const { replies, run } = setup({ mutedUntil: NOW + 30 * MIN });
		await run();
		expect(replies[0]).toContain("静音");
	});

	it("没静音 → 不提静音,别占一行", async () => {
		const { replies, run } = setup();
		await run();
		expect(replies[0]).not.toContain("静音");
	});

	// 静音到期后 status 得跟着变回来 —— 存的是到期时刻,判定同样是读时现算。
	it("静音已过期 → 当作没静音", async () => {
		const { replies, run } = setup({ mutedUntil: NOW - MIN });
		await run();
		expect(replies[0]).not.toContain("静音");
	});

	it("连接断了 → 标出来是哪个", async () => {
		const { replies, run } = setup({
			connections: [
				{ name: "NapCat", ok: true },
				{ name: "Lagrange", ok: false },
			],
		});
		await run();
		expect(replies[0]).toContain("Lagrange");
	});

	// 一个都没配的时候别显示一行空白,那看起来像功能坏了。
	it("一条连接都没配 → 说清楚", async () => {
		const { replies, run } = setup({ connections: [] });
		await run();
		expect(replies[0]).toContain("还没配");
	});

	it("渲染排着队 → 报出深度", async () => {
		const { replies, run } = setup({ renderQueue: 3 });
		await run();
		expect(replies[0]).toContain("3");
	});
});

const viewOf = (label: string, health?: SourceView["health"]): SourceView => ({
	sourceKey: `test.${label}`,
	descriptor: { label },
	...(health ? { health } : {}),
});

describe("readSourceHealth —— 取在册来源各自交的一行", () => {
	// 验红:把 `.filter` 那一道去掉(没有 health 的来源也占一行),这条红。
	it("没有 health 的来源不占行;有的按给定次序、名字取描述符的 label", () => {
		const rows = readSourceHealth(
			[
				viewOf("甲", () => ({ summary: "一" })),
				viewOf("没交的"),
				viewOf("乙", () => ({ summary: "二" })),
			],
			{ error: vi.fn() },
		);
		expect(rows).toEqual([
			{ label: "甲", summary: "一" },
			{ label: "乙", summary: "二" },
		]);
	});

	// 验红:把 `try / catch` 去掉,这条红(抛出去、整条 status 没了)。
	it("health() 抛了:那一行写「状态读不到」,别的行照常,记一行 error 带着抛出来的话", () => {
		const error = vi.fn();
		const rows = readSourceHealth(
			[
				viewOf("甲", () => {
					throw new Error("boom");
				}),
				viewOf("乙", () => ({ summary: "二" })),
			],
			{ error },
		);
		expect(rows).toEqual([
			{ label: "甲", summary: "状态读不到" },
			{ label: "乙", summary: "二" },
		]);
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toContain("boom");
	});

	it("调用时 this 是视图自己(登记表手抄视图不许丢上下文)", () => {
		const view: SourceView & { tag: string } = {
			tag: "我",
			sourceKey: "test.甲",
			descriptor: { label: "甲" },
			health() {
				return { summary: (this as { tag: string }).tag };
			},
		};
		expect(readSourceHealth([view], { error: vi.fn() })).toEqual([{ label: "甲", summary: "我" }]);
	});
});

const loginViewOf = (label: string, state: () => AuthState): SourceLoginView => ({
	sourceKey: `test.${label}`,
	label,
	auth: {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state,
		onChange: () => ({ dispose() {} }),
	},
});

describe("readLogins —— 取带登录口的来源各自的登录态", () => {
	// 验红:把 `readLogins` 里的 try / catch 去掉,这条红(`auth.state()` 的异常抛出去,整条 status 没了)。
	it("某个来源的 auth.state() 抛了:它那一行写「状态读不到」、记恰好一条 error 带来源名字,别的行照出", async () => {
		const error = vi.fn();
		const logins = readLogins(
			[
				loginViewOf("甲", () => {
					throw new Error("boom");
				}),
				loginViewOf("乙", () => ({ status: "logged-in", loggedInAt: "t" })),
			],
			{ error },
		);
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toBe("[status] 来源「甲」的 auth.state() 抛错: boom");

		const replies: string[] = [];
		const spec = createStatusCommand({
			probe: () => ({ ...HEALTHY, logins }),
			now: () => NOW,
		});
		await spec.run({} as never, recordingCtx(replies));
		expect((replies[0] ?? "").split("\n").slice(0, 3)).toEqual([
			"甲登录：状态读不到",
			"乙登录：已登录",
			"B 站：上次抓取 2 分钟前",
		]);
	});

	it("都读得到:按给定次序原样带上名字与状态,不记日志", () => {
		const error = vi.fn();
		const logins = readLogins(
			[
				loginViewOf("甲", () => ({ status: "logged-out" })),
				loginViewOf("乙", () => ({ status: "logged-out" })),
			],
			{ error },
		);
		expect(logins).toEqual([
			{ label: "甲", state: { status: "logged-out" } },
			{ label: "乙", state: { status: "logged-out" } },
		]);
		expect(error).not.toHaveBeenCalled();
	});
});

describe("index.ts 的接线", () => {
	// 验红:把 `index.ts` 的探针改回手写读 `lastFetchAt`(或不经登记表),这条红。
	it("status 的探针经 readSourceHealth 读来源登记表,入口里不再伸手进 B 站引擎问「上次抓取」", () => {
		const src = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../../index.ts"),
			"utf8",
		);
		expect(src).toContain("readSourceHealth(runtime.sourceRegistry.list(),");
		expect(src).not.toContain("lastFetchAt");
	});

	// 验红:把 `index.ts` 里 status / login 的来源改回直读 `authSystem`,这条红。
	it("status 的登录行与 login 的来源都现读来源登记表,入口里不再为这两条指令伸手进 B 站登录系统", () => {
		const src = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../../index.ts"),
			"utf8",
		);
		expect(src).toContain("listLoginSources(runtime.sourceRegistry.list())");
		expect(src).not.toContain("auth.state()");
		expect(src).not.toContain("auth.beginLogin()");
	});
});
