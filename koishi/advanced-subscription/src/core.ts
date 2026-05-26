/**
 * Advanced subscription adapter.
 *
 * Previously had its own runtime path (building SubItem[] and emitting Subscriptions).
 * Now it is purely a "config-shape adapter": converts the rich per-UP koishi Schema
 * into Subscription[] (new canonical format) and injects them into the main store
 * via the `bilibili-notify/advanced-sub` event.
 *
 * No independent runtime path remains — this package is a config translator.
 */

import { type Context, Schema } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";
import { buildAdvancedSubAndTargets, type SubItemRawConfig } from "./convert";

export type { BuildResult, ConversionResult } from "./convert";
export { buildAdvancedSubAndTargets, rawConfigToSubscription } from "./convert";

// ---- Schema definition (preserved for UI) ----

export interface BilibiliNotifyAdvancedSubConfig {
	subs: Record<string, SubItemRawConfig>;
}

export const BilibiliNotifyAdvancedSubConfig: Schema<BilibiliNotifyAdvancedSubConfig> =
	Schema.object({
		subs: Schema.dict(
			Schema.object({
				uid: Schema.string().required().description("要订阅的UP主的UID"),
				roomId: Schema.string().default("").description("直播间号，留空则自动查询"),
				dynamic: Schema.boolean().default(true).description("是否订阅动态通知"),
				dynamicAtAll: Schema.boolean()
					.default(false)
					.description("动态推送时是否 @全体(订阅级默认;频道行里可单独覆写)"),
				live: Schema.boolean().default(true).description("是否订阅直播开播通知"),
				liveAtAll: Schema.boolean()
					.default(true)
					.description(
						"开播推送时是否 @全体(订阅级默认;只冲开播,不冲 SC/上舰/总结;频道行里可单独覆写)",
					),
				liveEnd: Schema.boolean().default(true).description("是否订阅直播下播通知"),
				liveGuardBuy: Schema.boolean().default(false).description("是否订阅上舰通知"),
				superchat: Schema.boolean().default(false).description("是否订阅SC通知"),
				wordcloud: Schema.boolean().default(true).description("是否订阅弹幕词云"),
				liveSummary: Schema.boolean().default(true).description("是否订阅直播总结"),

				target: Schema.array(
					Schema.object({
						platform: Schema.string()
							.required()
							.description("消息推送平台（如 onebot、qq、discord）"),
						channelArr: Schema.array(
							Schema.object({
								channelId: Schema.string().required().description("频道或群组号"),
								dynamic: Schema.boolean().default(true).description("动态通知"),
								dynamicAtAll: Schema.boolean().description(
									"动态 @全体 覆写(可选;不填 = 跟订阅级默认;填 = 仅此频道按此值)",
								),
								live: Schema.boolean().default(true).description("直播通知"),
								liveAtAll: Schema.boolean().description(
									"开播 @全体 覆写(可选;不填 = 跟订阅级默认;只作用于开播,不冲 SC/上舰/总结)",
								),
								liveEnd: Schema.boolean().default(true).description("下播通知"),
								liveGuardBuy: Schema.boolean().default(false).description("上舰通知"),
								superchat: Schema.boolean().default(false).description("SC通知"),
								wordcloud: Schema.boolean().default(true).description("弹幕词云"),
								liveSummary: Schema.boolean().default(true).description("直播总结"),
								specialDanmaku: Schema.boolean().default(true).description("特别关注弹幕"),
								specialUserEnter: Schema.boolean().default(true).description("特别关注进入直播间"),
							}),
						)
							.role("table")
							.required()
							.description(
								"推送目标配置。注意:channelArr 留空期间该 UP 已经在监听动态/直播,但事件会直接丢弃不缓存——请尽快配置至少一个频道",
							),
					}),
				).description("推送平台和频道/群组列表"),

				customLiveSummary: Schema.intersect([
					Schema.object({
						enable: Schema.boolean().default(false).description("是否启用自定义直播总结"),
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
									"直播总结模板，支持变量：-dmc（弹幕发言人数）、-mdn（勋章名）、-dca（弹幕总数）、-un1~5（弹幕排行用户）、-dc1~5（弹幕排行数量）",
								),
						}),
						Schema.object({}),
					]),
				]),

				customLiveMsg: Schema.intersect([
					Schema.object({
						enable: Schema.boolean().default(false).description("是否启用自定义直播消息"),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							customLiveStart: Schema.string().description(
								"开播消息模板，支持变量：-name（UP主名字）、-follower（粉丝数）、-link（直播间链接）",
							),
							customLive: Schema.string().description(
								"直播中消息模板，支持变量：-name（UP主名字）、-time（开播时长）、-watched（观看人数）、-link（直播间链接）",
							),
							customLiveEnd: Schema.string().description(
								"下播消息模板，支持变量：-name（UP主名字）、-follower_change（粉丝变化）、-time（开播时长）",
							),
						}),
						Schema.object({}),
					]),
				]),

				customCardStyle: Schema.intersect([
					Schema.object({
						enable: Schema.boolean().default(false).description("是否启用自定义卡片样式"),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							cardColorStart: Schema.string()
								.pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
								.description("卡片渐变起始颜色（16进制）"),
							cardColorEnd: Schema.string()
								.pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
								.description("卡片渐变结束颜色（16进制）"),
						}),
						Schema.object({}),
					]),
				]),

				customGuardBuy: Schema.intersect([
					Schema.object({
						enable: Schema.boolean().default(false).description("是否启用自定义上舰消息"),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							guardBuyMsg: Schema.string()
								.default("【-mname的直播间】-uname加入了大航海（-guard）")
								.description(
									"上舰消息模板，支持变量：-uname（用户昵称）、-mname（主播名字）、-guard（舰长类别）",
								),
							captainImgUrl: Schema.string()
								.default(
									"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
								)
								.description("舰长图片链接"),
							supervisorImgUrl: Schema.string()
								.default(
									"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
								)
								.description("提督图片链接"),
							governorImgUrl: Schema.string()
								.default(
									"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
								)
								.description("总督图片链接"),
						}),
						Schema.object({}),
					]),
				]),

				customAi: Schema.intersect([
					Schema.object({
						enable: Schema.boolean()
							.default(false)
							.description(
								"是否为该 UP 启用 AI 自定义。关 = 沿用全局 GlobalDefaults.ai;开 = 用下方所有字段(留空字符串 = 沿用全局对应字段)",
							),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							personaName: Schema.string().default("小绫").description("AI 角色名字"),
							addressUser: Schema.string().default("主人").description("AI 对用户的称呼"),
							addressSelf: Schema.string().default("小绫").description("AI 对自己的称呼"),
							personaTraits: Schema.string()
								.default("温柔、体贴、说话轻声细语")
								.description("性格特征(逗号分隔多个特征,如「温柔、毒舌、爱用反问」)"),
							catchphrase: Schema.string().default("").description("口头禅(可空)"),
							baseRole: Schema.string()
								.default("")
								.description("基础角色描述,用于 system prompt 起手段(留空 = 用全局默认)"),
							extraSystemPrompt: Schema.string()
								.default("")
								.description("追加到 system prompt 末尾的额外指令(留空 = 用全局默认)"),
							dynamicPrompt: Schema.string()
								.default("")
								.description("动态点评的 prompt(留空 = 沿用全局 GlobalDefaults.ai.dynamicPrompt)"),
							liveSummaryPrompt: Schema.string()
								.default("")
								.description("直播总结的 prompt(留空 = 沿用全局)"),
							temperature: Schema.number()
								.min(0)
								.max(2)
								.step(0.1)
								.default(0.7)
								.description("AI temperature (0-2),越高越随机,默认 0.7"),
						}),
						Schema.object({}),
					]),
				]),

				customImageGroup: Schema.intersect([
					Schema.object({
						enable: Schema.boolean()
							.default(false)
							.description(
								"是否为该 UP 启用自定义图集行为。关 = 沿用 koishi/dynamic 插件全局;开 = 用下方字段覆盖",
							),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							// default 与 koishi/dynamic imageGroup.enable 对齐,避免开 enable 但
							// 未改字段时静默压住全局。注意字段名 `imgEnable` 与外层 `enable` 区分:
							// 外层 = 是否启用此 custom 模板;内层 = 是否推图集本身的行为。
							imgEnable: Schema.boolean()
								.default(true)
								.description("是否额外推送图集图片(关 = 只发卡片)"),
							forward: Schema.boolean()
								.default(false)
								.description("开 = 合并转发(聊天记录卡片);关 = 多图普通消息。单图不走合并转发"),
						}),
						Schema.object({}),
					]),
				]),

				customSpecialDanmakuUsers: Schema.intersect([
					Schema.object({
						enable: Schema.boolean().default(false).description("是否启用特别关注弹幕用户监测"),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							specialDanmakuUsers: Schema.array(String)
								.role("table")
								.description("特别关注弹幕用户列表（请填写UID），每个UID单独一行"),
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
							.description("是否启用特别关注用户进入直播间监测"),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							specialUsersEnterTheRoom: Schema.array(String)
								.role("table")
								.description("特别关注进入直播间用户列表（请填写UID），每个UID单独一行"),
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
								"是否为该 UP 启用自定义内容过滤。关 = 完全继承全局 GlobalDefaults.filters;开 = 用下方字段(数组留空 = 该项仍继承全局,标量为显式值)",
							),
					}),
					Schema.union([
						Schema.object({
							enable: Schema.const(true).required(),
							blockForward: Schema.boolean()
								.default(false)
								.description("是否丢弃「转发」动态(转发自其他 UP 的二级动态)"),
							blockArticle: Schema.boolean().default(false).description("是否丢弃「专栏文章」动态"),
							blockDraw: Schema.boolean()
								.default(false)
								.description(
									"是否丢弃「图文」动态(带图的朋友圈式动态;新版 B 站走 opus 框架,外层 type 仍为 DRAW)",
								),
							blockAv: Schema.boolean().default(false).description("是否丢弃「视频投稿」动态"),
							blockKeywords: Schema.array(String)
								.default([])
								.description("关键词黑名单:动态内容命中任一关键词(子串匹配)则丢弃,每行一条"),
							blockRegex: Schema.array(String)
								.default([])
								.description("正则黑名单:动态内容匹配任一正则则丢弃。无效正则会被忽略并打 warn"),
							whitelistKeywords: Schema.array(String)
								.default([])
								.description(
									"关键词白名单:非空时只有命中任一关键词的动态才放行(black 优先于 white)",
								),
							whitelistRegex: Schema.array(String)
								.default([])
								.description("正则白名单:同关键词白名单,但走正则匹配"),
							minScPrice: Schema.number()
								.min(0)
								.step(1)
								.default(0)
								.description("SC 最低价格(元):低于此值的 SC 不推。0 = 全部推"),
							minGuardLevel: Schema.union([1, 2, 3])
								.default(3)
								.description(
									"舰长最低等级:3=舰长 / 2=提督 / 1=总督。低于此等级的上舰不推(数值越低越严)",
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
								"是否为该 UP 启用自定义调度。关 = 完全继承全局 GlobalDefaults.schedule(含全局 quietHours);开 = 用下方字段",
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
										.description("起始小时(0-23)"),
									end: Schema.number()
										.min(0)
										.max(23)
										.step(1)
										.required()
										.description("结束小时(0-23,不含)"),
								}),
							)
								.role("table")
								.default([])
								.description(
									"per-UP 免打扰时段:落进任一区间的推送直接丢弃。粒度按「时」,半开区间 [start, end);end<start 视为跨午夜。留空 = 继承全局 quietHours。",
								),
							pushTime: Schema.number()
								.min(0)
								.max(24)
								.step(1)
								.default(0)
								.description(
									"「正在直播」复推间隔(小时):0 = 不复推。开播后每隔此小时数复推一次直播间状态",
								),
							restartPush: Schema.boolean()
								.default(false)
								.description("Koishi 重启后如果该 UP 正在直播,是否立即补推一次「开播」通知"),
						}),
						Schema.object({}),
					]),
				]),
			}).collapse(),
		),
	});

// ---- Conversion logic ----
// Pure conversion functions live in `./convert` (koishi-free, unit-testable);
// re-exported above so back-compat consumers of `core.ts` keep working.

export function applyAdvancedSub(ctx: Context, config: BilibiliNotifyAdvancedSubConfig): void {
	const emit = () => {
		const { subs, adapters, targets } = buildAdvancedSubAndTargets(config);
		// Emit adapters + targets first so the registry has them before
		// subscriptions reference them via routing.
		ctx.emit("bilibili-notify/advanced-sub-adapters", adapters);
		ctx.emit("bilibili-notify/advanced-sub-targets", targets);
		ctx.emit("bilibili-notify/advanced-sub", subs);
	};

	// P2:双路投递覆盖两种加载次序 —— eager `emit()` 兜「core 已就绪」,
	// `ready-to-receive` 兜「core 后就绪」。两路可能重复投递,但下游
	// SubscriptionStore.upsert 已幂等(内容未变直接 return,见 subscription
	// p2 stableStringify),重复投递为 no-op,故无需去重 / 改握手结构。
	emit();

	ctx.on("bilibili-notify/ready-to-receive", () => {
		emit();
	});
}
