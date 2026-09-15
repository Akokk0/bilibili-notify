// @vitest-environment jsdom

/**
 * 每个 CSS 文本框旁边那个 **AI 入口**(ADR-0014 决策 23 的 🔗)。
 *
 * 主人的原话是「大部分用户可能都不会写 CSS,让用户能直接请 AI 帮忙」,而这一步**只画位置**:
 * 按钮摆出来、禁用、说清楚「下一轮才接上」。接什么、怎么接归第三步的拷问。
 *
 * 钉三件:两处 CSS 都有它、它现在点不动、以及**点不动的理由在按钮上说得出来** ——
 * 一个没有任何说明的灰按钮,用户只会当成坏了。
 */

import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SkinInspector } from "../SkinInspector";

afterEach(cleanup);

function mount(selection: { kind: "frame" } | { kind: "block"; id: string }) {
	render(
		<SkinInspector
			manifest={structuredClone(DEFAULT_CARD_SKIN)}
			kind="live"
			selection={selection}
			onGrid={vi.fn()}
			onCss={vi.fn()}
			onHtml={vi.fn()}
			onShowIf={vi.fn()}
			onFrame={vi.fn()}
			onFrameCss={vi.fn()}
			onColumns={vi.fn()}
		/>,
	);
}

/** 默认皮肤 live 卡的第一个块 —— 块那一节要选中一个真的块才画得出来。 */
const FIRST_BLOCK_ID = DEFAULT_CARD_SKIN.cards.live?.blocks[0]?.id ?? "";

describe("CSS 旁边的 AI 入口(只画位置)", () => {
	it("外框那一节有", () => {
		mount({ kind: "frame" });
		expect(screen.getByRole("button", { name: /请 AI/ })).toBeTruthy();
	});

	it("块那一节也有 —— 决策说的是**每个** CSS 文本框旁边", () => {
		mount({ kind: "block", id: FIRST_BLOCK_ID });
		expect(screen.getByRole("button", { name: /请 AI/ })).toBeTruthy();
	});

	it("现在点不动", () => {
		mount({ kind: "frame" });
		expect((screen.getByRole("button", { name: /请 AI/ }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("按钮自己说得出为什么点不动 —— 别丢一个没来由的灰钮", () => {
		mount({ kind: "frame" });
		const btn = screen.getByRole("button", { name: /请 AI/ });
		expect(btn.getAttribute("title") ?? "").toMatch(/下一轮/);
	});
});
