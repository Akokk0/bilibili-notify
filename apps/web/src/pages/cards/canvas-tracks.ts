/**
 * 画布那十二列各占多宽(ADR-0018 决策 3)—— 几乎全是纯函数;碰 DOM 的只有
 * {@link readGridTracks} 那三行。
 *
 * 与 `canvas-drag.ts` 同一条规矩(ADR-0014 决策 20):画布的几何算法住在纯模块里,组件只
 * 负责收指针、交结果。jsdom 没有布局引擎(`getBoundingClientRect()` 一律回 0),几何写在
 * 组件里就一条都钉不住。
 *
 * 两条路,**真值优先**:
 *
 * - **量到了**:预览框里玻璃层的 `grid-template-columns` 计算值就是十二条轨道各自多少
 *   像素,照抄当权重,画布的比例与真卡一模一样。
 * - **量不到**(预览还没出来、只读态、jsdom):退回按清单估 —— 定宽列按它在**卡宽**里的
 *   占比折成 fr。
 *
 * ⚠️ 估的那条路**系统性偏小**,而且没法在清单里修好:网格不在外框上,在**玻璃层**上,
 * 玻璃层的宽度是外框的内容宽,而那圈内边距写在**皮肤 CSS** 里 —— 清单里没有这个字段。
 * 2026-09-20 真机量到的差:出厂上舰卡外框 430、玻璃层 400,定宽列被画窄 7%,第 8|9 条
 * 界线 59.30% 对真卡的 56.25%,偏 3.05 个百分点。**别去调那个估算的系数**:调准了这一套
 * 皮肤,换一套内边距不同的照样错;要准就把真值接上。
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { columnsOf } from "./skin-draft-ops";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;

/** 画布最前面那根行号列的宽度 px。画布的 CSS 与拖拽的量尺共用它。 */
export const ROW_LABEL_COL = 28;

/** 一条纯 px 的轨道。浏览器的**计算值**只会是这种写法。 */
const PX_TRACK = /^([\d.]+)px$/;

/**
 * 玻璃层的 `grid-template-columns` **计算值** → 十二个像素数。不是这个形状就回 `null`,
 * 调用方退回估算。
 *
 * 两种「不是这个形状」都得拦:
 * - **条数不对** —— 多半是量错了元素(转发框里那层网格、或皮肤自己改了列数)。拿一份
 *   对不上号的数去画,比画得不准更难查。
 * - **不是纯 px** —— 说明拿到的不是计算值(jsdom 会把 `repeat(...)` 原样回给你)。
 */
export function parseGridTracks(value: string): number[] | null {
	const parts = value.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== CARD_SKIN_LIMITS.columns) return null;
	const out: number[] = [];
	for (const part of parts) {
		const m = PX_TRACK.exec(part);
		if (!m) return null;
		out.push(Number(m[1]));
	}
	return out;
}

/**
 * 从预览框里那份文档上量出十二条轨道 —— 这是本模块**唯一**碰 DOM 的一口,薄到三行,
 * 判形状那一半仍归上面那个纯函数。
 *
 * 量的是外层卡的玻璃层(`[data-bn~="glass"]`)。转发框里那层网格是个**没有挂点的**裸
 * div(见渲染器的 `blockPropsOf`),所以 `querySelector` 取第一个就是对的那个。
 *
 * jsdom 里回 `null`:那儿没有布局引擎,`grid-template-columns` 的计算值就是作者写的原文
 * (`repeat(12, …)`),过不了 `parseGridTracks` 那道形状闸 —— 画布于是退回估算,正是想要的。
 */
export function readGridTracks(doc: Document): number[] | null {
	const glass = doc.querySelector('[data-bn~="glass"]');
	const view = doc.defaultView;
	if (!glass || !view) return null;
	return parseGridTracks(view.getComputedStyle(glass).gridTemplateColumns ?? "");
}

/** 按清单估:定宽列按它在卡宽里的占比折成 fr。真值量不到时才走这条(理由见文件头)。 */
function estimatedShares(card: Card): number[] {
	const cols = columnsOf(card);
	const fixed = cols.reduce((s, c) => s + ("px" in c ? c.px : 0), 0);
	const free = Math.max(0, card.width - fixed);
	const frTotal = cols.reduce((s, c) => s + ("px" in c ? 0 : c.fr), 0);
	return cols.map((c) => ("px" in c ? c.px : frTotal > 0 ? (free * c.fr) / frTotal : 0));
}

/**
 * 画布整条 `grid-template-columns`:行号那一列 + 十二列。
 *
 * 宽度一律折成 **fr 权重**而不是照抄 px:画布的宽度与卡宽不是一回事(430 宽的上舰卡摊在
 * 700 宽的面板里),照抄 px 会让比例整个失真。折成权重就与容器宽度无关了。
 */
export function canvasTemplate(card: Card, measured?: readonly number[] | null): string {
	const shares = measured ?? estimatedShares(card);
	// 0 会让那一列整个塌掉、块看不见;留 1 至少画得出来(这种包本来也过不了装包门)。
	const parts = shares.map((w) => `minmax(0, ${Math.max(w, 1).toFixed(3)}fr)`);
	return `${ROW_LABEL_COL}px ${parts.join(" ")}`;
}
