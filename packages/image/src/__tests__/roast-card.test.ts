/**
 * 单元测试 — AI 锐评卡(榜单周报 / 单人)。
 *
 * 这两张卡的正文**整段来自大模型**,UP 名字则来自 B 站。两者都不可信,而卡片
 * 渲染完就直接发到群里。所以测试重心是「脏输入不会破坏卡片」,而不是版式细节。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import {
	RoastBoardCard,
	type RoastBoardCardProps,
	RoastSoloCard,
	type RoastSoloCardProps,
} from "../templates/roast-card";

const up = (name: string, over: Record<string, unknown> = {}) => ({
	name,
	color: "#fb7299",
	avatar: "https://i0.hdslb.com/face.jpg",
	...over,
});

function boardProps(over: Partial<RoastBoardCardProps> = {}): RoastBoardCardProps {
	return {
		days: 30,
		cardColorStart: "#FF9A9E",
		cardColorEnd: "#FAD0C4",
		pigeon: { ...up("机智的党妹"), reason: "一个月就发一条" },
		diligent: { ...up("老番茄"), reason: "更新最勤" },
		roast: [{ ...up("机智的党妹"), comment: "鸽子精本精" }],
		scores: [
			{ ...up("老番茄"), score: 96 },
			{ ...up("机智的党妹"), score: 41 },
		],
		...over,
	};
}

function soloProps(over: Partial<RoastSoloCardProps> = {}): RoastSoloCardProps {
	return {
		days: 30,
		cardColorStart: "#FF9A9E",
		cardColorEnd: "#FAD0C4",
		up: up("机智的党妹"),
		verdict: "一个月就发一条,鸽子精本精",
		score: 32,
		highlights: [{ label: "涨粉", comment: "掉了两万" }],
		...over,
	};
}

const renderBoard = (over: Partial<RoastBoardCardProps> = {}) =>
	renderToString(createSSRApp({ render: () => h(RoastBoardCard, boardProps(over)) }));
const renderSolo = (over: Partial<RoastSoloCardProps> = {}) =>
	renderToString(createSSRApp({ render: () => h(RoastSoloCard, soloProps(over)) }));

describe("RoastBoardCard", () => {
	it("鸽王 / 勤奋 UP / 锐评 / 评分都出现在卡上", async () => {
		const html = await renderBoard();
		expect(html).toContain("机智的党妹");
		expect(html).toContain("老番茄");
		expect(html).toContain("一个月就发一条");
		expect(html).toContain("鸽子精本精");
		expect(html).toContain("96");
	});

	it("窗口天数标在卡上 —— 同一份榜单在 7 日和 30 日下含义完全不同", async () => {
		expect(await renderBoard({ days: 7 })).toContain("7");
	});

	it("模型给的文本一律转义,绝不能当 HTML 解释", async () => {
		// pushText / reason / comment 整段来自大模型。哪天有人把提示词注入
		// 引导成 `<img src=x onerror=...>`,这张卡是要发出去的。
		const html = await renderBoard({
			pigeon: { ...up("<script>alert(1)</script>"), reason: "<b>粗体</b>" },
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>粗体</b>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("没有锐评时整块收起,不留一个空标题", async () => {
		// 断言区块标题而不是「锐评」二字 —— 卡片副标题里本来就写着「智能女仆锐评」。
		expect(await renderBoard()).toContain("逐位锐评");
		expect(await renderBoard({ roast: [] })).not.toContain("逐位锐评");
	});

	it("没有评分时整块收起", async () => {
		expect(await renderBoard()).toContain("综合勤奋度评分");
		expect(await renderBoard({ scores: [] })).not.toContain("综合勤奋度评分");
	});

	it("进度条宽度夹在 0..100 —— 越界的分数会把条画出卡片外", async () => {
		// 解析层已经夹过一次,但模板是公开入口,自己也得站得住。
		const html = await renderBoard({
			scores: [
				{ ...up("甲"), score: 999 },
				{ ...up("乙"), score: -50 },
			],
		});
		const widths = [...html.matchAll(/width:\s*([\d.]+)%/g)].map((m) => Number(m[1]));
		expect(widths.length).toBeGreaterThan(0);
		for (const w of widths) {
			expect(w).toBeGreaterThanOrEqual(0);
			expect(w).toBeLessThanOrEqual(100);
		}
	});

	it("没有头像时退回首字母圆牌,而不是一个裂图", async () => {
		const html = await renderBoard({
			pigeon: { ...up("党妹", { avatar: undefined }), reason: "鸽" },
			diligent: { ...up("番茄", { avatar: undefined }), reason: "勤" },
			roast: [],
			scores: [],
		});
		expect(html).not.toContain("<img");
		expect(html).toContain("党");
	});

	it("背景图存在时替换渐变外框", async () => {
		const html = await renderBoard({ backgroundImage: "data:image/png;base64,AAAA" });
		expect(html).toContain("data:image/png;base64,AAAA");
		expect(html).not.toContain("linear-gradient(to right bottom");
	});
});

describe("RoastSoloCard", () => {
	it("名字 / 总评 / 评分 / 分维度点评都在", async () => {
		const html = await renderSolo();
		expect(html).toContain("机智的党妹");
		expect(html).toContain("鸽子精本精");
		expect(html).toContain("32");
		expect(html).toContain("涨粉");
		expect(html).toContain("掉了两万");
	});

	it("模型给的文本一律转义", async () => {
		const html = await renderSolo({ verdict: "<img src=x onerror=alert(1)>" });
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img");
	});

	it("没有分维度点评时整块收起", async () => {
		expect(await renderSolo({ highlights: [] })).not.toContain("掉了两万");
	});

	it("进度条宽度夹在 0..100", async () => {
		const html = await renderSolo({ score: 999 });
		const widths = [...html.matchAll(/width:\s*([\d.]+)%/g)].map((m) => Number(m[1]));
		expect(widths.length).toBeGreaterThan(0);
		for (const w of widths) expect(w).toBeLessThanOrEqual(100);
	});
});
