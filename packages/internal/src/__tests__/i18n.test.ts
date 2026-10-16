import { describe, expect, it } from "vite-plus/test";
import {
	createI18n,
	type Dict,
	type DictKey,
	LOCALES,
	mergeDict,
	placeholdersOf,
	stemOf,
	translate,
} from "../i18n";

describe("mergeDict", () => {
	it("后一层盖前一层,前一层独有的句子留着", () => {
		const merged = mergeDict({ a: "底 a", b: "底 b" }, { a: "上 a", c: "上 c" });
		expect(merged).toEqual({ a: "上 a", b: "底 b", c: "上 c" });
	});

	it("按句盖 —— 上层有这一句就整句换掉下层各类别,不留下层的 #other", () => {
		const merged = mergeDict(
			{ "n#one": "底 one", "n#other": "底 other", keep: "留" },
			{ "n#one": "上 one" },
		);
		expect(merged).toEqual({ "n#one": "上 one", keep: "留" });
	});

	it("上层只有不带后缀的一条时,同一句的各类别也整句换掉", () => {
		const merged = mergeDict({ "n#one": "底 one", "n#other": "底 other" }, { n: "上" });
		expect(merged).toEqual({ n: "上" });
	});

	it("层可以是 undefined,不改入参", () => {
		const base: Dict = { a: "1" };
		expect(mergeDict(base, undefined, { b: "2" })).toEqual({ a: "1", b: "2" });
		expect(base).toEqual({ a: "1" });
	});
});

describe("stemOf / placeholdersOf", () => {
	it("stemOf 去掉 #类别 后缀,没有后缀原样回", () => {
		expect(stemOf("report.count#other")).toBe("report.count");
		expect(stemOf("report.title")).toBe("report.title");
	});

	it("placeholdersOf 按出现顺序回不重复的占位符名", () => {
		expect(placeholdersOf("{name} 有 {count} 条,{name} 再见")).toEqual(["name", "count"]);
		expect(placeholdersOf("没有占位符")).toEqual([]);
	});
});

describe("translate", () => {
	it("填占位符;没给值的原样留着", () => {
		const dict: Dict = { hi: "你好 {name},第 {n} 位 {missing}" };
		expect(translate(dict, "zh-CN", "hi", { name: "甲", n: 3 })).toBe("你好 甲,第 3 位 {missing}");
	});

	it("en 的 count=1 挑 #one、0 与 2 挑 #other;zh-CN 一律 #other", () => {
		const dict: Dict = { "item#one": "{count} item", "item#other": "{count} items" };
		expect(translate(dict, "en", "item", { count: 1 })).toBe("1 item");
		expect(translate(dict, "en", "item", { count: 0 })).toBe("0 items");
		expect(translate(dict, "en", "item", { count: 2 })).toBe("2 items");
		const zh: Dict = { "item#one": "一条", "item#other": "{count} 条" };
		expect(translate(zh, "zh-CN", "item", { count: 1 })).toBe("1 条");
	});

	it("挑不到的类别落 #other;缺键回键本身", () => {
		const dict: Dict = { "item#other": "{count} 条" };
		expect(translate(dict, "en", "item", { count: 1 })).toBe("1 条");
		expect(translate(dict, "en", "nope")).toBe("nope");
	});

	it("占位符只认 values 自己的键 —— {constructor}、{toString} 没给值时原样留着", () => {
		const dict: Dict = { odd: "a {constructor} b {toString} c {name}" };
		expect(translate(dict, "en", "odd", { name: "x" })).toBe("a {constructor} b {toString} c x");
	});

	it("没有 count 时按不带后缀的键取", () => {
		expect(translate({ plain: "平的" }, "en", "plain", { other: 1 })).toBe("平的");
	});

	it("语言码不合法时不炸,落 #other", () => {
		const dict: Dict = { "item#one": "一", "item#other": "多 {count}" };
		expect(translate(dict, "not a locale!!", "item", { count: 1 })).toBe("多 1");
	});
});

describe("LOCALES", () => {
	it("第一版是简中、英、日,用 BCP 47 写法", () => {
		expect([...LOCALES]).toEqual(["zh-CN", "en", "ja"]);
	});
});

