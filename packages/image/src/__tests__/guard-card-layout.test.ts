/**
 * GuardCard 版式契约测试。guard 是受限 2D:`badgeSide` 决定徽章块靠左/靠右,
 * `blocks`(name/text)在另一侧上下排。只断言 `data-block` 的有无/顺序,不碰样式。
 */

import { DEFAULT_CARD_LAYOUT, type GuardLayout } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { GuardCard } from "../templates/guard-card";

async function renderGuard(over: Record<string, unknown> = {}): Promise<string> {
	const props = {
		captainImgUrl: "captain.png",
		guardLevel: 1,
		uname: "示例用户",
		face: "face.jpg",
		isAdmin: 0,
		masterAvatarUrl: "master.jpg",
		masterName: "示例主播",
		bgColor: ["#e84393", "#a29bfe"] as [string, string],
		...over,
	};
	const app = createSSRApp({ render: () => h(GuardCard, props) });
	return renderToString(app);
}

function blockOrder(html: string): string[] {
	return [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
}

describe("GuardCard layout", () => {
	it("default places badge on the right, name above text", async () => {
		expect(blockOrder(await renderGuard())).toEqual(["name", "text", "badge"]);
	});

	it("badgeSide=left puts the badge column first", async () => {
		const layout: GuardLayout = { ...DEFAULT_CARD_LAYOUT.guard, badgeSide: "left" };
		expect(blockOrder(await renderGuard({ layout }))[0]).toBe("badge");
	});

	it("reorders name/text within the content column", async () => {
		const layout: GuardLayout = {
			badgeSide: "right",
			blocks: [
				{ id: "text", type: "text", visible: true },
				{ id: "name", type: "name", visible: true },
			],
		};
		const order = blockOrder(await renderGuard({ layout }));
		expect(order.indexOf("text")).toBeLessThan(order.indexOf("name"));
	});

	it("omits a content block the layout marks invisible", async () => {
		const layout: GuardLayout = {
			badgeSide: "right",
			blocks: DEFAULT_CARD_LAYOUT.guard.blocks.map((b) =>
				b.type === "name" ? { ...b, visible: false } : b,
			),
		};
		expect(blockOrder(await renderGuard({ layout }))).not.toContain("name");
	});
});
