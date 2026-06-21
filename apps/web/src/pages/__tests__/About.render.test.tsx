// @vitest-environment jsdom

/**
 * About(关于 / 支持项目)页渲染测试。三个 section:支持项目(默认)/ 更新日志 / 关于本项目,
 * 经 SectionNav 切换。SectionNav 双形态(竖栏 + 横向条)→ 标签各出现两次,用 getAllBy*。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import About from "../About";

afterEach(() => cleanup());

describe("About page", () => {
	it("defaults to the sponsor section with an afdian entry and empty sponsor list", () => {
		render(<About />);
		expect(screen.getByText("前往爱发电支持")).toBeTruthy();
		const link = screen.getByRole("link", { name: /前往爱发电/ });
		expect(link.getAttribute("href")).toContain("afdian");
		expect(screen.getByText(/还没有人发电/)).toBeTruthy();
	});

	it("shows project info after switching to the about section", async () => {
		render(<About />);
		fireEvent.click(screen.getAllByRole("button", { name: /关于本项目/ })[0]);
		expect(await screen.findByText("Akokk0/bilibili-notify")).toBeTruthy();
		expect(screen.getByText("801338523")).toBeTruthy();
		expect(screen.getByText(/MIT License/)).toBeTruthy();
	});

	it("renders the changelog panel only after switching to it", async () => {
		render(<About />);
		expect(screen.queryByText("apps/CHANGELOG.md")).toBeNull();
		fireEvent.click(screen.getAllByRole("button", { name: /更新日志/ })[0]);
		expect(await screen.findByText("apps/CHANGELOG.md")).toBeTruthy();
	});

	// 回归:bn-anim-fade-in 的残留 transform 不挂在 grid 上,否则会改写内部 sticky 竖栏的
	// 包含块,使窄视口单列布局坍缩。该约束随「更新日志」从 Logs 一并迁来。
	it("keeps the fade-in transform off the grid/sticky layer", () => {
		const { container } = render(<About />);
		const fade = container.querySelector(".bn-anim-fade-in");
		expect(fade).toBeTruthy();
		expect(fade?.classList.contains("grid")).toBe(false);
		const grid = fade?.querySelector(".grid");
		expect(grid).toBeTruthy();
		expect(grid?.querySelector("aside.sticky")).toBeTruthy();
	});
});
