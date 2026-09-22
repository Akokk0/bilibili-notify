/**
 * `extension.json` —— 拓展包的清单。
 *
 * 清单存在的理由是**它要在代码跑起来之前就能回答问题**(ADR-0012 决策 8):
 * 面板要列出「装了但没启用」的拓展,而没启用就不该 `import()` 它;兼容性不合的拓展要
 * 「不加载 + 说清楚为什么」,而不是「加载了、注册到一半炸掉」;失败记账要拿得到身份,
 * 可偏偏最容易炸的就是 import 那一步 —— 炸了的话代码里的导出根本取不到。
 *
 * 所以这份 schema 校验的是**一段谁都没执行过的 JSON**,它必须自己把话说全。
 *
 * 清单有两档格式(ADR-0019 决策 16 / 18):v1 声明写在代码里、清单只报 `provides`;
 * v2 把静态声明全搬进清单(`settings` / `actions` / `contributes`)。宿主认一个区间,
 * **先单读 `apiVersion`,再按那一档的格式校验其余**。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	EXTENSION_API_RANGE,
	type ExtensionApiRange,
	ExtensionIdSchema,
	type ExtensionManifest,
	type ExtensionManifestRead,
	extensionNamespaceOf,
	manifestProvides,
	manifestSecretKeys,
	parseExtensionManifest,
	settingsValueSchema,
} from "./extension-manifest";

function v1(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "demo-ext",
		name: "机器人框架桥接",
		description: "把 koishi / AstrBot 里已经配好的机器人借给 BN 用。",
		version: "1.0.0",
		apiVersion: 1,
		provides: ["push"],
		...over,
	};
}

const DISPLAY = { label: "抖音", shortLabel: "抖", color: "#fe2c55" };

/** 一枚最小的图片 data URL(1×1 PNG)。 */
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function v2(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "demo-ext",
		name: "抖音订阅",
		description: "盯着抖音作者的新作品与开播。",
		version: "0.1.0",
		apiVersion: 2,
		contributes: { subscription: { display: DISPLAY, events: ["post"] } },
		...over,
	};
}

/** 只改 `contributes.subscription` 里的几格。 */
function sub(over: Record<string, unknown>): Record<string, unknown> {
	return v2({ contributes: { subscription: { display: DISPLAY, events: ["post"], ...over } } });
}

/** 只摆一格设置项。 */
function withField(field: Record<string, unknown>): Record<string, unknown> {
	return v2({ settings: { fields: [field] } });
}

function ok(raw: unknown, range?: ExtensionApiRange): ExtensionManifest {
	const r = parseExtensionManifest(raw, range);
	if (!r.ok) throw new Error(`应该收下,却是 ${r.reason}:${JSON.stringify(r)}`);
	return r.manifest;
}

function unreadable(raw: unknown, range?: ExtensionApiRange): string[] {
	const r = parseExtensionManifest(raw, range);
	if (r.ok || r.reason !== "unreadable") {
		throw new Error(`应该读不了,却是 ${JSON.stringify(r)}`);
	}
	return r.issues;
}

function incompatible(
	raw: unknown,
	range?: ExtensionApiRange,
): Extract<ExtensionManifestRead, { reason: "incompatible" }> {
	const r = parseExtensionManifest(raw, range);
	if (r.ok || r.reason !== "incompatible") {
		throw new Error(`应该判不兼容,却是 ${JSON.stringify(r)}`);
	}
	return r;
}

