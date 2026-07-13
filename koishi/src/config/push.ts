import { Schema } from "koishi";

/** 免打扰时段:落进任一区间内的推送直接丢弃,粒度按「时」,半开区间 [start, end)。 */
interface QuietHourRange {
	start: number;
	end: number;
}

interface MasterConfig {
	enable: boolean;
	platform?: string;
	masterAccount?: string;
	masterAccountGuildId?: string;
}

export interface PushConfig {
	/**
	 * 全局免打扰时段。per-UP 不自定义则继承本字段;per-UP 在高级订阅里可以单独
	 * 配 quietHours 覆盖。
	 */
	quietHours: QuietHourRange[];
	master: MasterConfig;
}

export const PushConfigSchema: Schema<PushConfig> = Schema.object({
	quietHours: Schema.array(
		Schema.object({
			start: Schema.number().min(0).max(23).step(1).required().description("起始小时(0-23)"),
			end: Schema.number().min(0).max(23).step(1).required().description("结束小时(0-23,不含)"),
		}),
	)
		.role("table")
		.default([])
		.description(
			"全局免打扰时段:落进任一区间的推送直接丢弃,不补推。粒度按「时」,半开区间 [start, end);end<start 视为跨午夜(如 22 → 7 表示晚 22 点到次日 7 点)。per-UP 想单独配置可在高级订阅里覆盖。",
		),

	master: Schema.intersect([
		Schema.object({
			enable: Schema.boolean()
				.default(false)
				.description(
					"要不要让笨笨女仆开启主人账号功能呢？(>﹏<)如果机器人遭遇了奇怪的小错误，女仆会立刻跑来向主人报告的！不、不过……如果没有私聊权限的话，女仆就联系不到主人了……请不要打开这个开关喔 (；´д｀)ゞ",
				),
		}).description("主人的特别区域……女仆会乖乖侍奉的！(>///<)"),
		Schema.union([
			Schema.object({
				enable: Schema.const(true).required(),
				platform: Schema.string().description(
					"主人想让女仆在哪个平台伺候您呢？请把平台名亲手填进来哒～(〃´-`〃)♡这里要填**机器人适配器的平台名**，要和女仆实际连着的机器人一致才找得到主人喔！常见的有 onebot、qq、qqguild、discord、telegram、lark…… ⚠️ 用 NapCat / Lagrange / go-cqhttp 这些 OneBot 实现的主人，请填 **onebot**（不是 qq！）填错的话女仆会迷路找不到主人哒 (つ﹏⊂)",
				),
				masterAccount: Schema.string()
					.role("secret")
					.required()
					.description(
						"请主人把自己的账号告诉女仆嘛……不然女仆会找不到主人哒 (つ﹏⊂)在 Q 群的话用 QQ 号就可以了～其他平台请用 inspect 插件告诉女仆主人的 ID 哦 (´｡• ᵕ •｡`) ♡",
					),
				masterAccountGuildId: Schema.string()
					.role("secret")
					.description(
						"如果是在 QQ 频道、Discord 这种地方……主人的群组 ID 也要告诉女仆喔 (；>_<)不然女仆会迷路找不到主人……请用 inspect 插件带女仆去看看嘛～(〃ﾉωﾉ)",
					),
			}),
			Schema.object({}),
		]),
	]),
}).description("推送 · 免打扰 · 主人通知");
