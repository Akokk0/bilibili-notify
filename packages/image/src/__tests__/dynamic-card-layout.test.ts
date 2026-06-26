/**
 * DynamicCard 版式契约测试。同 live:只断言 `data-block` 的有无/顺序,不碰样式。
 * 额外覆盖 5b:additional 独立块、转发内部用同一套版式递归渲染。
 */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { DynamicCard } from "../templates/dynamic-card";
import type { DynamicNode } from "../templates/dynamic-content";

function makeNode(over: Partial<DynamicNode> = {}): DynamicNode {
	return {
		avatarUrl: "face.jpg",
		upName: "示例UP",
		upIsVip: false,
		pubTime: "刚刚",
		topic: "示例话题",
		body: h("div", "动态正文"),
		additional: h("div", "附加内容"),
		stats: { forward: "1", comment: "2", like: "3" },
		...over,
	};
}

async function renderDyn(over: Record<string, unknown> = {}): Promise<string> {
	const props = {
		cardColorStart: "#000000",
		cardColorEnd: "#ffffff",
		node: makeNode(),
		...over,
	};
	const app = createSSRApp({ render: () => h(DynamicCard, props) });
	return renderToString(app);
}

function blockOrder(html: string): string[] {
	return [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
}

describe("DynamicCard layout", () => {
	it("renders all blocks in the default order, including additional and dividers", async () => {
		expect(blockOrder(await renderDyn())).toEqual([
			"header",
			"divider",
			"content",
			"additional",
			"divider",
			"stats",
		]);
	});

	it("renders the topic inline inside content, not as its own block", async () => {
		const html = await renderDyn();
		expect(blockOrder(html)).not.toContain("topic");
		expect(html).toContain("示例话题");
	});

	it("omits the topic text when there is no topic data", async () => {
		const html = await renderDyn({ node: makeNode({ topic: undefined }) });
		expect(html).not.toContain("示例话题");
	});

	it("omits the additional block when there is no additional content", async () => {
		expect(blockOrder(await renderDyn({ node: makeNode({ additional: null }) }))).not.toContain(
			"additional",
		);
	});

	it("omits a block the layout marks invisible", async () => {
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.dynamic.map((b) =>
			b.type === "stats" ? { ...b, visible: false } : b,
		);
		expect(blockOrder(await renderDyn({ layout }))).not.toContain("stats");
	});

	it("renders blocks in the layout's order", async () => {
		const layout: CardBlock[] = [
			{ id: "stats", type: "stats", visible: true },
			...DEFAULT_CARD_LAYOUT.dynamic.filter((b) => b.type !== "stats"),
		];
		const order = blockOrder(await renderDyn({ layout }));
		expect(order.indexOf("stats")).toBeLessThan(order.indexOf("header"));
	});

	it("renders the forwarded inner dynamic with the same block layout", async () => {
		const node = makeNode({
			forward: makeNode({ upName: "原作者", stats: undefined }),
		});
		const order = blockOrder(await renderDyn({ node }));
		// 外层各块 + 内部转发的 header/content/additional(内部无 stats)都进 DOM。
		// 内部块嵌在外层 content 块内,故 header 至少出现两次(外层 + 内部)。
		expect(order.filter((b) => b === "header").length).toBe(2);
		expect(order.filter((b) => b === "content").length).toBe(2);
	});

	it("applies layout visibility to the forwarded inner dynamic", async () => {
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.dynamic.map((b) =>
			b.type === "additional" ? { ...b, visible: false } : b,
		);
		// 外层与内部转发都有附加内容;隐藏 additional 块后两者都不应出现。
		const node = makeNode({ forward: makeNode({ upName: "原作者", stats: undefined }) });
		expect(blockOrder(await renderDyn({ node, layout }))).not.toContain("additional");
	});
});
