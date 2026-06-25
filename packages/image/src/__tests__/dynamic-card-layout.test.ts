/**
 * DynamicCard 版式契约测试。同 live:只断言 `data-block` 的有无/顺序,不碰样式。
 */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { DynamicCard } from "../templates/dynamic-card";

async function renderDyn(over: Record<string, unknown> = {}): Promise<string> {
	const props = {
		cardColorStart: "#000000",
		cardColorEnd: "#ffffff",
		decorateColor: "#FB7299",
		avatarUrl: "face.jpg",
		upName: "示例UP",
		upIsVip: false,
		pubTime: "刚刚",
		topic: "示例话题",
		mainContent: h("div", "动态正文"),
		forwardCount: "1",
		commentCount: "2",
		likeCount: "3",
		...over,
	};
	const app = createSSRApp({ render: () => h(DynamicCard, props) });
	return renderToString(app);
}

function blockOrder(html: string): string[] {
	return [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
}

describe("DynamicCard layout", () => {
	it("renders all blocks in the default order, including dividers", async () => {
		expect(blockOrder(await renderDyn())).toEqual([
			"header",
			"divider",
			"topic",
			"content",
			"divider",
			"stats",
		]);
	});

	it("omits the topic block when there is no topic data", async () => {
		expect(blockOrder(await renderDyn({ topic: undefined }))).not.toContain("topic");
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
});
