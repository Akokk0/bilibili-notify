// @vitest-environment jsdom

/**
 * 照声明画的那一页上反复出现的小件(`parts.tsx`)。
 *
 * 值得钉的:🔴 **「已复制」说的是屏幕上这一串**。复制了旧 token、再重新生成一把,钮还写着
 * 「已复制」的话,主人会以为新的已经在剪贴板里了 —— 照着粘过去的却是作废的那一把。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../../utils/clipboard", () => ({ copyToClipboard: vi.fn() }));

import { copyToClipboard } from "../../../../utils/clipboard";
import { CopyControl } from "../parts";

const OLD = "0123456789abcdef0123456789abcdef";
const NEW = "ffffffffffffffffffffffffffffffff";

beforeEach(() => {
	vi.mocked(copyToClipboard).mockReset();
	vi.mocked(copyToClipboard).mockResolvedValue(true);
});
afterEach(() => {
	cleanup();
});

describe("CopyControl:换了一串就回到「没复制」", () => {
	it("带字那颗:字回到「复制」,读屏器按的 label 不变", async () => {
		const { rerender } = render(<CopyControl label="复制 token" text={OLD} />);
		const button = screen.getByRole("button", { name: "复制 token" });
		fireEvent.click(button);
		await waitFor(() => expect(button.textContent).toBe("已复制"));
		expect(copyToClipboard).toHaveBeenCalledWith(OLD);

		rerender(<CopyControl label="复制 token" text={NEW} />);
		expect(screen.getByRole("button", { name: "复制 token" }).textContent).toBe("复制");
	});

	/** 图标钮没有字,「已复制」住在 label 里 —— 那一句同样得跟着回去。 */
	it("图标钮:label 里的「已复制」跟着去掉", async () => {
		const { rerender } = render(<CopyControl iconOnly label="复制 BN 地址" text={OLD} />);
		fireEvent.click(screen.getByRole("button", { name: "复制 BN 地址" }));
		expect(await screen.findByRole("button", { name: "复制 BN 地址(已复制)" })).toBeTruthy();

		rerender(<CopyControl iconOnly label="复制 BN 地址" text={NEW} />);
		expect(screen.getByRole("button", { name: "复制 BN 地址" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /已复制/ })).toBeNull();
	});

	/** 旧的那一串还在往剪贴板里写,屏幕上就换了新的:写完那一下说的是旧的,不许挂到新的头上。 */
	it("复制还没回来就换了一串:回来之后也不说「已复制」", async () => {
		let done = (_ok: boolean) => {};
		vi.mocked(copyToClipboard).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					done = resolve;
				}),
		);
		const { rerender } = render(<CopyControl label="复制 token" text={OLD} />);
		fireEvent.click(screen.getByRole("button", { name: "复制 token" }));
		rerender(<CopyControl label="复制 token" text={NEW} />);
		await act(async () => done(true));
		expect(screen.getByRole("button", { name: "复制 token" }).textContent).toBe("复制");
	});
});
