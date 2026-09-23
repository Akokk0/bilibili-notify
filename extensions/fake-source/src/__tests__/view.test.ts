/**
 * 假源交给面板的视图:它名下有几条订阅、开着几条,外加一句「这是开发用的假东西」。
 *
 * 视图是**现取**的(宿主每问一次叫一次回调),盲点在「什么时候该再问」—— 订阅一动就得喊一声
 * `statusChanged()`,不然主人在订阅页加完一条,切回拓展页那个数还是旧的。
 */

import type { ExtensionBlock, ExtensionOwnSubscription } from "@bilibili-notify/extension";
import { describe, expect, it } from "vite-plus/test";
import { bootFakeSource } from "./harness.js";

function sub(n: number, enabled: boolean): ExtensionOwnSubscription {
	return { id: `00000000-0000-4000-8000-00000000000${n}`, externalId: `fake-${n}`, enabled };
}

/** 五条,三条开着 —— 两个数不相同,才分得清哪格报的是哪个。 */
const FIVE = [sub(1, true), sub(2, false), sub(3, true), sub(4, false), sub(5, true)];

function blockOf<T extends ExtensionBlock["type"]>(
	page: readonly ExtensionBlock[] | undefined,
	type: T,
): Extract<ExtensionBlock, { type: T }> | undefined {
	return page?.find((block): block is Extract<ExtensionBlock, { type: T }> => block.type === type);
}

describe("视图", () => {
	it("页上一块键值报订阅总数与开着的条数,一条提示说它是开发用的假源、什么平台都没连", () => {
		const view = bootFakeSource(FIVE).view();
		expect(blockOf(view.page, "keyValue")?.items).toEqual([
			{ label: expect.any(String), value: expect.stringContaining("5") },
			{ label: expect.any(String), value: expect.stringContaining("3") },
		]);
		expect(blockOf(view.page, "notice")).toMatchObject({
			tone: "info",
			text: expect.stringMatching(/开发用.*没连/),
		});
	});

	it("拓展列表页那一行报它名下有几条订阅", () => {
		expect(bootFakeSource(FIVE).view().summary?.text).toEqual(expect.stringContaining("5"));
		expect(bootFakeSource([]).view().summary?.text).toEqual(expect.stringContaining("0"));
	});

	it("订阅一动就喊一声 statusChanged,再取视图就是新的条数", () => {
		const fake = bootFakeSource(FIVE);
		expect(fake.statusChanges()).toBe(0);
		fake.changeSubscriptions([sub(7, true), sub(8, false)]);
		expect(fake.statusChanges()).toBe(1);
		expect(blockOf(fake.view().page, "keyValue")?.items).toEqual([
			{ label: expect.any(String), value: expect.stringContaining("2") },
			{ label: expect.any(String), value: expect.stringContaining("1") },
		]);
	});
});
