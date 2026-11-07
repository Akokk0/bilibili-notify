import { createI18n } from "@bilibili-notify/internal/i18n";
import {
	bindPackageText,
	PACKAGE_DICTS,
	type PackageTextKey,
} from "@bilibili-notify/internal/texts";
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
		expect(warn).toHaveBeenCalledWith("头像加载失败，使用首字母", { url: "/gone.png" });
	});

	it("日志地址不带凭据或查询参数，实际图片地址保持原值", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const url = "https://user:password@example.test/avatar.png?token=private#secret";
		render(<Avatar name="A" color="#f00" url={url} />);
		const image = screen.getByRole("img", { name: "A" });
		expect(image.getAttribute("src")).toBe(url);
		fireEvent.error(image);
		expect(warn).toHaveBeenCalledWith("头像加载失败，使用首字母", {
			url: "https://example.test/avatar.png",
		});
	});

	it("图片出错时现取语言，并始终使用平实说明", () => {
		const texts = createI18n<PackageTextKey>({
			dicts: PACKAGE_DICTS,
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "maid",
		});
		const binding = bindPackageText(texts.t);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { rerender } = render(<Avatar name="A" color="#f00" url="/0.png" />);
		try {
			let index = 0;
			for (const [locale, message] of [
				["zh-CN", "头像加载失败，使用首字母"],
				["en", "Avatar failed to load; using initial"],
				["ja", "アバターを読み込めないため、頭文字を表示します"],
				["zh-TW", "頭像載入失敗，使用首字母"],
			] as const) {
				texts.set({ locale, voice: "maid" });
				const url = `/${index++}.png`;
				rerender(<Avatar name="A" color="#f00" url={url} />);
				fireEvent.error(screen.getByRole("img", { name: "A" }));
				expect(warn).toHaveBeenLastCalledWith(message, { url });
			}
			expect(warn).toHaveBeenCalledTimes(4);
		} finally {
			binding.dispose();
		}
	});

	it("地址变了重新试", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { rerender } = render(<Avatar name="小明" color="#f00" url="/gone.png" />);
		fireEvent.error(screen.getByRole("img", { name: "小明" }));
		rerender(<Avatar name="小明" color="#f00" url="/new.png" />);
		expect(screen.getByRole("img", { name: "小明" }).getAttribute("src")).toBe("/new.png");
	});
});
