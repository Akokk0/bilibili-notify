/**
 * 拓展交给面板的「视图」(ADR-0019 决策 20 / 26–28)—— 一组**封闭的积木**,由 BN 照着画。
 *
 * 它是契约:拓展写什么、面板画什么都在这里说死。宿主拿这份 schema 校验 v2 拓展交来的视图,
 * 不合规矩的不画(换成一条说清哪里不对的错误提示),所以这里既钉「收下什么」,也钉「拒什么」。
 */

import { describe, expect, it } from "vite-plus/test";
import { ExtensionViewSchema } from "./extension-view";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const accepts = (view: unknown) => ExtensionViewSchema.safeParse(view).success;

function issues(view: unknown): string {
	const r = ExtensionViewSchema.safeParse(view);
	if (r.success) throw new Error("应该拒");
	return r.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

/** 桥迁过去以后交的那一份 —— 设计稿上那张「连上了,但对不上」的卡。 */
const BRIDGE_VIEW = {
	summary: { tone: "ok", text: [{ b: "2" }, " 个 bot 在线"] },
	page: [
		{
			type: "copy",
			label: "BN 地址",
			value: { host: "extensionUrl" },
			note: ["这是", { b: "桥那台机器" }, "要访问得到的地址 —— 别填 ", { mono: "127.0.0.1" }, "。"],
		},
	],
	items: {
		links: {
			"3c0e9a7e-1b2d-4c5f-8a9b-0c1d2e3f4a5b": {
				status: { tone: "warn", text: "连上了,但对不上" },
				pill: "配置:koishi",
				subtitle: [
					"AstrBot v4.3.1 · ",
					{ time: 1790061520000, suffix: "连上" },
					" · 来自 192.168.1.8",
				],
				buttons: [{ label: "改成 AstrBot", set: { bridgeKind: "astrbot" } }],
				blocks: [
					{
						type: "notice",
						tone: "warn",
						text: [
							{ b: "这条接入配的是 koishi,连进来的却自报 astrbot。" },
							"多半是 token 填错了一头。",
						],
					},
					{
						type: "table",
						title: "它驮着的 bot",
						count: true,
						empty: "桥连上了,但它现在一个 bot 都没有。",
						columns: [
							{ kind: "icon" },
							{ kind: "text", width: 210 },
							{ kind: "tristate", label: "@全体" },
							{ kind: "tristate", label: "合并转发" },
						],
						rows: [
							[
								{ image: PNG, fallback: "ai" },
								{ text: "书房的小号", sub: "aiocqhttp · 1049382211" },
								"yes",
								"unknown",
							],
						],
					},
				],
			},
		},
	},
};

describe("ExtensionViewSchema —— 收下", () => {
	it("桥那一份(页级可复制值 + 列表项的状态、按钮、提示条、表格)", () => {
		expect(accepts(BRIDGE_VIEW)).toBe(true);
	});

	/**
	 * 卡里的积木分上下两段:`lead` 画在 BN 画的字段行(token 行)**上面**,`blocks` 画在下面 ——
	 * 桥今天就是「对不上」的提示在 token 行上、bot 表在下。
	 */
	it("列表项的 lead 与 blocks 各收一串积木", () => {
		const view = {
			items: {
				links: {
					a: {
						lead: [{ type: "notice", tone: "warn", text: "对不上" }],
						blocks: [{ type: "notice", tone: "info", text: "填两样" }],
					},
				},
			},
		};
		expect(accepts(view)).toBe(true);
	});

	it("空视图 —— 一样合规矩(拓展此刻什么都不想说)", () => {
		expect(accepts({})).toBe(true);
	});

	it("抖音那一份(键值 + 带按钮的提示条 + 调拓展的按钮)", () => {
		expect(
			accepts({
				page: [
					{
						type: "keyValue",
						items: [
							{ label: "登录", value: "cookie 有效", tone: "ok" },
							{ label: "上次检查", value: [{ time: 1790061400000 }] },
						],
					},
					{
						type: "notice",
						tone: "warn",
						text: "cookie 还有 3 天过期。",
						button: { label: "现在检查一次", action: "poll.now" },
					},
					{ type: "button", label: "现在检查一次", action: "poll.now" },
					{ type: "qr", image: PNG, caption: "用抖音扫一下" },
				],
			}),
		).toBe(true);
	});
});

describe("ExtensionViewSchema —— 拒", () => {
	it("不认识的积木 —— 拒(积木是封闭的一组,缺了等 BN 加)", () => {
		expect(issues({ page: [{ type: "chart", data: [1, 2] }] })).toContain("page.0");
	});

	it("多出来的键 —— 拒(拼错的键放过去就是一块静默不显示的积木)", () => {
		issues({ page: [{ type: "notice", tone: "warn", txt: "拼错了" }] });
		issues({ summary: { text: "x", color: "red" } });
		issues({ extra: true });
	});

	it("富文本只有五种片段 —— 带 HTML 的对象、别的键都拒", () => {
		issues({ summary: { text: [{ html: "<b>x</b>" }] } });
		issues({ summary: { text: [{ b: "x", mono: "y" }] } });
		issues({ summary: { text: [{ host: "publicUrl" }] } });
		issues({ summary: { text: [{ time: -1 }] } });
	});

	/** 「改设置」的按钮改的是**这一项**的一格(决策 27)—— 页级没有「这一项」。 */
	it("改设置的按钮只许挂在列表项上 —— 页级积木、页级提示条里的都拒", () => {
		const set = { label: "改掉", set: { kind: "astrbot" } };
		expect(issues({ page: [{ type: "button", ...set }] })).toContain("set");
		expect(issues({ page: [{ type: "notice", tone: "info", text: "x", button: set }] })).toContain(
			"set",
		);
	});

	it("调拓展的按钮,动作名要合清单那条规矩(它要进 URL)", () => {
		issues({ page: [{ type: "button", label: "按", action: "Poll Now" }] });
	});

	it("表格:一行的格数要和列对上,每格的样子要和那一列的种类对上", () => {
		const table = (rows: unknown[][]) => ({
			page: [
				{
					type: "table",
					columns: [{ kind: "icon" }, { kind: "text" }, { kind: "tristate", label: "@全体" }],
					rows,
				},
			],
		});
		expect(accepts(table([[{ fallback: "qq" }, "小粉", "no"]]))).toBe(true);
		expect(issues(table([[{ fallback: "qq" }, "小粉"]]))).toContain("rows.0");
		expect(issues(table([[{ fallback: "qq" }, "小粉", "maybe"]]))).toContain("rows.0.2");
		expect(issues(table([["qq", "小粉", "yes"]]))).toContain("rows.0.0");
	});

	it("表格的图标格:图片只收 data URL(和选项图标同一条),退路最多两个字", () => {
		const cell = (icon: unknown) => ({
			page: [{ type: "table", columns: [{ kind: "icon" }], rows: [[icon]] }],
		});
		expect(accepts(cell({ image: PNG, fallback: "te" }))).toBe(true);
		issues(cell({ image: "https://example.invalid/tg.png", fallback: "te" }));
		issues(cell({ fallback: "telegram" }));
	});

	it("可复制的值:要么一段字,要么 BN 现算的地址 —— 别的 host 不认", () => {
		issues({ page: [{ type: "copy", label: "地址", value: { host: "publicUrl" } }] });
	});

	it("状态 / 语气只认那几种", () => {
		issues({ items: { links: { a: { status: { tone: "danger", text: "坏了" } } } } });
		issues({ page: [{ type: "notice", tone: "success", text: "好了" }] });
	});

	it("列表项视图挂在「列表的 key → 项的 id」底下;key 要合设置项 key 的规矩", () => {
		issues({ items: { "not a key": { a: {} } } });
		issues({ items: { links: { "": {} } } });
	});
});