describe("parseExtensionManifest —— 两档格式", () => {
	it("宿主这一版认 v1 到 v2", () => {
		expect(EXTENSION_API_RANGE).toEqual({ min: 1, current: 2 });
	});

	it("v1 最小清单 —— 光靠它就能把拓展列在面板上,不必先加载代码", () => {
		const m = ok(v1());
		expect(m.apiVersion).toBe(1);
		expect(m.id).toBe("demo-ext");
		expect(m.version).toBe("1.0.0");
		expect(manifestProvides(m)).toEqual(["push"]);
		// 图标是可选的 —— 没有就退回灰方章,不是拒绝加载的理由。
		expect(m.icon).toBeUndefined();
	});

	it("v2 最小清单:开哪一口由 contributes 的键推出来,不再单写 provides", () => {
		const m = ok(v2());
		expect(m.apiVersion).toBe(2);
		expect(manifestProvides(m)).toEqual(["subscription"]);
	});

	it("v2 两口都开时,推出来的次序是固定的(push 在前),不随清单里的键序走", () => {
		const m = ok(
			v2({
				contributes: {
					subscription: { display: DISPLAY, events: ["post"] },
					push: { display: DISPLAY },
				},
			}),
		);
		expect(manifestProvides(m)).toEqual(["push", "subscription"]);
	});

	/** ADR-0019 决策 16 那份示例 —— 文档与代码说的必须是同一种格式。 */
	it("ADR 里那份抖音示例原样收下", () => {
		const m = ok({
			$schema: "https://example.invalid/extension.schema.json",
			id: "douyin",
			name: "抖音订阅",
			description: "盯着抖音作者的新作品与开播。",
			version: "0.1.0",
			icon: '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>',
			apiVersion: 2,
			settings: {
				fields: [
					{
						key: "cookie",
						type: "string",
						label: "Cookie",
						required: true,
						secret: true,
						multiline: true,
					},
				],
			},
			actions: { "login.start": { label: "扫码登录" } },
			contributes: {
				subscription: {
					display: { label: "抖音", shortLabel: "抖", color: "#fe2c55", postNoun: "作品" },
					events: ["post", "liveStart", "liveEnd"],
					cardSkin: "card-skin",
				},
			},
		});
		if (m.apiVersion !== 2) throw new Error("应该是 v2");
		expect(m.settings?.fields[0]).toMatchObject({ key: "cookie", type: "string", secret: true });
		expect(m.contributes.subscription?.display.postNoun).toBe("作品");
	});

	it("推送源那一段:外观 + 连接配置项;桥那种「连接是挑出来的」可以不写 connection", () => {
		const withConnection = ok(
			v2({
				contributes: {
					push: {
						display: DISPLAY,
						connection: { fields: [{ key: "endpoint", type: "string", label: "地址" }] },
					},
				},
			}),
		);
		if (withConnection.apiVersion !== 2) throw new Error("应该是 v2");
		expect(withConnection.contributes.push?.connection?.fields).toHaveLength(1);
		expect(() => ok(v2({ contributes: { push: { display: DISPLAY } } }))).not.toThrow();
	});
});

describe("parseExtensionManifest —— 先单读 apiVersion", () => {
	/**
	 * 为将来的宿主写的清单,**格式本来就可能是我们不认识的**。按今天的规矩挑它的毛病只会
	 * 报出一堆「读不了」,而真正的原因只有一条 —— 版本不合。
	 */
	it("高于当前档:判不兼容,哪怕其余部分是我们不认识的格式", () => {
		const r = incompatible({
			id: "future",
			name: "未来的拓展",
			description: "用的是 v3 的格式。",
			version: "3.0.0",
			apiVersion: 3,
			contributes: { chat: { whatever: true } },
			somethingNew: [1, 2, 3],
		});
		expect(r.requires).toBe(3);
		// 身份那几格**所有档位都读得出来** —— 面板照样能写出「××× 3.0.0 要更新的 BN」。
		expect(r.identity).toMatchObject({ id: "future", name: "未来的拓展", version: "3.0.0" });
	});

	it("低于最低档:同样判不兼容(宿主抬过最低档之后,老拓展停在门外)", () => {
		const r = incompatible(v1(), { min: 2, current: 3 });
		expect(r.requires).toBe(1);
		expect(r.identity.id).toBe("demo-ext");
	});

	it("在区间里就按那一档校验 —— 同一份 v1 清单,区间变了照样收", () => {
		expect(ok(v1(), { min: 1, current: 5 }).apiVersion).toBe(1);
	});

	it("版本不合、身份那几格也坏了:读不了(那几格在哪一档都是坏的)", () => {
		const issues = unreadable({ ...v1({ apiVersion: 9 }), id: "Bad Id" });
		expect(issues.join("\n")).toContain("id");
	});

	it.each([
		["缺", undefined],
		["不是整数", 1.5],
		["不是数", "2"],
		["零", 0],
	])("apiVersion %s —— 读不了,而且点名是 apiVersion", (_label, apiVersion) => {
		const issues = unreadable(v1({ apiVersion }));
		expect(issues.join("\n")).toContain("apiVersion");
	});

	it("不是对象 —— 读不了", () => {
		expect(unreadable([1, 2]).length).toBeGreaterThan(0);
		expect(unreadable(null).length).toBeGreaterThan(0);
	});
});

