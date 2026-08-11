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

import { describe, expect, it } from "vite-plus/test";
import { createStatusCommand, type StatusReport } from "../status-command.js";

const NOW = 1_786_500_000_000;
const MIN = 60_000;

const HEALTHY: StatusReport = {
	login: "已登录",
	lastFetchAt: NOW - 2 * MIN,
	renderQueue: 0,
	adapters: [{ name: "NapCat", ok: true }],
	mutedUntil: 0,
};

function setup(report: Partial<StatusReport> = {}) {
	const replies: string[] = [];
	const spec = createStatusCommand({
		probe: () => ({ ...HEALTHY, ...report }),
		reply: async (text) => {
			replies.push(text);
		},
		now: () => NOW,
	});
	return { spec, replies, run: () => spec.run({} as never) };
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

	// 四项各占一行。适配器全连着时**不点名** —— 名字只在断了的时候有用,
	// 平时列一串只是噪音(下面单独有一条验断掉时会点名)。
	it("四项都在", async () => {
		const { replies, run } = setup();
		await run();
		const text = replies[0] ?? "";
		expect(text).toContain("登录：已登录");
		expect(text).toContain("上次抓取：2 分钟前");
		expect(text).toContain("推送通道：");
		expect(text).toContain("渲染排队：");
	});

	// 手机上「14:32」还得自己算一下过了多久,「2 分钟前」不用。
	it("上次抓取说的是相对时间", async () => {
		const { replies, run } = setup({ lastFetchAt: NOW - 90 * MIN });
		await run();
		expect(replies[0]).toContain("1 小时前");
	});

	it("刚抓过 → 说「刚刚」,不说「0 分钟前」", async () => {
		const { replies, run } = setup({ lastFetchAt: NOW - 5_000 });
		await run();
		expect(replies[0]).toContain("刚刚");
	});

	// 「还没抓过」和「很久没抓了」是两回事:前者是刚启动,后者是坏了。
	it("一次都还没抓过 → 说清楚,而不是显示 1970 年", async () => {
		const { replies, run } = setup({ lastFetchAt: undefined });
		await run();
		expect(replies[0]).toContain("还没");
		expect(replies[0]).not.toContain("1970");
		expect(replies[0]).not.toContain("NaN");
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

	it("适配器断了 → 标出来是哪个", async () => {
		const { replies, run } = setup({
			adapters: [
				{ name: "NapCat", ok: true },
				{ name: "Lagrange", ok: false },
			],
		});
		await run();
		expect(replies[0]).toContain("Lagrange");
	});

	// 一个都没配的时候别显示一行空白,那看起来像功能坏了。
	it("一个适配器都没配 → 说清楚", async () => {
		const { replies, run } = setup({ adapters: [] });
		await run();
		expect(replies[0]).toContain("还没配");
	});

	it("渲染排着队 → 报出深度", async () => {
		const { replies, run } = setup({ renderQueue: 3 });
		await run();
		expect(replies[0]).toContain("3");
	});
});
