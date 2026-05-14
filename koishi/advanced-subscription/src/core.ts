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
				dynamic: Schema.boolean().default(true).description("是否订阅动态通知（总开关）"),
				dynamicAtAll: Schema.boolean()
					.default(false)
					.description("动态推送时是否 @全体(订阅级默认;频道行里可单独覆写)"),
				live: Schema.boolean().default(true).description("是否订阅直播开播通知（总开关）"),
				liveAtAll: Schema.boolean()
					.default(true)
					.description(
						"开播推送时是否 @全体(订阅级默认;只冲开播,不冲 SC/上舰/总结;频道行里可单独覆写)",
					),
				liveEnd: Schema.boolean().default(true).description("是否订阅直播下播通知（总开关）"),
				liveGuardBuy: Schema.boolean().default(false).description("是否订阅上舰通知（总开关）"),
				superchat: Schema.boolean().default(false).description("是否订阅SC通知（总开关）"),
				wordcloud: Schema.boolean().default(true).description("是否订阅弹幕词云（总开关）"),
				liveSummary: Schema.boolean().default(true).description("是否订阅直播总结（总开关）"),

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
							.description("推送目标配置"),
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

	emit();

	ctx.on("bilibili-notify/ready-to-receive", () => {
		emit();
	});
}
