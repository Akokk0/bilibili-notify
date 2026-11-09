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

import type { SettingsField } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { checkExtensionView, faultedExtensionView, type ViewCheckOptions } from "../view-check.js";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 桥那张列表,外加一格数字(拿来钉「值的类型对得上」)与一格单值设置(它不是列表)。 */
const FIELDS: SettingsField[] = [
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

/** 清单声明过的动作(决策 42:只有名字的一串)。 */
const ACTIONS = ["poll.now", "login.start"];

const INPUT: ViewCheckOptions = { fields: FIELDS, actions: ACTIONS, settings: SETTINGS };
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

const check = (raw: unknown, over: Partial<ViewCheckOptions> = {}) =>
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
	it.each([
		[
			"en",
			{
				labels: ["Key-value", "Table", "Notice", "Copyable value", "QR code", "Button"],
				whole: "Entire view",
				item: "This item",
				object: "Expected an object; received array.",
				page: "Page blocks",
				array: "page must be an array of blocks.",
				first: "Page block 1 ",
				extra:
					"Unknown view fields: originalField. A view only supports summary / page / items / images.",
				capWhere: "From page block 33 onward",
				cap: "Page limit: 32. Omitted blocks: 3.",
			},
		],
		[
			"ja",
			{
				labels: ["キーと値", "表", "通知", "コピー可能な値", "QRコード", "ボタン"],
				whole: "ビュー全体",
				item: "この項目",
				object: "オブジェクトが必要ですが、配列が渡されました。",
				page: "ページのブロック",
				array: "pageにはブロックの配列が必要です。",
				first: "ページの1番目のブロック",
				extra:
					"未対応のビューフィールド：originalField。指定できるのはsummary / page / items / imagesのみです。",
				capWhere: "ページの33番目のブロック以降",
				cap: "ページには最大32ブロックまで表示できます。残りの3ブロックは省略しました。",
			},
		],
		[
			"zh-TW",
			{
				labels: ["鍵值", "表格", "提示列", "可複製的值", "QR Code", "按鈕"],
				whole: "整個檢視",
				item: "此項目",
				object: "應提供物件，但收到的是陣列。",
				page: "頁面區塊",
				array: "page 應為區塊陣列。",
				first: "頁面第 1 個區塊",
				extra: "含有不支援的檢視欄位：originalField。檢視只接受 summary / page / items / images。",
				capWhere: "從頁面第 33 個區塊起",
				cap: "頁面最多顯示 32 個區塊，已省略後方 3 個。",
			},
		],
	] as const)(
		"%s localizes structural view faults without dropping valid blocks or existing item identities",
		(locale, text) => {
			i18n.set({ locale, voice: "plain" });
			const whole = check([]);
			expect(whole.view.page).toEqual([{ fault: { where: text.whole, reason: text.object } }]);
			expect(whole.view.items?.links?.a).toEqual({
				fault: { where: text.item, reason: text.object },
			});
			const invalidPage = check({ page: "original" });
			expect(invalidPage.view.page).toEqual([{ fault: { where: text.page, reason: text.array } }]);
			for (const [index, type] of [
				"keyValue",
				"table",
				"notice",
				"copy",
				"qr",
				"button",
			].entries()) {
				expect(check({ page: [{ type }, NOTICE] }).view.page?.[0]).toMatchObject({
					fault: { where: `${text.first}(${text.labels[index]})` },
				});
				expect(check({ page: [{ type }, NOTICE] }).view.page?.[1]).toEqual({ block: NOTICE });
			}
			expect(check({ originalField: true }).view.page).toEqual([
				{ fault: { where: text.whole, reason: text.extra } },
			]);
			const capped = check({ page: Array.from({ length: 35 }, () => NOTICE) });
			expect(capped.view.page?.slice(0, 32)).toEqual(
				Array.from({ length: 32 }, () => ({ block: NOTICE })),
			);
			expect(capped.view.page?.[32]).toEqual({ fault: { where: text.capWhere, reason: text.cap } });
		},
	);

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

	/**
	 * 调拓展的按钮,动作名要是清单声明过的(决策 22 / 42)—— 对不上的那颗按下去只会撞一句「清单里没有
	 * 这个动作」,先在这儿点名:哪一块、哪个名字,别的块照画。
	 */
	it("调拓展的按钮,动作名不是清单声明过的 —— 那一块画不出来,点名那个名字", () => {
		const good = { type: "button", button: { kind: "action", label: "检查", action: "poll.now" } };
		const bad = {
			type: "notice",
			tone: "warn",
			text: "过期了",
			button: { kind: "action", label: "重登", action: "login.again" },
		};
		const { view, problems } = check({ page: [good, bad, NOTICE] });
		expect(view.page?.[0]).toEqual({ block: good });
		const slot = view.page?.[1];
		if (!slot || !("fault" in slot)) throw new Error("第 2 块应该换成了一条提示");
		expect(slot.fault.where).toBe("页上第 2 块(提示条)");
		expect(slot.fault.reason).toContain("button.action");
		expect(slot.fault.reason).toContain("login.again");
		expect(view.page?.[2]).toEqual({ block: NOTICE });
		expect(problems).toHaveLength(1);
	});

	it("清单一个动作都没声明 —— 调拓展的按钮一律画不出来", () => {
		const button = {
			type: "button",
			button: { kind: "action", label: "检查", action: "poll.now" },
		};
		expect(check({ page: [button] }, { actions: [] }).view.page?.[0]).toMatchObject({
			fault: { reason: expect.stringContaining("poll.now") },
		});
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
	it.each([
		[
			"en",
			{
				images: "images must map image keys to images; all images in this view were omitted.",
				items: "items must map list keys to item IDs and their views.",
				byId: "items.links must map item IDs to their views.",
				undeclared:
					'items entry "originalList" is not a list setting declared in the manifest; it was omitted.',
				missing: 'Item "original-id" does not exist in list items.links; it was omitted.',
				action:
					'button.action: Action "original.action" is not declared in the manifest\'s actions. Declare it first.',
				fields: [
					"id is assigned by BN",
					'Field "originalField" is not declared in this list.',
					'Field "token" is secret or generated',
					'Field "retries" expects number, but received string.',
					'"originalOption" is not an option for field "bridgeKind".',
				],
			},
		],
		[
			"ja",
			{
				images:
					"imagesには画像キーと画像の対応表が必要です。このビューの画像はすべて省略しました。",
				items: "itemsにはリストのキー、項目ID、ビューの対応表が必要です。",
				byId: "items.linksには項目IDとビューの対応表が必要です。",
				undeclared:
					"itemsの「originalList」はマニフェストに宣言されたリスト設定ではないため、省略しました。",
				missing: "items.linksに項目「original-id」は存在しないため、省略しました。",
				action:
					"button.action：アクション「original.action」がマニフェストのactionsにありません。先に宣言してください。",
				fields: [
					"idはBNが割り当てるため",
					"「originalField」はこのリストで宣言されていません。",
					"「token」はシークレットまたは生成値",
					"「retries」はnumberですが、stringが渡されました。",
					'「bridgeKind」の選択肢に"originalOption"はありません。',
				],
			},
		],
		[
			"zh-TW",
			{
				images: "images 應為圖片鍵與圖片的對照表，已省略此檢視的所有圖片。",
				items: "items 應為清單鍵、項目 ID 與檢視的對照表。",
				byId: "items.links 應為項目 ID 與檢視的對照表。",
				undeclared: "items 中的「originalList」不是資訊清單宣告的清單設定，已省略。",
				missing: "items.links 中不存在項目「original-id」，已省略。",
				action: "button.action：資訊清單的 actions 未宣告「original.action」，請先宣告。",
				fields: [
					"id 由 BN 指派",
					"此清單未宣告欄位「originalField」。",
					"欄位「token」是密鑰或產生的值",
					"欄位「retries」應為 number，但收到的是 string。",
					'欄位「bridgeKind」沒有選項 "originalOption"。',
				],
			},
		],
	] as const)(
		"%s explains list and action validation while preserving valid items and protected settings",
		(locale, text) => {
			i18n.set({ locale, voice: "plain" });
			expect(check({ images: [] }).problems).toEqual([text.images]);
			expect(check({ items: [] }).view.items?.links?.a).toMatchObject({
				fault: { reason: text.items },
			});
			expect(check({ items: { links: [] } }).view.items?.links?.a).toMatchObject({
				fault: { reason: text.byId },
			});
			expect(check({ items: { originalList: {}, links: { "original-id": {} } } }).problems).toEqual(
				[text.undeclared, text.missing],
			);
			const action = check({
				page: [
					{
						type: "button",
						button: { kind: "action", label: "Original label 原文", action: "original.action" },
					},
					NOTICE,
				],
			});
			expect(action.view.page?.[0]).toMatchObject({ fault: { reason: text.action } });
			expect(action.view.page?.[1]).toEqual({ block: NOTICE });
			const protectedItem = check({
				items: {
					links: {
						a: {
							buttons: [
								{
									kind: "set",
									label: "Original label 原文",
									set: {
										id: "new-id",
										originalField: "raw",
										token: "original-secret",
										retries: "bad",
										bridgeKind: "originalOption",
									},
								},
							],
						},
						b: { status: { tone: "ok", text: "Original status 原文" } },
					},
				},
			});
			const slot = protectedItem.view.items?.links?.a;
			if (!slot || !("fault" in slot))
				throw new Error("Expected a fault for a protected-setting mutation");
			for (const reason of text.fields) expect(slot.fault.reason).toContain(reason);
			expect(slot.fault.reason).not.toContain("original-secret");
			expect(protectedItem.view.items?.links?.b).toEqual({
				view: { status: { tone: "ok", text: "Original status 原文" } },
			});
		},
	);

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

/** 列表项上的「调拓展」按钮也照清单核:卡头上的、藏在积木里的,对不上的那一项整项画不出来。 */
describe("列表项上「调拓展」的按钮", () => {
	const item = (view: Record<string, unknown>) =>
		check({ items: { links: { a: view, b: { status: { tone: "ok", text: "已连接" } } } } }).view
			.items?.links;

	it("声明过的 —— 照画", () => {
		expect(
			item({ buttons: [{ kind: "action", label: "踢下线", action: "login.start" }] })?.a,
		).toHaveProperty("view");
	});

	it("卡头上的没声明 —— 那一项画不出来,点名那一颗;别的项照画", () => {
		const links = item({ buttons: [{ kind: "action", label: "踢下线", action: "kick" }] });
		const slot = links?.a;
		if (!slot || !("fault" in slot)) throw new Error("应该画不出来");
		expect(slot.fault.reason).toContain("buttons.0.action");
		expect(slot.fault.reason).toContain("kick");
		expect(links?.b).toHaveProperty("view");
	});

	it("藏在积木里的没声明 —— 同样按项降级", () => {
		const slot = item({
			lead: [
				{
					type: "notice",
					tone: "warn",
					text: "x",
					button: { kind: "action", label: "重连", action: "reconnect" },
				},
			],
		})?.a;
		expect(slot).toMatchObject({
			fault: { reason: expect.stringContaining("lead.0.button.action") },
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
	it.each([
		[
			"en",
			"Page block 2 (Table)",
			"Serialized view size:",
			"Cannot render the summary; the list-page summary was omitted:",
			"This item",
			'Item "a" in items.links',
		],
		[
			"ja",
			"ページの2番目のブロック(表)",
			"ビュー全体は",
			"概要を表示できないため、一覧ページでは省略しました：",
			"この項目",
			"items.linksの項目「a」",
		],
		[
			"zh-TW",
			"頁面第 2 個區塊(表格)",
			"檢視序列化後為",
			"無法顯示摘要，已省略清單頁的摘要：",
			"此項目",
			"items.links 中的項目「a」",
		],
	] as const)(
		"%s localizes size downgrades without dropping small blocks or the other list item",
		(locale, where, size, summary, itemWhere, itemLog) => {
			i18n.set({ locale, voice: "plain" });
			const large = check(
				{ summary: { text: "Original summary 原文" }, page: [NOTICE, table(longRows(40)), COPY] },
				{ maxBytes: LIMIT },
			);
			expect(large.view.page?.[0]).toEqual({ block: NOTICE });
			expect(large.view.page?.[2]).toEqual({ block: COPY });
			expect(large.view.summary).toEqual({ text: "Original summary 原文" });
			expect(large.view.page?.[1]).toMatchObject({
				fault: { where, reason: expect.stringContaining(size) },
			});
			expect(JSON.stringify(large.view.page?.[1])).toContain("4 KB");
			expect(bytes(large.view)).toBeLessThanOrEqual(LIMIT);
			const summaryOnly = check({ summary: { text: "x".repeat(900) } }, { maxBytes: 256 });
			expect(summaryOnly.view.summary).toBeUndefined();
			expect(summaryOnly.problems[0]).toContain(summary);
			const items = check(
				{
					items: {
						links: {
							a: { blocks: [table(longRows(40))] },
							b: { status: { tone: "ok", text: "Original status 原文" } },
						},
					},
				},
				{ maxBytes: LIMIT },
			);
			expect(items.view.items?.links?.a).toMatchObject({
				fault: { where: itemWhere, reason: expect.stringContaining(size) },
			});
			expect(items.problems[0]).toContain(itemLog);
			expect(items.view.items?.links?.b).toEqual({
				view: { status: { tone: "ok", text: "Original status 原文" } },
			});
			expect(bytes(items.view)).toBeLessThanOrEqual(LIMIT);
		},
	);

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
