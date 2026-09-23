/**
 * 宿主怎么核一份 v2 视图(ADR-0019 决策 39 / 40):**按主人看的单位降级** —— 页上按块、列表按项、
 * 摘要单独。坏的只换掉那一块 / 那一项(换成一条点名「哪儿、为什么」的提示),好的照画。
 *
 * 从前是「一格不对整份不画」:一个对端报来的超长名字就让整页连同列表页那一行一起消失,逼得每个
 * 拓展抄一份宿主的上限自己截断。
 *
 * 这里还钉着只有宿主判得了的几条:`items` 的键要对得上清单与存着的设置、「改设置」只许改这一项
 * 声明过的格、整份视图有字节上限。
 */

import type { ExtensionManifestField } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { checkExtensionView, faultedExtensionView, type ViewCheckInput } from "../view-check.js";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 桥那张列表,外加一格数字(拿来钉「值的类型对得上」)与一格单值设置(它不是列表)。 */
const FIELDS: ExtensionManifestField[] = [
	{ key: "nick", type: "string", label: "昵称" },
	{
		key: "links",
		type: "list",
		label: "桥接入",
		title: "name",
		toggle: "enabled",
		fields: [
			{
				key: "bridgeKind",
				type: "enum",
				label: "哪一种桥",
				options: [
					{ value: "koishi", label: "koishi" },
					{ value: "astrbot", label: "AstrBot" },
				],
			},
			{ key: "name", type: "string", label: "名字", required: true },
			{ key: "token", type: "string", label: "token", secret: true, generate: true, default: "" },
			{ key: "apiKey", type: "string", label: "API key", secret: true },
			{ key: "retries", type: "number", label: "重试" },
			{ key: "enabled", type: "boolean", label: "启用", default: true },
		],
	},
];

const SETTINGS = {
	nick: "小粉",
	links: [
		{ id: "a", name: "家里那台", bridgeKind: "koishi", token: "t", enabled: true },
		{ id: "b", name: "机房那台", bridgeKind: "astrbot", token: "u", enabled: true },
	],
};

const INPUT: ViewCheckInput = { fields: FIELDS, settings: SETTINGS };

const check = (raw: unknown, over: Partial<ViewCheckInput> = {}) =>
	checkExtensionView(raw, { ...INPUT, ...over });

const NOTICE = { type: "notice", tone: "info", text: "照常" } as const;
const COPY = { type: "copy", label: "BN 地址", value: { host: "extensionUrl" } } as const;

/** 一张 icon + text 的表。`rows` 由用例给。 */
const table = (rows: unknown[][]) => ({
	type: "table",
	columns: [{ kind: "icon" }, { kind: "text" }],
	rows,
});

