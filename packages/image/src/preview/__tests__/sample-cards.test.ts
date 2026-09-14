/**
 * 出厂示例卡片数据(`preview/sample-cards.ts`)—— 编辑器实时预览喂给渲染器的那一套 props。
 *
 * 这份数据**唯一真正的判据是「真渲染得出来」**:props 的形状对不对,类型门只管得到一半
 * (`data` 是 any、`node` 是画好的结构树、档位色是元组…),少一个字段、字段名手抄错一个字母,
 * 编译照过、预览现场才空一块。所以这里不比字符串,直接过一遍 `renderCardWithSkin`。
 *
 * 场景表本身(七种卡齐全 / id 不重复)钉在 `packages/internal` 那头 —— 表住在 internal,
 * 因为面板也要读它。
 */

import { readFileSync } from "node:fs";
import { CARD_PREVIEW_SCENES, CARD_SKIN_KINDS, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { renderCardWithSkin } from "../../skin/render-skin";
import { sampleCardProps } from "../sample-cards";

/** 卡外框的挂点(`data-bn="frame"`)—— 画出来的东西至少得有个外框。 */
const FRAME_HOOK = /data-bn="(?:[^"]*\s)?frame(?:\s[^"]*)?"/;

async function render(kind: (typeof CARD_SKIN_KINDS)[number], scene?: string): Promise<string> {
	// `as never`:出口刻意回 unknown(示例数据不是对外契约,别让调用方照它写类型),
	// 这里替调用方把 props 递进去。
	return renderCardWithSkin(
		kind,
		(await sampleCardProps(kind, scene)) as never,
		DEFAULT_CARD_SKIN,
		{},
	);
}

describe("出厂示例数据 — 七种卡都画得出来", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:默认场景渲染出带外框的 HTML`, async () => {
			const html = await render(kind);
			expect(html).toMatch(FRAME_HOOK);
			// 空壳也带外框,所以再要一句:玻璃层里至少落了一个块。
			expect(html).toContain("data-block=");
		});
	}
});

describe("出厂示例数据 — 直播卡三个场景", () => {
	it("三个场景都渲染得通,且两两不同", async () => {
		const ids = CARD_PREVIEW_SCENES.live.map((s) => s.id);
		const htmls = await Promise.all(ids.map((id) => render("live", id)));
		for (const html of htmls) expect(html).toMatch(FRAME_HOOK);
		// 两两不同:三个场景要是喂出同一份 props,场景等于没做 —— 而面板上三个按钮照样点得动。
		expect(new Set(htmls).size).toBe(ids.length);
	});
});

describe("出厂示例数据 — 场景回落", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:不认识的场景名回落到第一个场景,与不传 scene 逐字节相同`, async () => {
			const [fallback, bare, first] = await Promise.all([
				render(kind, "这个场景不存在"),
				render(kind),
				render(kind, CARD_PREVIEW_SCENES[kind][0].id),
			]);
			expect(fallback).toBe(bare);
			expect(fallback).toBe(first);
		});
	}
});

describe("出厂示例数据 — 确定性", () => {
	/**
	 * 防回归:示例数据一旦碰时钟或随机数,预览就会自己飘 —— 用户改一行 CSS 再画一次,
	 * 出来的差异里混着数据的抖动,而这种抖动在单次渲染里看不出来。所以直接读自己的源码钉住。
	 */
	it("模块里没有时钟 / 随机数的调用", () => {
		const src = readFileSync(new URL("../sample-cards.ts", import.meta.url), "utf8");
		for (const banned of ["Date.now", "new Date", "Math.random"]) {
			expect(src).not.toContain(banned);
		}
	});

	it("同样入参连画两次,产出逐字节相同", async () => {
		const [a, b] = await Promise.all([render("live", "ended"), render("live", "ended")]);
		expect(a).toBe(b);
	});
});
