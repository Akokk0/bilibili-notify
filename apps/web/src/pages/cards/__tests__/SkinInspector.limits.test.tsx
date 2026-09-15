// @vitest-environment jsdom

/**
 * 面板上那两个「几 / 几」计数器量的是**哪把尺**(ADR-0014「上限的算法三层不一致」)。
 *
 * 退这份包的清洗器量的是 UTF-8 字节,所以面板也必须报字节。用 `value.length` 报的是
 * UTF-16 单元数 —— 一个汉字才记 1,于是中文密集的块会在面板上显示「3000 / 8192」、
 * 一路存到服务端才被退回来,而面板从头到尾没说过一句它要超了。
 *
 * 钉的就是这件事:同一段中文,计数器报的数与那道闸判的必须是同一个。
 */

import { CARD_SKIN_LIMITS, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SkinInspector } from "../SkinInspector";

afterEach(cleanup);

type LooseManifest = { cards: Record<string, Record<string, unknown>> };

function mount(
	build: (m: LooseManifest) => void,
	selection: { kind: "frame" } | { kind: "block"; id: string },
) {
	const m = structuredClone(DEFAULT_CARD_SKIN) as unknown as LooseManifest;
	build(m);
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
			onFrameCss={vi.fn()}
			onColumns={vi.fn()}
		/>,
	);
}

const CUSTOM_ID = "cjk-probe";

/** 往 live 卡里塞一个自定义块 —— HTML 那一节只对自定义块画。 */
function withCustomBlock(html: string) {
	return (m: LooseManifest) => {
		const live = m.cards.live as { blocks: unknown[] };
		live.blocks = [
			...live.blocks,
			{ id: CUSTOM_ID, kind: "custom", html, grid: { row: 1, column: 1, span: 12 } },
		];
	};
}

describe("面板计数器按 UTF-8 字节报", () => {
	it("外框 CSS:一百个汉字报的是 300,不是 100", () => {
		mount(
			(m) => {
				m.cards.live = { ...m.cards.live, css: "字".repeat(100) };
			},
			{ kind: "frame" },
		);
		expect(screen.getByText(`300 / ${CARD_SKIN_LIMITS.maxCssBytes}`)).toBeTruthy();
	});

	it("外框 CSS:UTF-16 没到头、字节到了头 —— 面板当场说存不下去", () => {
		const cjk = "字".repeat(6000);
		expect(cjk.length).toBeLessThan(CARD_SKIN_LIMITS.maxCssBytes);
		mount(
			(m) => {
				m.cards.live = { ...m.cards.live, css: cjk };
			},
			{ kind: "frame" },
		);
		expect(screen.getByText(/超过上限/)).toBeTruthy();
	});

	it("自定义块 HTML:一百个汉字报的是 300,不是 100", () => {
		mount(withCustomBlock("字".repeat(100)), { kind: "block", id: CUSTOM_ID });
		expect(screen.getByText(`300 / ${CARD_SKIN_LIMITS.maxHtmlBytes}`)).toBeTruthy();
	});

	it("自定义块 HTML:UTF-16 没到头、字节到了头 —— 面板当场说存不下去", () => {
		const cjk = "字".repeat(3000);
		expect(cjk.length).toBeLessThan(CARD_SKIN_LIMITS.maxHtmlBytes);
		mount(withCustomBlock(cjk), { kind: "block", id: CUSTOM_ID });
		expect(screen.getAllByText(/超过上限/).length).toBeGreaterThan(0);
	});
});
