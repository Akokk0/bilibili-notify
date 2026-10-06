/**
 * 按档换色的挂点(㉔d,ADR-0028 决策 4 的 2026-10-06 🔗):档位卡的外框与每个块 wrapper 上有属性 `data-rank`,皮肤 CSS 用
 * 属性选择器按档写规则。**清洗器一个字没改** —— 它今天就放行非 `data-bn` 的属性选择器。这里钉清洗这一半:
 * 块 CSS `[data-bn="self"][data-rank="3"]{…}` 与外框 CSS `[data-bn="frame"][data-rank="3"]{…}` 过得了清洗、产物原样保留。
 * 另一半(清洗后的规则塞进皮肤、翻译成 `.bn-blk-<id>[data-rank="3"]` / `[data-bn~="frame"][data-rank="3"]`、真出图,
 * 档位对上的选得中、对不上的选不中)要 DOM,住在 `packages/image/src/__tests__/data-rank.test.ts`,那边用的规则字符串就是
 * 这里断言过「清洗后原样」的那两条。
 *
 * 验红:让清洗器对 `data-rank` 属性选择器丢弃(例如把 `data-` 开头的属性选择器纳入 `data-bn` 那套检查),这里红。
 */

import { CARD_SKIN_RANK_ATTR } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { sanitizeCardBlockCss, sanitizeCardFrameCss } from "../css-sanitizer.js";

const BLOCK_RULE = `[data-bn="self"][data-rank="3"]{color:rgb(1,2,3)}`;
const FRAME_RULE = `[data-bn="frame"][data-rank="3"]{outline:2px solid rgb(4,5,6)}`;

function sanitizedBlock(kind: "sc" | "guard", builtin: string, css: string): string {
	const res = sanitizeCardBlockCss(css, { kind, builtin });
	expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return res.css;
}

function sanitizedFrame(css: string): string {
	const res = sanitizeCardFrameCss(css);
	expect(res.ok, res.ok ? "" : res.errors.join(" / ")).toBe(true);
	if (!res.ok) throw new Error("unreachable");
	return res.css;
}

describe("清洗器放行 data-rank 属性选择器(清洗器零改动)", () => {
	it('块 CSS:[data-bn="self"][data-rank="3"]{…} 原样保留', () => {
		expect(sanitizedBlock("sc", "amount", BLOCK_RULE)).toBe(BLOCK_RULE);
		expect(sanitizedBlock("guard", "viewerName", BLOCK_RULE)).toBe(BLOCK_RULE);
	});

	it('外框 CSS:[data-bn="frame"][data-rank="3"]{…} 原样保留', () => {
		expect(sanitizedFrame(FRAME_RULE)).toBe(FRAME_RULE);
	});

	it("常量就是 data-rank", () => {
		expect(CARD_SKIN_RANK_ATTR).toBe("data-rank");
	});
});
