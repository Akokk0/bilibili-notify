/**
 * **「跨几行」对单张图的块是真高度**(2026-09-18 主人拍板)。
 *
 * 出图那头的网格只写了 `grid-template-columns`,行是隐式的、完全按内容撑 —— 所以
 * `rowSpan` 从来只是一句给画布看的声明,拖它一个像素都不会变(`c7816d9d` 拍板时就写明了
 * 「出图不变」,而 `b705dff3` 却给了四条边都能拉的把手)。主人 09-18 撞上这件事:
 * 「缩了封面图,但是不能正确反映到渲染里」。
 *
 * 定案是**只让图块变真**:封面这种「一张有确定尺寸的图」按 `rowSpan × 行高` 注真高度;
 * **文字块照旧按内容撑** —— 标题一行还是三行由真实数据说了算,写死就是裁字(这正是
 * ADR 决策 6 否掉「绝对坐标排版」的理由)。
 */

import type { CardSkinCard } from "@bilibili-notify/internal";
import { CARD_SKIN_BUILTIN_BLOCKS, CARD_SKIN_LIMITS } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createSSRApp } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import type { LiveCardProps } from "../../templates/live-card";
import { renderSkinnedCard } from "../render-skin";

let props: LiveCardProps;

beforeAll(async () => {
	const fixture = CARD_FIXTURES.find((f) => f.name === "live-streaming");
	if (!fixture) throw new Error("夹具表里没有 live-streaming");
	props = (await fixture.build()).props as unknown as LiveCardProps;
});

const block = (id: string, builtin: string, rowSpan?: number) =>
	({
		id,
		kind: "builtin",
		builtin,
		grid: { row: 1, column: 1, span: 12, ...(rowSpan === undefined ? {} : { rowSpan }) },
	}) as unknown as CardSkinCard["blocks"][number];

async function styleOf(blocks: CardSkinCard["blocks"], id: string): Promise<string> {
	const { vnode } = renderSkinnedCard({ kind: "live", card: { width: 600, blocks }, props });
	const doc = new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window
		.document;
	// 高度在**内层**,网格坐标在外面那层格子上(ADR-0018)—— 这里两层拼起来一起问。
	const cell = doc.querySelector(`[data-cell="${id}"]`)?.getAttribute("style") ?? "";
	const inner = doc.querySelector(`.bn-blk-${id}`)?.getAttribute("style") ?? "";
	return `${cell};${inner}`;
}

describe("跨行 = 真高度(只对单张图的块)", () => {
	it("行高是契约常量,画布与出图共用同一个数", () => {
		expect(CARD_SKIN_LIMITS.rowHeight).toBe(56);
	});

	it("封面跨 3 行 = 高 168px", async () => {
		const style = await styleOf([block("cover", "cover", 3)], "cover");
		expect(style).toContain(`height:${3 * CARD_SKIN_LIMITS.rowHeight}px`);
	});

	// 文字块的高度取决于真实数据(标题一行还是三行),写死就是裁字。
	it("文字块跨 3 行照旧按内容撑,一个字节的高度都不注", async () => {
		const style = await styleOf([block("title", "title", 3)], "title");
		expect(style).toContain("grid-row:1 / span 3");
		expect(style).not.toContain("height:");
	});

	// 没写跨行 = 没声明高度,照旧按内容撑 —— 存量皮肤那条路一个字节不变。
	it("没写跨行的封面也不注高度", async () => {
		const style = await styleOf([block("cover", "cover")], "cover");
		expect(style).not.toContain("height:");
	});

	// 接线守卫:高度注在 wrapper 上,图得跟着填满才看得出来。图的那两个 class 剪掉,
	// 高度照注而封面纹丝不动 —— 正是主人 09-18 撞上的那种「改得动、就是不生效」。
	it("封面图自己填满那块高度,而且按比例裁不是压扁", async () => {
		const { vnode } = renderSkinnedCard({
			kind: "live",
			card: { width: 600, blocks: [block("cover", "cover", 3)] },
			props,
		});
		const doc = new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window
			.document;
		const img = doc.querySelector(".bn-blk-cover img");
		expect(img?.className).toContain("h-full");
		expect(img?.className).toContain("object-cover");
	});

	// 目录里标了哪几块是「一张有确定尺寸的图」—— 画布照它决定上下把手画不画。
	it("目录标出的就是两张封面 —— 图廊张数不定,按内容撑", () => {
		const marked: string[] = [];
		for (const [kind, blocks] of Object.entries(CARD_SKIN_BUILTIN_BLOCKS)) {
			for (const [name, meta] of Object.entries(blocks)) {
				if (meta.heightFromRows) marked.push(`${kind}.${name}`);
			}
		}
		expect(marked.sort()).toEqual(["dynamic.videoCover", "live.cover"]);
	});
});
