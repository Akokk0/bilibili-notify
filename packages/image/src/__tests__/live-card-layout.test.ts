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
		showPopularity: true,
		showArea: true,
		showFans: true,
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
	it("renders all blocks in the default order, including the divider", async () => {
		const html = await renderLive();
		expect(blockOrder(html)).toEqual(["cover", "header", "title", "divider", "data", "desc"]);
	});

	it("omits a block the layout marks invisible", async () => {
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b) =>
			b.id === "desc" ? { ...b, visible: false } : b,
		);
		const html = await renderLive({ layout });
		expect(blockOrder(html)).not.toContain("desc");
	});

	it("renders a non-first block's top margin as wrapper padding-top", async () => {
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b) =>
			b.type === "title" ? { ...b, marginTop: 24 } : b,
		);
		const html = await renderLive({ layout });
		expect(html).toContain("padding-top:24px");
	});

	it("skips the first block's top margin (the frame fixes the top edge)", async () => {
		// cover 是首块,即便给了 marginTop 也不应渲染成 padding-top(由容器固定)。
		const layout: CardBlock[] = DEFAULT_CARD_LAYOUT.live.map((b) =>
			b.type === "cover" ? { ...b, marginTop: 99 } : b,
		);
		const html = await renderLive({ layout });
		expect(html).not.toContain("padding-top:99px");
	});

	it("applies glassOpacity to the card surface, falling back to the baseline", async () => {
		expect(await renderLive()).toContain("rgba(255,255,255,0.82)");
		expect(await renderLive({ glassOpacity: 0.4 })).toContain("rgba(255,255,255,0.4)");
	});

	it("keeps the frosted blur for any glassOpacity, including 0", async () => {
		expect(await renderLive({ glassOpacity: 0.4 })).toContain("blur(10px)");
		// 透明度 0 仍保留磨砂(透明但模糊):与「完全透明」开关区分开。
		const transparent = await renderLive({ glassOpacity: 0 });
		expect(transparent).toContain("rgba(255,255,255,0)");
		expect(transparent).toContain("blur(10px)");
	});

	it("glassClear makes the surface fully clear — transparent AND no blur", async () => {
		const clear = await renderLive({ glassClear: true });
		expect(clear).toContain("rgba(255,255,255,0)");
		expect(clear).toContain("blur(0px)");
		expect(clear).not.toContain("blur(10px)");
	});

	it("renders blocks in the layout's order", async () => {
		const layout: CardBlock[] = [
			{ id: "title", type: "title", visible: true },
			{ id: "cover", type: "cover", visible: true },
			...DEFAULT_CARD_LAYOUT.live.filter((b) => b.type !== "title" && b.type !== "cover"),
		];
		const order = blockOrder(await renderLive({ layout }));
		expect(order.indexOf("title")).toBeLessThan(order.indexOf("cover"));
	});
});

// 数据区(data 块)内部三项由 show* 开关控制 —— 这是内容契约(某项在/不在),非样式。
describe("LiveCard data section show flags", () => {
	it("shows popularity / area / fans by default (live status)", async () => {
		const html = await renderLive();
		expect(html).toContain("人气：");
		expect(html).toContain("分区：");
		expect(html).toContain("当前粉丝数：");
	});

	it("hides popularity when showPopularity is false", async () => {
		const html = await renderLive({ showPopularity: false });
		expect(html).not.toContain("人气：");
		// 其它两项仍在
		expect(html).toContain("分区：");
		expect(html).toContain("当前粉丝数：");
	});

	it("hides area when showArea is false", async () => {
		const html = await renderLive({ showArea: false });
		expect(html).not.toContain("分区：");
		expect(html).toContain("人气：");
	});

	it("hides fans data when showFans is false", async () => {
		const html = await renderLive({ showFans: false });
		expect(html).not.toContain("当前粉丝数：");
		expect(html).toContain("人气：");
	});

	it("collapses the whole data block when all three are off", async () => {
		const html = await renderLive({ showPopularity: false, showArea: false, showFans: false });
		expect(blockOrder(html)).not.toContain("data");
	});
});
