// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { BrowserSourceSettings } from "../browser-source-settings";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: { get: getMock, post: postMock },
	ApiError: class extends Error {},
}));

/** get 按路径分派:`/renderer` 可变(切换后刷新),`/chrome` 固定。 */
function mockGet({ status, detectPath = null }: { status: unknown; detectPath?: string | null }) {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/cards/renderer") {
			return typeof status === "function" ? (status as () => unknown)() : status;
		}
		if (path === "/api/cards/chrome") return { path: detectPath };
		throw new Error(`unexpected GET ${path}`);
	});
}

describe("BrowserSourceSettings", () => {
	it.each([
		[
			"ja",
			"ご主人様、chromePath / chromeEndpoint は接続を確認してから、その場で切り替えますよ。",
			"ご主人様、この環境には書き込める設定ファイルがありませんよ。変更はすぐに反映しますが、再起動すると戻るので、環境変数か YAML で設定してくださいね。",
			"ご主人様、一般的な場所には Chrome / Chromium が見つかりませんでした。パスを手動で入力してくださいね。",
			"自動検出",
		],
		[
			"zh-TW",
			"主人，chromePath / chromeEndpoint 會先確認連線，成功後立即切換喔。",
			"主人，目前沒有可寫入的設定檔。切換會立即生效，但重新啟動後不會保留，請改用環境變數或 YAML 設定喔。",
			"主人，在常見位置找不到 Chrome / Chromium，請手動填入路徑喔。",
			"自動偵測",
		],
	] as const)(
		"%s 女仆浏览器提示保留原端点和未应用草稿",
		async (locale, subtitle, persistence, missing, detect) => {
			mockGet({
				status: {
					enabled: true,
					source: { chromeEndpoint: "ws://original-browser:3000" },
					persistable: false,
				},
			});
			render(<BrowserSourceSettings />);
			await screen.findByText(/重启后不保留/);
			const input = screen.getByPlaceholderText(/ws:\/\//) as HTMLInputElement;
			fireEvent.change(input, { target: { value: "ws://edited-browser:3000" } });
			act(() => i18n.set({ locale, voice: "maid" }));
			expect(screen.getByText(subtitle)).toBeTruthy();
			expect(screen.getByText(persistence)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: detect }));
			expect(await screen.findByText(missing)).toBeTruthy();
			expect(screen.getByPlaceholderText(/ws:\/\//)).toBe(input);
			expect(input.value).toBe("ws://edited-browser:3000");
			expect(screen.getByTestId("browser-source-current").textContent).toContain(
				"ws://original-browser:3000",
			);
			expect(postMock).not.toHaveBeenCalled();
		},
	);

	it.each(["zh-CN", "en", "ja", "zh-TW"] as const)(
		"%s 显式字段说明不误报缺失，切换口吻保留端点草稿",
		async (locale) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				mockGet({
					status: {
						enabled: true,
						source: { chromeEndpoint: "ws://original-browser:3000" },
						persistable: true,
					},
				});
				render(<BrowserSourceSettings />);
				const current = await screen.findByTestId("browser-source-current");
				await waitFor(() => expect(current.textContent).toContain("ws://original-browser:3000"));
				const input = screen.getByPlaceholderText(/ws:\/\//) as HTMLInputElement;
				fireEvent.change(input, { target: { value: "ws://edited-browser:3000" } });
				for (const voice of ["plain", "maid"] as const) {
					act(() => i18n.set({ locale, voice }));
					expect(screen.getByPlaceholderText(/ws:\/\//)).toBe(input);
					expect(input.value).toBe("ws://edited-browser:3000");
					expect(current.textContent).toContain("ws://original-browser:3000");
					expect(warn).not.toHaveBeenCalled();
					expect(postMock).not.toHaveBeenCalled();
				}
			} finally {
				cleanup();
				warn.mockRestore();
			}
		},
	);

	beforeEach(() => {
		i18n.set({ locale: "zh-CN", voice: "plain" });
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

	it("应用远程端点 → POST /renderer 并刷新状态", async () => {
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
			expect(postMock).toHaveBeenCalledWith("/api/cards/renderer", {
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
	it("browser settings change language without losing the edited endpoint or applying it", async () => {
		mockGet({
			status: {
				enabled: true,
				source: { chromeEndpoint: "ws://original-browser:3000" },
				persistable: false,
			},
		});
		postMock.mockResolvedValue({ ok: true, chromeEndpoint: "ws://edited-browser:3000" });
		render(<BrowserSourceSettings />);
		const current = await screen.findByTestId("browser-source-current");
		await waitFor(() => expect(current.textContent).toContain("ws://original-browser:3000"));
		const input = screen.getByPlaceholderText(/ws:\/\//) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "ws://edited-browser:3000" } });
		for (const [locale, remote, apply] of [
			["en", "Remote browser", "Apply remote endpoint"],
			["ja", "リモートブラウザー", "リモート接続先を適用"],
			["zh-TW", "遠端瀏覽器", "套用遠端端點"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(current.textContent).toContain(remote);
			expect(current.textContent).toContain("ws://original-browser:3000");
			expect(screen.getByPlaceholderText(/ws:\/\//)).toBe(input);
			expect(input.value).toBe("ws://edited-browser:3000");
			expect(screen.getByRole("button", { name: apply })).toBeTruthy();
			expect(postMock).not.toHaveBeenCalled();
		}
		fireEvent.click(screen.getByRole("button", { name: "套用遠端端點" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/cards/renderer", {
			chromeEndpoint: "ws://edited-browser:3000",
		});
	});
});
