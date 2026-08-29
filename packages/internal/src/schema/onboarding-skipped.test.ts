/**
 * `onboarding.skipped` —— 「这台实例的主人不用再自动展开新手指引了」这一笔标记。
 *
 * 它是导览展开判定的持久化那一半(交互侧见 web 的 tour-companion 测试)。这里守
 * 配置层的两条不变量:
 *
 * ① **老配置缺这个字段照样能读** —— 独立端启动时 `GlobalConfigSchema.parse` 失败
 *    是直接挂掉的,新字段不带 `.default` 就是让所有老用户开不了机(同
 *    `templateDefaultsSeen` / `imageGroup` 那批)。
 * ② **缺字段补出来必须是「没跳过」** —— 语义是「没这笔标记 = 该自动展开指引」。
 *    补成 true 就等于把新手指引对所有存量实例永久关掉,而这个特性存在的全部意义
 *    就是让新装的用户一开面板就被接住。
 *
 * 注意它**不是**已退役的 `dismissed`:那个字段管的是「彻底关闭、标签都不留」,
 * 已随「永久常驻无关闭态」定案删除。这一笔只管「别自动展开」,左缘标签照常在。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";

describe("onboarding.skipped", () => {
	it("老 globals.json 没有 onboarding 段 → 自动补出「没跳过」,不是解析失败", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.onboarding;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.onboarding.skipped).toBe(false);
	});

	it("全新安装 = 没跳过 → 新用户一开面板就能被指引接住", () => {
		expect(makeDefaultGlobalConfig().onboarding.skipped).toBe(false);
	});
});
