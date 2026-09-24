/**
 * 直播推送的两处小规矩,**B 站的直播间与拓展订阅的直播共用**(ADR-0019 决策 65 / 67):什么时候推两边
 * 各管各的(计时器不共用),但同一个设置在两边得是同一个意思 —— 各抄一份的话,主人给某个抖音号设的
 * 封面 / 等待时长迟早有一格只有 B 站那头认。
 */

import type { CustomCardStyleLike, PickCardBackground } from "./push-like";

/** 断流接续等多久(分钟):设置里的值,缺省 2,防御性夹到 [1, 10]。 */
export function liveEndGraceMinutes(configured: number | undefined): number {
	return Math.min(10, Math.max(1, configured ?? 2));
}

/**
 * 直播卡的样式,**每推一次轮一张自定义封面**:样式自带的封面列表优先;这条订阅 / 这类卡没有任何覆盖
 * (列表为空)就落回全局那一套默认封面。列表多于一张时经 `pick`(游标键 `scopeKey`)选下一张、强制
 * `enable: true`,其余字段留空,由渲染器逐字段回退全局配置。选不出 / 只有一张 → 原样返回(单张已由
 * 宿主预填进 `liveCoverImage`)。
 *
 * 每调一次就推进一次游标 —— 只在真要推一张卡时调。
 */
export function rotateLiveCover(
	style: CustomCardStyleLike,
	defaultCovers: string[] | undefined,
	pick: PickCardBackground,
	scopeKey: string,
): CustomCardStyleLike {
	const covers =
		style.liveCoverImages && style.liveCoverImages.length > 0
			? style.liveCoverImages
			: defaultCovers;
	if (!covers || covers.length <= 1) return style;
	const picked = pick(scopeKey, covers);
	return picked === undefined ? style : { ...style, enable: true, liveCoverImage: picked };
}