/**
 * 身份那几格在两档里是同一套规矩。
 *
 * id 同时是**三个地方的一段**:URL(`/ext/:id/*`)、装载目录
 * (`<dataDir>/extensions/<id>/`)、失败记账的键。所以它比「非空字符串」要严得多,
 * 而且必须**在清单校验这一步**拦住 —— 放过去之后每一处都得自己防一遍。
 */
describe.each([
	["v1", v1],
	["v2", v2],
])("身份那几格(%s)", (_label, build) => {
	it.each(["demo-ext", "douyin-source", "x2"])("id %s —— 收下", (id) => {
		expect(ok(build({ id })).id).toBe(id);
	});

	it.each([
		["..", "路径穿越:装载目录是 <dataDir>/extensions/<id>/"],
		[".", "同上"],
		["a/b", "斜杠会把 /ext/:id/* 劈成两段"],
		["a b", "空格进 URL 要转义,转义完就跟目录名对不上了"],
		["Douyin", "大写:macOS / Windows 的文件系统不分大小写,Douyin 与 douyin 会撞同一个目录"],
		["-lead", "连字符开头 / 结尾:肉眼难认,复制粘贴容易掉"],
		["trail-", "同上"],
		["a".repeat(65), "长度没上限的话它会变成一段没人读得完的 URL"],
		["", "空"],
	])("id %s —— 拒(%s)", (id) => {
		unreadable(build({ id }));
	});

	/**
	 * 版本号是**失败记账的另一半**(ADR-0012 后果段:按 id + 版本记账,连续失败自动停用)。
	 * 记账的键要能比大小、要能一眼看出「换过版本了」,所以它得是个真 semver,不是随手一串。
	 */
	it.each(["1.0.0", "0.1.2", "1.0.0-alpha.1", "10.20.30"])("version %s —— 收下", (version) => {
		expect(ok(build({ version })).version).toBe(version);
	});

	it.each(["1", "1.0", "v1.0.0", "latest", "1.0.0.0", "01.0.0", "1.0.0+build.1"])(
		"version %s —— 拒",
		(version) => {
			unreadable(build({ version }));
		},
	);

	it("图标有长度上限 —— 清单是要进签名摘要、还要随列表发到面板的那份", () => {
		const small = `<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>`;
		expect(ok(build({ icon: small })).icon).toBe(small);
		unreadable(build({ icon: "x".repeat(64_001) }));
	});
});

describe("v1:格式已冻结,照旧宽松", () => {
	it("多出来的字段丢掉而不是拒绝 —— 已经发出去的 v1 包不能因为宿主升级变成读不了", () => {
		const m = ok(v1({ futureField: "?" }));
		expect(m).not.toHaveProperty("futureField");
	});

	it("开哪一口必须写清楚,而且不能一口都不开", () => {
		unreadable(v1({ provides: [] }));
		expect(manifestProvides(ok(v1({ provides: ["subscription"] })))).toEqual(["subscription"]);
		unreadable(v1({ provides: ["kitchen-sink"] }));
	});
});

/**
 * v2 是**严格**的:多一个键就读不了。拼错的键(`setings`)放过去就是一格静默失效的声明
 * —— 面板上少了一栏,没人报错。格式要长新东西,跟着升 apiVersion(区间就是干这个的)。
 */
describe("v2:严格", () => {
	it("顶层多一个键 —— 读不了,而且点名那个键", () => {
		expect(unreadable(v2({ setings: { fields: [] } })).join("\n")).toContain("setings");
	});

	it("v2 里还写 provides —— 读不了:它由 contributes 推出来,两处写会打架", () => {
		expect(unreadable(v2({ provides: ["push"] })).join("\n")).toContain("provides");
	});

	it("`$schema` 是唯一额外允许的键(编辑器补全用)", () => {
		expect(() => ok(v2({ $schema: "./extension.schema.json" }))).not.toThrow();
	});

	it("设置项里多一个键 —— 读不了", () => {
		unreadable(withField({ key: "a", type: "string", label: "A", hint: "旧名字" }));
	});

	it("contributes 一口都不开 —— 读不了", () => {
		unreadable(v2({ contributes: {} }));
	});

	it("contributes 里开一个不存在的口 —— 读不了", () => {
		unreadable(v2({ contributes: { chat: { display: DISPLAY } } }));
	});
});

