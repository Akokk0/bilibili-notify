/**
 * B 站这个集成的设置:`config/settings/bilibili.json`(ADR-0021 决策 42 下 10-01 的 🔗)。格式由 B 站自己定,
 * 登记进配置仓(今天在 `runtime/bootstrap.ts`,3a 起在组装根);核心不读这一份(守卫 12)。
 *
 * ⑥f 只挪位置、不改键名:两格(`dynamicCron` / `healthCheckMinutes`)原样从核心设置的 `app` 搬来。`healthCheckMinutes` 随 3a 改名
 * `loginCheckIntervalMinutes`。0.x 还有第三格 `userAgent`(自定义 UA),已删:浏览器身份一律由 `packages/http` 生成,UA 与
 * `sec-ch-ua` 永远配套(ADR-0025 决策 7);格式不是 strict,老文件 / 老备份里带着它读进来时被剥掉。
 *
 * 读法:来源在 `start` 里经 `ctx.settings(schema)` 各读各的格({@link BiliDynamicSettingsSchema}、
 * {@link BiliLoginCheckSettingsSchema}),哪格读不懂停哪样。
 */

import {
	BILIBILI_SOURCE_KEY,
	DEFAULT_DYNAMIC_CRON,
	DEFAULT_HEALTH_CHECK_MINUTES,
} from "@bilibili-notify/internal";
import { CronTime } from "cron";
import { z } from "zod";
import type { IntegrationSettingsSegment } from "../config/store.js";

export const BiliSettingsSchema = z.object({
	/**
	 * 动态轮询的 cron。读盘只认它是字符串:对存量宽松,一条解析不了的老值不该让开机失败(运行期
	 * `new CronJob` 另有 try/catch 兜着);能不能解析在写入那一道核({@link settingsSegment})。
	 */
	dynamicCron: z.string().default(DEFAULT_DYNAMIC_CRON),
	/** 登录健康检查的间隔(分钟)。 */
	healthCheckMinutes: z.number().int().min(5).max(180).default(DEFAULT_HEALTH_CHECK_MINUTES),
});
export type BiliSettings = z.infer<typeof BiliSettingsSchema>;

/** cron 能不能解析:委托给 `cron` 包的 `CronTime`,与动态引擎、粉丝轮询实际排程用的是同一个解析器。 */
function isParsableCron(expr: string): boolean {
	try {
		new CronTime(expr);
		return true;
	} catch {
		return false;
	}
}

/**
 * 登记进配置仓的那一份。写入时核 cron 能不能解析:从前一条解析不了的表达式能存进去,下次开机
 * `new CronJob` 同步抛错、把整个服务崩穿 —— 拦在保存这一刻,主人当场看见原因。只核这次改了的 cron:盘上留着的
 * 一条老坏值不挡主人改健康检查间隔(与从前路由上那道「补丁里带了才核」同一个口径)。
 */
export const settingsSegment: IntegrationSettingsSegment<BiliSettings> = {
	key: BILIBILI_SOURCE_KEY,
	schema: BiliSettingsSchema,
	checkWrite(next, prev) {
		if (next.dynamicCron === prev?.dynamicCron || isParsableCron(next.dynamicCron)) return [];
		return [{ path: ["dynamicCron"], message: `不是合法的 cron 表达式："${next.dynamicCron}"` }];
	},
};

/**
 * 动态那一样读的格:只有 `dynamicCron`,且比读盘 schema 严一道「能解析」(与动态引擎实际排程用的同一个解析器)。
 * 读盘 schema 认一条解析不了的老 cron 是好的(面板照旧显示盘上那串原文),但读它的人不能拿它去造一个不拉的引擎 ——
 * 读不过就停动态、问题表里说清。其余格(登录检查那一格)坏没坏,这里看不见。
 */
export const BiliDynamicSettingsSchema = z.object({
	dynamicCron: BiliSettingsSchema.shape.dynamicCron.refine(isParsableCron, {
		message: "不是合法的 cron 表达式",
	}),
});

/** 登录检查那一样读的格:只有 `healthCheckMinutes`,与读盘 schema 同一个格 schema。 */
export const BiliLoginCheckSettingsSchema = BiliSettingsSchema.pick({ healthCheckMinutes: true });
