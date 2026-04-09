import { describe, expect, it } from "vitest";
import { renderCard } from "../render";
import { SCCard } from "../templates/sc-card";

const baseProps = {
	senderFace: "https://example.com/face.jpg",
	senderName: "测试用户",
	masterName: "主播大人",
	masterAvatarUrl: "https://example.com/master.jpg",
	text: "这是一条醒目留言！",
	price: 50,
	duration: "2分钟",
	bgColor: ["#74b9ff", "#0984e3"] as const,
};

describe("SCCard TSX 渲染", () => {
	it("输出完整 HTML 文档", async () => {
		const html = await renderCard(SCCard, baseProps, { title: "醒目留言通知" });
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<title>醒目留言通知</title>");
	});

	it("包含金额和时长", async () => {
		const html = await renderCard(SCCard, baseProps);
		expect(html).toContain("¥50");
		expect(html).toContain("2分钟");
	});

	it("包含发送者和主播名", async () => {
		const html = await renderCard(SCCard, baseProps);
		expect(html).toContain("测试用户");
		expect(html).toContain("主播大人");
	});

	it("包含留言内容", async () => {
		const html = await renderCard(SCCard, baseProps);
		expect(html).toContain("这是一条醒目留言！");
	});

	it("没有留言时不渲染留言区", async () => {
		const html = await renderCard(SCCard, { ...baseProps, text: "" });
		expect(html).not.toContain("whitespace-pre-wrap");
	});

	it("UnoCSS 注入了样式", async () => {
		const html = await renderCard(SCCard, baseProps);
		expect(html).toContain("<style>");
		expect(html).toContain("backdrop-filter");
	});

	it("XSS 特殊字符被转义", async () => {
		const html = await renderCard(SCCard, { ...baseProps, text: "<script>alert(1)</script>" });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