describe("v2 的外观(display)", () => {
	it.each(["#fe2c55", "#FE2C55", "#abc"])("color %s —— 收下", (color) => {
		expect(() => ok(sub({ display: { ...DISPLAY, color } }))).not.toThrow();
	});

	it.each(["red", "#12345", "url(x)", "#fe2c55; background: red", "rgb(0,0,0)"])(
		"color %s —— 拒(清单来自第三方,颜色进样式,只收 hex)",
		(color) => {
			unreadable(sub({ display: { ...DISPLAY, color } }));
		},
	);

	it("名字与短名都不能空", () => {
		unreadable(sub({ display: { ...DISPLAY, label: "" } }));
		unreadable(sub({ display: { ...DISPLAY, shortLabel: "" } }));
	});

	it("postNoun 只有订阅源那段有 —— 推送源的外观写它读不了", () => {
		expect(() => ok(sub({ display: { ...DISPLAY, postNoun: "作品" } }))).not.toThrow();
		unreadable(v2({ contributes: { push: { display: { ...DISPLAY, postNoun: "作品" } } } }));
	});
});

describe("v2 的订阅源段", () => {
	it("events 至少一种、只能是那三种、不能重复", () => {
		unreadable(sub({ events: [] }));
		unreadable(sub({ events: ["post", "gift"] }));
		unreadable(sub({ events: ["post", "post"] }));
	});

	/** 包内路径一律相对拓展根、不带 `./`、不许 `..`(ADR-0019 决策 16)。 */
	it.each(["card-skin", "skins/card-skin", "card_skin.v2"])("cardSkin %s —— 收下", (cardSkin) => {
		expect(() => ok(sub({ cardSkin }))).not.toThrow();
	});

	it.each(["./card-skin", "../card-skin", "/card-skin", "a/../b", "a//b", "a/", "", "a\\b"])(
		"cardSkin %s —— 拒",
		(cardSkin) => {
			unreadable(sub({ cardSkin }));
		},
	);
});

/**
 * 设置项按**数据类型**分,不按控件分(ADR-0019 决策 17),与 zod 一一对应。
 */
describe("v2 的设置项", () => {
	it.each([
		{ key: "cookie", type: "string", label: "Cookie", secret: true, multiline: true },
		{ key: "token", type: "string", label: "Token", secret: true, generate: true, monospace: true },
		{ key: "interval", type: "number", label: "间隔", min: 30, max: 600, step: 10, unit: "秒" },
		{ key: "enabled", type: "boolean", label: "启用", default: true },
		{
			key: "kind",
			type: "enum",
			label: "种类",
			options: [
				{ value: "koishi", label: "koishi", icon: PNG },
				{ value: "astrbot", label: "AstrBot" },
			],
			default: "koishi",
		},
		{
			key: "links",
			type: "list",
			label: "桥接入",
			itemLabel: "接入",
			title: "name",
			fields: [
				{ key: "name", type: "string", label: "名字", required: true },
				{ key: "token", type: "string", label: "Token", secret: true, generate: true },
			],
		},
	])("$type —— 收下", (field) => {
		const m = ok(withField(field));
		if (m.apiVersion !== 2) throw new Error("应该是 v2");
		expect(m.settings?.fields[0]).toMatchObject(field);
	});

	it.each([
		["空", ""],
		["数字开头", "1a"],
		["下划线开头(挡住 __proto__ 这一类)", "__proto__"],
		["带点(面板拿它拼路径)", "a.b"],
		["带连字符", "a-b"],
	])("key %s —— 拒", (_label, key) => {
		unreadable(withField({ key, type: "string", label: "X" }));
	});

	it("同一张表里 key 重复 —— 读不了(哪一栏说了算没有答案)", () => {
		const issues = unreadable(
			v2({
				settings: {
					fields: [
						{ key: "a", type: "string", label: "A" },
						{ key: "a", type: "number", label: "A2" },
					],
				},
			}),
		);
		expect(issues.join("\n")).toContain("a");
	});

	it("默认值的类型要与 type 对得上", () => {
		unreadable(withField({ key: "a", type: "string", label: "A", default: 1 }));
		unreadable(withField({ key: "a", type: "number", label: "A", default: "1" }));
		unreadable(withField({ key: "a", type: "boolean", label: "A", default: "true" }));
	});

	it("enum:至少一个选项、值不重复、默认值必须是选项之一", () => {
		unreadable(withField({ key: "a", type: "enum", label: "A", options: [] }));
		unreadable(
			withField({
				key: "a",
				type: "enum",
				label: "A",
				options: [
					{ value: "x", label: "X" },
					{ value: "x", label: "X2" },
				],
			}),
		);
		unreadable(
			withField({
				key: "a",
				type: "enum",
				label: "A",
				options: [{ value: "x", label: "X" }],
				default: "y",
			}),
		);
	});

	it("number:min 不能大于 max", () => {
		unreadable(withField({ key: "a", type: "number", label: "A", min: 10, max: 1 }));
	});

	it("list:每项至少一栏、只嵌一层(项里不能再有 list)、项里的 key 也不能重复", () => {
		unreadable(withField({ key: "a", type: "list", label: "A", title: "b", fields: [] }));
		unreadable(
			withField({
				key: "a",
				type: "list",
				label: "A",
				title: "b",
				fields: [
					{
						key: "b",
						type: "list",
						label: "B",
						fields: [{ key: "c", type: "string", label: "C" }],
					},
				],
			}),
		);
		unreadable(
			withField({
				key: "a",
				type: "list",
				label: "A",
				title: "b",
				fields: [
					{ key: "b", type: "string", label: "B", required: true },
					{ key: "b", type: "string", label: "B2" },
				],
			}),
		);
	});

	it("不认识的 type —— 读不了(旧名字 text / toggle / select 也不认)", () => {
		for (const type of ["text", "toggle", "select", "json"]) {
			unreadable(withField({ key: "a", type, label: "A" }));
		}
	});

	it("连接配置项与设置项是同一种形状", () => {
		unreadable(
			v2({
				contributes: {
					push: {
						display: DISPLAY,
						connection: { fields: [{ key: "a", type: "text", label: "A" }] },
					},
				},
			}),
		);
	});
});

