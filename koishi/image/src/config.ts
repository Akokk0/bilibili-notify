import { DEFAULT_CARD_STYLE } from "@bilibili-notify/internal";
import { Schema } from "koishi";

export interface BilibiliNotifyImageConfig {
	logLevel: number;
	cardColorStart: string;
	cardColorEnd: string;
	font: string;
	/**
	 * 直播卡「数据区」(原人气/分区 + 粉丝信息合并块)各项显示开关,默认全开。
	 * BREAKING(next release):移除旧的 `hideDesc`(简介显隐改由独立端版式控制,koishi 暂不可调)
	 * 与 `hideFollower`(并入 `showFans`,语义反转为「显示=true」)。旧 yaml 的这两个字段被
	 * koishi Schema 丢弃;原先隐藏粉丝的用户需把 `showFans` 关掉。
	 */
	showPopularity: boolean;
	showArea: boolean;
	showFans: boolean;
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
	showPopularity: Schema.boolean()
		.default(DEFAULT_CARD_STYLE.showPopularity)
		.description("直播卡数据区是否显示人气 / 点赞～关掉会更简洁清爽，女仆都听主人的 (｀・ω・´)b"),
	showArea: Schema.boolean()
		.default(DEFAULT_CARD_STYLE.showArea)
		.description("直播卡数据区是否显示直播分区～主人想露就露，不想露女仆就藏起来 (〃´-`〃)♡"),
	showFans: Schema.boolean()
		.default(DEFAULT_CARD_STYLE.showFans)
		.description("直播卡数据区是否显示粉丝数据(当前粉丝数 / 累计观看 / 粉丝变化) (*´∀`)~♡"),
});
