// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BrowserSourceSettings } from "../browser-source-settings";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: { get: getMock, post: postMock },
	ApiError: class extends Error {},
}));

/** get 按路径分派:render-source 可变(切换后刷新),detect-chrome 固定。 */
function mockGet({ status, detectPath = null }: { status: unknown; detectPath?: string | null }) {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/cards/render-source") {
			return typeof status === "function" ? (status as () => unknown)() : status;
		}
		if (path === "/api/cards/detect-chrome") return { path: detectPath };
		throw new Error(`unexpected GET ${path}`);
	});
}

describe("BrowserSourceSettings", () => {
	beforeEach(() => {
		getMock.mockReset();
		postMock.mockReset();
	});
	afterEach(() => cleanup());

	it("加载后显示当前来源(远程端点)", async () => {
		mockGet({
			status: { enabled: true, source: { chromeEndpoint: "ws://browser:3000" }, persistable: true },
		});
		render(<BrowserSourceSettings />);
		const current = await screen.findByTestId("browser-source-current");
		await waitFor(() => expect(current.textContent).toContain("ws://browser:3000"));
		expect(current.textContent).toContain("远程浏览器");
	});

	it("未启用时显示未启用态", async () => {
		mockGet({ status: { enabled: false, source: null, persistable: true } });
		render(<BrowserSourceSettings />);
		const current = await screen.findByTestId("browser-source-current");
		await waitFor(() => expect(current.textContent).toContain("未启用"));
	});

	it("persistable=false → 提示重启后不保留", async () => {
		mockGet({
			status: { enabled: true, source: { chromePath: "/usr/bin/chromium" }, persistable: false },
		});
		render(<BrowserSourceSettings />);
		expect(await screen.findByText(/重启后不保留/)).toBeTruthy();
	});

	it("自动探测把命中的路径填进本地输入框", async () => {
		mockGet({
			status: { enabled: false, source: null, persistable: true },
			detectPath: "/usr/bin/google-chrome",
		});
		render(<BrowserSourceSettings />);
		fireEvent.click(await screen.findByRole("button", { name: /自动探测/ }));
		await waitFor(() => {
			const input = screen.getByPlaceholderText(/Chrome/) as HTMLInputElement;
			expect(input.value).toBe("/usr/bin/google-chrome");
		});
	});

	it("应用远程端点 → POST enable-rendering 并刷新状态", async () => {
		let current: unknown = { enabled: false, source: null, persistable: true };
		mockGet({ status: () => current });
		postMock.mockImplementation(async () => {
			current = {
				enabled: true,
				source: { chromeEndpoint: "ws://browser:3000" },
				persistable: true,
			};
			return { ok: true, chromeEndpoint: "ws://browser:3000" };
		});
		render(<BrowserSourceSettings />);
		fireEvent.change(await screen.findByPlaceholderText(/ws:\/\//), {
			target: { value: "ws://browser:3000" },
		});
		fireEvent.click(screen.getByRole("button", { name: /应用远程端点/ }));
		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/cards/enable-rendering", {
				chromeEndpoint: "ws://browser:3000",
			}),
		);
		const statusLine = screen.getByTestId("browser-source-current");
		await waitFor(() => expect(statusLine.textContent).toContain("ws://browser:3000"));
		expect(statusLine.textContent).toContain("远程浏览器");
	});

	it("切换失败 → 显示后端错误,状态不变", async () => {
		mockGet({
			status: { enabled: true, source: { chromePath: "/usr/bin/chromium" }, persistable: true },
		});
		postMock.mockRejectedValue(new Error("浏览器连接失败：connect ECONNREFUSED"));
		render(<BrowserSourceSettings />);
		fireEvent.change(await screen.findByPlaceholderText(/ws:\/\//), {
			target: { value: "ws://bad:3000" },
		});
		fireEvent.click(screen.getByRole("button", { name: /应用远程端点/ }));
		expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
		expect(screen.getByText("/usr/bin/chromium")).toBeTruthy(); // 原来源仍显示
	});
});
