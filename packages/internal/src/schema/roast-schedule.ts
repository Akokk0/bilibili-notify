import { z } from "zod";
import {
	DEFAULT_ROAST_CRON,
	DEFAULT_ROAST_DAYS,
	DEFAULT_ROAST_SCHEDULE,
	ROAST_MAX_DAYS,
	ROAST_MIN_DAYS,
} from "../constants";

/**
 * 锐评定时推送的调度配置 —— 榜单周报与单人锐评共用同一副形状。
 *
 * 「周期」与「数据范围」是解耦的两个字段:`cron` 定何时发,`days` 定统计多少天。
 * 不预设「周报 / 月报 / 季报」这类组合 —— 用户想要周报就配「每周一 + 7 天」,
 * 想每天看就配「每天 + 1 天」。预设组合除了限制人,还会引出撞车、粒度、内容
 * 雷同一串本来不存在的问题。
 */

// 边界与默认值本体住在 zero-dep 的 `../constants` —— 配置页要拿它们做输入提示,
// 而 `apps/web` 不能把 zod 拉进浏览器 bundle,从这个文件 import 就会。这里只 re-export。
export {
	DEFAULT_ROAST_CRON,
	DEFAULT_ROAST_DAYS,
	DEFAULT_ROAST_SCHEDULE,
	ROAST_MAX_DAYS,
	ROAST_MIN_DAYS,
};

export const RoastScheduleSchema = z.object({
	/**
	 * 总开关。**默认必须是 false** —— 存量用户升级上来,不该有任何东西开始自己
	 * 往群里发帖。这条在 `roast-schedule.test.ts` 里钉着。
	 */
	enabled: z.boolean().default(false),
	/**
	 * 何时发。只当字符串收着,合不合法由调度器启动时校验并报日志(同 `dynamicCron`
	 * / `fansCron`)—— 在 schema 拦下来的话,用户编辑途中改一个字就存不了盘。
	 */
	cron: z.string().default(DEFAULT_ROAST_CRON),
	/** 统计窗口天数,与 `cron` 无关联 —— 用户自由组合。 */
	days: z.number().int().min(ROAST_MIN_DAYS).max(ROAST_MAX_DAYS).default(DEFAULT_ROAST_DAYS),
	/** 推送目标(PushTarget.id),可多个。空数组 = 没配目标,调度器跳过并按 notifyOnError 说明。 */
	targets: z.array(z.uuid()).default([]),
	/**
	 * 发前是否要主人批。开启后生成的稿子先落成待审草稿并私聊主人,回 y 才进群。
	 *
	 * 注意:只有**收得到回复**的推送通道才审得了(webhook 是单向的,开了就是永远
	 * 发不出去)。配置侧据此禁用,见 adapter 的入站能力位。
	 */
	approval: z.boolean().default(false),
	/** 没发出去时(生成失败 / 订阅不足 / 全部目标推送失败)私聊说明原因。 */
	notifyOnError: z.boolean().default(true),
});
export type RoastSchedule = z.infer<typeof RoastScheduleSchema>;
