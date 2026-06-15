// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeAutoDetect } from "../chrome-autodetect";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: { get: getMock, post: postMock },
	ApiError: class extends Error {},
}));

describe("ChromeAutoDetect", () => {
	beforeEach(() => {
		getMock.mockReset();
		postMock.mockReset();
	});
	afterEach(() => cleanup());

	it("renders the auto-detect button initially", () => {
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		expect(screen.getByRole("button", { name: /自动探测/ })).toBeTruthy();
	});

	it("探测命中 → 展示路径 + 启用按钮", async () => {
		getMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		expect(await screen.findByText("/usr/bin/google-chrome")).toBeTruthy();
		expect(screen.getByRole("button", { name: /启用/ })).toBeTruthy();
	});

	it("点启用 → POST enable-rendering + 回调 onEnabled", async () => {
		getMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });
		postMock.mockResolvedValue({ ok: true, chromePath: "/usr/bin/google-chrome" });
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		fireEvent.click(await screen.findByRole("button", { name: /启用/ }));
		await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/cards/enable-rendering", {
			chromePath: "/usr/bin/google-chrome",
		});
	});

	it("探测不到 → 提示手动配置,不显示启用按钮", async () => {
		getMock.mockResolvedValue({ path: null });
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		expect(await screen.findByText(/未.*找到|手动/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /启用/ })).toBeNull();
	});
});
