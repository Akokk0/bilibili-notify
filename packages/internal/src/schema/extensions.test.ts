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
