/**
 * **转发框里那张内层卡跟着皮肤走**(ADR-0014「仍未决」里记的那条)。
 *
 * 一条转发动态在卡上是**两张卡套在一起**:外层是转发者,转发框(`[data-bn="forward"]`)
 * 里是原动态。外层早就按皮肤的网格装了,内层却一直走旧的一维竖栈 —— 而且因为全仓已经
 * 没人往 props 里传 `layout`,它实际是**钉死在出厂默认版式**上:换皮肤不跟,连迁移过自己
 * v7 版式的存量用户也拿不回来。
 *
 * 这份钉的就是那条线:内层与外层**同一份皮肤、同一套块、同一批 class**,而数据各算各的
 * (`showIf` 与占位符在内层要看内层那条动态)。
 *
 * 每张测试皮肤都要摆一个 `forward` 块 —— 转发框就是它画的(从前它长在 `content` 复合块
 * 里,复合块退役后成了独立的原子块)。它在**内层**没有数据,所以自己收起,不进内层块序。
 */

import type { CardSkinCard } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createSSRApp } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import { FORWARD_INSET_CLASS } from "../../blocks/dynamic";
import type { DynamicCardProps } from "../../templates/dynamic-card";
import { renderSkinnedCard } from "../render-skin";

/** dynamic-forward 那份 props:示例转发者 转发了 示例UP 的一条视频投稿。 */
let props: DynamicCardProps;

beforeAll(async () => {
	const fixture = CARD_FIXTURES.find((f) => f.name === "dynamic-forward");
	if (!fixture) throw new Error("夹具表里没有 dynamic-forward");
	props = (await fixture.build()).props as unknown as DynamicCardProps;
});

const block = (
	id: string,
	builtin: string,
	row: number,
	over: Record<string, unknown> = {},
): CardSkinCard["blocks"][number] =>
	({ id, kind: "builtin", builtin, grid: { row, column: 1, span: 12 }, ...over }) as never;

const customBlock = (id: string, html: string, row: number): CardSkinCard["blocks"][number] =>
	({ id, kind: "custom", html, grid: { row, column: 1, span: 12 } }) as never;

async function render(blocks: CardSkinCard["blocks"]): Promise<Document> {
	const { vnode } = renderSkinnedCard({
		kind: "dynamic",
		card: { width: 600, blocks },
		props,
	});
	return new JSDOM(await renderToString(createSSRApp({ render: () => vnode }))).window.document;
}

/** 转发框里那一层的块名(按文档序)。 */
function innerLabels(doc: Document): string[] {
	const inset = doc.querySelector(`[class="${FORWARD_INSET_CLASS}"]`);
	if (!inset) throw new Error("这张卡上没有转发框");
	return [...inset.querySelectorAll("[data-block]")].map(
		(el) => el.getAttribute("data-block") ?? "",
	);
}

function inner(doc: Document): Element {
	const inset = doc.querySelector(`[class="${FORWARD_INSET_CLASS}"]`);
	if (!inset) throw new Error("这张卡上没有转发框");
	return inset;
}

describe("转发框里的内层卡 — 跟着皮肤走", () => {
	it("块的顺序按皮肤,不是出厂默认版式", async () => {
		// 皮肤把正文摆在头部**上面**:内层也得是这个顺序。
		const doc = await render([
			block("c", "text", 1),
			block("h", "avatar", 2),
			block("f", "forward", 3),
		]);
		expect(innerLabels(doc)).toEqual(["text", "avatar"]);
	});

	it("皮肤没摆的块,内层也不画", async () => {
		const doc = await render([block("c", "text", 1), block("f", "forward", 2)]);
		expect(innerLabels(doc)).toEqual(["text"]);
	});

	it("内层块挂的是同一批 bn-blk- class —— 一条皮肤 CSS 同时管内外两层", async () => {
		const doc = await render([
			block("h", "avatar", 1),
			block("c", "text", 2),
			block("f", "forward", 3),
		]);
		expect([...inner(doc).querySelectorAll(".bn-blk-h")].length).toBe(1);
		expect(doc.querySelectorAll(".bn-blk-h").length).toBe(2);
	});

	it("内层是网格容器 —— 皮肤的分栏在内层照样成立", async () => {
		const doc = await render([
			block("h", "avatar", 1),
			block("c", "text", 2),
			block("f", "forward", 3),
		]);
		const grid = inner(doc).firstElementChild;
		expect(grid?.getAttribute("style") ?? "").toContain("display:grid");
	});
});

describe("转发框里的内层卡 — 数据各算各的", () => {
	it("占位符读的是内层那条动态的作者,不是转发者", async () => {
		const doc = await render([
			customBlock("who", "<div>{up.name}</div>", 1),
			block("c", "text", 2),
			block("f", "forward", 3),
		]);
		const all = [...doc.querySelectorAll(".bn-blk-who")].map((el) => el.textContent);
		expect(all).toEqual(["示例转发者", "示例UP·大会员"]);
	});

	it("showIf 按内层的数据判 —— 外层是转发、内层不是", async () => {
		const doc = await render([
			block("c", "text", 1),
			customBlock("tag", "<div>转发</div>", 2),
			block("f", "forward", 3),
		]);
		// 外层那份画出来了(它确实是转发),内层那份没有。
		expect(doc.querySelectorAll(".bn-blk-tag").length).toBe(2);

		const guarded = await render([
			block("c", "text", 1),
			{ ...customBlock("tag", "<div>转发</div>", 2), showIf: "dynamic.isForward" } as never,
			block("f", "forward", 3),
		]);
		expect(guarded.querySelectorAll(".bn-blk-tag").length).toBe(1);
		expect(innerLabels(guarded)).toEqual(["text"]);
	});
});
