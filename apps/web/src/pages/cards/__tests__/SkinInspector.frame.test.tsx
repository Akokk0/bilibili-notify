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
