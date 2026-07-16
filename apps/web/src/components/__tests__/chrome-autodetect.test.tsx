// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

	it("渲染远程端点输入框,空值时连接按钮禁用", () => {
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		expect(screen.getByPlaceholderText(/ws:\/\//)).toBeTruthy();
		const btn = screen.getByRole("button", { name: /连接远程浏览器/ }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	it("填远程端点 + 点连接 → POST enable-rendering { chromeEndpoint } + 回调 onEnabled", async () => {
		postMock.mockResolvedValue({ ok: true, chromeEndpoint: "ws://browser:3000" });
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.change(screen.getByPlaceholderText(/ws:\/\//), {
			target: { value: "ws://browser:3000" },
		});
		fireEvent.click(screen.getByRole("button", { name: /连接远程浏览器/ }));
		await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/cards/enable-rendering", {
			chromeEndpoint: "ws://browser:3000",
		});
	});

	it("远程端点连接失败 → 显示后端错误,不回调 onEnabled", async () => {
		postMock.mockRejectedValue(new Error("远程浏览器连接失败：connect ECONNREFUSED browser:3000"));
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.change(screen.getByPlaceholderText(/ws:\/\//), {
			target: { value: "ws://bad:3000" },
		});
		fireEvent.click(screen.getByRole("button", { name: /连接远程浏览器/ }));
		expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
		expect(onEnabled).not.toHaveBeenCalled();
	});
});
