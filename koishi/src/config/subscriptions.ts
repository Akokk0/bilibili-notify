import type { FlatSubConfigItem } from "@bilibili-notify/subscription";
import { Schema } from "koishi";

export type { FlatSubConfigItem };

export interface SubscriptionsConfig {
	list: FlatSubConfigItem[];
}

export const SubscriptionsConfigSchema: Schema<SubscriptionsConfig> = Schema.object({
	list: Schema.array(
		Schema.object({
			name: Schema.string().required().description("UP 昵称"),
			uid: Schema.string().required().description("UID"),
			dynamic: Schema.boolean().default(true).description("动态推送"),
			dynamicAtAll: Schema.boolean().default(false).description("动态 @全体"),
			live: Schema.boolean().default(true).description("开播通知"),
			liveAtAll: Schema.boolean().default(true).description("开播 @全体"),
			liveEnd: Schema.boolean().default(true).description("下播通知"),
			liveGuardBuy: Schema.boolean().default(false).description("上舰消息"),
			superchat: Schema.boolean().default(false).description("SC 消息"),
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
}).description("订阅 · 基础模式(高级订阅关闭时生效)");
