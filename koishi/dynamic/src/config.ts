import type { DynamicFilterConfig } from "@bilibili-notify/dynamic";
import { DEFAULT_DYNAMIC_CRON, DEFAULT_TEMPLATES } from "@bilibili-notify/internal";
import { Schema } from "koishi";

export interface BilibiliNotifyDynamicConfig {
	logLevel: number;
	dynamicCron: string;
	dynamicVideoUrlToBV: boolean;
	dynamicTemplate: string;
	videoTemplate: string;
	imageGroup: {
		enable: boolean;
		forward: boolean;
	};
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
	dynamicCron: Schema.string()
		.default(DEFAULT_DYNAMIC_CRON)
		.description(
			"主人想多久检查一次动态呢？这里填写 cron 表达式～太短太频繁会吓到女仆的，请温柔一点 (〃ﾉωﾉ)",
		),
	dynamicVideoUrlToBV: Schema.boolean()
		.default(false)
		.description("如果是视频动态，开启后会把链接换成 BV 号哦～方便主人的其他用途 (*´･ω･`)"),
	dynamicTemplate: Schema.string()
		.default(DEFAULT_TEMPLATES.dynamic)
		.description(
			"动态推送的文案模板～变量 {name}=UP 昵称、{url}=动态链接。想去掉链接（比如用 QQ 官方机器人）就把 {url} 删掉哦 (๑•̀ㅂ•́)و✧",
		),
	videoTemplate: Schema.string()
		.default(DEFAULT_TEMPLATES.dynamicVideo)
		.description(
			"视频投稿的文案模板～变量 {name}=UP 昵称、{url}=视频链接（开了上面的 BV 开关则是 BV 号）。同样删掉 {url} 就不带链接。",
		),
	imageGroup: Schema.object({
		enable: Schema.boolean()
			.default(false)
			.description(
				"要不要把动态里的图片也一起推送呢？但、但是可能会触发 QQ 的风控，女仆会有点害怕 (；>_<) 请主人小心决定…",
			),
		forward: Schema.boolean()
			.default(false)
			.description(
				"开 = 合并转发(聊天记录卡片);关 = 多图普通消息。单图不走合并转发,仅当上面 enable 开启时生效。",
			),
	}).description("动态图集推送行为"),
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
				draw: Schema.boolean()
					.default(false)
					.description("是否屏蔽图文动态（带图的朋友圈式动态）～女仆遵命！"),
				av: Schema.boolean()
					.default(false)
					.description("是否屏蔽视频投稿动态～只要把图文留下、稿件忽略也是可以的！"),
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
