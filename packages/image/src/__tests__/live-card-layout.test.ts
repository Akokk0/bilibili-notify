/**
 * LiveCard 版式契约测试。只断言「块按 layout 的顺序 / 显隐进出 DOM」这一结构契约
 * (经稳定的 `data-block` 标记),**不碰 class / 样式 / 文案** —— 与项目「不测 HTML/CSS
 * 拼装」的惯例不冲突:这里测的是描述符驱动的块装配逻辑,restyle 不会让它误红。
 * 像素级是否复刻现状由预览人眼验收。
 */

import { type CardBlock, DEFAULT_CARD_LAYOUT } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { LiveCard } from "../templates/live-card";

async function renderLive(over: Record<string, unknown> = {}): Promise<string> {
	const props = {
		hideDesc: false,
		hideFollower: false,
		cardColorStart: "#000000",
		cardColorEnd: "#ffffff",
		data: {
			title: "直播标题",
			area_name: "分区",
			user_cover: "cover.jpg",
			keyframe: "keyframe.jpg",
			description: "简介文字",
			online: 100,
		},
		username: "示例UP",
		userface: "face.jpg",
		titleStatus: "",
		liveTime: "已开播 1 小时",
		liveStatus: 1,
		cover: true,
		onlineNum: "100",
		likedNum: "",
		watchedNum: "",
		fansNum: "123",
		fansChanged: "",
		...over,
	};
	const app = createSSRApp({ render: () => h(LiveCard, props) });
	return renderToString(app);
}

function blockOrder(html: string): string[] {
	return [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
}

describe("LiveCard layout", () => {
	it("renders all blocks in the default order", async () => {
		const html = await renderLive();
		expect(blockOrder(html)).toEqual(["cover", "header", "title", "stats", "follower", "desc"]);
	});

	it("omits a block the layout marks invisible", async () => {
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b) =>
			b.id === "desc" ? { ...b, visible: false } : b,
		);
		const html = await renderLive({ layout });
		expect(blockOrder(html)).not.toContain("desc");
	});

	it("renders blocks in the layout's order", async () => {
		const layout: CardBlock[] = [
			{ id: "title", visible: true },
			{ id: "cover", visible: true },
			...DEFAULT_CARD_LAYOUT.live.filter((b) => b.id !== "title" && b.id !== "cover"),
		];
		const order = blockOrder(await renderLive({ layout }));
		expect(order.indexOf("title")).toBeLessThan(order.indexOf("cover"));
	});
});
