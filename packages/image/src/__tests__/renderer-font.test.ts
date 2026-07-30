/**
 * 单元测试 —— 每张卡到底用哪款字体。
 *
 * 两件事在这里定死:
 *
 * 1. **per-call 覆盖要认。** 设置页从一开始就允许给单个 UP(以及单个卡片类型)另设
 *    字体,schema 存得下、`resolveCardStyleForKind` 也解析得出 —— 唯独渲染器**从来
 *    没收到过**这个字段,于是「给这位 UP 单独换个字体」选了等于没选。这一族 bug 的
 *    共同长相:界面上改得动、保存得下、就是不生效。
 * 2. **自带字体文件优先于家族名。** 主人上传的字体经 `resolveFontAsset` 读成 data URL,
 *    拼成 `@font-face` 交给模版;资产悬空(删了 / 卷丢了)就静静回落家族名 —— 出图
 *    不该因为少一个文件而崩,与背景图同一条纪律。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { ImageRenderer, type ImageRendererConfig } from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";
import { USER_FONT_FAMILY } from "../render";
import type { CardColorOptions } from "../types";

// biome-ignore lint/suspicious/noExplicitAny: 与 image-renderer.test.ts 同款白盒访问
type AnyRenderer = any;

function makeRenderer(
	config: Partial<ImageRendererConfig> = {},
	resolveFontAsset?: (id: string) => Promise<string>,
): ImageRenderer {
	const ctx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	return new ImageRenderer({
		serviceCtx: ctx,
		puppeteer: { page: async () => ({}) as never } as unknown as PuppeteerLike,
		config: {
			cardColorStart: "#000000",
			cardColorEnd: "#ffffff",
			font: "全局那款",
			showPopularity: true,
			showArea: true,
			showFans: true,
			...config,
		},
		...(resolveFontAsset ? { resolveFontAsset } : {}),
	});
}

function resolveFont(
	r: ImageRenderer,
	colorOptions: CardColorOptions = {},
): Promise<{ font: string; fontFace?: string }> {
	return (r as AnyRenderer).resolveFont(colorOptions);
}

describe("家族名那条路", () => {
	it("什么都没覆盖 → 用全局那款,不产生 @font-face", async () => {
		expect(await resolveFont(makeRenderer())).toEqual({ font: "全局那款" });
	});

	it("per-call 覆盖了字体 → 用覆盖那款(给单个 UP / 单类卡另设字体就靠它)", async () => {
		// 回归守卫:这个字段以前压根没进 colorOptions,per-UP 换字体选了等于没选。
		const got = await resolveFont(makeRenderer(), { font: "这位 UP 的" });
		expect(got.font).toBe("这位 UP 的");
	});
});

describe("自带字体文件那条路", () => {
	const DATA_URL = "data:font/woff2;base64,AAAA";

	it("配了字体资产 → 家族名换成内部那个,并带上 @font-face", async () => {
		const r = makeRenderer({ fontAsset: "abc.woff2" }, async () => DATA_URL);
		const got = await resolveFont(r);
		expect(got.font).toBe(USER_FONT_FAMILY);
		expect(got.fontFace).toContain(DATA_URL);
		expect(got.fontFace).toContain(USER_FONT_FAMILY);
	});

	it("字体资产优先于家族名 —— 两个都设了以文件为准", async () => {
		const r = makeRenderer({ font: "家族名", fontAsset: "abc.woff2" }, async () => DATA_URL);
		expect((await resolveFont(r)).font).toBe(USER_FONT_FAMILY);
	});

	it("per-call 覆盖字体资产 → 用覆盖那款文件", async () => {
		const seen: string[] = [];
		const r = makeRenderer({ fontAsset: "global.woff2" }, async (id) => {
			seen.push(id);
			return DATA_URL;
		});
		await resolveFont(r, { fontAsset: "per-up.ttf" });
		expect(seen).toEqual(["per-up.ttf"]);
	});

	it("资产悬空(解析成空)→ 静静回落家族名,不发一条空 src 的 @font-face", async () => {
		// 主人把字体删了、卷丢了都会走到这儿。出图不该崩,也不该塞一条无效规则进 CSS。
		const r = makeRenderer({ font: "兜底那款", fontAsset: "gone.woff2" }, async () => "");
		expect(await resolveFont(r)).toEqual({ font: "兜底那款" });
	});

	it("没注入 resolver(koishi 那种宿主)→ 回落家族名,不是崩", async () => {
		const r = makeRenderer({ font: "兜底那款", fontAsset: "abc.woff2" });
		expect(await resolveFont(r)).toEqual({ font: "兜底那款" });
	});
});

describe("解析结果要缓存 —— 一款中文字体几十兆,不能每张卡读一遍盘", () => {
	it("同一个资产连着出好几张卡,只解析一次", async () => {
		const resolve = vi.fn(async () => "data:font/woff2;base64,AAAA");
		const r = makeRenderer({ fontAsset: "same.woff2" }, resolve);
		await resolveFont(r);
		await resolveFont(r);
		await resolveFont(r);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("换了一款就重新解析 —— 缓存不能把旧字体黏住", async () => {
		const resolve = vi.fn(async () => "data:font/woff2;base64,AAAA");
		const r = makeRenderer({ fontAsset: "a.woff2" }, resolve);
		await resolveFont(r);
		await resolveFont(r, { fontAsset: "b.woff2" });
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});
