import type { FlatSubConfigItem } from "@bilibili-notify/subscription";
import { Schema } from "koishi";

export interface BilibiliNotifyConfig {
	advancedSub: boolean;
	subs: FlatSubConfigItem[];
	logLevel: number;
	userAgent?: string;
	loginHealthCheckMinutes: number;
	master: {
		enable: boolean;
		platform?: string;
		masterAccount?: string;
		masterAccountGuildId?: string;
	};
}

export const BilibiliNotifyConfigSchema: Schema<BilibiliNotifyConfig> = Schema.object({
	advancedSub: Schema.boolean()
		.default(false)
		.description(
			"这个开关决定是否使用高级订阅功能喔～如果主人想要超级灵活的订阅内容，就请开启并安装 bilibili-notify-advanced-subscription 呀 (๑•̀ㅂ•́)و♡",
		),

	subs: Schema.array(
		Schema.object({
			name: Schema.string().required().description("UP昵称"),
			uid: Schema.string().required().description("UID"),
			dynamic: Schema.boolean().default(true).description("动态"),
			dynamicAtAll: Schema.boolean().default(false).description("动态@全体"),
			live: Schema.boolean().default(true).description("直播"),
			liveAtAll: Schema.boolean().default(true).description("直播@全体"),
			liveEnd: Schema.boolean().default(true).description("下播通知"),
			liveGuardBuy: Schema.boolean().default(false).description("上舰消息"),
			superchat: Schema.boolean().default(false).description("SC消息"),
			wordcloud: Schema.boolean().default(true).description("弹幕词云"),
			liveSummary: Schema.boolean().default(true).description("直播总结"),
			platform: Schema.string().required().description("平台名"),
			target: Schema.string().required().description("群号/频道号"),
		}),
	)
		.role("table")
		.description(
			"在这里填写主人的订阅信息～UP 昵称、UID、roomid、平台、群号都要填正确，不然女仆会迷路哒 (；>_<)如果多个群聊/频道，请用英文逗号分隔哦～女仆会努力送到每一个地方的！",
		),

	logLevel: Schema.number()
		.min(1)
		.max(3)
		.step(1)
		.default(1)
		.description(
			"这里可以设置日志等级喔～3 是最详细的调试信息，1 是只显示错误信息。主人可以根据需要选择合适的等级，让女仆更好地为您服务 (๑•̀ㅂ•́)و✧",
		),

	userAgent: Schema.string().description(
		"这里可以设置请求头的 User-Agent 哦～如果请求出现了 -352 的奇怪错误，主人可以试着在这里换一个看看 (；>_<)",
	),

	loginHealthCheckMinutes: Schema.number()
		.min(5)
		.max(180)
		.step(1)
		.default(30)
		.description(
			"登录状态周期检测的间隔（分钟）。女仆会按这个频率悄悄帮主人确认账号还在线哦～如果发现失效会立刻汇报呢 (๑•̀ㅂ•́)و✧",
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
				platform: Schema.union([
					"qq",
					"qqguild",
					"onebot",
					"discord",
					"red",
					"telegram",
					"satori",
					"chronocat",
					"lark",
				]).description(
					"主人想让女仆在哪个平台伺候您呢？请从这里选一个吧～(〃´-`〃)♡女仆会乖乖待在主人选的地方哒！",
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
});