/**
 * 选项图标是**图片 data URL**,一律当 `<img>` 画(ADR-0019 决策 31):`<img>` 里的 SVG 不跑脚本、
 * 拉不进外部资源,所以不用过 SVG 白名单。规矩与桥协议里 bot 图标那条相同。
 */
describe("v2 的选项图标", () => {
	const enumWith = (icon: unknown) =>
		withField({ key: "a", type: "enum", label: "A", options: [{ value: "x", label: "X", icon }] });

	it.each([
		PNG,
		"data:image/jpeg;base64,/9j/4AAQ",
		"data:image/webp;base64,UklGRg==",
		"data:image/svg+xml;base64,PHN2Zy8+",
	])("%s —— 收下", (icon) => {
		expect(() => ok(enumWith(icon))).not.toThrow();
	});

	it.each([
		["内联 SVG 标记", "<svg viewBox='0 0 1 1'/>"],
		["http 地址(面板一开就去对家点名)", "https://example.invalid/logo.png"],
		["不是 base64", "data:image/svg+xml;utf8,<svg/>"],
		["不是图片", "data:text/html;base64,PGgxPg=="],
		["超过 32 KB", `data:image/png;base64,${"A".repeat(32 * 1024)}`],
	])("%s —— 拒", (_label, icon) => {
		unreadable(enumWith(icon));
	});
});

/**
 * 列表设置项自己声明怎么画成卡(ADR-0019 决策 29)。引用的格必须真在项里、类型也对得上 ——
 * 指歪了的话,面板上那张卡就少一块而没人报错。
 */