describe("页上按块", () => {
	it("好的块照原样交出去,次序不变", () => {
		const { view, problems } = check({ page: [NOTICE, COPY] });
		expect(view.page).toEqual([{ block: NOTICE }, { block: COPY }]);
		expect(problems).toEqual([]);
	});

	it("坏一块只换掉那一块:点名第几块、什么积木、哪一格为什么", () => {
		const bad = table([
			[
				{ kind: "text", text: "qq" },
				{ kind: "text", text: "小粉" },
			],
		]);
		const { view, problems } = check({ page: [NOTICE, bad, COPY] });
		expect(view.page?.[0]).toEqual({ block: NOTICE });
		expect(view.page?.[2]).toEqual({ block: COPY });
		const slot = view.page?.[1];
		if (!slot || !("fault" in slot)) throw new Error("第 2 块应该换成了一条提示");
		expect(slot.fault.where).toBe("页上第 2 块(表格)");
		expect(slot.fault.reason).toContain("rows.0.0");
		expect(slot.fault.reason).toContain("这一格是 text,那一列是 icon");
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("页上第 2 块(表格)");
	});

	it("不认识的积木:说清是哪一种、为什么不画", () => {
		const slot = check({ page: [{ type: "chart", data: [1] }] }).view.page?.[0];
		expect(slot).toEqual({
			fault: {
				where: "页上第 1 块(「chart」)",
				reason: expect.stringContaining("不认识"),
			},
		});
	});

	it("页上的「改设置」按钮 —— 那一块画不出来(页上没有「这一项」)", () => {
		const set = { kind: "set", label: "改掉", set: { bridgeKind: "astrbot" } };
		const { view } = check({ page: [{ type: "button", button: set }, NOTICE] });
		expect(view.page?.[0]).toMatchObject({ fault: { reason: expect.stringContaining("列表项") } });
		expect(view.page?.[1]).toEqual({ block: NOTICE });
	});

	it("引用了字典里没有的图 —— 那一块画不出来,说清是哪张", () => {
		const { view } = check({
			page: [
				table([
					[
						{ kind: "icon", image: "tg", fallback: "te" },
						{ kind: "text", text: "x" },
					],
				]),
			],
			images: { qq: PNG },
		});
		expect(view.page?.[0]).toMatchObject({ fault: { reason: expect.stringContaining("「tg」") } });
	});

	it("page 不是一串 —— 页上一条提示", () => {
		const { view } = check({ page: { type: "notice" } });
		expect(view.page).toEqual([{ fault: { where: "页上的积木", reason: expect.any(String) } }]);
	});

	it("超过 32 块:前 32 块照画,后面的说一句少画了几块", () => {
		const { view } = check({ page: Array.from({ length: 35 }, () => NOTICE) });
		expect(view.page).toHaveLength(33);
		expect(view.page?.slice(0, 32).every((slot) => "block" in slot)).toBe(true);
		expect(view.page?.[32]).toMatchObject({ fault: { reason: expect.stringContaining("3 块") } });
	});
});

describe("列表按项", () => {
	it("好的项照原样交出去", () => {
		const item = { status: { tone: "ok", text: "已连接" }, blocks: [NOTICE] };
		expect(check({ items: { links: { a: item } } }).view.items).toEqual({
			links: { a: { view: item } },
		});
	});

	it("坏一项只换掉那一项(卡上写「状态未知」),别的项照画", () => {
		const { view, problems } = check({
			items: {
				links: {
					a: { status: { tone: "danger", text: "坏了" } },
					b: { status: { tone: "ok", text: "已连接" } },
				},
			},
		});
		expect(view.items?.links?.a).toEqual({
			fault: { where: "这一项", reason: expect.stringContaining("status.tone") },
		});
		expect(view.items?.links?.b).toEqual({ view: { status: { tone: "ok", text: "已连接" } } });
		expect(problems).toHaveLength(1);
	});

	/** 项里一块积木坏了 —— 按项算,不是按块:列表的单位是「一项」。 */
	it("项里的一块积木坏了 —— 整项画不出来", () => {
		const { view } = check({
			items: { links: { a: { status: { tone: "ok", text: "好" }, lead: [{ type: "chart" }] } } },
		});
		expect(view.items?.links?.a).toMatchObject({ fault: { where: "这一项" } });
	});

	it("第一层的键不是清单里声明过的列表 —— 丢掉,记一句", () => {
		const { view, problems } = check({
			items: { links: { a: {} }, nick: { a: {} }, ghosts: { a: {} } },
		});
		expect(Object.keys(view.items ?? {})).toEqual(["links"]);
		expect(problems.join("\n")).toContain("nick");
		expect(problems.join("\n")).toContain("ghosts");
	});

	it("第二层的键不是那张列表里现存的项 —— 丢掉,记一句", () => {
		const { view, problems } = check({ items: { links: { a: {}, gone: {} } } });
		expect(Object.keys(view.items?.links ?? {})).toEqual(["a"]);
		expect(problems.join("\n")).toContain("gone");
	});

	it("items 不是一张表 —— 每一条现存的项都画不出来", () => {
		const { view } = check({ items: [] });
		expect(view.items?.links?.a).toMatchObject({ fault: { where: "这一项" } });
		expect(view.items?.links?.b).toMatchObject({ fault: { where: "这一项" } });
	});

	/**
	 * 「改设置」的按钮只许改**这一项声明过的格**(决策 39):`id` 是 BN 给的身份,密钥与生成的格有
	 * 自己的路(重新生成),值的类型要对得上 —— 否则那一发写要么被拒、要么写进去一份拓展自己一读就
	 * 整份失败的设置。
	 */
	describe("「改设置」的按钮", () => {
		const withButton = (set: Record<string, unknown>) =>
			check({ items: { links: { a: { buttons: [{ kind: "set", label: "改", set }] } } } }).view
				.items?.links?.a;

		it("改声明过的格、类型对得上 —— 照画", () => {
			expect(withButton({ bridgeKind: "astrbot", retries: 3, enabled: false })).toHaveProperty(
				"view",
			);
		});

		it.each([
			["id", { id: "hijacked" }, "id"],
			["没声明的格", { bogus: 1 }, "bogus"],
			["生成的格", { token: "x" }, "token"],
			["密钥格", { apiKey: "x" }, "apiKey"],
			["数字格给了字符串", { retries: "3" }, "retries"],
			["布尔格给了字符串", { enabled: "false" }, "enabled"],
			["枚举不在选项里", { bridgeKind: "nonebot" }, "bridgeKind"],
		])("%s —— 那一项画不出来,点名那一格", (_what, set, key) => {
			const slot = withButton(set);
			if (!slot || !("fault" in slot)) throw new Error("应该画不出来");
			expect(slot.fault.reason).toContain(`buttons.0.set.${key}`);
		});

		it("藏在积木里的也核(提示条上的、单独一颗的)", () => {
			const bad = { kind: "set", label: "改", set: { bogus: 1 } };
			const lead = check({
				items: {
					links: { a: { lead: [{ type: "notice", tone: "warn", text: "x", button: bad }] } },
				},
			}).view.items?.links?.a;
			expect(lead).toMatchObject({
				fault: { reason: expect.stringContaining("lead.0.button.set") },
			});
			const blocks = check({
				items: { links: { a: { blocks: [{ type: "button", button: bad }] } } },
			}).view.items?.links?.a;
			expect(blocks).toMatchObject({
				fault: { reason: expect.stringContaining("blocks.0.button.set") },
			});
		});
	});
});

