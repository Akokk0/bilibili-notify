// @vitest-environment jsdom

/**
 * ScopeTabs —— 同一条 tab 条上,「全局」TabButton 与 per-UP 复合 tab 的**选中态
 * 必须说同一句话**(TAB_ACTIVE_LANGUAGE:粉实心块 + on-solid 字)。
 *
 * 收编前 per-UP 自配「白卡 + 粉描边 + shadow-bn-card」,与紧挨着的「全局」实心块
 * 并排摆着两种选中态 —— 2026-08-30 审计点名的「另一条账」。per-UP 做不成
 * TabButton(结构上是「主钮 + 移除钮」的复合体),所以靠共用导出的语汇常量钉齐。
 */

import { TAB_ACTIVE_LANGUAGE, TAB_IDLE_LANGUAGE } from "@bilibili-notify/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import { ScopeTabs } from "../scope-tabs";

afterEach(cleanup);

function makeSub(uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		cachedProfile: {
			name,
			avatar: "",
			sign: "",
			fans: 0,
			lastRefreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

const SUB = makeSub("111", "UP甲");

function renderTabs(scope: string) {
	return render(
		<ScopeTabs
			scope={scope}
			onChange={vi.fn()}
			tabSubs={[SUB]}
			availableSubs={[]}
			onAddSub={vi.fn()}
			onRemoveSub={vi.fn()}
			overridesCountFor={() => 2}
		/>,
	);
}

/** 语汇常量的每个词都得在这颗元素身上。 */
function expectSpeaks(el: Element, language: string) {
	const cls = (el as HTMLElement).className.split(/\s+/);
	for (const word of language.split(/\s+/)) {
		expect([word, cls.includes(word)]).toEqual([word, true]);
	}
}

const perUpTab = () => {
	const el = screen.getByText("UP甲").closest('[data-bn^="tab"]');
	if (!el) throw new Error("没找到 per-UP tab");
	return el;
};

describe("ScopeTabs 的两种 tab 说同一句选中语汇", () => {
	it("per-UP 选中 = TAB_ACTIVE_LANGUAGE,旧的白卡方言一个词都不许剩", () => {
		renderTabs(SUB.id);
		const tab = perUpTab();
		expect(tab.getAttribute("data-bn")).toBe("tab tab-active");
		expectSpeaks(tab, TAB_ACTIVE_LANGUAGE);
		for (const old of ["bg-bn-surface", "border-bn-pink/25", "shadow-bn-card", "text-bn-pink"]) {
			expect((tab as HTMLElement).className).not.toContain(old);
		}
	});

	it("per-UP 闲置 = TAB_IDLE_LANGUAGE,与 TabButton 的闲置一字不差", () => {
		renderTabs("__global");
		const tab = perUpTab();
		expect(tab.getAttribute("data-bn")).toBe("tab");
		expectSpeaks(tab, TAB_IDLE_LANGUAGE);
	});

	it("「全局」TabButton 选中时说的也是同一句 —— 语汇只有一处定义", () => {
		renderTabs("__global");
		const globalBtn = screen.getByText("全局 / 全部 UP").closest("button");
		if (!globalBtn) throw new Error("没找到全局 tab");
		expectSpeaks(globalBtn, TAB_ACTIVE_LANGUAGE);
	});

	it("选中 tab 里的移除 × 走 scrim 档(实心粉底上 tertiary 灰读不出来),闲置回常规档", () => {
		const { unmount } = renderTabs(SUB.id);
		const closeActive = screen.getByLabelText(/移除 UP甲/);
		// scrim 档刻意不挂 btn(皮肤的按钮实底会盖掉纱,见 IconButton 那段),字走 on-solid。
		expect(closeActive.getAttribute("data-bn")).toBe(null);
		expect(closeActive.className).toContain("text-bn-on-solid");
		unmount();
		renderTabs("__global");
		const closeIdle = screen.getByLabelText(/移除 UP甲/);
		expect(closeIdle.getAttribute("data-bn")).toBe("btn");
	});
});
