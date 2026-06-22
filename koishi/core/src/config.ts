import { DEFAULT_HEALTH_CHECK_MINUTES } from "@bilibili-notify/internal";
import type { FlatSubConfigItem } from "@bilibili-notify/subscription";
import { Schema } from "koishi";

export type { FlatSubConfigItem };

/** 免打扰时段:落进任一区间内的推送直接丢弃,粒度按「时」,半开区间 [start, end)。 */
export interface KoishiQuietHourRange {
	start: number;
	end: number;
}

export interface BilibiliNotifyConfig {
	advancedSub: boolean;
	subs: FlatSubConfigItem[];
	logLevel: number;
	userAgent?: string;
	loginHealthCheckMinutes: number;
	/**
	 * 注入的静态加密口令。设置后 secrets(B 站 cookie / AI apiKey)用它经 scrypt
	 * 派生 AES-256 密钥加密,密钥本身不落盘 → 真正的静态加密;留空则回退到与密文
	 * 同目录的随机密钥(仅混淆,不构成真正的加密)。对齐 standalone 端的
	 * bootstrap.cookieEncryptionKey / BN_COOKIE_KEY。
	 */
	cookieEncryptionKey?: string;
	master: {
		enable: boolean;
		platform?: string;
		masterAccount?: string;
		masterAccountGuildId?: string;
	};
	/**
	 * 全局免打扰时段。per-UP 不自定义则继承本字段;per-UP 在 advanced-subscription
	 * schema 里可以单独配 quietHours 覆盖。
	 *
	 * features 总开关之所以不在 koishi config 暴露,是因为 koishi 端添加新订阅时
	 * 已经由 advanced-subscription / subs[] 的 Schema.boolean().default(true) 提供
	 * 默认值——「全局 features 默认值」这个语义在 koishi 端冗余;它只对 dashboard
	 * 的「添加新订阅时的初始勾选」流程有意义。
	 */
	quietHours?: KoishiQuietHourRange[];
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
			liveAtAll: Schema.boolean().default(true).description("开播@全体"),
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
		.default(DEFAULT_HEALTH_CHECK_MINUTES)
		.description(
			"登录状态周期检测的间隔（分钟）。女仆会按这个频率悄悄帮主人确认账号还在线哦～如果发现失效会立刻汇报呢 (๑•̀ㅂ•́)و✧",
		),

	cookieEncryptionKey: Schema.string()
		.role("secret")
		.description(
			"静态加密口令～设置后女仆会用它派生 AES-256 密钥，把主人的 B 站 Cookie / AI apiKey 真正加密保存，密钥本身不落盘 (๑•̀ㅂ•́)و✧ 留空的话女仆只能用本地随机密钥简单混淆一下，安全性会差很多哒 (；>_<) 💡 主人可以在终端跑 `openssl rand -base64 32`（或 `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`）生成一串足够随机的口令哦～ ⚠️ 一旦设置请务必妥善保管、不要随意改动或清空，否则之前加密的内容就解不开了，需要重新登录呢……",
		),

	quietHours: Schema.array(
		Schema.object({
			start: Schema.number().min(0).max(23).step(1).required().description("起始小时(0-23)"),
			end: Schema.number().min(0).max(23).step(1).required().description("结束小时(0-23,不含)"),
		}),
	)
		.role("table")
		.default([])
		.description(
			"全局免打扰时段:落进任一区间的推送直接丢弃,不补推。粒度按「时」,半开区间 [start, end);end<start 视为跨午夜(如 22 → 7 表示晚 22 点到次日 7 点)。per-UP 想单独配置可在 advanced-subscription 里覆盖。",
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
});
