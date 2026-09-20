// @vitest-environment jsdom

/**
 * **画布的列宽**(ADR-0018 决策 3)。
 *
 * 画布从前照清单自己算:定宽列按它在**卡宽**里的占比折成 fr。那个算法有一处系统性的错 ——
 * 网格不在外框上,在**玻璃层**上,而玻璃层的宽度是外框的内容宽,那圈内边距写在**皮肤 CSS**
 * 里,清单里根本没有这个字段。2026-09-20 真机量到的差:出厂上舰卡 430 宽、玻璃层 400,
 * 定宽列被画窄 7%,第 8|9 条界线偏了 3.05 个百分点。
 *
 * 所以改成**读真值**:预览框里玻璃层的 `grid-template-columns` 计算值,就是十二条轨道
 * 各自多少像素 —— 不用再算,照抄。读不到(预览还没出来、jsdom 里没有布局引擎)就退回
 * 原来那套估算,**退回这条路必须一直活着**:画布不能因为预览慢半拍就空着。
 *
 * 这一份钉纯函数;把预览框里那份计算值真的送到画布手里,归 `SkinPreviewPane` 那条接线的
 * 守卫(剪断必红)。
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import {
	canvasTemplate,
	parseGridTracks,
	ROW_LABEL_COL,
	readGridMetrics,
	readGridTracks,
} from "../canvas-tracks";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;

/** 出厂上舰卡的列定义:8 根等分 + 4 根 43.75px 的定宽。 */
const guardCard = (): Card =>
	({
		width: 430,
		blocks: [],
		columns: [
			...Array.from({ length: 8 }, () => ({ fr: 1 })),
			...Array.from({ length: 4 }, () => ({ px: 43.75 })),
		],
	}) as unknown as Card;

/** 模板里那十二个 fr 权重(行号那一列不算)。 */
function weights(template: string): number[] {
	return [...template.matchAll(/minmax\(0, ([\d.]+)fr\)/g)].map((m) => Number(m[1]));
}

describe("parseGridTracks — 把计算值翻成十二个数", () => {
	it("十二条 px 轨道 → 十二个数", () => {
		const value = `${"28.125px ".repeat(8)}43.75px 43.75px 43.75px 43.75px`.trim();
		expect(parseGridTracks(value)).toEqual([
			...Array.from({ length: 8 }, () => 28.125),
			43.75,
			43.75,
			43.75,
			43.75,
		]);
	});

	// 条数不对多半是量错了元素(转发框里那层网格、或者皮肤自己改了列数)。宁可退回估算,
	// 也不拿一份对不上号的数去画 —— 那比画得不准更难查。
	it("条数不是 12 → 回 null", () => {
		expect(parseGridTracks("100px 100px")).toBeNull();
		expect(parseGridTracks(`${"10px ".repeat(13)}`.trim())).toBeNull();
	});

	// 浏览器的**计算值**一律是 px;出现别的写法说明拿到的不是计算值(jsdom 就会回原样)。
	it("不是纯 px(none / repeat / minmax / 空串)→ 回 null", () => {
		expect(parseGridTracks("")).toBeNull();
		expect(parseGridTracks("none")).toBeNull();
		expect(parseGridTracks("repeat(12, minmax(0, 1fr))")).toBeNull();
		expect(parseGridTracks(`${"minmax(0, 1fr) ".repeat(12)}`.trim())).toBeNull();
	});

	it("列数跟着契约常量走,不写死 12", () => {
		const value = `${"10px ".repeat(CARD_SKIN_LIMITS.columns)}`.trim();
		expect(parseGridTracks(value)).toHaveLength(CARD_SKIN_LIMITS.columns);
	});
});

describe("canvasTemplate — 量到就照抄,量不到才估", () => {
	it("量到真轨道 → 权重就是那十二个数,比例与真卡一模一样", () => {
		const measured = [...Array.from({ length: 8 }, () => 28.125), 43.75, 43.75, 43.75, 43.75];
		const w = weights(canvasTemplate(guardCard(), measured));
		expect(w).toEqual(measured);
		// 第 8|9 条界线:真卡是 225/400 = 56.25%。
		const total = w.reduce((s, x) => s + x, 0);
		const boundary = w.slice(0, 8).reduce((s, x) => s + x, 0) / total;
		expect(boundary).toBeCloseTo(0.5625, 6);
	});

	/**
	 * 退回那条路是**照卡宽估**,它偏 3 个百分点 —— 这里把那个偏差**明写出来**,免得哪天
	 * 有人「顺手修一下」把它调成 56.25% 却没接真值:那样画布看着准了,实则又在凭清单猜,
	 * 换一套内边距不同的皮肤照样错。真值那条路才是答案。
	 */
	it("量不到 → 退回按卡宽估(已知偏 3 个百分点,不是 bug 是兜底)", () => {
		const w = weights(canvasTemplate(guardCard(), null));
		const total = w.reduce((s, x) => s + x, 0);
		const boundary = w.slice(0, 8).reduce((s, x) => s + x, 0) / total;
		expect(boundary).toBeCloseTo(255 / 430, 6);
		expect(boundary).not.toBeCloseTo(0.5625, 3);
	});

	it("没写 columns 的皮肤 → 十二等分,量到与量不到都一样", () => {
		const card = { width: 600, blocks: [] } as unknown as Card;
		expect(new Set(weights(canvasTemplate(card, null)))).toHaveLength(1);
	});

	// 0 会让那一列整个塌掉、块看不见;留 1 至少画得出来。
	it("轨道宽 0 的列不许塌成 0", () => {
		const measured = [0, ...Array.from({ length: 11 }, () => 10)];
		expect(weights(canvasTemplate(guardCard(), measured))[0]).toBe(1);
	});

	it("行号那一列在最前面,宽度是契约常量", () => {
		expect(canvasTemplate(guardCard(), null).startsWith(`${ROW_LABEL_COL}px `)).toBe(true);
	});
});

