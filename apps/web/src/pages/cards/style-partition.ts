/**
 * per-kind 样式 partial 的**字段族分区** —— `cardStyleByKind.<kind>` 一个 partial 里住着
 * 两套互不相交的字段族,各有独立的 UI 开关,写入时必须只碰自己的族、保留别家的:
 *
 * - **外观覆盖**(字体/玻璃/背景图):「单独样式」开关,写 `appearanceOnly` 投影。
 *   (渐变起 / 止色已退役 —— 卡片底色归皮肤自己的 CSS,见 ADR-0014 决策 15 的 🔗。)
 * - **直播封面**(liveCoverImages):「直播封面」开关,pickCover/omitCover ——
 *   封面若混进外观快照,开「单独样式」就会把封面/背景互相钉住(用户报过的联动 bug)。
 *
 * 从前还有第三族「数据区 show」(人气/分区/粉丝),2026-09-14 随三个开关一起退役
 * (ADR-0014 决策 16 的 🔗):那三件拆成了原子块,想少显示哪件就在皮肤里删哪块。
 */

import type { CardStyle } from "../../types/globals";

export type StylePartial = Partial<CardStyle>;

const COVER_KEY = "liveCoverImages" as const;

/** 取覆盖里的直播封面字段子集。 */
export function pickCover(p: StylePartial | undefined): StylePartial {
	return p?.[COVER_KEY] !== undefined ? { [COVER_KEY]: p[COVER_KEY] } : {};
}

/** 只去掉直播封面字段(保留外观)。 */
export function omitCover(p: StylePartial | undefined): StylePartial {
	const o: StylePartial = { ...(p ?? {}) };
	delete o[COVER_KEY];
	return o;
}

/** 外观覆盖投影:去封面,只留字体/玻璃/背景图。 */
export function appearanceOnly(p: StylePartial | undefined): StylePartial {
	return omitCover(p);
}

export const hasCoverOverride = (p: StylePartial | undefined): boolean =>
	p?.[COVER_KEY] !== undefined;

/** 是否存在外观族覆盖(封面不算)。 */
export const hasAppearanceOverride = (p: StylePartial | undefined): boolean =>
	!!p && Object.keys(p).some((k) => k !== COVER_KEY);

export const isEmptyObj = (p: object): boolean => Object.keys(p).length === 0;
