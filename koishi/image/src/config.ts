import { DEFAULT_CARD_STYLE } from "@bilibili-notify/internal";
import { Schema } from "koishi";

export interface BilibiliNotifyImageConfig {
	logLevel: number;
	cardColorStart: string;
	cardColorEnd: string;
	font: string;
	hideDesc: boolean;
	/**
	 * BREAKING(next release):前身字段 `followerDisplay`(显示=true)重命名 + 语义反转
	 * 为 `hideFollower`(隐藏=true),对齐 `hideDesc` 命名风格。koishi Schema 不识别
	 * 旧字段 → 升级后旧 yaml 里 `followerDisplay: false`(想隐藏)被 schema 丢弃,
	 * 取 `hideFollower` 默认 false(=显示),粉丝又会显示出来。受影响用户需手动
	 * 把 yaml 里的字段名改成 `hideFollower` 并把布尔值取反。
	 */
	hideFollower: boolean;
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
		.default(DEFAULT_CARD_STYLE.cardColorStart)
		.description(
			"这是推送卡片渐变背景的起始颜色～主人喜欢什么颜色，女仆就用什么颜色 (〃´-`〃)♡ 请填写十六进制颜色值哦！",
		),
	cardColorEnd: Schema.string()
		.default(DEFAULT_CARD_STYLE.cardColorEnd)
		.description("这是推送卡片渐变背景的结束颜色～和起始颜色搭配使用，打造漂亮的渐变效果 (*´∀`)~♡"),
	font: Schema.string()
		.default(DEFAULT_CARD_STYLE.font)
		.description(
			"如果主人想用自己的专属字体，可以在这里填写字体名称～女仆会努力渲染成主人喜欢的样子 (〃´-`〃)♡",
		),
	hideDesc: Schema.boolean()
		.default(DEFAULT_CARD_STYLE.hideDesc)
		.description("开启后会隐藏直播间简介，让推送卡片看起来更简洁清爽！女仆会照做的 (｀・ω・´)b"),
	hideFollower: Schema.boolean()
		.default(DEFAULT_CARD_STYLE.hideFollower)
		.description("开启后会隐藏推送卡片上的粉丝变化和累计观看人数。女仆觉得不显示也挺清爽 (*´∀`)~♡"),
});