describe("摘要单独", () => {
	it("摘要坏了就不画,记一句;页与项照画", () => {
		const { view, problems } = check({
			summary: { tone: "ok", text: "x", color: "red" },
			page: [NOTICE],
			items: { links: { a: {} } },
		});
		expect(view.summary).toBeUndefined();
		expect(view.page).toEqual([{ block: NOTICE }]);
		expect(view.items?.links?.a).toEqual({ view: {} });
		expect(problems.join("\n")).toContain("摘要");
	});

	it("好的摘要照原样", () => {
		const summary = { tone: "ok", text: [{ b: "2" }, " 个 bot 在线"] };
		expect(check({ summary }).view.summary).toEqual(summary);
	});
});

describe("图片字典", () => {
	const iconRow = (image: string) => [
		{ kind: "icon", image, fallback: "qq" },
		{ kind: "text", text: "小粉" },
	];

	it("一张图不合规矩:引用它的块画不出来(说清那张图为什么不行),别的块照画", () => {
		const { view, problems } = check({
			page: [table([iconRow("bad")]), table([iconRow("qq")])],
			images: { qq: PNG, bad: "https://example.invalid/x.png" },
		});
		expect(view.page?.[0]).toMatchObject({ fault: { reason: expect.stringContaining("「bad」") } });
		expect(view.page?.[1]).toHaveProperty("block");
		expect(view.images).toEqual({ qq: PNG });
		expect(problems.join("\n")).toContain("images.bad");
	});

	it("没人引用的图不下发", () => {
		const { view } = check({ page: [table([iconRow("qq")])], images: { qq: PNG, spare: PNG } });
		expect(view.images).toEqual({ qq: PNG });
	});
});

