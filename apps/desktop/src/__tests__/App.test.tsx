// @vitest-environment jsdom

/**
 * 桌面启动页(launcher)的行为测试。
 *
 * 原版是零构建的原生 HTML(git 历史里的 src/index.html),React 化时必须原样保住的
 * 行为都钉在这里:degraded 提示、轮询刷新、ready 自动跳转、按钮的 invoke 语义与
 * busy 禁用、dock 按钮的文案/禁用/提示。Tauri 的 invoke 与页面跳转都走注入,
 * 测试里不碰真 window.__TAURI__。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { App, type LauncherState } from "../App";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function state(over: Partial<LauncherState> = {}): LauncherState {
	return {
		status: "starting",
		statusLabel: "正在启动后端服务",
		message: "正在启动本机后端。服务就绪后会自动打开 Dashboard。",
		detail: "",
		panelUrl: null,
		dockToggleAvailable: true,
		dockHidden: false,
		...over,
	};
}

describe("App — degraded(无 Tauri API)", () => {
	it("invoke 不存在时给出提示,且不发起任何轮询", () => {
		render(<App invoke={undefined} navigate={vi.fn()} />);
		expect(screen.getByText("Tauri API 不可用")).toBeTruthy();
		expect(screen.getByText("请在 Tauri 桌面壳中打开此页面。")).toBeTruthy();
		expect(screen.getByText("window.__TAURI__.core.invoke 不存在")).toBeTruthy();
	});
});

describe("App — 启动中", () => {
	it("渲染后端状态,starting 时「重试启动」与「打开 Dashboard」禁用", async () => {
		const invoke = vi.fn(async (cmd: string) => {
			if (cmd === "get_launcher_state") return state();
			return undefined;
		});
		render(<App invoke={invoke} navigate={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText("正在启动后端服务")).toBeTruthy();
		});
		expect(screen.getByText("正在启动本机后端。服务就绪后会自动打开 Dashboard。")).toBeTruthy();
		expect((screen.getByRole("button", { name: "重试启动" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(
			(screen.getByRole("button", { name: "打开 Dashboard" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("非 starting 且有 panelUrl 时按钮解禁", async () => {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state"
				? state({ status: "failed", statusLabel: "启动失败", panelUrl: "http://127.0.0.1:8787" })
				: undefined,
		);
		render(<App invoke={invoke} navigate={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText("启动失败")).toBeTruthy();
		});
		expect((screen.getByRole("button", { name: "重试启动" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
		expect(
			(screen.getByRole("button", { name: "打开 Dashboard" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});
});

describe("App — 状态点对 Rust 真实状态串的映射", () => {
	// 契约对面是 main.rs LauncherStatus::as_str():starting/ready/stopped/failed/crashed。
	// 曾经这里映射的是虚构的 "error",真实故障时点色掉到灰色兜底 —— 用 Rust 真串钉死。
	async function dotBackground(status: string, statusLabel: string): Promise<string> {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state" ? state({ status, statusLabel }) : undefined,
		);
		const { container } = render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText(statusLabel)).toBeTruthy();
		});
		const dot = container.querySelector("span.h-2.w-2") as HTMLElement;
		return dot.style.background;
	}

	it("failed → 红点", async () => {
		expect(await dotBackground("failed", "后端服务启动失败")).toMatch(
			/#ef4444|rgb\(239, 68, 68\)/i,
		);
	});

	it("crashed → 红点", async () => {
		expect(await dotBackground("crashed", "后端服务已崩溃")).toMatch(/#ef4444|rgb\(239, 68, 68\)/i);
	});

	it("stopped → 橙点", async () => {
		expect(await dotBackground("stopped", "后端服务已停止")).toMatch(
			/#f59e0b|rgb\(245, 158, 11\)/i,
		);
	});
});

describe("App — ready 自动跳转", () => {
	it("ready 且有 panelUrl → navigate(panelUrl)", async () => {
		const navigate = vi.fn();
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state"
				? state({ status: "ready", statusLabel: "已就绪", panelUrl: "http://127.0.0.1:8787" })
				: undefined,
		);
		render(<App invoke={invoke} navigate={navigate} />);

		await waitFor(() => {
			expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:8787");
		});
	});

	it("ready 但没有 panelUrl → 不跳", async () => {
		const navigate = vi.fn();
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state"
				? state({ status: "ready", statusLabel: "已就绪", panelUrl: null })
				: undefined,
		);
		render(<App invoke={invoke} navigate={navigate} />);

		await waitFor(() => {
			expect(screen.getByText("已就绪")).toBeTruthy();
		});
		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("App — 轮询", () => {
	it("每 pollMs 重新拉一次 launcher state", async () => {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state" ? state() : undefined,
		);
		render(<App invoke={invoke} navigate={vi.fn()} pollMs={20} />);

		await waitFor(() => {
			expect(invoke.mock.calls.filter(([c]) => c === "get_launcher_state").length).toBeGreaterThan(
				2,
			);
		});
	});
});

describe("App — 按钮 invoke 语义", () => {
	it("打开 Dashboard / 日志 / 数据目录 / 退出各自击发对应命令", async () => {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state"
				? state({ status: "failed", statusLabel: "启动失败", panelUrl: "http://127.0.0.1:8787" })
				: undefined,
		);
		render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("启动失败")).toBeTruthy();
		});

		fireEvent.click(screen.getByRole("button", { name: "打开 Dashboard" }));
		fireEvent.click(screen.getByRole("button", { name: "打开后端日志" }));
		fireEvent.click(screen.getByRole("button", { name: "打开启动器日志" }));
		fireEvent.click(screen.getByRole("button", { name: "打开数据目录" }));
		fireEvent.click(screen.getByRole("button", { name: "退出应用" }));

		const cmds = invoke.mock.calls.map(([c]) => c);
		for (const cmd of [
			"open_panel_in_browser",
			"open_server_log_dir",
			"open_launcher_log_dir",
			"open_data_dir",
			"quit_app",
		]) {
			expect(cmds).toContain(cmd);
		}
	});

	it("重试启动 → retry_service,随后立即刷新状态", async () => {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state"
				? state({ status: "failed", statusLabel: "启动失败" })
				: undefined,
		);
		render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("启动失败")).toBeTruthy();
		});

		const before = invoke.mock.calls.filter(([c]) => c === "get_launcher_state").length;
		fireEvent.click(screen.getByRole("button", { name: "重试启动" }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("retry_service");
			expect(invoke.mock.calls.filter(([c]) => c === "get_launcher_state").length).toBeGreaterThan(
				before,
			);
		});
	});

	it("命令失败时错误信息落进 detail 区", async () => {
		const invoke = vi.fn(async (cmd: string) => {
			if (cmd === "get_launcher_state")
				return state({ status: "failed", statusLabel: "启动失败", panelUrl: "http://x" });
			if (cmd === "open_data_dir") throw new Error("没权限打开目录");
			return undefined;
		});
		render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("启动失败")).toBeTruthy();
		});

		fireEvent.click(screen.getByRole("button", { name: "打开数据目录" }));
		await waitFor(() => {
			expect(screen.getByText(/没权限打开目录/)).toBeTruthy();
		});
	});
});

describe("App — Dock 按钮", () => {
	it("dockHidden=true 时文案变「显示 Dock 图标」", async () => {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state" ? state({ dockHidden: true }) : undefined,
		);
		render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "显示 Dock 图标" })).toBeTruthy();
		});
	});

	it("dockToggleAvailable=false 时禁用并给出 title 提示", async () => {
		const invoke = vi.fn(async (cmd: string) =>
			cmd === "get_launcher_state" ? state({ dockToggleAvailable: false }) : undefined,
		);
		render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			const btn = screen.getByRole("button", { name: "隐藏 Dock 图标" }) as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
			expect(btn.title).toBe("当前平台或菜单栏图标不可用");
		});
	});

	it("点击切换 dock → toggle_dock_icon + 刷新", async () => {
		let hidden = false;
		const invoke = vi.fn(async (cmd: string) => {
			if (cmd === "get_launcher_state")
				return state({ status: "failed", statusLabel: "启动失败", dockHidden: hidden });
			if (cmd === "toggle_dock_icon") hidden = true;
			return undefined;
		});
		render(<App invoke={invoke} navigate={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "隐藏 Dock 图标" })).toBeTruthy();
		});

		fireEvent.click(screen.getByRole("button", { name: "隐藏 Dock 图标" }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("toggle_dock_icon");
			expect(screen.getByRole("button", { name: "显示 Dock 图标" })).toBeTruthy();
		});
	});
});
