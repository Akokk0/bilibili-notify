/**
 * 批准的像素差清单(ADR-0028 决策 2,守卫 10)。形状与判官在 `card-diff-check.ts`。
 *
 * - `baseline`:清单开张(1.0 第 2 期 ⑩,2026-10-02)时 23 个样例的出图 hash。新加的夹具在这里补一行。
 * - `approvals`:之后每一次出图变化,**只往末尾追加**,一条写清样例、变化、类别、依据和新 hash。
 *   同一样例认最后一条;旧条目不改不删,它们就是出图变迁的账。
 */

import type { CardDiffList } from "./card-diff-check";

export const APPROVED_CARD_DIFFS: CardDiffList = {
	baseline: {
		"dynamic-article": "5dc8efb7725183cd",
		"dynamic-av": "3fe2f49baa0aa630",
		"dynamic-charge-only": "3bb0aea26e823e4e",
		"dynamic-custom-layout": "9c6b31abc3668adb",
		"dynamic-draw": "d8bd91abf31eafad",
		"dynamic-draw-single": "2b71a06c8da42d0f",
		"dynamic-forward": "e9349768a41a0b63",
		"dynamic-unrenderable": "c1c4a811f19545a4",
		"dynamic-with-additional": "47ca0a2ce1b3affe",
		"dynamic-word": "1619094b9d17a1a5",
		"guard-badge-left": "4953c32520c4813f",
		"guard-captain": "9f376b5f5cc8b981",
		"guard-governor": "1a670a2d04ad14ce",
		"live-ended": "cb3cbdd6abffbde9",
		"live-minimal": "821353aa66a17c4d",
		"live-streaming": "0198f11ccd8c998e",
		"live-with-fontface": "d90b9bbf14f30c22",
		"roast-board": "f9cd965bda97fc57",
		"roast-solo": "687842993460e699",
		"sc-custom-layout": "64f3c3cfef80c2a1",
		"sc-high": "c6f9e1a451794ab7",
		"sc-low": "6a6641a7c480ee7b",
		wordcloud: "a1444fb7ddc6f1ef",
	},
	approvals: [],
};
