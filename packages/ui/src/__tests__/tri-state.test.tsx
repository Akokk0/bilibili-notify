// @vitest-environment jsdom

/**
 * `TriStateChip` —— 三态记号 + 名字。悬停说明默认说的是「能力」那一套(支持 / 不支持 /
 * 还不知道);讲的不是能力的地方要能整份换掉,不然只能在库外再抄一份 chip。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TRISTATE_TEXT, TriStateChip } from "../tri-state";

afterEach(cleanup);

const titleOf = (container: HTMLElement) =>
	(container.firstElementChild as HTMLElement).getAttribute("title");

describe("TriStateChip", () => {
	it("不传说法时用默认那三句", () => {
		for (const state of ["supported", "unsupported", "unknown"] as const) {
			const { container } = render(<TriStateChip label="@全体" state={state} />);
			expect(titleOf(container)).toBe(`@全体:${TRISTATE_TEXT[state]}`);
			cleanup();
		}
		expect(TRISTATE_TEXT).toEqual({
			supported: "支持",
			unsupported: "不支持",
			unknown: "还不知道",
		});
	});

	it("传了就用传的", () => {
		const { container } = render(
			<TriStateChip
				label="同步"
				state="unknown"
				stateText={{ supported: "开着", unsupported: "关着", unknown: "没问到" }}
			/>,
		);
		expect(titleOf(container)).toBe("同步:没问到");
	});
});
