// @vitest-environment jsdom

/**
 * 卡片外框那一节的**出血**控件(ADR-0014 决策 19 的 🔗)。
 *
 * 单独开一份而不是并进 `skin-draft-ops.test.ts`:那份钉的是「`setFrame` 收到 patch 之后
 * 怎么改清单」,它全绿也证明不了**面板上真有一个控件把 patch 发出来**。皮肤这一摊已经
 * 栽过一次同族的:`cardSkin` 这个可选参数从头到尾没人传,两端的单测各自全绿、类型也绿,
 * 只有主人开着面板才看出来。所以这里钉的是那条线本身。
 */

import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SkinInspector } from "../SkinInspector";

afterEach(cleanup);

function mount(over: Record<string, unknown> = {}) {
	const onFrame = vi.fn();
	render(
		<SkinInspector
			manifest={structuredClone(DEFAULT_CARD_SKIN)}
			kind="live"
			selection={{ kind: "frame" }}
			onGrid={vi.fn()}
			onCss={vi.fn()}
			onHtml={vi.fn()}
			onShowIf={vi.fn()}
			onFrame={onFrame}
			onFrameCss={vi.fn()}
			onColumns={vi.fn()}
			{...over}
		/>,
	);
	return { onFrame };
}

describe("常用旋钮接在哪一层", () => {
	/** 外框那一节读的必须是 `[data-bn="frame"]`,块那一节读的必须是 `[data-bn="self"]`。 */
	function withCss(frameCss: string, selection: { kind: "frame" } | { kind: "block"; id: string }) {
		const m = structuredClone(DEFAULT_CARD_SKIN) as unknown as {
			cards: Record<string, Record<string, unknown>>;
		};
		m.cards.live = { ...m.cards.live, css: frameCss };
		const onFrameCss = vi.fn();
		render(
			<SkinInspector
				manifest={m as never}
				kind="live"
				selection={selection}
				onGrid={vi.fn()}
				onCss={vi.fn()}
				onHtml={vi.fn()}
				onShowIf={vi.fn()}
				onFrame={vi.fn()}
				onFrameCss={onFrameCss}
				onColumns={vi.fn()}
			/>,
		);
		return { onFrameCss };
	}

	it("外框那一节读的是 frame 那条规则 —— 传错挂点这条就红", () => {
		withCss('[data-bn="frame"]{padding:20px}', { kind: "frame" });
		expect((screen.getByLabelText("内边距") as HTMLInputElement).value).toBe("20");
	});

	it("外框那段 CSS 里写了什么规则就列什么,选择器照原文显示、不按挂点筛", () => {
		withCss('[data-bn="self"]{padding:20px}', { kind: "frame" });
		expect((screen.getByLabelText(/的选择器$/) as HTMLInputElement).value).toBe('[data-bn="self"]');
	});

	it("拧外框的旋钮 → 走 onFrameCss 交回整段", () => {
		const { onFrameCss } = withCss('[data-bn="frame"]{padding:20px}', { kind: "frame" });
		fireEvent.change(screen.getByLabelText("内边距"), { target: { value: "24" } });
		expect(onFrameCss).toHaveBeenCalledWith('[data-bn="frame"]{padding:24px}');
	});
});

describe("卡片外框 — 出血", () => {
	it("有一个数字控件,改了它把 bleedSize 发出去", () => {
		const { onFrame } = mount();
		const input = screen.getByLabelText(/出血/);
		fireEvent.change(input, { target: { value: "24" } });
		expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ bleedSize: 24 }));
	});

	it("说得出它是干什么的 —— 光写「出血」两个字没人知道那是辉光的余量", () => {
		mount();
		expect(screen.getByText(/辉光/)).toBeTruthy();
	});
});
