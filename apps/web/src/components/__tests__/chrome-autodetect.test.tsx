// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
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
		i18n.set({ locale: "zh-CN", voice: "plain" });
		getMock.mockReset();
		postMock.mockReset();
	});
	afterEach(() => cleanup());

	it("renders the auto-detect button initially", () => {
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		expect(screen.getByRole("button", { name: /自动探测/ })).toBeTruthy();
	});

	/**
	 * 三颗药丸钮收成一份之后的不变量。绿的那两颗此前逐字相同,谁在其中一处
	 * fork 一份改样式,这里就红;`data-bn` 是皮肤唯一能瞄准它们的口子。
	 */
	it("三颗药丸钮同一副骨架,绿的两颗完全一致,且都挂了皮肤挂点", async () => {
		getMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		await waitFor(() => screen.getByRole("button", { name: "启用" }));

		const pills = {
			detect: screen.getByRole("button", { name: /自动探测/ }),
			enable: screen.getByRole("button", { name: "启用" }),
			remote: screen.getByRole("button", { name: /连接远程浏览器/ }),
		};
		for (const el of Object.values(pills)) {
			expect(el.getAttribute("data-bn")).toBe("btn");
			for (const c of ["rounded-bn-pill", "border", "px-3", "py-1", "disabled:opacity-60"]) {
				expect([c, el.className.split(/\s+/).includes(c)]).toEqual([c, true]);
			}
		}
		expect(pills.enable.className).toBe(pills.remote.className);
		expect(pills.detect.className).not.toBe(pills.enable.className);
	});

	it("探测命中 → 展示路径 + 启用按钮", async () => {
		getMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });
		render(<ChromeAutoDetect onEnabled={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		expect(await screen.findByText("/usr/bin/google-chrome")).toBeTruthy();
		expect(screen.getByRole("button", { name: /启用/ })).toBeTruthy();
	});

	it("点启用 → POST /renderer + 回调 onEnabled", async () => {
		getMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });
		postMock.mockResolvedValue({ ok: true, chromePath: "/usr/bin/google-chrome" });
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		fireEvent.click(await screen.findByRole("button", { name: /启用/ }));
		await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/cards/renderer", {
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

	it("填远程端点 + 点连接 → POST /renderer { chromeEndpoint } + 回调 onEnabled", async () => {
		postMock.mockResolvedValue({ ok: true, chromeEndpoint: "ws://browser:3000" });
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.change(screen.getByPlaceholderText(/ws:\/\//), {
			target: { value: "ws://browser:3000" },
		});
		fireEvent.click(screen.getByRole("button", { name: /连接远程浏览器/ }));
		await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/cards/renderer", {
			chromeEndpoint: "ws://browser:3000",
		});
	});

	it("启用本机 Chrome 失败(非 2xx,api 抛 ApiError)→ 显示服务端那句原话,不回调 onEnabled", async () => {
		getMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });
		postMock.mockRejectedValue(new Error("服务还没准备好，请稍后重试"));
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		fireEvent.click(await screen.findByRole("button", { name: "启用" }));
		expect(await screen.findByText("服务还没准备好，请稍后重试")).toBeTruthy();
		expect(onEnabled).not.toHaveBeenCalled();
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
	it("detected browser and pending endpoint survive language changes without enabling rendering", async () => {
		getMock.mockResolvedValue({ path: "/test/browser" });
		const onEnabled = vi.fn();
		render(<ChromeAutoDetect onEnabled={onEnabled} />);
		fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
		await screen.findByText("/test/browser");
		const input = screen.getByPlaceholderText(/ws:\/\//) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "ws://pending-browser:3000" } });
		for (const [locale, enable, connect] of [
			["en", "Enable", "Connect remote browser"],
			["ja", "有効にする", "リモートブラウザーに接続"],
			["zh-TW", "啟用", "連線至遠端瀏覽器"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText("/test/browser")).toBeTruthy();
			expect(screen.getByRole("button", { name: enable })).toBeTruthy();
			expect(screen.getByRole("button", { name: connect })).toBeTruthy();
			expect(screen.getByPlaceholderText(/ws:\/\//)).toBe(input);
			expect(input.value).toBe("ws://pending-browser:3000");
			expect(postMock).not.toHaveBeenCalled();
			expect(onEnabled).not.toHaveBeenCalled();
		}
	});
});
