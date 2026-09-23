/**
 * 拓展交给面板的「视图」(ADR-0019 决策 20 / 26–28,09-23 决策 39 改过一轮)—— 一组**封闭的积木**,
 * 由 BN 照着画。
 *
 * 它是契约:拓展写什么、面板画什么都在这里说死。宿主拿这里的几块 schema **逐块 / 逐项**校验 v2
 * 拓展交来的视图(决策 40:坏的只换掉那一块 / 那一项),所以这里既钉「收下什么」,也钉「拒什么」。
 * 要看清单才判得了的(列表的键、项的 id、「改设置」改的是哪几格)与整份的字节上限在宿主那头,
 * 见 `apps/server/src/extensions/view-check.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	EXTENSION_VIEW_MAX_BYTES,
	ExtensionBlockSchema,
	ExtensionViewSchema,
	viewImageKeysOf,
} from "./extension-view";

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
				buttons: [{ kind: "set", label: "改成 AstrBot", set: { bridgeKind: "astrbot" } }],
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
								{ kind: "icon", image: "qq", fallback: "ai" },
								{ kind: "text", text: "书房的小号", sub: "aiocqhttp · 1049382211" },
								{ kind: "tristate", value: "yes" },
								{ kind: "tristate", value: "unknown" },
							],
						],
					},
				],
			},
		},
	},
	images: { qq: PNG },
};

/** 一张只有一列的表 —— 拿来钉格子的规矩。 */
const table = (columns: unknown[], rows: unknown[][]) => ({
	page: [{ type: "table", columns, rows }],
});