describe("整份", () => {
	it("不是一个对象 —— 页上一条提示,每一条现存的项都画不出来", () => {
		const { view } = check("not a view");
		expect(view.page).toEqual([{ fault: { where: "整份视图", reason: expect.any(String) } }]);
		expect(view.items?.links?.a).toMatchObject({ fault: { where: "这一项" } });
		expect(view.items?.links?.b).toMatchObject({ fault: { where: "这一项" } });
		expect(view.summary).toBeUndefined();
	});

	it("顶层多了一格 —— 页上一条提示点名它,其余照画", () => {
		const { view } = check({ page: [NOTICE], extra: 1 });
		expect(view.page?.[0]).toMatchObject({
			fault: { where: "整份视图", reason: expect.stringContaining("extra") },
		});
		expect(view.page?.[1]).toEqual({ block: NOTICE });
	});

	it("宿主自己判它整份不能用(交回 Promise、回调抛了)—— 同一种样子", () => {
		const { view, problems } = faultedExtensionView("回调抛了", INPUT);
		expect(view.page).toEqual([{ fault: { where: "整份视图", reason: "回调抛了" } }]);
		expect(view.items?.links?.a).toEqual({ fault: { where: "这一项", reason: "回调抛了" } });
		expect(problems).toEqual(["整份视图画不出来:回调抛了"]);
	});
});

/**
 * 整份视图序列化后有字节上限(决策 39):面板每收到一声 `statusChanged()` 就整份重拉。超了**按块 /
 * 按项**降级:先放下最重的那一块(连同它引用的图一起算),直到整份回到上限以内。
 */
describe("字节上限", () => {
	const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
	const LIMIT = 4096;
	const longRows = (n: number) =>
		Array.from({ length: n }, (_, i) => [
			{ kind: "icon", fallback: "qq" },
			{ kind: "text", text: `bot ${i} ${"长".repeat(60)}` },
		]);

	it("一张大表把整份撑过上限:只换掉它(说清整份多大、上限多大、它多大),别的照画", () => {
		const { view, problems } = check(
			{
				summary: { text: "3 个 bot 在线" },
				page: [NOTICE, table(longRows(40)), COPY],
				items: { links: { a: { status: { tone: "ok", text: "已连接" } } } },
			},
			{ maxBytes: LIMIT },
		);
		expect(view.page?.[0]).toEqual({ block: NOTICE });
		expect(view.page?.[2]).toEqual({ block: COPY });
		const slot = view.page?.[1];
		if (!slot || !("fault" in slot)) throw new Error("大表应该换成了一条提示");
		expect(slot.fault.reason).toMatch(/整份视图.*KB.*上限 4 KB/);
		expect(slot.fault.reason).toMatch(/这一块.*KB/);
		expect(view.summary).toEqual({ text: "3 个 bot 在线" });
		expect(view.items?.links?.a).toHaveProperty("view");
		expect(bytes(view)).toBeLessThanOrEqual(LIMIT);
		expect(problems).toHaveLength(1);
	});

	it("图算在引用它的那一块头上:字少图大的那块先放下", () => {
		const bigImage = `data:image/png;base64,${"A".repeat(3000)}`;
		const { view } = check(
			{
				page: [
					// 字多、不带图:一千来字节
					table(longRows(4)),
					// 字少、带一张三千字节的图
					table([
						[
							{ kind: "icon", image: "big", fallback: "qq" },
							{ kind: "text", text: "x" },
						],
					]),
				],
				images: { big: bigImage },
			},
			{ maxBytes: LIMIT },
		);
		expect(view.page?.[0]).toHaveProperty("block");
		expect(view.page?.[1]).toHaveProperty("fault");
		// 放下它之后那张图没人引用了,也不下发
		expect(view.images).toBeUndefined();
	});

	it("列表的一项太大 —— 那一项画不出来,卡上说清", () => {
		const { view } = check(
			{
				items: {
					links: {
						a: { blocks: [table(longRows(40))] },
						b: { status: { tone: "ok", text: "已连接" } },
					},
				},
			},
			{ maxBytes: LIMIT },
		);
		expect(view.items?.links?.a).toMatchObject({
			fault: { where: "这一项", reason: expect.stringContaining("上限") },
		});
		expect(view.items?.links?.b).toHaveProperty("view");
	});

	it("没超就一块都不动", () => {
		const raw = { page: [NOTICE, table(longRows(2))] };
		expect(check(raw, { maxBytes: LIMIT }).view.page?.every((slot) => "block" in slot)).toBe(true);
	});
});