describe("v2 的列表声明", () => {
	const ITEM = [
		{ key: "name", type: "string", label: "名字", required: true },
		{
			key: "kind",
			type: "enum",
			label: "种类",
			options: [
				{ value: "koishi", label: "koishi", icon: PNG },
				{ value: "astrbot", label: "AstrBot" },
			],
			default: "koishi",
		},
		{ key: "token", type: "string", label: "token", secret: true, generate: true, monospace: true },
		{ key: "enabled", type: "boolean", label: "启用", default: true },
	];
	const list = (over: Record<string, unknown> = {}) =>
		withField({
			key: "links",
			type: "list",
			label: "桥接入",
			title: "name",
			fields: ITEM,
			...over,
		});

	it("桥那份:标题 / 方块 / 停用开关 / 叫法 / 成对复制 / 删除后果 —— 收下", () => {
		const m = ok(
			list({
				itemLabel: "接入",
				mark: "kind",
				toggle: "enabled",
				description: "在这里建一条,把生成的 token 和 BN 地址填进插件设置里。",
				newItemCopy: [{ host: "extensionUrl", label: "BN 地址" }, { field: "token" }],
				removeWarning: "那一头的插件会连不上,从它借来的 bot 建的连接也会发不出去。",
			}),
		);
		if (m.apiVersion !== 2) throw new Error("应该是 v2");
		expect(m.settings?.fields[0]).toMatchObject({ title: "name", mark: "kind", toggle: "enabled" });
	});

	it("title 必填,而且要指向项里一格**必填的** string —— 卡片总得有个名字", () => {
		unreadable(withField({ key: "links", type: "list", label: "L", fields: ITEM }));
		unreadable(list({ title: "nope" }));
		unreadable(list({ title: "enabled" }));
		unreadable(list({ title: "token" }));
	});

	it("mark 要指向 enum,toggle 要指向 boolean", () => {
		unreadable(list({ mark: "name" }));
		unreadable(list({ mark: "nope" }));
		unreadable(list({ toggle: "kind" }));
		unreadable(list({ toggle: "nope" }));
	});

	it("newItemCopy:host 只认 extensionUrl;field 要指向项里一格 string", () => {
		unreadable(list({ newItemCopy: [{ host: "publicUrl", label: "地址" }] }));
		unreadable(list({ newItemCopy: [{ field: "enabled" }] }));
		unreadable(list({ newItemCopy: [{ field: "nope" }] }));
		unreadable(list({ newItemCopy: [{ host: "extensionUrl" }] }));
	});

	it("项里的字段不许叫 id —— 它由 BN 生成、藏起来(视图按它把积木挂到那一项上)", () => {
		unreadable(
			withField({
				key: "links",
				type: "list",
				label: "L",
				title: "name",
				fields: [...ITEM, { key: "id", type: "string", label: "id" }],
			}),
		);
	});
});

/**
 * 备份脱敏照清单里的密钥声明抹(ADR-0019 决策 17「白捡的三样」之一):清单在代码跑起来之前就
 * 读得到,所以**没在跑的拓展也能精确地抹**,不必整片当密钥。
 */
describe("manifestSecretKeys", () => {
	it("设置项、列表项、连接配置项里标了 secret 的键都算,去重", () => {
		const m = ok(
			v2({
				settings: {
					fields: [
						{ key: "cookie", type: "string", label: "Cookie", secret: true },
						{ key: "interval", type: "number", label: "间隔" },
						{
							key: "links",
							type: "list",
							label: "接入",
							title: "name",
							fields: [
								{ key: "name", type: "string", label: "名字", required: true },
								{ key: "token", type: "string", label: "token", secret: true, generate: true },
							],
						},
					],
				},
				contributes: {
					push: {
						display: DISPLAY,
						connection: {
							fields: [
								{ key: "botKey", type: "string", label: "密钥", secret: true },
								{ key: "token", type: "string", label: "token", secret: true },
							],
						},
					},
				},
			}),
		);
		expect(manifestSecretKeys(m)).toEqual(["botKey", "cookie", "token"]);
	});

	it("v1 的密钥声明在代码里,清单答不出来 —— undefined(不是空表:空表是「一格都不用抹」)", () => {
		expect(manifestSecretKeys(ok(v1()))).toBeUndefined();
	});

	it("v2 一格密钥都没声明 —— 空表", () => {
		expect(manifestSecretKeys(ok(v2()))).toEqual([]);
	});
});

/**
 * BN 写设置之前照声明先校验(ADR-0019 决策 17「白捡的三样」之一)—— 今天那一格是
 * `z.unknown()`,写坏了拓展读到的是一份它解不出的设置(桥:空名单、所有 token 当场失效)。
 */
