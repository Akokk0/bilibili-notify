/**
 * `globals.extensions` —— 拓展模块的开关。
 *
 * 三条不变量:
 *
 * ① **老配置没有这一段照样开得了机**。独立端启动时 `GlobalSettingsSchema.parse` 失败是
 *    直接挂掉的(同 `onboarding` / `linkParsing` 那批)。
 * ② **不认识的模块 id 原样留着**。模块是编进产物的,一次回退 / 一次撤下就会让配置里
 *    多出一个当下没人认领的 id —— 把它抹掉等于用户再升回来时开关被人悄悄关了。
 * ③ **缺失 = 关着**。开关是用户按的:桥接模块一开就是在对外收长连接,不该因为升级了
 *    一版就自己开起来。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalSettingsSchema, isExtensionEnabled, makeDefaultGlobalSettings } from "../globals";

function withExtensions(value: unknown) {
	const g = makeDefaultGlobalSettings() as unknown as Record<string, unknown>;
	g.extensions = value;
	return GlobalSettingsSchema.parse(g);
}

describe("globals.extensions", () => {
	it("老 globals.json 没有 extensions 段 → 解析得过,补成空表", () => {
		const g = makeDefaultGlobalSettings() as unknown as Record<string, unknown>;
		delete g.extensions;
		const parsed = GlobalSettingsSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.extensions).toEqual({});
	});

	it("不认识的模块 id 原样留着 —— 撤下 / 回退一次不该把用户的开关抹掉", () => {
		const parsed = withExtensions({ "some-future-module": { enabled: true } });
		expect(parsed.extensions["some-future-module"]?.enabled).toBe(true);
	});

	it("**缺失 = 关着**:桥接模块不会因为升了一版就自己开始收长连接", () => {
		expect(isExtensionEnabled(makeDefaultGlobalSettings(), "anything")).toBe(false);
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

describe("globals.extensions.<id> 不带设置", () => {
	/**
	 * 拓展自己的持久设置不在核心设置里,住在它自己的文件 `config/settings/extensions/<id>.json`
	 * (ADR-0021 决策 42)。核心这一格只剩主人按的开关;盘上残留的 `settings` 读的时候被剥掉(schema 不是 strict,
	 * 整份拒收会让老盘开不了机)—— 迁移器早把它搬进了拓展自己的文件。
	 */
	it("盘上残留的 settings 读的时候被剥掉,开关原样留着", () => {
		const settings = { links: [{ id: "a", name: "家里那台", token: "t0ken", enabled: true }] };
		const parsed = withExtensions({ bridge: { enabled: true, settings } });
		expect(parsed.extensions.bridge).toEqual({ enabled: true });
		expect("settings" in (parsed.extensions.bridge ?? {})).toBe(false);
	});

	it("没有 settings 的开关格读出来还是只有 enabled —— 不补任何别的格", () => {
		const parsed = withExtensions({ bridge: { enabled: true } });
		expect(parsed.extensions.bridge).toEqual({ enabled: true });
	});
});

/**
 * `globals.marketplace` —— 拓展市场的源列表(ADR-0013)。官方源不在这里(它是内置的、
 * 不能删),这里只有主人自己加的第三方源。
 */
describe("globals.marketplace", () => {
	it("保留自定义 HTTPS 索引，拒绝残缺仓库、非 HTTPS 及带空白的地址", () => {
		const g = makeDefaultGlobalSettings();
		const url = "https://index.example/list.json?channel=alpha";
		g.marketplace = { sources: [{ id: "index", url }] };
		expect(GlobalSettingsSchema.parse(g).marketplace.sources[0]?.url).toBe(url);
		for (const invalid of [
			"alice",
			"alice/../tools",
			"alice/..",
			"-alice/tools",
			"http://github.com/alice/tools",
			"https:example.com",
			"https://index.example/list with spaces.json",
		]) {
			g.marketplace.sources[0] = { id: "index", url: invalid };
			expect(GlobalSettingsSchema.safeParse(g).success, invalid).toBe(false);
		}
	});

	it("GitHub 仓库简写和仓库网址保存为同一个固定 Release 索引", () => {
		for (const url of [
			"Alice/Tools",
			"https://github.com/Alice/Tools",
			"https://github.com/Alice/Tools.git/",
			"https://github.com/Alice/Tools/releases/download/bn-marketplace/marketplace.json",
		]) {
			const g = makeDefaultGlobalSettings();
			g.marketplace = { sources: [{ id: "repo", url }] };
			expect(GlobalSettingsSchema.parse(g).marketplace.sources).toEqual([
				{
					id: "repo",
					url: "https://github.com/alice/tools/releases/download/bn-marketplace/marketplace.json",
				},
			]);
		}
	});

	it("老 globals.json 没有这一段 → 解析得过,源列表补成空", () => {
		const g = makeDefaultGlobalSettings() as unknown as Record<string, unknown>;
		delete g.marketplace;
		expect(GlobalSettingsSchema.parse(g).marketplace).toEqual({ sources: [] });
	});

	it("源 = id + https 地址(名字可选,索引自己带);http 拒,封顶 20 条", () => {
		const g = makeDefaultGlobalSettings() as unknown as Record<string, unknown>;
		const src = (over: Record<string, unknown> = {}) => ({
			id: "s1",
			url: "https://alice.example/bn/marketplace.json",
			...over,
		});
		g.marketplace = { sources: [src()] };
		expect(GlobalSettingsSchema.parse(g).marketplace.sources).toEqual([src()]);
		for (const bad of [src({ url: "http://alice.example/m.json" }), src({ name: "" })]) {
			g.marketplace = { sources: [bad] };
			expect(GlobalSettingsSchema.safeParse(g).success).toBe(false);
		}
		g.marketplace = { sources: Array.from({ length: 21 }, (_, i) => src({ id: `s${i}` })) };
		expect(GlobalSettingsSchema.safeParse(g).success).toBe(false);
	});
});