describe("ExtensionViewSchema —— 收下", () => {
	it("桥那一份(页级可复制值 + 列表项的状态、按钮、提示条、表格 + 图片字典)", () => {
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

	it("抖音那一份(键值 + 带按钮的提示条 + 按钮积木 + 二维码按键引用图)", () => {
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
						button: { kind: "action", label: "现在检查一次", action: "poll.now" },
					},
					{
						type: "button",
						button: { kind: "action", label: "现在检查一次", action: "poll.now" },
					},
					{ type: "qr", image: "login", caption: "用抖音扫一下" },
				],
				images: { login: PNG },
			}),
		).toBe(true);
	});

	it("表格四种格各自带种类,与那一列同种就收", () => {
		expect(
			accepts(
				table(
					[
						{ kind: "icon" },
						{ kind: "text" },
						{ kind: "mono" },
						{ kind: "tristate", label: "@全体" },
					],
					[
						[
							{ kind: "icon", fallback: "qq" },
							{ kind: "text", text: "小粉" },
							{ kind: "mono", text: "2854196310" },
							{ kind: "tristate", value: "no" },
						],
					],
				),
			),
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

	/**
	 * 按钮显式带 `kind`(决策 39):从前靠「有没有 `action` / `set` 这个键」分,类型挡不住两个键
	 * 同时写 —— 面板按哪一种画全凭它先查哪个键。
	 */
	describe("按钮", () => {
		const button = (b: unknown) => ({ page: [{ type: "button", button: b }] });

		it("不带 kind 的老写法 —— 拒", () => {
			expect(issues(button({ label: "按", action: "poll.now" }))).toContain("page.0.button");
		});

		it("两个键同时写 —— 拒(一颗按钮只做一件事)", () => {
			issues(button({ kind: "action", label: "按", action: "poll.now", set: { kind: "x" } }));
			issues({
				items: {
					links: {
						a: {
							buttons: [
								{ kind: "set", label: "改", set: { bridgeKind: "astrbot" }, action: "poll.now" },
							],
						},
					},
				},
			});
		});

		it("按钮积木是 { type: button, button },不再把按钮的键摊在积木上", () => {
			issues({ page: [{ type: "button", kind: "action", label: "按", action: "poll.now" }] });
		});

		it("调拓展的按钮,动作名要合清单那条规矩(它要进 URL)", () => {
			issues(button({ kind: "action", label: "按", action: "Poll Now" }));
		});

		/** 「改设置」的按钮改的是**这一项**的一格(决策 27)—— 页级没有「这一项」。 */
		it("改设置的按钮只许挂在列表项上 —— 页级积木、页级提示条里的都拒", () => {
			const set = { kind: "set", label: "改掉", set: { kind: "astrbot" } };
			expect(issues(button(set))).toContain("button.set");
			expect(
				issues({ page: [{ type: "notice", tone: "info", text: "x", button: set }] }),
			).toContain("button.set");
		});

		it("一格都不改的「改设置」—— 拒", () => {
			issues({ items: { links: { a: { buttons: [{ kind: "set", label: "改", set: {} }] } } } });
		});
	});

	/**
	 * 表格的格子**自带种类**(决策 39):宿主只核「这一格与这一列同种」。从前按位置对列,格子在类型
	 * 里只能是 `unknown`,一个字符串落在 icon 列上照样过了类型检查。
	 */
	describe("表格", () => {
		it("一行的格数要和列对上", () => {
			expect(
				issues(table([{ kind: "mono" }, { kind: "mono" }], [[{ kind: "mono", text: "a" }]])),
			).toContain("rows.0");
		});

		it("格子的种类与那一列不同 —— 拒,点名那一格", () => {
			const text = issues(
				table(
					[{ kind: "icon" }, { kind: "tristate", label: "@全体" }],
					[
						[
							{ kind: "icon", fallback: "qq" },
							{ kind: "text", text: "yes" },
						],
					],
				),
			);
			expect(text).toContain("rows.0.1");
		});

		it("不带种类的格(老写法:裸字符串、裸三态词)—— 拒", () => {
			issues(table([{ kind: "mono" }], [["abc"]]));
			issues(table([{ kind: "tristate", label: "@全体" }], [["yes"]]));
			issues(table([{ kind: "text" }], [[{ text: "小粉" }]]));
		});

		it("三态只认那三个词", () => {
			issues(
				table([{ kind: "tristate", label: "@全体" }], [[{ kind: "tristate", value: "maybe" }]]),
			);
		});

		it("图标格的退路最多两个字", () => {
			issues(table([{ kind: "icon" }], [[{ kind: "icon", fallback: "telegram" }]]));
		});
	});

	/**
	 * 图片进顶层的 `images` 字典,格子与二维码按键引用(决策 39):每行内联一份 base64 时,两百个
	 * bot 的视图八百多 KB,每喊一次 `statusChanged()` 就整份重拉。单张的规矩与选项图标同一条。
	 */
	describe("图片", () => {
		it("引用了字典里没有的键 —— 拒,点名那一格", () => {
			expect(
				issues({
					...table([{ kind: "icon" }], [[{ kind: "icon", image: "tg", fallback: "te" }]]),
					images: { qq: PNG },
				}),
			).toContain("page.0.rows.0.0.image");
			expect(issues({ page: [{ type: "qr", image: "login" }] })).toContain("page.0.image");
		});

		it("字典里的图只收图片 data URL,单张封顶", () => {
			issues({ images: { tg: "https://example.invalid/tg.png" } });
			issues({ images: { big: `data:image/png;base64,${"A".repeat(40_000)}` } });
		});

		it("格子里不再收内联的图", () => {
			issues(table([{ kind: "icon" }], [[{ kind: "icon", image: PNG, fallback: "te" }]]));
		});

		it("键的规矩:字母数字开头、不许撞原型上的名字", () => {
			issues({ images: { "": PNG } });
			issues({ images: { "a b": PNG } });
			issues({ images: { constructor: PNG } });
		});
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

describe("一块积木引用了哪些图", () => {
	it("表格的图标格与二维码 —— 去重", () => {
		const blocks = ExtensionBlockSchema.array().parse([
			{
				type: "table",
				columns: [{ kind: "icon" }, { kind: "icon" }],
				rows: [
					[
						{ kind: "icon", image: "qq", fallback: "qq" },
						{ kind: "icon", fallback: "te" },
					],
					[
						{ kind: "icon", image: "qq", fallback: "qq" },
						{ kind: "icon", image: "tg", fallback: "te" },
					],
				],
			},
			{ type: "qr", image: "login" },
			{ type: "notice", tone: "info", text: "没有图" },
		]);
		expect([...viewImageKeysOf(blocks)].sort()).toEqual(["login", "qq", "tg"]);
	});
});

it("整份视图的字节上限是 256 KiB", () => {
	expect(EXTENSION_VIEW_MAX_BYTES).toBe(256 * 1024);
});
