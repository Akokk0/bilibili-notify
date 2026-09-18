/**
 * **转发框里那张内层卡也是原子块拼的**(ADR-0014 决策 8 的 🔗)。
 *
 * 内层卡跟着同一份皮肤走,所以它也该是原子块 —— 摆漏一块的话画出来的内层卡只是少了一行,
 * 别的门全绿。
 *
 * 这份原来还有一条更大的门:同一份示例数据,冻住的旧默认皮肤画出的每一段文字、每一张图,
 * 新默认皮肤里都得有、而且一样多 —— 那是拆原子块那一轮防「静默漏摆」用的。旧默认皮肤已
 * 随迁移一起退役(决策 17 的 2026-09-18 🔗),而那条门的活由 `__tests__/card-baseline.test.ts`
 * 接了过去:出厂默认皮肤画出的字节整份钉住,漏一块当场红。
 */

import {
	type CardSkinKind,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
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
