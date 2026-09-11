/**
 * `globals.extensions` —— 拓展模块的开关。
 *
 * 三条不变量:
 *
 * ① **老配置没有这一段照样开得了机**。独立端启动时 `GlobalConfigSchema.parse` 失败是
 *    直接挂掉的(同 `onboarding` / `linkParsing` 那批)。
 * ② **不认识的模块 id 原样留着**。模块是编进产物的,一次回退 / 一次撤下就会让配置里
 *    多出一个当下没人认领的 id —— 把它抹掉等于用户再升回来时开关被人悄悄关了。
 * ③ **缺失 = 关着**。开关是用户按的:桥接模块一开就是在对外收长连接,不该因为升级了
 *    一版就自己开起来。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, isExtensionEnabled, makeDefaultGlobalConfig } from "./globals";

function withExtensions(value: unknown) {
	const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
	g.extensions = value;
	return GlobalConfigSchema.parse(g);
}

describe("globals.extensions", () => {
	it("老 globals.json 没有 extensions 段 → 解析得过,补成空表", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.extensions;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.extensions).toEqual({});
	});

	it("不认识的模块 id 原样留着 —— 撤下 / 回退一次不该把用户的开关抹掉", () => {
		const parsed = withExtensions({ "some-future-module": { enabled: true } });
		expect(parsed.extensions["some-future-module"]?.enabled).toBe(true);
	});

	it("**缺失 = 关着**:桥接模块不会因为升了一版就自己开始收长连接", () => {
		expect(isExtensionEnabled(makeDefaultGlobalConfig(), "anything")).toBe(false);
	});

	it("开了就是开了,关了就是关了", () => {
		expect(isExtensionEnabled(withExtensions({ "demo-ext": { enabled: true } }), "demo-ext")).toBe(
			true,
		);
		expect(isExtensionEnabled(withExtensions({ "demo-ext": { enabled: false } }), "demo-ext")).toBe(
			false,
		);
	});

	it("有这个 id 但没写 enabled → 当关着", () => {
		expect(withExtensions({ "demo-ext": {} }).extensions["demo-ext"]?.enabled).toBe(false);
	});
});

describe("globals.extensions.<id>.settings", () => {
	/**
	 * 拓展自己的持久设置(桥的接入名单住这儿)。**宿主不认识它的形状**:归拓展自己那份
	 * zod —— 所以这里只能是原样存、原样取,多一层「清洗」就是核心在猜拓展的形状。
	 */
	it("原样存、原样取 —— 宿主不认识形状,也不替它清洗", () => {
		const settings = { links: [{ id: "a", name: "家里那台", token: "t0ken", enabled: true }] };
		const parsed = withExtensions({ bridge: { enabled: true, settings } });
		expect(parsed.extensions.bridge?.settings).toEqual(settings);
	});

	it("没设过就是没有 —— 不补一个空对象,空对象在拓展眼里可能是「形状不对」", () => {
		const parsed = withExtensions({ bridge: { enabled: true } });
		expect(parsed.extensions.bridge?.settings).toBeUndefined();
	});
});

/**
 * `globals.marketplace` —— 拓展市场的源列表(ADR-0013)。官方源不在这里(它是内置的、
 * 不能删),这里只有主人自己加的第三方源。
 */
describe("globals.marketplace", () => {
	it("老 globals.json 没有这一段 → 解析得过,源列表补成空", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.marketplace;
		expect(GlobalConfigSchema.parse(g).marketplace).toEqual({ sources: [] });
	});

	it("源 = id + https 地址(名字可选,索引自己带);http 拒,封顶 20 条", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		const src = (over: Record<string, unknown> = {}) => ({
			id: "s1",
			url: "https://alice.example/bn/marketplace.json",
			...over,
		});
		g.marketplace = { sources: [src()] };
		expect(GlobalConfigSchema.parse(g).marketplace.sources).toEqual([src()]);
		for (const bad of [src({ url: "http://alice.example/m.json" }), src({ name: "" })]) {
			g.marketplace = { sources: [bad] };
			expect(GlobalConfigSchema.safeParse(g).success).toBe(false);
		}
		g.marketplace = { sources: Array.from({ length: 21 }, (_, i) => src({ id: `s${i}` })) };
		expect(GlobalConfigSchema.safeParse(g).success).toBe(false);
	});
});
