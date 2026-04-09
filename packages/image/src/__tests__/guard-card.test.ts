import { describe, expect, it } from "vitest";
import { renderCard } from "../render";
import { GuardCard } from "../templates/guard-card";

const baseProps = {
	captainImgUrl: "https://example.com/captain.png",
	guardLevel: 3 as const,
	uname: "舰长用户",
	face: "https://example.com/face.jpg",
	isAdmin: 0,
	masterAvatarUrl: "https://example.com/master.jpg",
	masterName: "主播大人",
	bgColor: ["#fd79a8", "#e84393"] as [string, string],
};

describe("GuardCard TSX 渲染", () => {
	it("输出完整 HTML 文档", async () => {
		const html = await renderCard(GuardCard, baseProps, { title: "上舰通知" });
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<title>上舰通知</title>");
	});

	it("包含用户名和主播名", async () => {
		const html = await renderCard(GuardCard, baseProps);
		expect(html).toContain("舰长用户");
		expect(html).toContain("主播大人");
	});

	it("guardLevel=3 显示总督描述文字", async () => {
		const html = await renderCard(GuardCard, { ...baseProps, guardLevel: 3 });
		expect(html).toContain("总督");
	});

	it("guardLevel=2 显示提督描述文字", async () => {
		const html = await renderCard(GuardCard, { ...baseProps, guardLevel: 2 });
		expect(html).toContain("提督");
	});

	it("guardLevel=1 显示舰长描述文字", async () => {
		const html = await renderCard(GuardCard, { ...baseProps, guardLevel: 1 });
		expect(html).toContain("大航海舰队");
	});

	it("isAdmin=1 时显示房管", async () => {
		const html = await renderCard(GuardCard, { ...baseProps, isAdmin: 1 });
		expect(html).toContain("房管");
	});

	it("UnoCSS 注入了样式", async () => {
		const html = await renderCard(GuardCard, baseProps);
		expect(html).toContain("<style>");
		expect(html).toContain("backdrop-filter");
	});
});
