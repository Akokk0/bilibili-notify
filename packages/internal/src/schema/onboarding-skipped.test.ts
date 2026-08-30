/**
 * `onboarding.skipped` —— 新手指引的三态持久标记(2026-08-30 主人定案改版)。
 *
 * 三态:**缺失 = 还没问过**(打开面板弹询问框:新用户开始指引 / 老用户跳过)、
 * `false` = 要指引(导览出现)、`true` = 不要(整个导览不渲染,系统页可重开)。
 *
 * 这里守配置层的两条不变量:
 *
 * ① **老配置缺这个字段照样能读** —— 独立端启动时 `GlobalConfigSchema.parse` 失败
 *    是直接挂掉的(同 `templateDefaultsSeen` / `imageGroup` 那批)。
 * ② **「缺失」必须原样穿透,不许被 default 补成 false** —— 缺失的意思是「还没问
 *    过用户」,询问框全靠它弹;补成 false 等于永远不问、对老用户直接开导览,
 *    正是上一版被主人打回的行为。全新安装同理:第一次开面板就该被问一次。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";

describe("onboarding.skipped 三态", () => {
	it("老 globals.json 没有 onboarding 段 → 解析成功,skipped 保持缺失(= 该弹询问框)", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.onboarding;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.onboarding?.skipped).toBeUndefined();
	});

	it("全新安装 → skipped 同样缺失:新装用户第一次开面板也要被问一次", () => {
		expect(makeDefaultGlobalConfig().onboarding?.skipped).toBeUndefined();
	});

	it("已作出的选择原样保留:true 与 false 都不被改写", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		g.onboarding = { skipped: true };
		expect(GlobalConfigSchema.parse(g).onboarding?.skipped).toBe(true);
		g.onboarding = { skipped: false };
		expect(GlobalConfigSchema.parse(g).onboarding?.skipped).toBe(false);
	});
});
