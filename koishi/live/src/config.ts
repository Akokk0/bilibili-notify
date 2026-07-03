import {
	DEFAULT_CONTENT_FILTERS,
	DEFAULT_SCHEDULE,
	DEFAULT_TEMPLATES,
} from "@bilibili-notify/internal";
import { Schema } from "koishi";

export interface BilibiliNotifyLiveConfig {
	logLevel: number;
	wordcloudStopWords?: string;
	pushTime: number;
	restartPush: boolean;
	liveEndGrace: boolean;
	liveEndGraceMinutes: number;
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
	liveUrl: boolean;
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
		.default(DEFAULT_SCHEDULE.pushTime)
		.description(
			"主人想多长时间推送一次直播状态呢？单位是小时，0 表示不推送。女仆会按主人的节奏努力工作的 (๑•̀ㅂ•́)و✧",
		),
	restartPush: Schema.boolean()
		.default(DEFAULT_SCHEDULE.restartPush)
		.description(
			"插件重启后，如果 UP 正在直播，要不要马上推送一次呢？女仆会第一时间报告给主人的！",
		),

	liveEndGrace: Schema.boolean()
		.default(DEFAULT_SCHEDULE.liveEndGrace)
		.description(
			"断流接续～开启后 UP 下播不会马上通知，女仆会先等一会儿；如果在等待时间内又开播了（多半是网络抖动或被超管掐了流），就当作同一场直播接续下去，不发下播也不重发开播 (｀・ω・´)b",
		),
	liveEndGraceMinutes: Schema.number()
		.min(1)
		.max(10)
		.step(1)
		.default(DEFAULT_SCHEDULE.liveEndGraceMinutes)
		.description(
			"断流接续的等待时长（分钟，1～10）～只有上面的开关打开时才生效；超过这个时间还没重新开播，女仆才判定是真的下播并通知主人 (〃´-`〃)♡",
		),

	minScPrice: Schema.number()
		.min(0)
		.default(DEFAULT_CONTENT_FILTERS.minScPrice)
		.description("SC（醒目留言）最低推送金额，低于此金额的 SC 不会推送。设为 0 表示全部推送。"),

	minGuardLevel: Schema.union([
		Schema.const(3).description("舰长及以上（全部推送）"),
		Schema.const(2).description("仅推送提督及以上"),
		Schema.const(1).description("仅推送总督"),
	])
		.default(DEFAULT_CONTENT_FILTERS.minGuardLevel)
		.description("上舰消息最低推送等级，低于此等级的上舰不会推送。"),

	liveSummary: Schema.array(String)
		.default(DEFAULT_TEMPLATES.liveSummary.split("\n"))
		.role("table")
		.description(
			"这里可以自定义直播总结的模版～每一行就是一段内容，女仆会按主人写的格式发送哦 (〃´-`〃)♡变量解释：{dmc}代表总弹幕发送人数，{mdn}代表主播粉丝牌子名，{dca}代表总弹幕数，{un1}到{un5}代表弹幕发送条数前五名用户的用户名，{dc1}到{dc5}代表弹幕发送条数前五名的弹幕发送数量，数组每一行代表换行",
		),

	customGuardBuy: Schema.intersect([
		Schema.object({
			enable: Schema.boolean().default(false).description("要不要让女仆开启自定义上舰消息呢？(ﾟ▽ﾟ)"),
		}),
		Schema.union([
			Schema.object({
				enable: Schema.const(true).required(),
				guardBuyMsg: Schema.string()
					.default("【{mname}的直播间】{uname} 加入了大航海（{guard}）")
					.description(
						"这里可以自定义上舰提示内容～{uname} 是用户名，{mname} 是主播名，{guard} 是舰长类型哒！女仆会甜甜地发送给主人的群里 (〃ﾉωﾉ)♡",
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

	liveUrl: Schema.boolean()
		.default(true)
		.description(
			"开播 / 直播中 / 下播推送要不要附带直播间链接呢？链接会作为独立的一段跟在文案后面～用 QQ 官方机器人的主人请关掉,不然会被吞消息的 (＞﹏＜)",
		),

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
					.default(DEFAULT_TEMPLATES.liveStart)
					.description(
						"这是开播提示语的自定义格式～{name}代表UP昵称，{follower}代表当前粉丝数，\\n为换行。链接不再写进模板哦,由上面的「附带直播间链接」开关决定 (〃´-`〃)♡",
					),
				customLive: Schema.string()
					.default(DEFAULT_TEMPLATES.liveOngoing)
					.description(
						"直播中提示语的自定义内容在这里～{name}代表UP昵称，{time}代表开播时长，{watched}代表累计观看人数，\\n为换行。链接不再写进模板哦,由上面的「附带直播间链接」开关决定 (〃´-`〃)♡",
					),
				customLiveEnd: Schema.string()
					.default(DEFAULT_TEMPLATES.liveEnd)
					.description(
						"下播提示语的设定～{time}、{follower_change} 等变量女仆都会帮主人处理好 (*´∀`)，{name}代表UP昵称，{follower_change}代表本场直播粉丝数变化，{time}代表开播时长，\\n为换行。链接不再写进模板哦,由上面的「附带直播间链接」开关决定 (〃´-`〃)♡",
					),
			}),
			Schema.object({}),
		]),
	]),
});
