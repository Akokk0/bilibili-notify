import { describe, expect, it } from "vitest";
import { h } from "vue";
import { renderCard } from "../render";
import { DynamicCard } from "../templates/dynamic-card";

const baseProps = {
	cardColorStart: "#74b9ff",
	cardColorEnd: "#0984e3",
	decorateColor: "#FFFFFF",
	avatarUrl: "https://example.com/face.jpg",
	upName: "测试UP主",
	upIsVip: false,
	pubTime: "2026-04-09 20:00:00",
	decorateCardUrl: undefined,
	decorateCardId: undefined,
	topic: "",
	mainContent: h("p", "这是动态正文内容"),
	forwardCount: "100",
	commentCount: "200",
	likeCount: "300",
};

describe("DynamicCard TSX 渲染", () => {
	it("输出完整 HTML 文档", async () => {
		const html = await renderCard(DynamicCard, baseProps, { title: "动态通知" });
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<title>动态通知</title>");
	});

	it("包含 UP 主名称和发布时间", async () => {
		const html = await renderCard(DynamicCard, baseProps);
		expect(html).toContain("测试UP主");
		expect(html).toContain("2026-04-09 20:00:00");
	});

	it("渲染 mainContent VNode", async () => {
		const html = await renderCard(DynamicCard, baseProps);
		expect(html).toContain("这是动态正文内容");
	});

	it("包含转发、评论、点赞数", async () => {
		const html = await renderCard(DynamicCard, baseProps);
		expect(html).toContain("100");
		expect(html).toContain("200");
		expect(html).toContain("300");
	});

	it("有话题时渲染话题标签", async () => {
		const html = await renderCard(DynamicCard, { ...baseProps, topic: "游戏日常" });
		expect(html).toContain("游戏日常");
	});

	it("传入装扮卡片数据时不报错（装扮卡展示已移除）", async () => {
		const html = await renderCard(DynamicCard, {
			...baseProps,
			decorateCardUrl: "https://example.com/decorate.png",
			decorateCardId: "No.12345",
		});
		expect(html).toContain(baseProps.upName);
	});

	it("upIsVip=true 时 UP 主名称使用粉色", async () => {
		const html = await renderCard(DynamicCard, { ...baseProps, upIsVip: true });
		expect(html).toContain("#FB7299");
	});

	it("mainContent 支持嵌套 VNode", async () => {
		const content = h("div", [h("span", "第一段"), h("span", "第二段")]);
		const html = await renderCard(DynamicCard, { ...baseProps, mainContent: content });
		expect(html).toContain("第一段");
		expect(html).toContain("第二段");
	});

	it("UnoCSS 注入了样式", async () => {
		const html = await renderCard(DynamicCard, baseProps);
		expect(html).toContain("<style>");
		expect(html).toContain("backdrop-filter");
	});
});
