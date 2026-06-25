/** @jsxImportSource vue */

import type { CardBlock } from "@bilibili-notify/internal";
import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { renderBlocks } from "../templates/block-layout";

// 把一组块用固定 builders 渲染成 data-block 序列(divider 始终产出 hairline,
// 内容块 a/b 产出内容,empty 产出 null 模拟「无数据自动收起」)。
async function order(blocks: CardBlock[]): Promise<string[]> {
	const builders: Record<string, () => ReturnType<typeof h> | null> = {
		[DIVIDER_TYPE]: () => h("hr"),
		a: () => h("div", "a"),
		b: () => h("div", "b"),
		empty: () => null,
	};
	const html = await renderToString(
		createSSRApp({ render: () => h("div", renderBlocks(blocks, builders)) }),
	);
	return [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
}

const blk = (type: string): CardBlock => ({ id: type, type, visible: true });
const div = (n: number): CardBlock => ({ id: `divider-${n}`, type: DIVIDER_TYPE, visible: true });

describe("renderBlocks divider suppression", () => {
	it("keeps a divider between two content blocks", async () => {
		expect(await order([blk("a"), div(1), blk("b")])).toEqual(["a", "divider", "b"]);
	});

	it("drops a leading divider", async () => {
		expect(await order([div(1), blk("a")])).toEqual(["a"]);
	});

	it("drops a trailing divider", async () => {
		expect(await order([blk("a"), div(1)])).toEqual(["a"]);
	});

	it("collapses consecutive dividers to one", async () => {
		expect(await order([blk("a"), div(1), div(2), blk("b")])).toEqual(["a", "divider", "b"]);
	});

	it("drops a divider orphaned by a hidden/empty neighbour", async () => {
		// a, divider, empty(收起), divider, b → 中间内容没了,两条 divider 合成一条
		expect(await order([blk("a"), div(1), blk("empty"), div(2), blk("b")])).toEqual([
			"a",
			"divider",
			"b",
		]);
	});
});
