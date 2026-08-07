/**
 * 锐评定时推送的配置契约。
 *
 * 两份调度、两个落点,而且**都不是继承关系**:
 *   - `GlobalConfig.roastSchedule` —— 榜单周报,全局唯一的一条
 *   - `Subscription.roastSchedule` —— 单人锐评,每位 UP 自己一条
 *
 * 所以它们都挂在顶层,不进 `defaults` / `overrides`:那两处的语义是「per-UP 缺
 * 字段就回退全局」,而榜单和单人压根是两样东西,回退过去只会拿到一份内容不对的
 * 配置。`specialUsers` 是同类先例(per-UP 独有、不参与折叠)。
 *
 * 守三条不变量:
 * ① 老配置缺这个字段照样能读 —— `GlobalConfigSchema.parse` 在独立端启动路径上,
 *    新字段不带 `.default` 就是让所有老用户开不了机。
 * ② **默认必须是关的** —— 存量用户升级上来,不该有任何东西开始自己往群里发帖。
 * ③ 它不参与 `resolve()` 折叠 —— 一旦被顺手塞进 overrides,单人调度就会去继承
 *    榜单的配置。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";
import { resolve } from "./resolve";
import { ROAST_MAX_DAYS, ROAST_MIN_DAYS, RoastScheduleSchema } from "./roast-schedule";
import { makeEmptySubscription, SubscriptionSchema } from "./subscriptions";

describe("RoastScheduleSchema", () => {
	it("默认是关的 —— 存量用户升上来不会突然开始发帖", () => {
		const s = RoastScheduleSchema.parse({});
		expect(s.enabled).toBe(false);
		expect(s.targets).toEqual([]);
		expect(s.approval).toBe(false);
	});

	it("异常通知默认开、成功抄送默认关", () => {
		const s = RoastScheduleSchema.parse({});
		// 没发出去要说一声(主人刚为这事修过动态检测);发成功了不必每次都打扰。
		expect(s.notifyOnError).toBe(true);
		expect(s.ccMaster).toBe(false);
	});

	it("days 卡在 1–90,越界拒绝", () => {
		expect(RoastScheduleSchema.safeParse({ days: ROAST_MIN_DAYS }).success).toBe(true);
		expect(RoastScheduleSchema.safeParse({ days: ROAST_MAX_DAYS }).success).toBe(true);
		expect(RoastScheduleSchema.safeParse({ days: 0 }).success).toBe(false);
		expect(RoastScheduleSchema.safeParse({ days: ROAST_MAX_DAYS + 1 }).success).toBe(false);
		expect(RoastScheduleSchema.safeParse({ days: 7.5 }).success).toBe(false);
	});

	it("cron 只当字符串收着,不在 schema 里解析", () => {
		// 与 dynamicCron / fansCron 一致:表达式合不合法由调度器启动时报,
		// schema 拦下来只会让用户改一个字就存不了盘。
		expect(RoastScheduleSchema.safeParse({ cron: "0 9 * * 1" }).success).toBe(true);
		expect(RoastScheduleSchema.safeParse({ cron: "完全不是 cron" }).success).toBe(true);
	});

	it("targets 必须是 uuid", () => {
		expect(RoastScheduleSchema.safeParse({ targets: ["not-a-uuid"] }).success).toBe(false);
	});
});

describe("roastSchedule 在配置里的落点", () => {
	it("老 globals.json 没有 roastSchedule → 自动补默认,不是解析失败", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.roastSchedule;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.roastSchedule.enabled).toBe(false);
	});

	it("老订阅没有 roastSchedule → 自动补默认,不是解析失败", () => {
		const sub = makeEmptySubscription({
			id: "11111111-1111-4111-8111-111111111111",
			uid: "123",
		}) as unknown as Record<string, unknown>;
		delete sub.roastSchedule;
		const parsed = SubscriptionSchema.safeParse(sub);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.roastSchedule.enabled).toBe(false);
	});

	it("不参与 resolve() 折叠 —— 单人调度绝不继承榜单调度", () => {
		const sub = makeEmptySubscription({
			id: "22222222-2222-4222-8222-222222222222",
			uid: "456",
		});
		const eff = resolve(sub, makeDefaultGlobalConfig().defaults);
		// 有朝一日谁把它塞进 overrides,这条会红:届时单人锐评会去继承榜单的
		// cron / targets,配出来的东西跟界面上显示的对不上。
		expect(eff).not.toHaveProperty("roastSchedule");
	});
});