describe("readGridTracks — 从预览框那份文档上量", () => {
	/** 造一份带玻璃层的文档,并让它回一份指定的计算值。 */
	function docWith(computed: string, hook = "glass"): Document {
		const doc = document.implementation.createHTMLDocument("t");
		const el = doc.createElement("div");
		el.setAttribute("data-bn", hook);
		doc.body.appendChild(el);
		const view = doc.defaultView ?? window;
		Object.defineProperty(doc, "defaultView", {
			configurable: true,
			value: {
				getComputedStyle: () => ({ gridTemplateColumns: computed }),
			} as unknown as typeof view,
		});
		return doc;
	}

	it("量到玻璃层的计算值 → 十二个数", () => {
		const doc = docWith(`${"30px ".repeat(8)}40px 40px 40px 40px`.trim());
		expect(readGridTracks(doc)).toEqual([30, 30, 30, 30, 30, 30, 30, 30, 40, 40, 40, 40]);
	});

	it("文档里没有玻璃层 → null", () => {
		expect(readGridTracks(docWith("100px", "frame"))).toBeNull();
	});

	// jsdom 与「预览还没画完」都落在这一档:回的不是计算值,形状闸拦下来,画布退回估算。
	it("回的不是计算值(jsdom 会原样吐作者写的那串)→ null", () => {
		expect(readGridTracks(docWith("repeat(12, minmax(0, 1fr))"))).toBeNull();
	});
});

/**
 * **行高也要量**(2026-09-20 主人问「大家占的行都一样多,为什么容器高度不一致」)。
 *
 * 答案是行轨道是 `auto`、高度由内容撑;画布的行却是等高的示意。**不把画布的行改成按真高度
 * 画**(那版 2026-09-18 做过又撤回,理由在 ADR-0014 决策 6 的 🔗;而且列稳行抖 —— 列宽只在
 * 改列定义 / 卡宽时变,行高改一个字就变),而是**把真高度印在行号旁边**:数字跳一下不影响
 * 布局,疑问当场答掉。
 *
 * 行与列的解析规矩**刻意不同**:列必须恰好十二条(条数不对就是量错了元素),行**几条都行**
 * (行数由块决定,而且画布还多画一条空行当落点)。
 */
describe("readGridMetrics — 列与行一起量", () => {
	function docWith(cols: string, rows: string): Document {
		const doc = document.implementation.createHTMLDocument("t");
		const el = doc.createElement("div");
		el.setAttribute("data-bn", "glass");
		doc.body.appendChild(el);
		Object.defineProperty(doc, "defaultView", {
			configurable: true,
			value: {
				getComputedStyle: () => ({ gridTemplateColumns: cols, gridTemplateRows: rows }),
			} as unknown as Window,
		});
		return doc;
	}

	it("量到两样就都交出去", () => {
		const m = readGridMetrics(
			docWith(`${"30px ".repeat(8)}40px 40px 40px 40px`.trim(), "54px 31px 16px 82px"),
		);
		expect(m.columns).toHaveLength(12);
		expect(m.rows).toEqual([54, 31, 16, 82]);
	});

	// 行数由块决定,没有「必须几条」这回事 —— 拿十二条那把尺去量行,一张卡都量不出来。
	it("行不限条数,一条也算", () => {
		expect(readGridMetrics(docWith("x", "88px")).rows).toEqual([88]);
	});

	it("行量不出来(jsdom 回的是原文)→ rows 是 null,列那一半照旧", () => {
		const m = readGridMetrics(docWith(`${"30px ".repeat(8)}40px 40px 40px 40px`.trim(), "none"));
		expect(m.rows).toBeNull();
		expect(m.columns).toHaveLength(12);
	});

	it("没有玻璃层 → 两样都是 null", () => {
		const doc = document.implementation.createHTMLDocument("t");
		expect(readGridMetrics(doc)).toEqual({ columns: null, rows: null });
	});
});
