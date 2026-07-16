/**
 * per-kind 样式 partial 的**字段族分区** —— `cardStyleByKind.<kind>` 一个 partial 里住着
 * 三套互不相交的字段族,各有独立的 UI 开关,写入时必须只碰自己的族、保留别家的:
 *
 * - **颜色覆盖**(渐变/字体/玻璃/背景图):「单独样式」开关,写 `colorOnly` 投影。
 * - **数据区 show**(人气/分区/粉丝):「直播数据」开关,pickShow/omitShow。
 * - **直播封面**(liveCoverImages):「直播封面」开关,pickCover/omitCover ——
 *   封面若混进颜色快照,开「单独样式」就会把封面/背景互相钉住(用户报过的联动 bug)。
 */

import type { CardStyle } from "../../types/globals";

export type StylePartial = Partial<CardStyle>;

export const SHOW_KEYS = ["showPopularity", "showArea", "showFans"] as const;
export type ShowKey = (typeof SHOW_KEYS)[number];

const COVER_KEY = "liveCoverImages" as const;

/** 取覆盖里的 show 字段子集(数据区)。 */
export function pickShow(p: StylePartial | undefined): StylePartial {
	const o: StylePartial = {};
	if (p) for (const k of SHOW_KEYS) if (p[k] !== undefined) o[k] = p[k];
	return o;
}

/** 只去掉 show 字段(保留颜色与封面)。 */
export function omitShow(p: StylePartial | undefined): StylePartial {
	const o: StylePartial = { ...(p ?? {}) };
	for (const k of SHOW_KEYS) delete o[k];
	return o;
}

/** 取覆盖里的直播封面字段子集。 */
export function pickCover(p: StylePartial | undefined): StylePartial {
	return p?.[COVER_KEY] !== undefined ? { [COVER_KEY]: p[COVER_KEY] } : {};
}

/** 只去掉直播封面字段(保留颜色与 show)。 */
export function omitCover(p: StylePartial | undefined): StylePartial {
	const o: StylePartial = { ...(p ?? {}) };
	delete o[COVER_KEY];
	return o;
}

/** 颜色覆盖投影:去 show、去封面,只留渐变/字体/玻璃/背景图。 */
export function colorOnly(p: StylePartial | undefined): StylePartial {
	return omitCover(omitShow(p));
}

export const hasShowOverride = (p: StylePartial | undefined): boolean =>
	SHOW_KEYS.some((k) => p?.[k] !== undefined);

export const hasCoverOverride = (p: StylePartial | undefined): boolean =>
	p?.[COVER_KEY] !== undefined;

/** 是否存在颜色族覆盖(show 与封面不算)。 */
export const hasColorOverride = (p: StylePartial | undefined): boolean =>
	!!p && Object.keys(p).some((k) => !SHOW_KEYS.includes(k as ShowKey) && k !== COVER_KEY);

export const isEmptyObj = (p: object): boolean => Object.keys(p).length === 0;
