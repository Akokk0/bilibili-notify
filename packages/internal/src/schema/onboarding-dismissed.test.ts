/**
 * 新手进度卡的收起状态(`GlobalConfig.onboardingDismissed`)。
 *
 * 2026-08-29 grilling 定案:dashboard 首页进度卡在用户点收起后不再出现;这个
 * 状态**存 server 而非 localStorage** —— 跨设备一致,重装(数据目录清空)才重弹。
 * 挂 GlobalConfig 顶层的理由同 `mutedUntil`:它不是 per-UP 的东西,`defaults`
 * 的「per-UP 缺字段回退全局」语义跟它无关。
 *
 * 守三条不变量:
 * ① 老 globals.json 缺这个字段照样能读 —— `GlobalConfigSchema.parse` 在独立端
 *    启动路径上,新字段不带 `.default` 就是让所有老用户开不了机。
 * ② **默认必须是 false** —— 进度卡的「老用户不被弹脸」靠的是全绿自动收起
 *    (机器判据),不是靠默认藏起来;默认 true 会让真正的新用户永远看不到它。
 * ③ 不参与 `resolve()` 折叠 —— 纯 dashboard UI 状态,跟推送配置无关。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";
import { resolve } from "./resolve";
import { makeEmptySubscription } from "./subscriptions";

describe("GlobalConfig.onboardingDismissed", () => {
	it("老 globals.json 没有 onboardingDismissed → 自动补 false,不是解析失败", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.onboardingDismissed;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.onboardingDismissed).toBe(false);
	});

	it("显式 true 往返保留 —— 收起动作要真的存得住", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		g.onboardingDismissed = true;
		const parsed = GlobalConfigSchema.parse(g);
		expect(parsed.onboardingDismissed).toBe(true);
	});

	it("非布尔值拒绝 —— PATCH 链路上的脏值别悄悄存进盘", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		g.onboardingDismissed = "yes";
		expect(GlobalConfigSchema.safeParse(g).success).toBe(false);
	});

	it("不参与 resolve() 折叠 —— 纯 UI 状态不该混进 per-UP 生效配置", () => {
		const sub = makeEmptySubscription({
			id: "33333333-3333-4333-8333-333333333333",
			uid: "789",
		});
		const eff = resolve(sub, makeDefaultGlobalConfig().defaults);
		expect(eff).not.toHaveProperty("onboardingDismissed");
	});
});