describe("settingsValueSchema", () => {
	const FIELDS = (() => {
		const m = ok(
			v2({
				settings: {
					fields: [
						{ key: "cookie", type: "string", label: "Cookie", required: true, secret: true },
						{ key: "interval", type: "number", label: "间隔", min: 30, max: 600, default: 60 },
						{
							key: "quality",
							type: "enum",
							label: "清晰度",
							options: [
								{ value: "raw", label: "原图" },
								{ value: "lite", label: "省流量" },
							],
						},
						{ key: "live", type: "boolean", label: "开播也推" },
						{
							key: "links",
							type: "list",
							label: "接入",
							title: "name",
							fields: [
								{ key: "name", type: "string", label: "名字", required: true },
								{ key: "token", type: "string", label: "token", secret: true, generate: true },
							],
						},
					],
				},
			}),
		);
		if (m.apiVersion !== 2 || !m.settings) throw new Error("应该是带设置的 v2");
		return m.settings.fields;
	})();
	const accepts = (value: unknown) => settingsValueSchema(FIELDS).safeParse(value).success;
	const GOOD = {
		cookie: "sessionid=abc",
		interval: 90,
		quality: "lite",
		live: true,
		links: [{ id: "a1", name: "家里那台", token: "" }],
	};

	it("照声明写的 —— 收下;没声明的键原样放过(拓展自己可能有面板不管的格)", () => {
		expect(accepts(GOOD)).toBe(true);
		expect(accepts({ ...GOOD, extra: { anything: 1 } })).toBe(true);
		expect(accepts({ cookie: "c" })).toBe(true);
	});

	it.each([
		["必填的 string 是空串", { ...GOOD, cookie: "" }],
		["必填的 string 缺了", { interval: 90 }],
		["number 越界", { ...GOOD, interval: 10 }],
		["number 写成字符串", { ...GOOD, interval: "90" }],
		["enum 不是选项之一", { ...GOOD, quality: "hd" }],
		["boolean 写成字符串", { ...GOOD, live: "true" }],
		["列表不是数组", { ...GOOD, links: {} }],
		["列表项没有 id", { ...GOOD, links: [{ name: "家里那台", token: "" }] }],
		["列表项的 id 是空串", { ...GOOD, links: [{ id: "", name: "家里那台", token: "" }] }],
		[
			"列表项的 id 重复",
			{
				...GOOD,
				links: [
					{ id: "a1", name: "一", token: "" },
					{ id: "a1", name: "二", token: "" },
				],
			},
		],
		["列表项里必填的 string 是空串", { ...GOOD, links: [{ id: "a1", name: "", token: "" }] }],
		["整份不是对象", ["cookie"]],
	])("%s —— 拒", (_label, value) => {
		expect(accepts(value)).toBe(false);
	});

	it("没设过(undefined)—— 收下:那是「按没有算」,不是写坏了", () => {
		expect(settingsValueSchema(FIELDS).safeParse(undefined).success).toBe(true);
	});
});

describe("v2 的动作", () => {
	it.each(["login.start", "refresh", "login.qrCode"])("%s —— 收下", (name) => {
		expect(() => ok(v2({ actions: { [name]: { label: "按钮" } } }))).not.toThrow();
	});

	it.each(["", "Login", "login..start", ".login", "login.", "login/start", "login-start"])(
		"%s —— 拒(动作名要进 URL:/api/ext/:id/actions/:name)",
		(name) => {
			unreadable(v2({ actions: { [name]: { label: "按钮" } } }));
		},
	);

	it("动作要有名字给人看", () => {
		unreadable(v2({ actions: { refresh: { label: "" } } }));
		unreadable(v2({ actions: { refresh: {} } }));
	});
});

/**
 * 命名空间(ADR-0013):第三方源发的拓展 id 是 `<命名空间>.<名字>`,**没有点的 id 保留给
 * 官方源**。命名空间烧进 id 而不是装的时候拼 —— id 在 BN 里是落盘的键(连接的
 * `extensionId`、设置槽、目录名),它必须与用户怎么称呼那个源无关。
 */
describe("拓展 id 的命名空间", () => {
	it("一个点分两段,两段各自仍是小写字母数字连字符", () => {
		for (const id of ["alice.douyin", "a1.b-2", "bridge", "x"]) {
			expect(ExtensionIdSchema.safeParse(id).success, id).toBe(true);
		}
	});

	it("只许一个点,点两边都不能空,也不能连着点", () => {
		for (const id of ["a.b.c", ".x", "x.", "a..b", "A.b", "a.-b", "a-.b"]) {
			expect(ExtensionIdSchema.safeParse(id).success, id).toBe(false);
		}
	});

	it("extensionNamespaceOf:有点的取点前那段,没点的是官方(undefined)", () => {
		expect(extensionNamespaceOf("alice.douyin")).toBe("alice");
		expect(extensionNamespaceOf("bridge")).toBeUndefined();
	});
});
