/**
 * SCCard 版式契约测试。同 live/dynamic:只断言 `data-block` 的有无/顺序,不碰样式。
 */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { SCCard } from "../templates/sc-card";

async function renderSc(over: Record<string, unknown> = {}): Promise<string> {
	const props = {
		senderFace: "face.jpg",
		senderName: "示例用户",
		masterName: "示例主播",
		masterAvatarUrl: "master.jpg",
		text: "主播加油！",
		price: 30,
		duration: "1小时",
		bgColor: ["#e84393", "#a29bfe"] as const,
		...over,
	};
	const app = createSSRApp({ render: () => h(SCCard, props) });
	return renderToString(app);
}

function blockOrder(html: string): string[] {
	return [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
}

describe("SCCard layout", () => {
	it("renders all blocks in the default order", async () => {
		expect(blockOrder(await renderSc())).toEqual(["amount", "divider", "sender", "message"]);
	});

	it("omits the message block when there is no text", async () => {
		expect(blockOrder(await renderSc({ text: "" }))).not.toContain("message");
	});

	it("omits a block the layout marks invisible", async () => {
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.sc.map((b) =>
			b.type === "divider" ? { ...b, visible: false } : b,
		);
		expect(blockOrder(await renderSc({ layout }))).not.toContain("divider");
	});

	it("renders blocks in the layout's order", async () => {
		const layout: CardBlock[] = [
			{ id: "sender", type: "sender", visible: true },
			...DEFAULT_CARD_LAYOUT.sc.filter((b) => b.type !== "sender"),
		];
		const order = blockOrder(await renderSc({ layout }));
		expect(order.indexOf("sender")).toBeLessThan(order.indexOf("amount"));
	});
});
