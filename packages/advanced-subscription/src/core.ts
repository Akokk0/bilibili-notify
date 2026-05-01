import type {
	CustomCardStyle,
	CustomGuardBuy,
	CustomLiveMsg,
	CustomLiveSummary,
	PushFeature,
	SubItem,
	SubItemMasters,
	Subscriptions,
	Target,
} from "@bilibili-notify/push";
import { MASTER_FEATURES, PUSH_FEATURES } from "@bilibili-notify/push";
import { type Context, Schema } from "koishi";
import type {} from "koishi-plugin-bilibili-notify";

type ChannelConfig = Record<PushFeature, boolean> & { channelId: string };

interface TargetConfig {
	platform: string;
	channelArr: ChannelConfig[];
}

type SubItemRawConfig = SubItemMasters & {
	uid: string;
	roomId: string;
	target: TargetConfig[];
	customLiveSummary: { enable: boolean; liveSummary?: string[] };
	customLiveMsg: CustomLiveMsg;
	customCardStyle: CustomCardStyle;
	customGuardBuy: CustomGuardBuy;
	customSpecialDanmakuUsers: {
		enable: boolean;
		specialDanmakuUsers?: string[];
		msgTemplate?: string;
	};
	customSpecialUsersEnterTheRoom: {
		enable: boolean;
		specialUsersEnterTheRoom?: string[];
		msgTemplate?: string;
	};
};

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
					.description("是否在动态通知中@所有人（总开关）"),
				live: Schema.boolean().default(true).description("是否订阅直播开播通知（总开关）"),
				liveAtAll: Schema.boolean().default(true).description("是否在开播通知中@所有人（总开关）"),
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
								dynamicAtAll: Schema.boolean().default(false).description("动态@所有人"),
								live: Schema.boolean().default(true).description("直播通知"),
								liveAtAll: Schema.boolean().default(true).description("开播@所有人"),
								liveEnd: Schema.boolean().default(true).description("下播通知"),
								liveGuardBuy: Schema.boolean().default(false).description("上舰通知"),
								superchat: Schema.boolean().default(false).description("SC通知"),
								wordcloud: Schema.boolean().default(true).description("弹幕词云"),
								liveSummary: Schema.boolean().default(true).description("直播总结"),
								specialDanmaku: Schema.boolean().default(true).description("特别关注弹幕"),
								specialUserEnterTheRoom: Schema.boolean()
									.default(true)
									.description("特别关注进入直播间"),
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
							cardBasePlateColor: Schema.string()
								.pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
								.description("底板颜色（16进制）"),
							cardBasePlateBorder: Schema.string()
								.pattern(/\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax)/)
								.description("底板边框宽度（需带单位）"),
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

function pickRawMasters(raw: SubItemRawConfig): SubItemMasters {
	const out = {} as SubItemMasters;
	for (const key of MASTER_FEATURES) out[key] = raw[key] !== false;
	return out;
}

function configToSubItem(name: string, raw: SubItemRawConfig): SubItem {
	const target: Target = {};
	for (const entry of raw.target ?? []) {
		const { platform, channelArr } = entry;
		if (!channelArr?.length) continue;
		for (const ch of channelArr) {
			const item = { platform, channelId: ch.channelId };
			for (const key of PUSH_FEATURES) {
				if (!ch[key]) continue;
				if (!target[key]) target[key] = [];
				target[key]?.push(item);
			}
		}
	}

	// sub 级总开关压制：master 关闭时抹掉对应特性的全部 channel，
	// 即使 channel 自己开着也不发。
	for (const key of MASTER_FEATURES) {
		if (raw[key] === false) delete target[key];
	}

	const customLiveSummary: CustomLiveSummary = {
		enable: !!raw.customLiveSummary?.enable,
		liveSummary: (raw.customLiveSummary?.liveSummary ?? []).join("\n"),
	};

	return {
		uid: raw.uid,
		uname: name,
		roomId: raw.roomId ?? "",
		...pickRawMasters(raw),
		target,
		customCardStyle: raw.customCardStyle ?? { enable: false },
		customLiveMsg: raw.customLiveMsg ?? { enable: false },
		customGuardBuy: raw.customGuardBuy ?? { enable: false },
		customLiveSummary,
		customSpecialDanmakuUsers: raw.customSpecialDanmakuUsers?.enable
			? {
					enable: true,
					specialDanmakuUsers: raw.customSpecialDanmakuUsers.specialDanmakuUsers,
					msgTemplate: raw.customSpecialDanmakuUsers.msgTemplate ?? "",
				}
			: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: raw.customSpecialUsersEnterTheRoom?.enable
			? {
					enable: true,
					specialUsersEnterTheRoom: raw.customSpecialUsersEnterTheRoom.specialUsersEnterTheRoom,
					msgTemplate: raw.customSpecialUsersEnterTheRoom.msgTemplate ?? "",
				}
			: { enable: false, msgTemplate: "" },
	};
}

export function applyAdvancedSub(ctx: Context, config: BilibiliNotifyAdvancedSubConfig): void {
	const buildSubs = (): Subscriptions => {
		const subs: Subscriptions = {};
		for (const [name, raw] of Object.entries(config.subs)) {
			subs[raw.uid] = configToSubItem(name, raw);
		}
		return subs;
	};

	ctx.emit("bilibili-notify/advanced-sub", buildSubs());

	ctx.on("bilibili-notify/ready-to-receive", () => {
		ctx.emit("bilibili-notify/advanced-sub", buildSubs());
	});
}
