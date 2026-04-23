import { Schema } from "koishi";

export interface BilibiliNotifyLiveConfig {
	logLevel: number;
	wordcloudStopWords?: string;
	pushTime: number;
	restartPush: boolean;
	minScPrice: number;
	minGuardLevel: 1 | 2 | 3;
	liveSummary: string[];
	customGuardBuy: {
		enable: boolean;
		guardBuyMsg?: string;
		captainImgUrl?: string;
		supervisorImgUrl?: string;
		governorImgUrl?: string;
	};
	customLiveMsg: {
		enable: boolean;
		customLiveStart?: string;
		customLive?: string;
		customLiveEnd?: string;
	};
}

export const BilibiliNotifyLiveConfig: Schema<BilibiliNotifyLiveConfig> = Schema.object({
	logLevel: Schema.number()
		.min(1)
		.max(3)
		.step(1)
		.default(1)
		.description(
			"这里可以设置日志等级喔～3 是最详细的调试信息，1 是只显示错误信息。主人可以根据需要选择合适的等级，让女仆更好地为您服务 (๑•̀ㅂ•́)و✧",
		),
	wordcloudStopWords: Schema.string().description(
		"这里可以填写词云生成时要忽略的词～用英文逗号分隔哦！女仆会乖乖把这些词过滤掉的 (๑•̀ㅂ•́)و✧",
	),
	pushTime: Schema.number()
		.default(0)
		.description(
			"主人想多长时间推送一次直播状态呢？单位是小时，0 表示不推送。女仆会按主人的节奏努力工作的 (๑•̀ㅂ•́)و✧",
		),
	restartPush: Schema.boolean()
		.default(false)
		.description(
			"插件重启后，如果 UP 正在直播，要不要马上推送一次呢？女仆会第一时间报告给主人的！",
		),

	minScPrice: Schema.number()
		.min(0)
		.default(0)
		.description("SC（醒目留言）最低推送金额，低于此金额的 SC 不会推送。设为 0 表示全部推送。"),

	minGuardLevel: Schema.union([
		Schema.const(3).description("舰长及以上（全部推送）"),
		Schema.const(2).description("仅推送提督及以上"),
		Schema.const(1).description("仅推送总督"),
	])
		.default(3)
		.description("上舰消息最低推送等级，低于此等级的上舰不会推送。"),

	liveSummary: Schema.array(String)
		.default([
			"🔍【弹幕情报站】本场直播数据如下：",
			"🧍‍♂️ 总共 -dmc 位-mdn上线",
			"💬 共计 -dca 条弹幕飞驰而过",
			"📊 热词云图已生成，快来看看你有没有上榜！",
			"👑 本场顶级输出选手：",
			"🥇 -un1 - 弹幕输出 -dc1 条",
			"🥈 -un2 - 弹幕 -dc2 条，萌力惊人",
			"🥉 -un3 - -dc3 条精准狙击",
			"🎖️ 特别嘉奖：-un4 & -un5",
			"你们的弹幕，我们都记录在案！🕵️‍♀️",
		])
		.role("table")
		.description(
			"这里可以自定义直播总结的模版～每一行就是一段内容，女仆会按主人写的格式发送哦 (〃´-`〃)♡变量解释：-dmc代表总弹幕发送人数，-mdn代表主播粉丝牌子名，-dca代表总弹幕数，-un1到-un5代表弹幕发送条数前五名用户的用户名，-dc1到-dc5代表弹幕发送条数前五名的弹幕发送数量，数组每一行代表换行",
		),

	customGuardBuy: Schema.intersect([
		Schema.object({
			enable: Schema.boolean().default(false).description("要不要让女仆开启自定义上舰消息呢？(ﾟ▽ﾟ)"),
		}),
		Schema.union([
			Schema.object({
				enable: Schema.const(true).required(),
				guardBuyMsg: Schema.string()
					.default("【-mname的直播间】-uname 加入了大航海（-guard）")
					.description(
						"这里可以自定义上舰提示内容～-uname 是用户名，-mname 是主播名，-guard 是舰长类型哒！女仆会甜甜地发送给主人的群里 (〃ﾉωﾉ)♡",
					),
				captainImgUrl: Schema.string()
					.default(
						"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
					)
					.description(
						"舰长图片链接，这是对应舰长阶级的图片链接～女仆会把它贴在推送里，让消息更好看(*´∀`)~♡",
					),
				supervisorImgUrl: Schema.string()
					.default(
						"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
					)
					.description(
						"提督图片链接，这是对应提督阶级的图片链接～女仆会把它贴在推送里，让消息更好看(*´∀`)~♡",
					),
				governorImgUrl: Schema.string()
					.default(
						"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
					)
					.description(
						"总督图片链接，这是对应总督阶级的图片链接～女仆会把它贴在推送里，让消息更好看(*´∀`)~♡",
					),
			}),
			Schema.object({}),
		]),
	]),

	customLiveMsg: Schema.intersect([
		Schema.object({
			enable: Schema.boolean()
				.default(false)
				.description("要不要让女仆开启自定义直播消息呢？(〃ﾉωﾉ)"),
		}),
		Schema.union([
			Schema.object({
				enable: Schema.const(true).required(),
				customLiveStart: Schema.string()
					.default("-name 开播啦，当前粉丝数：-follower\n-link")
					.description(
						"这是开播提示语的自定义格式～女仆会把 -name、-follower、-link 都替换成真实数据送给主人 (〃´-`〃)♡，-name代表UP昵称，-follower代表当前粉丝数，-link代表直播间链接（QQ官方机器人请不要使用），\\n为换行",
					),
				customLive: Schema.string()
					.default("-name 正在直播，已播 -time，累计观看：-watched\n-link")
					.description(
						"直播中提示语的自定义内容在这里～-name、-time、-watched 都会由女仆乖乖替换哒！-name代表UP昵称，-time代表开播时长，-watched代表累计观看人数，-link代表直播间链接（QQ官方机器人请不要使用），\\n为换行",
					),
				customLiveEnd: Schema.string()
					.default("-name 下播啦，本次直播了 -time，粉丝变化 -follower_change")
					.description(
						"下播提示语的设定～-time、-follower_change 等变量女仆都会帮主人处理好 (*´∀`)，-name代表UP昵称，-follower_change代表本场直播粉丝数变化，-time代表开播时长，\\n为换行",
					),
			}),
			Schema.object({}),
		]),
	]),
});
