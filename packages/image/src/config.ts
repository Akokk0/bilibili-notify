import { Schema } from "koishi";

export interface BilibiliNotifyImageConfig {
	logLevel: number;
	cardColorStart: string;
	cardColorEnd: string;

	font: string;
	hideDesc: boolean;
	followerDisplay: boolean;
}

export const BilibiliNotifyImageConfig: Schema<BilibiliNotifyImageConfig> = Schema.object({
	logLevel: Schema.number()
		.min(1)
		.max(3)
		.step(1)
		.default(1)
		.description(
			"这里可以设置日志等级喔～3 是最详细的调试信息，1 是只显示错误信息。主人可以根据需要选择合适的等级，让女仆更好地为您服务 (๑•̀ㅂ•́)و✧",
		),
	cardColorStart: Schema.string()
		.default("#e0c3fc")
		.description(
			"这是推送卡片渐变背景的起始颜色～主人喜欢什么颜色，女仆就用什么颜色 (〃´-`〃)♡ 请填写十六进制颜色值哦！",
		),
	cardColorEnd: Schema.string()
		.default("#8ec5fc")
		.description("这是推送卡片渐变背景的结束颜色～和起始颜色搭配使用，打造漂亮的渐变效果 (*´∀`)~♡"),
	font: Schema.string()
		.default("sans-serif")
		.description(
			"如果主人想用自己的专属字体，可以在这里填写字体名称～女仆会努力渲染成主人喜欢的样子 (〃´-`〃)♡",
		),
	hideDesc: Schema.boolean()
		.default(false)
		.description("开启后会隐藏直播间简介，让推送卡片看起来更简洁清爽！女仆会照做的 (｀・ω・´)b"),
	followerDisplay: Schema.boolean()
		.default(true)
		.description(
			"要不要在推送卡片上显示粉丝变化和累计观看人数呢？女仆觉得显示出来会更好看 (*´∀`)~♡",
		),
});
