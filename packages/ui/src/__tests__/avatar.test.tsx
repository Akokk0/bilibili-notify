// @vitest-environment jsdom

/**
 * `Avatar` 图裂了退回首字母,不露浏览器的裂图占位。图裂的原因不止一种(地址过时、CDN 拒绝、文件被清掉),
 * 所以退回的同时在控制台留一行 warn,写上是哪个地址,开发时照样查得到。地址变了重新试。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Avatar } from "../atoms";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Avatar", () => {
	it("有地址就显图", () => {
		render(<Avatar name="小明" color="#f00" url="/a.png" />);
		expect(screen.getByRole("img", { name: "小明" }).getAttribute("src")).toBe("/a.png");
	});

	it("图裂了:换成首字母,并 warn 出那个地址", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		render(<Avatar name="小明" color="#f00" url="/gone.png" />);
		fireEvent.error(screen.getByRole("img", { name: "小明" }));
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByText("小")).toBeTruthy();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("/gone.png"));
	});

	it("地址变了重新试", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { rerender } = render(<Avatar name="小明" color="#f00" url="/gone.png" />);
		fireEvent.error(screen.getByRole("img", { name: "小明" }));
		rerender(<Avatar name="小明" color="#f00" url="/new.png" />);
		expect(screen.getByRole("img", { name: "小明" }).getAttribute("src")).toBe("/new.png");
	});
});
