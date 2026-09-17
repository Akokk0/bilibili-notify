/**
 * **新默认皮肤用原子块拼**(ADR-0014 决策 8 的 2026-09-18 🔗)。
 *
 * 默认皮肤从复合块换成原子块,外观允许小幅变化(主人选的),所以这里**不比像素**,比的是
 * 「东西一件没少、也没多出来」:同一份示例数据,冻住的旧默认皮肤画出来的每一段文字、每一张图,
 * 新默认皮肤里都得有,而且一样多。拆的时候漏摆一个原子块(或者把某个块的收起条件写错),
 * 画出来的卡只是少了一行,别的门全绿 —— 这条就是为那种静默缺失写的。
 *
 * 另钉一件:转发框里那张内层卡跟着同一份皮肤走,所以也是原子块拼的。
 */

import {
	CARD_PREVIEW_SCENES,
	type CardSkinKind,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	LEGACY_DEFAULT_CARD_SKIN,
} from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { sampleCard } from "../../preview/sample-cards";
import { renderCardWithSkin } from "../render-skin";

async function render(kind: CardSkinKind, scene: string, skin: CardSkinManifest): Promise<string> {
	const sample = await sampleCard(kind, scene);
	return renderCardWithSkin(kind, sample.props as never, skin, {
		...(sample.raw ? { raw: sample.raw } : {}),
	});
}

/**
 * 一张卡上「看得见的东西」:每段非空文字、每张 `<img>` 的地址、每个行内背景图的地址,排好序。
 * 只看 `<body>` —— `<head>` 里是样式表,新旧两份的 CSS 本来就不一样。
 */
function pieces(html: string): string[] {
	const { document, NodeFilter } = new JSDOM(html).window;
	const out: string[] = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType === 3) {
			const t = n.textContent?.trim();
			if (t) out.push(`文字:${t}`);
			continue;
		}
		if (n.nodeType !== 1) continue;
		const el = n as Element;
		if (el.tagName === "STYLE") continue;
		if (el.tagName === "IMG") out.push(`图:${el.getAttribute("src")}`);
		const bg = (el as HTMLElement).style?.backgroundImage;
		if (bg) out.push(`背景图:${bg}`);
	}
	return out.sort();
}

const EDITABLE: CardSkinKind[] = ["live", "dynamic", "sc", "guard"];

describe("新默认皮肤 — 旧默认画得出的每一件都还在", () => {
	for (const kind of EDITABLE) {
		for (const scene of CARD_PREVIEW_SCENES[kind]) {
			it(`${kind} · ${scene.label}`, async () => {
				const [legacy, current] = await Promise.all([
					render(kind, scene.id, LEGACY_DEFAULT_CARD_SKIN),
					render(kind, scene.id, DEFAULT_CARD_SKIN),
				]);
				const want = pieces(legacy);
				expect(want.length).toBeGreaterThan(0);
				expect(pieces(current)).toEqual(want);
			});
		}
	}
});

describe("新默认皮肤 — 转发框里的内层卡也是原子块", () => {
	it("框里摆的是头像 / 名字 / 时间 / 正文这些原子块,没有头部与正文复合块", async () => {
		const html = await render("dynamic", "forward", DEFAULT_CARD_SKIN);
		const { document } = new JSDOM(html).window;
		const inset = document.querySelector('[data-block="forward"]');
		expect(inset).not.toBeNull();
		const inner = [...(inset?.querySelectorAll("[data-block]") ?? [])].map((e) =>
			e.getAttribute("data-block"),
		);
		expect(inner).toEqual(expect.arrayContaining(["avatar", "name", "time", "media"]));
		expect(inner).not.toContain("header");
		expect(inner).not.toContain("content");
	});
});
