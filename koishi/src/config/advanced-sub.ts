import { Schema } from "koishi";
import type { SubItemRawConfig } from "../subscriptions/advanced";

export interface AdvancedSubConfig {
	enabled: boolean;
	subs: Record<string, SubItemRawConfig>;
}

export const AdvancedSubConfigSchema: Schema<AdvancedSubConfig> = Schema.object({
	enabled: Schema.boolean()
		.default(false)
		.description(
			"这个开关决定是否使用高级订阅功能喔～如果主人想要超级灵活的订阅内容，就请开启呀 (๑•̀ㅂ•́)و♡",
		),
	subs: Schema.dict(
		Schema.object({
			uid: Schema.string()
				.required()
				.description("要订阅的 UP 主的 UID，一定要填对哦，不然女仆会找错人的 (；>_<)"),
			roomId: Schema.string().default("").description("直播间号～留空的话女仆会自动帮主人查询哒"),
			dynamic: Schema.boolean().default(true).description("要不要订阅动态通知呢？"),
			dynamicAtAll: Schema.boolean()
				.default(false)
				.description(
					"动态推送时要不要 @全体呢？（这是订阅级默认值；下面的频道行里可以单独覆写哦）",
				),
			live: Schema.boolean().default(true).description("要不要订阅开播通知呢？"),
			liveAtAll: Schema.boolean()
				.default(true)
				.description(
					"开播推送时要不要 @全体呢？（订阅级默认值；只影响开播通知，不冲 SC / 上舰 / 总结；频道行里可以单独覆写）",
				),
			liveEnd: Schema.boolean().default(true).description("要不要订阅下播通知呢？"),
			liveGuardBuy: Schema.boolean().default(false).description("要不要订阅上舰通知呢？"),
			superchat: Schema.boolean().default(false).description("要不要订阅 SC 通知呢？"),
			wordcloud: Schema.boolean().default(true).description("要不要订阅弹幕词云呢？"),
			liveSummary: Schema.boolean().default(true).description("要不要订阅直播总结呢？"),

			target: Schema.array(
				Schema.object({
					platform: Schema.string()
						.required()
						.description(
							"消息推送平台，比如 onebot、qq、discord 这些～要和机器人适配器一致才找得到哦",
						),
					selfId: Schema.string().description(
						"想让**哪个账号**来送这些消息呢？(´｡• ᵕ •｡`) 留空的话女仆会自己挑该平台第一个在线的机器人——挂了两个同平台机器人的主人，这里填上那个账号的 ID（QQ 群里就是机器人的 QQ 号）就能钦点啦～ ⚠️ 一旦填了女仆就**只认这一个号**：它要是离线了，这些消息就不发了，也不会偷偷换个号发出去。不知道该填什么的话，敲 `status.bot` 女仆会把当前连着的机器人报给主人喔 (๑˃ᴗ˂)ﻭ",
					),
					channelArr: Schema.array(
						Schema.object({
							channelId: Schema.string().required().description("频道号/群组号"),
							dynamic: Schema.boolean().default(true).description("动态推送"),
							dynamicAtAll: Schema.boolean().description("动态 @全体（覆写订阅默认）"),
							live: Schema.boolean().default(true).description("开播通知"),
							liveAtAll: Schema.boolean().description("开播 @全体（覆写订阅默认）"),
							liveEnd: Schema.boolean().default(true).description("下播通知"),
							liveGuardBuy: Schema.boolean().default(false).description("上舰消息"),
							superchat: Schema.boolean().default(false).description("SC 消息"),
							wordcloud: Schema.boolean().default(true).description("弹幕词云"),
							liveSummary: Schema.boolean().default(true).description("直播总结"),
							specialDanmaku: Schema.boolean().default(true).description("特别关注弹幕提醒"),
							specialUserEnter: Schema.boolean().default(true).description("特别关注进房提醒"),
						}),
					)
						.role("table")
						.required()
						.description(
							"推送目标配置～要提醒主人一下:channelArr 留空期间该 UP 其实已经在被监听动态/直播了，只是事件会被女仆直接丢掉、不会缓存——所以请尽快配置至少一个频道哦 (；>_<)",
						),
				}),
			).description("推送平台和频道/群组列表，女仆会照着这份名单一个个送过去哒～"),

			customLiveSummary: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description("要不要为这个 UP 启用专属的自定义直播总结呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
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
								"直播总结模板，女仆会照着这份写好的稿子念给主人听～支持变量：{dmc}（弹幕发言人数）、{mdn}（勋章名）、{dca}（弹幕总数）、{un1}~{un5}（弹幕排行用户）、{dc1}~{dc5}（弹幕排行数量）",
							),
					}),
					Schema.object({}),
				]),
			]),

			customLiveMsg: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description("要不要为这个 UP 启用专属的自定义直播消息呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						customLiveStart: Schema.string().description(
							"开播消息模板，支持变量：{name}（UP主名字）、{follower}（粉丝数）。链接不用写进模板哦，由 live 域的「附带直播间链接」开关统一决定～",
						),
						customLive: Schema.string().description(
							"直播中消息模板，支持变量：{name}（UP主名字）、{time}（开播时长）、{watched}（观看人数）",
						),
						customLiveEnd: Schema.string().description(
							"下播消息模板，支持变量：{name}（UP主名字）、{follower_change}（粉丝变化）、{time}（开播时长）",
						),
					}),
					Schema.object({}),
				]),
			]),

			customDynamicMsg: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description("要不要为这个 UP 启用专属的自定义动态文案呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						dynamicText: Schema.string().description(
							"动态(非视频)推送文案模板，支持变量：{name}（UP主名字）。链接不用写进模板哦，由 dynamic 域的「附带链接」开关统一决定～",
						),
						videoText: Schema.string().description(
							"视频投稿推送文案模板，支持变量：{name}（UP主名字）。链接 / BV 同样由「附带链接」开关决定哒",
						),
					}),
					Schema.object({}),
				]),
			]),

			customCardStyle: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description("要不要为这个 UP 启用专属的卡片配色呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						cardColorStart: Schema.string()
							.pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
							.description("卡片渐变的起始颜色，请填十六进制色值哦～"),
						cardColorEnd: Schema.string()
							.pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
							.description("卡片渐变的结束颜色，和起始颜色搭配出漂亮渐变～"),
					}),
					Schema.object({}),
				]),
			]),

			customGuardBuy: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description("要不要为这个 UP 启用专属的上舰消息呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						guardBuyMsg: Schema.string()
							.default("【{mname}的直播间】{uname}加入了大航海（{guard}）")
							.description(
								"上舰消息模板，支持变量：{uname}（用户昵称）、{mname}（主播名字）、{guard}（舰长类别）",
							),
						captainImgUrl: Schema.string()
							.default(
								"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
							)
							.description("舰长的图片链接，女仆会贴在推送里让消息更好看～"),
						supervisorImgUrl: Schema.string()
							.default(
								"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
							)
							.description("提督的图片链接，女仆会贴在推送里让消息更好看～"),
						governorImgUrl: Schema.string()
							.default(
								"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
							)
							.description("总督的图片链接，女仆会贴在推送里让消息更好看～"),
					}),
					Schema.object({}),
				]),
			]),

			customAi: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description(
							"要不要为这个 UP 单独定制 AI 人格呢？关 = 沿用全局 GlobalDefaults.ai；开 = 用下方所有字段（留空字符串 = 沿用全局对应字段）",
						),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						personaName: Schema.string()
							.default("小绫")
							.description("AI 的角色名字，主人喜欢叫什么就叫什么～"),
						addressUser: Schema.string().default("主人").description("AI 要怎么称呼主人呢？"),
						addressSelf: Schema.string().default("小绫").description("AI 要怎么称呼自己呢？"),
						personaTraits: Schema.string()
							.default("温柔、体贴、说话轻声细语")
							.description("性格特征，逗号分隔多个特征就好，比如「温柔、毒舌、爱用反问」～"),
						catchphrase: Schema.string().default("").description("口头禅，可以留空不填哦"),
						baseRole: Schema.string()
							.default("")
							.description("基础角色描述，用于 system prompt 起手段～留空的话就沿用全局默认"),
						extraSystemPrompt: Schema.string()
							.default("")
							.description("追加到 system prompt 末尾的额外指令～留空的话就沿用全局默认"),
						dynamicPrompt: Schema.string()
							.default("")
							.description(
								"动态点评专属的 prompt～留空的话就沿用全局 GlobalDefaults.ai.dynamicPrompt",
							),
						liveSummaryPrompt: Schema.string()
							.default("")
							.description("直播总结专属的 prompt～留空的话就沿用全局默认"),
						temperature: Schema.number()
							.min(0)
							.max(2)
							.step(0.1)
							.default(0.7)
							.description("AI temperature（0～2），数值越高越随机，默认 0.7 哦"),
					}),
					Schema.object({}),
				]),
			]),

			customImageGroup: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description(
							"要不要为这个 UP 启用专属的图集推送行为呢？关 = 沿用 dynamic 域全局；开 = 用下方字段覆盖",
						),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						// default 与 dynamic 域 imageGroup.enable 对齐,避免开 enable 但
						// 未改字段时静默压住全局。注意字段名 `imgEnable` 与外层 `enable` 区分:
						// 外层 = 是否启用此 custom 模板;内层 = 是否推图集本身的行为。
						imgEnable: Schema.boolean()
							.default(true)
							.description("要不要额外推送图集图片呢？（关 = 只发卡片）"),
						forward: Schema.boolean()
							.default(false)
							.description("开 = 合并转发（聊天记录卡片）；关 = 多图普通消息。单图不走合并转发哦"),
					}),
					Schema.object({}),
				]),
			]),

			customSpecialDanmakuUsers: Schema.intersect([
				Schema.object({
					enable: Schema.boolean().default(false).description("要不要开启特别关注弹幕用户监测呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						specialDanmakuUsers: Schema.array(String)
							.role("table")
							.description("特别关注的弹幕用户列表（请填写 UID），每个 UID 单独一行～"),
						msgTemplate: Schema.string()
							.default("【-mastername的直播间】⭐ 特别关注弹幕 -uname: -msg")
							.description(
								"特别关注弹幕消息模板，支持变量：-mastername（主播名字）、-uname（用户昵称）、-msg（弹幕内容）",
							),
					}),
					Schema.object({}),
				]),
			]),

			customSpecialUsersEnterTheRoom: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description("要不要开启特别关注用户进入直播间监测呢？"),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						specialUsersEnterTheRoom: Schema.array(String)
							.role("table")
							.description("特别关注的进入直播间用户列表（请填写 UID），每个 UID 单独一行～"),
						msgTemplate: Schema.string()
							.default("【-mastername的直播间】🌟 特别关注用户 -uname 进入了直播间")
							.description(
								"特别关注进入直播间消息模板，支持变量：-mastername（主播名字）、-uname（用户昵称）",
							),
					}),
					Schema.object({}),
				]),
			]),

			customFilters: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description(
							"要不要为这个 UP 单独定制内容过滤呢？关 = 完全继承全局 GlobalDefaults.filters；开 = 用下方字段（数组留空 = 该项仍继承全局，标量为显式值）",
						),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						blockForward: Schema.boolean()
							.default(false)
							.description("要不要丢弃「转发」动态呢？（转发自其他 UP 的二级动态）"),
						blockArticle: Schema.boolean()
							.default(false)
							.description("要不要丢弃「专栏文章」动态呢？"),
						blockDraw: Schema.boolean()
							.default(false)
							.description(
								"要不要丢弃「图文」动态呢？（带图的朋友圈式动态；新版 B 站走 opus 框架，外层 type 仍为 DRAW）",
							),
						blockAv: Schema.boolean().default(false).description("要不要丢弃「视频投稿」动态呢？"),
						blockKeywords: Schema.array(String)
							.default([])
							.description(
								"关键词黑名单～动态内容命中任一关键词（子串匹配）就会被女仆丢掉，每行一条哦",
							),
						blockRegex: Schema.array(String)
							.default([])
							.description(
								"正则黑名单～动态内容匹配任一正则就会被丢掉。无效正则会被忽略并打 warn，不用担心",
							),
						whitelistKeywords: Schema.array(String)
							.default([])
							.description(
								"关键词白名单～非空时只有命中任一关键词的动态才会被放行（黑名单优先于白名单）",
							),
						whitelistRegex: Schema.array(String)
							.default([])
							.description("正则白名单～和关键词白名单一样的规则，只是走正则匹配"),
						minScPrice: Schema.number()
							.min(0)
							.step(1)
							.default(0)
							.description(
								"SC 最低价格（元）～低于这个数字的 SC 女仆就不推啦，设成 0 就是全部都推",
							),
						minGuardLevel: Schema.union([1, 2, 3])
							.default(3)
							.description(
								"舰长最低等级：3=舰长 / 2=提督 / 1=总督。低于这个等级的上舰不推（数值越低越严格哦）",
							),
					}),
					Schema.object({}),
				]),
			]),

			customSchedule: Schema.intersect([
				Schema.object({
					enable: Schema.boolean()
						.default(false)
						.description(
							"要不要为这个 UP 启用专属调度呢？关 = 完全继承全局 GlobalDefaults.schedule（含全局 quietHours）；开 = 用下方字段",
						),
				}),
				Schema.union([
					Schema.object({
						enable: Schema.const(true).required(),
						quietHours: Schema.array(
							Schema.object({
								start: Schema.number()
									.min(0)
									.max(23)
									.step(1)
									.required()
									.description("起始小时（0～23）"),
								end: Schema.number()
									.min(0)
									.max(23)
									.step(1)
									.required()
									.description("结束小时（0～23，不含）"),
							}),
						)
							.role("table")
							.default([])
							.description(
								"per-UP 免打扰时段～落进任一区间的推送女仆会直接丢掉。粒度按「时」，半开区间 [start, end)；end<start 视为跨午夜。留空的话就继承全局 quietHours 咯",
							),
						pushTime: Schema.number()
							.min(0)
							.max(24)
							.step(1)
							.default(0)
							.description(
								"「正在直播」复推间隔（小时）：0 = 不复推。开播后每隔这么多小时，女仆就复推一次直播间状态",
							),
						restartPush: Schema.boolean()
							.default(false)
							.description(
								"Koishi 重启后如果这个 UP 正在直播，要不要让女仆立即补推一次「开播」通知呢？",
							),
					}),
					Schema.object({}),
				]),
			]),
		}).collapse(),
	),
}).description("高级订阅");
