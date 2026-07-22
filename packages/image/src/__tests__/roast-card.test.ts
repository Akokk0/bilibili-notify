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

	it("卡片自己不画 emoji —— 长相由渲染机器的字体说了算,换台机器就变样", async () => {
		// 两张卡的装饰图标一律走内联 SVG。emoji 在开发机、Docker 镜像、koishi
		// 宿主上各画各的,缺字体时直接是豆腐块。模型写的正文里有 emoji 不算违规
		// (那是内容),所以这里的 props 本身不带 emoji。
		const pictographic = /\p{Extended_Pictographic}/u;
		expect(await renderBoard()).not.toMatch(pictographic);
		expect(await renderSolo()).not.toMatch(pictographic);
	});

	/**
	 * 下面两条断言的是**类名**而不是渲染结果 —— 版式 bug 只有量出像素才看得见,
	 * 而 SSR 出来的是没有布局的 HTML。所以退一步,把「当初为什么加这个类」钉住:
	 * 类被顺手删掉时会红,这正是这两个 bug 当初的成因。
	 */
	it("名字按内容撑开而不是塞进定宽列 —— 定宽会把长 ID 截成「极客湾Geeker…」", async () => {
		// 单人卡的评分条只有一行,没有对齐对象,定宽纯属白白截断。
		const html = await renderSolo({ up: up("极客湾Geekerwan") });
		expect(html).toContain("max-w-[46%]");
		expect(html).not.toContain("w-[120px]");
		// 榜单卡多行并列,定宽是刻意的:名字长短不一会把进度条起点推得参差不齐。
		expect(await renderBoard()).toContain("w-[120px]");
	});

	it("分维度标签不跟着点评一起长高 —— 点评换行会把标签拉成长条", async () => {
		const html = await renderSolo({
			highlights: [
				{ label: "涨粉", comment: "近 7 日涨粉 15720,近 30 日涨粉 17780,无新内容却集中涨粉" },
			],
		});
		// flex 默认 align-items: stretch,少了 items-start 右边一换行左边就被拉高。
		expect(html).toContain("items-start");
	});

	it("进度条宽度夹在 0..100", async () => {
		const html = await renderSolo({ score: 999 });
		const widths = [...html.matchAll(/width:\s*([\d.]+)%/g)].map((m) => Number(m[1]));
		expect(widths.length).toBeGreaterThan(0);
		for (const w of widths) expect(w).toBeLessThanOrEqual(100);
	});
});