describe("createI18n", () => {
	const zh = {
		plain: { hi: "你好", only: "只有中文", "n#other": "{count} 个" },
		maid: { hi: "主人好" },
	};
	const en = { plain: { hi: "Hello", "n#one": "{count} thing", "n#other": "{count} things" } };

	it("缺句拿打底语言补", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "en",
			voice: "plain",
		});
		expect(i18n.t("hi")).toBe("Hello");
		expect(i18n.t("only")).toBe("只有中文");
		expect(i18n.t("n", { count: 1 })).toBe("1 thing");
	});

	it("要女仆而这种语言没有女仆层 —— 拿到平实版,状态里口吻落回平实", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "en",
			voice: "maid",
		});
		expect(i18n.t("hi")).toBe("Hello");
		expect(i18n.state().voice).toBe("plain");
	});

	it("有女仆层的语言:女仆层盖平实版", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "maid",
		});
		expect(i18n.t("hi")).toBe("主人好");
		expect(i18n.state().voice).toBe("maid");
		i18n.set({ voice: "plain" });
		expect(i18n.t("hi")).toBe("你好");
	});

	it("口吻是单独记着的:切去没有女仆层的语言再切回来,女仆层回来", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "maid",
		});
		i18n.set({ locale: "en" });
		expect(i18n.state().voice).toBe("plain");
		i18n.set({ locale: "zh-CN" });
		expect(i18n.t("hi")).toBe("主人好");
	});

	it("dicts 缺这种语言时当成空的平实层,不抛;缺的句子落到打底语言", () => {
		// 运行时的值(如拓展的译文文件不全)可以比类型多一种语言
		const i18n = createI18n<string, string>({
			dicts: { "zh-CN": zh },
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "plain",
		});
		expect(() => i18n.set({ locale: "ja" })).not.toThrow();
		expect(i18n.t("hi")).toBe("你好");
		expect(i18n.state().voice).toBe("plain");
		const noFallback = createI18n<string, string>({
			dicts: { "zh-CN": zh },
			locale: "ja",
			voice: "maid",
		});
		expect(noFallback.t("hi")).toBe("hi");
	});

	it("没给打底语言也能建,缺句回键本身", () => {
		const i18n = createI18n({ dicts: { en }, locale: "en", voice: "plain" });
		expect(i18n.t("only")).toBe("only");
	});

	it("t 读的是调用那一刻的语言(先拿到 t、set 之后再调,出新语言)", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "plain",
		});
		const t = i18n.t;
		expect(t("hi")).toBe("你好");
		i18n.set({ locale: "en" });
		expect(t("hi")).toBe("Hello");
	});

	it("两次 set 之间状态引用不变;set 之后换新引用、通知订阅者;退订后不再通知", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "plain",
		});
		const first = i18n.state();
		expect(i18n.state()).toBe(first);
		let calls = 0;
		const unsubscribe = i18n.subscribe(() => {
			calls += 1;
		});
		i18n.set({ locale: "en" });
		const second = i18n.state();
		expect(second).not.toBe(first);
		expect(second.locale).toBe("en");
		expect(i18n.state()).toBe(second);
		expect(calls).toBe(1);
		unsubscribe();
		i18n.set({ locale: "zh-CN" });
		expect(calls).toBe(1);
	});

	it("状态上带一个绑死这一份的 t", () => {
		const i18n = createI18n<string, "zh-CN" | "en">({
			dicts: { "zh-CN": zh, en },
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "plain",
		});
		const old = i18n.state();
		i18n.set({ locale: "en" });
		expect(old.t("hi")).toBe("你好");
		expect(i18n.state().t("hi")).toBe("Hello");
	});

	it("两个实例互不影响", () => {
		const make = () =>
			createI18n<string, "zh-CN" | "en">({
				dicts: { "zh-CN": zh, en },
				fallback: "zh-CN",
				locale: "zh-CN",
				voice: "plain",
			});
		const a = make();
		const b = make();
		a.set({ locale: "en" });
		expect(a.t("hi")).toBe("Hello");
		expect(b.t("hi")).toBe("你好");
	});

	it("set 同样的值不重复通知", () => {
		const i18n = createI18n({ dicts: { en }, locale: "en", voice: "plain" });
		let calls = 0;
		i18n.subscribe(() => {
			calls += 1;
		});
		i18n.set({ locale: "en", voice: "plain" });
		expect(calls).toBe(0);
	});
});

describe("DictKey", () => {
	it("去掉 #类别 后缀,几条收成一个键", () => {
		const keys: DictKey<{ a: string; "n#one": string; "n#other": string }>[] = ["a", "n"];
		expect(keys).toEqual(["a", "n"]);
	});
});
