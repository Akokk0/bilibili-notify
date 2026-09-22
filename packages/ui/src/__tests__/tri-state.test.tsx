// @vitest-environment jsdom

/**
 * `TriStateChip` —— 三态记号 + 名字。悬停说明是名字接上「能力」那三句之一(支持 / 不支持 /
 * 还不知道)。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TRISTATE_TEXT, TriStateChip } from "../tri-state";

afterEach(cleanup);

const titleOf = (container: HTMLElement) =>
	(container.firstElementChild as HTMLElement).getAttribute("title");

describe("TriStateChip", () => {
	it("悬停说明是名字 + 那三句之一", () => {
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
});
