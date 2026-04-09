import { describe, expect, it } from "vitest";
import { renderCard } from "../render";
import { LiveCard } from "../templates/live-card";

const mockLiveData = {
	title: "今晚一起玩游戏",
	description: "欢迎来到直播间！",
	area_name: "单机游戏",
	user_cover: "https://example.com/cover.jpg",
	keyframe: "https://example.com/keyframe.jpg",
	online: 12345,
};

const baseProps = {
	hideDesc: false,
	followerDisplay: true,
	cardColorStart: "#74b9ff",
	cardColorEnd: "#0984e3",
	data: mockLiveData,
	username: "游戏主播",
	userface: "https://example.com/face.jpg",
	titleStatus: "开播啦",
	liveTime: "开播时间：2026-04-09 20:00:00",
	liveStatus: 1,
	cover: true,
	onlineNum: "1.2万",
	likedNum: "3000",
	watchedNum: "5万",
	fansNum: "10万",
	fansChanged: "+100",
};

describe("LiveCard TSX 渲染", () => {
	it("输出完整 HTML 文档", async () => {
		const html = await renderCard(LiveCard, baseProps, { title: "直播通知" });
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<title>直播通知</title>");
	});

	it("包含直播标题和主播名", async () => {
		const html = await renderCard(LiveCard, baseProps);
		expect(html).toContain("今晚一起玩游戏");
		expect(html).toContain("游戏主播");
	});

	it("包含分区名称", async () => {
		const html = await renderCard(LiveCard, baseProps);
		expect(html).toContain("单机游戏");
	});

	it("hideDesc=false 时渲染简介", async () => {
		const html = await renderCard(LiveCard, { ...baseProps, hideDesc: false });
		expect(html).toContain("欢迎来到直播间！");
	});

	it("hideDesc=true 时不渲染简介", async () => {
		const html = await renderCard(LiveCard, { ...baseProps, hideDesc: true });
		expect(html).not.toContain("欢迎来到直播间！");
	});

	it("liveStatus=1 时显示粉丝数", async () => {
		const html = await renderCard(LiveCard, { ...baseProps, liveStatus: 1, followerDisplay: true });
		expect(html).toContain("当前粉丝数");
	});

	it("liveStatus=2 时显示累计观看人数", async () => {
		const html = await renderCard(LiveCard, { ...baseProps, liveStatus: 2, followerDisplay: true });
		expect(html).toContain("累计观看人数");
	});

	it("liveStatus=3 时显示粉丝数变化", async () => {
		const html = await renderCard(LiveCard, { ...baseProps, liveStatus: 3, followerDisplay: true });
		expect(html).toContain("粉丝数变化");
	});

	it("description 为空时显示默认文案", async () => {
		const html = await renderCard(LiveCard, {
			...baseProps,
			data: { ...mockLiveData, description: "" },
		});
		expect(html).toContain("这个主播很懒");
	});

	it("UnoCSS 注入了样式", async () => {
		const html = await renderCard(LiveCard, baseProps);
		expect(html).toContain("<style>");
		expect(html).toContain("backdrop-filter");
	});
});
