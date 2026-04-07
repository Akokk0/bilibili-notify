import { Schema } from "koishi";
import type { DynamicFilterConfig } from "./types";

export interface BilibiliNotifyDynamicConfig {
	logLevel: number;
	dynamicUrl: boolean;
	dynamicCron: string;
	dynamicVideoUrlToBV: boolean;
	pushImgsInDynamic: boolean;
	filter: DynamicFilterConfig & { notify?: boolean };
}

export const BilibiliNotifyDynamicSchema: Schema<BilibiliNotifyDynamicConfig> = Schema.object({
	logLevel: Schema.number()
		.min(1)
		.max(3)
		.step(1)
		.default(1)
		.description(
			"这里可以设置日志等级喔～3 是最详细的调试信息，1 是只显示错误信息。主人可以根据需要选择合适的等级，让女仆更好地为您服务 (๑•̀ㅂ•́)و✧",
		),
	dynamicUrl: Schema.boolean()
		.default(false)
		.description(
			"发送动态时要不要顺便发链接呢？但如果主人用的是 QQ 官方机器人，这个开关不要开喔～不然会出事的 (；>_<)！",
		),
	dynamicCron: Schema.string()
		.default("*/2 * * * *")
		.description(
			"主人想多久检查一次动态呢？这里填写 cron 表达式～太短太频繁会吓到女仆的，请温柔一点 (〃ﾉωﾉ)",
		),
	dynamicVideoUrlToBV: Schema.boolean()
		.default(false)
		.description("如果是视频动态，开启后会把链接换成 BV 号哦～方便主人的其他用途 (*´･ω･`)"),
	pushImgsInDynamic: Schema.boolean()
		.default(false)
		.description(
			"要不要把动态里的图片也一起推送呢？但、但是可能会触发 QQ 的风控，女仆会有点害怕 (；>_<) 请主人小心决定…",
		),
	filter: Schema.intersect([
		Schema.object({
			enable: Schema.boolean().default(false).description("要开启吗？"),
		}).description("这里是动态屏蔽设置～如果有不想看到的内容，女仆可以帮主人过滤掉 (＞﹏＜)！"),
		Schema.union([
			Schema.object({
				enable: Schema.const(true).required(),
				notify: Schema.boolean()
					.default(false)
					.description("当动态被屏蔽时，要不要让女仆通知主人呢？"),
				regex: Schema.string().description(
					"这里可以填写正则表达式，用来屏蔽特定动态～女仆会努力匹配的！",
				),
				keywords: Schema.array(String).description(
					"这里填写关键字，每一个都是单独的一项～有这些词的动态女仆都会贴心地拦下来 (*´∀`)",
				),
				forward: Schema.boolean().default(false).description("要不要屏蔽转发动态呢？主人说了算！"),
				article: Schema.boolean()
					.default(false)
					.description("是否屏蔽专栏动态～女仆会按照主人的喜好来处理 (๑•̀ㅂ•́)و✧"),
				whitelistEnable: Schema.boolean()
					.default(false)
					.description("是否启用白名单过滤（仅推送匹配白名单规则的动态）"),
				whitelistRegex: Schema.string().description("白名单正则表达式，命中时允许推送该动态"),
				whitelistKeywords: Schema.array(String).description(
					"白名单关键词，命中任意关键词时允许推送该动态",
				),
			}),
			Schema.object({}),
		]),
	]),
});
